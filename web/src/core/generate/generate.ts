/**
 * Prompt-to-level, verified (§8.3 steps 3-5): plan → layout → build → bot, then the deterministic fixer.
 *
 *   1. clamp the plan (beats.ts) and lay it out (layout.ts → draw.ts: blue-line draft strokes)
 *   2. perceive (exact: every stroke is labelled) and run the Faithful build without repairs
 *   3. if the bot finds it unsolvable (or a hard fairness flag), the beat at the frontier is made one step easier
 *      (shrink its width / rise / spacing by 1), or a rest is inserted before it; up to 3 times
 *   4. still failing: `frontier_text` says why in plain words, for the one PLAN retry the orchestrator may make,
 *      and the returned build is the greedy repair (repairUnsolvable), so the draft is always playable.
 * The same generator authors Starter World (`ink: 'marker'` re-inks the draft in the kid's palette, K1 "Ink it").
 */
import type { BuildInput, BuildResult } from '../index.ts';
import { PROMPT_LEVEL } from '../params.ts';
import type { Beat, EditOp, EditRecord, GameMode, GameRules, InkColor, InkDoc, InkStroke, LevelPlan, LibraryType, PlaytestReport, Role, RuleV4, SceneGraph, SceneObject, Tier } from '../types.gen.ts';
import { build, finish, prepare } from '../build/build.ts';
import { resolveRules } from '../build/level.ts';
import { hardFlags } from '../edits/invariants.ts';
import { OP_CLASS, explain } from '../edits/vocabulary.ts';
import { profileOf } from '../edits/work.ts';
import { inkFromStrokes } from '../ink/index.ts';
import { perceiveHeuristic } from '../scene/perceive.ts';
import { editId } from '../util/ids.ts';
import { normalizePlan, shrinkBeat, bandOf } from './beats.ts';
import type { ClampMode } from './beats.ts';
import { layoutToInk } from './draw.ts';
import { layoutPrims } from './layout.ts';
import type { Layout, LayoutOverrides, Span } from './layout.ts';

/** The kid's marker colour for each role (K1 "Ink it", Starter World). */
const MARKER: Partial<Record<Role, InkColor>> = {
  ground: 'black', platform: 'black', wall: 'black', ceiling: 'black', door: 'black', pole: 'black', spring: 'black',
  text: 'black', arrow: 'black', start_marker: 'black', decoration: 'black', spikes: 'red', lava: 'red', saw: 'red',
  enemy: 'red', coin: 'blue', big_coin: 'blue', key: 'blue', goal: 'green', checkpoint: 'green',
};

/** "Ink it" (K1 for every draft stroke): blue-line draft → the kid's marker palette, origin 'kid'; labels kept. */
export function inkIt(ink: InkDoc, origin: 'kid' | 'migrated' = 'kid'): InkDoc {
  const strokes: InkStroke[] = ink.strokes.map((s) => ({ ...s, color: s.color === 'draft' ? MARKER[s.label ?? 'decoration'] ?? 'black' : s.color, origin: s.origin === 'draft' ? origin : s.origin }));
  const out = inkFromStrokes(strokes, { cell: 16, screens: ink.world.screens, w: ink.world.w, h: 27 });
  const res: InkDoc & { x_beats?: unknown } = { ...out, source: ink.source, typed_rules: ink.typed_rules, character: ink.character, sheets: ink.sheets };
  const beats = (ink as InkDoc & { x_beats?: unknown }).x_beats;
  if (beats) res.x_beats = beats;
  return res;
}

export interface GenerateOptions {
  tier?: Tier;
  overrides?: LayoutOverrides & { edits?: EditOp[] };
  clamp?: ClampMode; // 'band' for model / keyword plans, 'envelope' for authored Starter World plans
  ink?: 'draft' | 'marker';
  library?: LibraryType[];
  fixer?: boolean; // default true
  /** v4: the level's own rules (BuildInput.logic) and its mode (BuildInput.mode), e.g. a showcase level's. */
  logic?: RuleV4[] | null;
  mode?: GameMode | null;
}

export interface PlanFix {
  beat: string;
  from: Beat;
  to: Beat | null; // null: a rest was inserted before it
  why: string; // failure kind or flag code
}

export interface GenerateResult {
  plan: LevelPlan; // the clamped plan after fixes
  ink: InkDoc;
  graph0: SceneGraph;
  result: BuildResult; // the build at the requested tier (repaired when the fixer could not make it solvable)
  solvable: boolean; // solvable as laid out, before any R repair
  fixes: PlanFix[];
  frontier_text: string | null;
  dropped: string[];
  spans: Span[];
}

const WHAT: Record<string, string> = {
  gap_too_wide: 'jump', ledge_too_high: 'climb', wall_too_tall: 'wall', head_bonk: 'jump under the ceiling',
  key_unreachable: 'key', goal_unreachable: 'path to the flag', spawn_trapped: 'start', hard_flag: 'jump',
};

function strokeBeat(ink: InkDoc): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of ink.strokes) {
    const b = (s as InkStroke & { x_beat?: string }).x_beat;
    if (typeof b === 'string') m.set(s.id, b);
  }
  return m;
}

function isRealBeat(addr: string): boolean {
  return /^\d+\.\d+$/.test(addr);
}

/** The beat to make easier: the one holding the blocking object, else the first real beat at / after the frontier x. */
export function failingBeat(report: PlaytestReport, lay: Layout, objs: readonly SceneObject[], ink: InkDoc): { addr: string; why: string } | null {
  const sb = strokeBeat(ink);
  const blocking = report.frontier?.blocking ?? null;
  let x: number | null = null;
  let why = 'goal_unreachable';
  let viaObject: string | null = null;
  if (!report.solvable) {
    if (blocking) {
      why = blocking.kind;
      // a hazard, enemy or ledge names its own beat; a ground run spans many beats, so it is located by x instead
      const o = objs.find((q) => q.id === blocking.to_object && q.role !== 'ground');
      if (o) for (const s of o.strokes) {
        const b = sb.get(s);
        if (b && isRealBeat(b)) {
          viaObject = b;
          break;
        }
      }
      x = blocking.from[0];
    } else {
      const xs = (report.frontier?.reached ?? []).map((c) => c[0]);
      x = xs.length ? Math.max(...xs) : 0;
    }
  } else {
    const f = hardFlags(report).find((q) => q.severity === 'hard' || q.severity === 'block');
    if (!f) return null;
    why = f.code;
    x = f.at ? f.at[0] : null;
    for (const id of f.object_ids ?? []) {
      const o = objs.find((q) => q.id === id && q.role !== 'ground');
      for (const s of o?.strokes ?? []) {
        const b = sb.get(s);
        if (b && isRealBeat(b)) viaObject ??= b;
      }
    }
  }
  if (viaObject) return { addr: viaObject, why };
  if (x === null) return null;
  const spans = lay.spans.filter((s) => s.x1 > s.x0 || s.kind === 'goal');
  const at = spans.findIndex((s) => x! >= s.x0 - 0.5 && x! < s.x1 + 0.5);
  const from = at >= 0 ? at : spans.findIndex((s) => s.x0 >= x!);
  if (from < 0) return null;
  // the frontier stands on a beat's far end: the blocker is the next real, fixable beat
  for (let k = from; k < spans.length; k++) {
    const s = spans[k];
    if (!isRealBeat(s.addr) || s.kind === 'flat' || s.kind === 'rest' || s.kind === 'checkpoint' || s.kind === 'goal') {
      if (k === from && isRealBeat(s.addr) && s.kind === 'flat') return { addr: s.addr, why };
      continue;
    }
    return { addr: s.addr, why };
  }
  return null;
}

function frontierText(report: PlaytestReport, addr: string | null): string | null {
  if (report.solvable) return null;
  const b = report.frontier?.blocking ?? null;
  const where = addr && isRealBeat(addr) ? (() => {
    const [s, k] = addr.split('.').map(Number);
    return ` in section ${s + 1} beat ${k + 1}`;
  })() : '';
  if (!b) return `nobody can reach the flag${where}; make that part easier`;
  const what = WHAT[b.kind] ?? 'jump';
  const need = String(b.need ?? '').slice(0, 40);
  const have = String(b.have ?? '').slice(0, 40);
  return `the ${what}${where} needs ${need || 'more than the player can do'}${have ? `; max is ${have}` : ''}`;
}

/** Apply one fixer step to a plan (a copy): shrink the beat, or insert a 4-cell rest before it. */
function fixPlan(plan: LevelPlan, addr: string, why: string): { plan: LevelPlan; fix: PlanFix } | null {
  const [si, bi] = addr.split('.').map(Number);
  const sec = plan.sections[si];
  const beat = sec?.beats[bi];
  if (!beat) return null;
  const next: LevelPlan = JSON.parse(JSON.stringify(plan));
  const easier = shrinkBeat(beat, bandOf(plan.band));
  if (easier) {
    next.sections[si].beats[bi] = easier;
    return { plan: next, fix: { beat: addr, from: beat, to: easier, why } };
  }
  const prev = sec.beats[bi - 1];
  if (prev && prev.kind === 'rest') return null; // already rested: nothing more the fixer can do here
  next.sections[si].beats.splice(bi, 0, { kind: 'rest', length: 4 });
  return { plan: next, fix: { beat: addr, from: beat, to: null, why } };
}

/** Override edits address generated objects as `@<beat>:<role>[#k]` (k-th by x); resolved after perception. */
function resolveEdits(ops: readonly EditOp[], g: SceneGraph, ink: InkDoc): EditRecord[] {
  const sb = strokeBeat(ink);
  const find = (ref: string): string | null => {
    const m = /^@([^:]+):([a-z_]+)(?:#(\d+))?$/.exec(ref);
    if (!m) return ref;
    const [, beat, role, k] = m;
    const hits = g.objects.filter((o) => !o.rel.part_of && o.role === role && o.strokes.some((s) => sb.get(s) === beat));
    hits.sort((a, b) => {
      const xa = ink.strokes.find((s) => s.id === a.strokes[0])?.pts[0]?.[0] ?? 0;
      const xb = ink.strokes.find((s) => s.id === b.strokes[0])?.pts[0]?.[0] ?? 0;
      return xa - xb;
    });
    return hits[Number(k ?? 0)]?.id ?? null;
  };
  const out: EditRecord[] = [];
  for (const op0 of ops) {
    const op = JSON.parse(JSON.stringify(op0)) as Record<string, unknown>;
    let ok = true;
    for (const key of ['target', 'key', 'door', 'near', 'root', 'a', 'b', 'group', 'entity', 'flag', 'pole', 'surface']) {
      if (typeof op[key] === 'string' && (op[key] as string).startsWith('@')) {
        const id = find(op[key] as string);
        if (!id) ok = false;
        else op[key] = id;
      }
    }
    if (!ok) continue;
    const e = op as unknown as EditOp;
    const ex = explain(e, null);
    out.push({
      id: editId(e), op: e, class: OP_CLASS[e.op], by: 'kid', stage: 'ink', tier: 'faithful', status: 'applied',
      reason_key: ex.reason_key, reason_args: {}, reason_text: null, depends_on: [], required: false, group: ex.group,
      validation: null, ghost: null, reject_reason: null, cid: null,
    });
  }
  return out;
}

/** Lay out a plan as a blue-line draft (or marker) InkDoc, with its beat spans. */
export function layoutDetailed(plan: LevelPlan, rules: GameRules, seed: number, o: GenerateOptions = {}): { plan: LevelPlan; layout: Layout; ink: InkDoc } {
  const r = resolveRules(rules);
  const p = profileOf(r);
  const canRun = r.abilities?.run !== false;
  const clamped = normalizePlan(plan, p, canRun, o.clamp ?? 'band');
  const layout = layoutPrims(clamped, p, canRun, o.overrides);
  const draft = layoutToInk(layout, seed);
  return { plan: clamped, layout, ink: o.ink === 'marker' ? inkIt(draft) : draft };
}

/** §8.3 steps 2-5: lay out, build, prove, fix (≤ 3), and always return a playable build. */
export function generateLevel(plan: LevelPlan, rules: GameRules, seed: number, o: GenerateOptions = {}): GenerateResult {
  const t0 = Date.now();
  const r = resolveRules(rules);
  const p = profileOf(r);
  const canRun = r.abilities?.run !== false;
  const library = o.library ?? [];
  let cur = normalizePlan(plan, p, canRun, o.clamp ?? 'band');
  const fixes: PlanFix[] = [];
  const max = o.fixer === false ? 0 : PROMPT_LEVEL.fixer_max;
  let last: { lay: Layout; ink: InkDoc; graph0: SceneGraph; input: BuildInput; f: ReturnType<typeof prepare>; addr: string | null } | null = null;
  let solvable = false;
  for (let attempt = 0; attempt <= max; attempt++) {
    const lay = layoutPrims(cur, p, canRun, o.overrides);
    const draft = layoutToInk(lay, seed);
    const ink = o.ink === 'marker' ? inkIt(draft) : draft;
    const graph0 = perceiveHeuristic(ink, { library, parent: null });
    const edits = o.overrides?.edits?.length ? resolveEdits(o.overrides.edits, graph0, ink) : [];
    const input: BuildInput = { ink, graph0, edits, rules: r, library, parent: null, tier: 'faithful', repairUnsolvable: false, seed,
      ...(o.logic?.length ? { logic: o.logic } : {}), ...(o.mode ? { mode: o.mode } : {}) };
    const f = prepare(input);
    // unsolvable always sends the frontier beat to the fixer; a fairness flag does so only for model / keyword plans
    // (an authored Starter World level keeps its beats, and its flags are reported to the author)
    const flagged = (o.clamp ?? 'band') === 'band' && hardFlags(f.report).some((x) => x.severity === 'hard' && x.code !== 'long_segment');
    const bad = !f.report.solvable || flagged;
    const fb = bad ? failingBeat(f.report, lay, f.work.objs, ink) : null;
    last = { lay, ink, graph0, input, f, addr: fb?.addr ?? null };
    if (!bad) {
      solvable = f.report.solvable;
      break;
    }
    if (attempt === max || !fb) break;
    const next = fixPlan(cur, fb.addr, fb.why);
    if (!next) break;
    fixes.push(next.fix);
    cur = next.plan;
  }
  const L0 = last!;
  // `solvable` is the bot's verdict on the draft as laid out: a draft the fixer could not clear of a fairness flag
  // is still solvable (its flags reach the preview), and only a truly unsolvable one gets the repair + PLAN retry
  solvable = L0.f.report.solvable;
  const tier = o.tier ?? 'faithful';
  let result: BuildResult;
  if (solvable && tier === 'faithful') result = finish({ ...L0.input, tier }, L0.f, t0);
  else result = build({ ...L0.input, tier, repairUnsolvable: true });
  return {
    plan: cur, ink: L0.ink, graph0: L0.graph0, result, solvable, fixes,
    frontier_text: solvable ? null : frontierText(L0.f.report, L0.addr), dropped: L0.lay.dropped, spans: L0.lay.spans,
  };
}
