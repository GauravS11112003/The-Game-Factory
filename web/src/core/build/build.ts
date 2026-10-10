/**
 * build() (§3.1): a pure, deterministic function of (ink, graph0, edit records with statuses, rules, library,
 * parent, tier, repairUnsolvable).
 *
 *   G1    = apply(G0, U-edits)                         understanding (model, kid, library, parser)
 *   N     = normalize(G1)                              class N, stable ids, statuses honoured
 *   L     = compile(G2); R0 = analyze(L, fast)
 *   if repairUnsolvable and (!R0.solvable or hard flags): R = repairSearch(G2, R0)       (≤ 4 rounds)
 *   D     = stored P/C/K edits for this tier (nested), re-validated against G2+R; failures → 'rejected'
 *   level = compile(apply(G2, R ∪ D accepted)); report = analyze(level, full)
 *
 * Undo is a rebuild without the edit: the same inputs give a byte-identical level and report.
 */
import type { BuildInput, BuildResult } from '../index.ts';
import { PERCEPTION, REPAIR } from '../params.ts';
import type { EditRecord, MessageRef, PlaytestReport, SceneObject, Setpiece, Stage } from '../types.gen.ts';
import { ensureComponents } from '../ink/index.ts';
import { withParentInk } from '../scene/remix.ts';
import { checkReport, hardFlags } from '../edits/invariants.ts';
import { tierRank } from '../edits/vocabulary.ts';
import { cloneWork, emptyState, graphOf, isKid, objBBox, profileOf, workFromGraph } from '../edits/work.ts';
import type { Ctx, Work } from '../edits/work.ts';
import { analyzeSafe } from '../design/playtest.ts';
import { repairSearch } from '../design/repair_search.ts';
import { compileWork } from './compile.ts';
import { assembleLevel, lightLevel, resolveRules, worldOf } from './level.ts';
import type { AssembleInput } from './level.ts';
import { normalize } from './normalize.ts';
import { Runner } from './runner.ts';

/** The Faithful snapshot: the work after understanding, normalize and repair. Shared by every tier build. */
export interface Faithful {
  work: Work;
  records: EditRecord[];
  rejected: EditRecord[];
  report: PlaytestReport;
  approx: boolean;
  warnings: MessageRef[];
  stage: Stage;
  a: AssembleInput;
  ctx: Ctx;
}

function nowMs(): number {
  return Date.now();
}

function stageOf(edits: readonly EditRecord[]): Stage {
  return edits.some((e) => e.class === 'U' && e.by === 'model') ? 'understood' : 'ink';
}

/** Understanding + normalize + repair (everything below the dial). */
export function prepare(i: BuildInput): Faithful {
  // a paper remix scan inherits the parent's strokes, exactly as perceiveHeuristic saw them (§6.5)
  const ink = ensureComponents(withParentInk(i.ink, i.parent));
  const rules = resolveRules(i.rules);
  const profile = profileOf(rules);
  const world = worldOf(ink);
  const w = workFromGraph(i.graph0 ?? { objects: [] }, world);
  w.st = emptyState();
  const library = i.library ?? [];
  const ctx: Ctx = { ink, library, rules, profile, tier: 'faithful', report: null };
  const edits = i.edits ?? [];
  const stage = stageOf(edits);
  const R = new Runner(w, ctx, edits);
  const norm = normalize(R, stage, edits);
  // kid or model repair choices (DESIGN repair_choices, Fix it) are applied before the search
  for (const e of edits) {
    if (e.class !== 'R' || e.by === 'auto' || e.by === 'greedy' || e.tier !== 'faithful') continue;
    R.run(e.op, { by: e.by, stage: e.stage, tier: 'faithful', cls: 'R', required: true, recordFailures: true, cid: e.cid ?? null, reason_key: e.reason_key, reason_args: e.reason_args, reason_text: e.reason_text ?? null });
  }
  const a: AssembleInput = { ink, rules, library, parent: i.parent ?? null };
  let r = analyzeSafe(lightLevel(a, compileWork(R.w), R.w), 'fast', profile);
  let report = r.report;
  let approx = r.approx;
  const warnings = [...norm.warnings];
  const failing = !report.solvable || hardFlags(report).some((f) => f.code !== 'unsolvable' && f.severity === 'hard');
  if (i.repairUnsolvable && failing) {
    const exclude = new Set(edits.filter((e) => e.status === 'undone').map((e) => e.id));
    const maxChain = stage === 'ink' || stage === 'understood' ? REPAIR.ink_chain_max : REPAIR.faithful_max_repairs;
    const out = repairSearch(R, a, report, approx, { stage, maxChain, exclude });
    report = out.report;
    approx = out.approx;
    warnings.push(...out.warnings);
    if (out.applied.length) {
      r = analyzeSafe(lightLevel(a, compileWork(R.w), R.w), 'fast', profile);
      report = r.report;
      approx = r.approx;
    }
  }
  // offline setpieces (§3.3 merge 6): kid hazards, enemies, springs, keys and doors within 2 cells of the route
  if (!R.w.setpieces.length && report.route.length) {
    const sp = geometricSetpieces(R.w, report);
    if (sp.length) {
      R.w.setpieces = sp;
      r = analyzeSafe(lightLevel(a, compileWork(R.w), R.w), 'fast', profile);
      report = r.report;
      approx = r.approx;
    }
  }
  return { work: R.w, records: [...R.records], rejected: [...R.rejected], report, approx, warnings, stage, a, ctx };
}

const SETPIECE_ROLES = new Set(['spikes', 'lava', 'saw', 'enemy', 'spring', 'key', 'door']);

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Geometric setpieces: route-adjacent kid hazards and enemies, neighbours within 4 cells grouped, ≤ 4 in route order. */
export function geometricSetpieces(w: Work, report: PlaytestReport): Setpiece[] {
  const near: { o: SceneObject; x: number }[] = [];
  for (const o of w.objs) {
    if (!SETPIECE_ROLES.has(o.role) || o.rel.part_of || !isKid(o)) continue;
    const b = objBBox(o);
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const half = Math.max(b[2] - b[0], b[3] - b[1]) / 2;
    const d = Math.min(...report.route.map((s) => distToSeg(cx, cy, s.from[0], s.from[1] - 0.9, s.to[0], s.to[1] - 0.9))) - half;
    if (d <= PERCEPTION.setpieces.geometric_route_dist_c) near.push({ o, x: b[0] });
  }
  near.sort((p, q) => p.x - q.x || (p.o.id < q.o.id ? -1 : 1));
  const groups: SceneObject[][] = [];
  for (const n of near) {
    const g = groups[groups.length - 1];
    if (g && n.x - Math.max(...g.map((o) => objBBox(o)[2])) <= 4) g.push(n.o);
    else groups.push([n.o]);
  }
  const used = new Map<string, number>();
  return groups.slice(0, PERCEPTION.setpieces.model_max).map((g) => {
    const roles = g.map((o) => o.role);
    const kind: Setpiece['kind'] = roles.includes('key') || roles.includes('door') ? 'puzzle' : roles.every((r) => r === 'enemy') ? 'enemy' : roles.includes('spring') ? 'climb' : 'hazard_run';
    const noun = roles.includes('enemy') && !roles.some((r) => r === 'spikes' || r === 'lava' || r === 'saw') ? 'monster' : roles.includes('lava') ? 'lava' : roles.includes('key') || roles.includes('door') ? 'key and door' : roles.includes('spring') ? 'spring' : 'spikes';
    const k = (used.get(noun) ?? 0) + 1;
    used.set(noun, k);
    return { name: k > 1 ? `the ${noun} ${k}` : `the ${noun}`, ids: g.map((o) => o.id), kind, by: 'geometric' as const };
  });
}

function designerEdits(i: BuildInput): EditRecord[] {
  const t = tierRank(i.tier);
  const designerClass = (e: EditRecord): boolean => e.class === 'P' || e.class === 'C' || e.class === 'K' || ((e.class === 'R' || e.class === 'N') && e.tier !== 'faithful');
  return (i.edits ?? []).filter((e) => designerClass(e) && tierRank(e.tier) <= Math.max(t, e.class === 'K' ? 3 : 0) && (e.status === 'applied' || e.status === 'undone'));
}

function runDesigner(f: Faithful, i: BuildInput, list: readonly EditRecord[], skip: ReadonlySet<string>): Runner {
  const R = new Runner(cloneWork(f.work), { ...f.ctx, tier: i.tier, report: f.report }, i.edits ?? [], cloneWork(f.work));
  R.adopt(f.records, f.rejected);
  for (const e of list) {
    if (skip.has(e.id)) continue;
    R.run(e.op, {
      by: e.by, stage: e.class === 'K' ? e.stage : 'designed', tier: e.tier, cls: e.class, recordFailures: true,
      reason_text: e.reason_text ?? null, reason_key: e.reason_key, reason_args: e.reason_args, cid: e.cid ?? null,
      depends_on: e.depends_on, group: e.group ?? null,
    });
  }
  if (tierRank(i.tier) >= 1 && f.report.fastest_ms > 0) R.run({ op: 'set_par' }, { by: 'auto', stage: 'designed', tier: 'polished', cls: 'P' });
  return R;
}

/** Apply the tier's designer edits on the snapshot and produce the final level and full report. */
export function finish(i: BuildInput, f: Faithful, t0: number): BuildResult {
  const list = designerEdits(i);
  let R = runDesigner(f, i, list, new Set());
  const profile = f.ctx.profile;
  if (list.some((e) => e.status === 'applied')) {
    const quick = analyzeSafe(lightLevel(f.a, compileWork(R.w), R.w), 'fast', profile);
    const bad = checkReport(quick.report, { base: f.report, designer: true, approx: quick.approx });
    if (bad) {
      // find the culprits: add designer edits one at a time, rejecting each that breaks a hard constraint
      const skip = new Set<string>();
      const why = new Map<string, MessageRef>();
      for (let k = 0; k < list.length; k++) {
        if (list[k].status !== 'applied') continue;
        const trial = runDesigner(f, i, list.slice(0, k + 1), skip);
        const rr = analyzeSafe(lightLevel(f.a, compileWork(trial.w), trial.w), 'fast', profile);
        const v = checkReport(rr.report, { base: f.report, designer: true, approx: rr.approx });
        if (v) {
          skip.add(list[k].id);
          why.set(list[k].id, v);
        }
      }
      R = runDesigner(f, i, list, skip);
      for (const id of skip) {
        const e = list.find((x) => x.id === id)!;
        R.rejected.push({ ...e, status: 'rejected', reject_reason: why.get(id) ?? { key: 'reject.unsolvable', args: {} } });
      }
    }
  }
  const comp = compileWork(R.w);
  const light = lightLevel(f.a, comp, R.w);
  const full = analyzeSafe(light, 'full', profile, i.tier);
  const report = full.report;
  const hard = hardFlags(report).map((x) => x.code);
  const edits = R.records.map((e) => (e.status === 'applied' ? { ...e, validation: { solvable: report.solvable, flags: hard, drift_cells: e.validation?.drift_cells ?? 0, dC: e.validation?.dC ?? 0 } } : e));
  const warnings = [...f.warnings];
  if (full.approx) warnings.push({ key: 'warning.bot_unavailable', args: {} });
  const source = edits.some((e) => e.stage === 'designed' && e.by === 'model' && e.status === 'applied') ? 'model' : edits.some((e) => e.by === 'greedy' && e.status === 'applied') ? 'greedy' : 'none';
  const level = assembleLevel(f.a, R.w, comp, edits, report, i.tier, warnings, null, source);
  return { graph: graphOf(R.w), level, report, edits, rejected: R.rejected, ms: nowMs() - t0 };
}

export function build(i: BuildInput): BuildResult {
  const t0 = nowMs();
  return finish(i, prepare(i), t0);
}
