/**
 * Repair search (§3.7, [GF 5.2]): a minimal-intent-cost search keyed by failure kind, run only while the bot
 * reports `unsolvable` or a hard flag.
 *
 *   for round in 1..4 while failing:
 *     f = classify(first failure)                 (the unreached target nearest the frontier, in route order)
 *     C = GENERATORS[f.kind](f)                   (≤ 64 candidates, 1-2 ops each, inside the vocabulary bounds)
 *     evaluate C sorted by intent cost in a sandbox: apply → invariants → local re-solve of the window around the
 *       blocker (bot `localReach`, ±1.5 screens, §4.1) → analyze (fast) only for candidates that get past it
 *     choose the cheapest candidate that fixes it, else the largest frontier gain per unit cost
 *     keep the 2 next-cheapest fixes as an `alts` group for DESIGN (repair_choices)
 *
 * The topology (+3) and detached-pillar (+4) terms make "lower the wall by 1" (1.2) beat lifting it (≥ 9) [M B].
 */
import { REPAIR } from '../params.ts';
import type { CellXY, EditOp, MessageArgs, MessageRef, PlaytestReport, SceneObject, Stage } from '../types.gen.ts';
import { compileWork } from '../build/compile.ts';
import { lightLevel } from '../build/level.ts';
import type { AssembleInput } from '../build/level.ts';
import { Runner } from '../build/runner.ts';
import { gMax, hMax } from '../edits/envelope.ts';
import { hardFlags } from '../edits/invariants.ts';
import { slotId } from '../edits/slots.ts';
import { cloneWork, floorBelow, isDynamic, isFloor, obj, objBBox, topAt } from '../edits/work.ts';
import type { Work } from '../edits/work.ts';
import { editId } from '../util/ids.ts';
import { localReach } from '../bot/index.ts';
import { analyzeSafe, classifyFailure, frontierScore } from './playtest.ts';
import type { Failure } from './playtest.ts';

interface Cand {
  ops: EditOp[];
  reason_key: string;
  reason_args: MessageArgs;
}

interface Evaluated {
  c: Cand;
  cost: number;
  report: PlaytestReport;
  fixed: boolean;
  gain: number;
  x: number;
}

function ends(o: SceneObject): { x0: number; y0: number; x1: number; y1: number } | null {
  if (o.shape.k === 'surface' && o.shape.segs.length) {
    const s = [...o.shape.segs].sort((a, b) => a.a[0] - b.a[0]);
    return { x0: s[0].a[0], y0: s[0].a[1], x1: s[s.length - 1].b[0], y1: s[s.length - 1].b[1] };
  }
  if (o.shape.k === 'wall') return { x0: o.shape.x, y0: o.shape.y0, x1: o.shape.x + (o.shape.w ?? 1), y1: o.shape.y0 };
  return null;
}

/** The movable root of an object (its part_of root). */
function rootOf(w: Work, id: string | null): SceneObject | undefined {
  let o = obj(w, id);
  const seen = new Set<string>();
  while (o && o.rel.part_of && !seen.has(o.id)) {
    seen.add(o.id);
    o = obj(w, o.rel.part_of) ?? o;
    if (seen.has(o.id)) break;
  }
  return o;
}

function surfaceAt(w: Work, p: CellXY | null): SceneObject | undefined {
  if (!p) return undefined;
  return floorBelow(w, p[0] + 0.5, p[1] - 0.25, 1)?.o;
}

function gapGens(w: Work, f: Failure, rep: (o: SceneObject) => boolean, profile: Parameters<typeof gMax>[0]): Cand[] {
  const near = obj(w, f.fromObj) ?? surfaceAt(w, f.at);
  const far = rootOf(w, f.toObj) ?? surfaceAt(w, f.to);
  if (!near || !far || near === far) return [];
  const en = ends(near);
  const ef = ends(far);
  if (!en || !ef) return [];
  const right = ef.x0 >= en.x1 - 0.01;
  const gap = right ? ef.x0 - en.x1 : en.x0 - ef.x1;
  let runway = 0;
  const edgeY = right ? en.y1 : en.y0;
  for (let k = 0; k < 6; k++) {
    const x = right ? en.x1 - 0.5 - k : en.x0 + 0.5 + k;
    if (topAt(near, x) !== edgeY) break;
    runway++;
  }
  const gm = gMax(profile, runway);
  const d = Math.max(1, Math.ceil(gap - gm));
  const out: Cand[] = [];
  const args = { gap: Math.round(gap), max: gm };
  const sideToward = right ? 'right' : 'left';
  const sideBack = right ? 'left' : 'right';
  const farSide = right ? 'left' : 'right';
  if (rep(far)) for (let dx = d; dx <= 3; dx++) out.push({ ops: [{ op: 'nudge', group: far.id, dx: right ? -dx : dx, dy: 0 }], reason_key: 'repair.gap_nudged', reason_args: { ...args, dx } });
  for (let k = d; k <= 3; k++) {
    out.push({ ops: [{ op: 'extend', target: near.id, side: sideToward, cells: k }], reason_key: 'repair.extended', reason_args: { cells: k } });
    out.push({ ops: [{ op: 'extend', target: far.id, side: farSide, cells: k }], reason_key: 'repair.extended', reason_args: { cells: k } });
  }
  for (let a = 1; a < d && a <= 3; a++) {
    const b = d - a;
    if (b >= 1 && b <= 3) out.push({ ops: [{ op: 'extend', target: near.id, side: sideToward, cells: a }, { op: 'extend', target: far.id, side: farSide, cells: b }], reason_key: 'repair.extended', reason_args: { cells: d } });
  }
  if (runway < REPAIR.runway_target_c) {
    const k = Math.min(3, REPAIR.runway_target_c - runway);
    out.push({ ops: [{ op: 'extend', target: near.id, side: sideBack, cells: k }], reason_key: 'repair.runway', reason_args: { cells: k } });
  }
  const midX = right ? (en.x1 + ef.x0) / 2 : (ef.x1 + en.x0) / 2;
  const y = Math.round((edgeY + (right ? ef.y0 : ef.y1)) / 2);
  for (const sw of [2, 3]) out.push({ ops: [{ op: 'add_step', slot: slotId({ kind: 'step', x: midX, y, host: null, face: null, x0: null, x1: null, w: sw }), w: sw }], reason_key: 'repair.step_added', reason_args: {} });
  return out;
}

function ledgeGens(w: Work, f: Failure, rep: (o: SceneObject) => boolean, hmax: number): Cand[] {
  const target = rootOf(w, f.toObj) ?? surfaceAt(w, f.to);
  const from = obj(w, f.fromObj) ?? surfaceAt(w, f.at);
  if (!target) return [];
  const et = ends(target);
  if (!et) return [];
  const fromY = f.at[1];
  const ty = f.to ? f.to[1] : et.y0;
  const rise = Math.max(1, Math.round(fromY - ty));
  const d = Math.max(1, rise - hmax);
  const out: Cand[] = [];
  if (rep(target)) for (let dy = d; dy <= 3; dy++) out.push({ ops: [{ op: 'nudge', group: target.id, dx: 0, dy }], reason_key: 'repair.ledge_nudged', reason_args: { rise, max: hmax, dy } });
  const right = et.x0 >= f.at[0];
  const baseX = right ? et.x0 - 1.5 : et.x1 + 1.5;
  const stepY = Math.round(fromY - Math.ceil(rise / 2));
  for (const sw of [2, 3]) out.push({ ops: [{ op: 'add_step', slot: slotId({ kind: 'step', x: baseX, y: stepY, host: null, face: null, x0: null, x1: null, w: sw }), w: sw }], reason_key: 'repair.step_added', reason_args: {} });
  if (from) {
    const sy = topAt(from, baseX) ?? fromY;
    out.push({ ops: [{ op: 'add_spring', slot: slotId({ kind: 'spring', x: baseX, y: sy, host: from.id, face: 'top', x0: null, x1: null, w: null }), strength: 1.0 }], reason_key: 'repair.spring_added', reason_args: {} });
  }
  return out;
}

function wallGens(w: Work, f: Failure, hmax: number): Cand[] {
  const wall = obj(w, f.toObj);
  if (!wall || wall.shape.k !== 'wall') return [];
  const s = wall.shape;
  const height = Math.round(f.at[1] - s.y0);
  const out: Cand[] = [];
  const need = Math.max(1, height - hmax);
  for (let k = need; k <= 2; k++) out.push({ ops: [{ op: 'trim', target: wall.id, side: 'top', cells: k }], reason_key: 'repair.wall_trimmed', reason_args: { cells: k } });
  // lifting it is a candidate too, so the cost model (pillar + topology) can rank it last
  for (let k = need; k <= 3; k++) out.push({ ops: [{ op: 'nudge', group: wall.id, dx: 0, dy: -k }], reason_key: 'repair.nudged', reason_args: { cells: k } });
  const right = s.x >= f.at[0];
  const baseX = right ? s.x - 1.5 : s.x + (s.w ?? 1) + 1.5;
  const from = floorBelow(w, baseX, f.at[1] - 0.25, 1)?.o;
  const stepY = Math.round(f.at[1] - Math.ceil(height / 2));
  for (const sw of [2, 3]) out.push({ ops: [{ op: 'add_step', slot: slotId({ kind: 'step', x: baseX, y: stepY, host: null, face: null, x0: null, x1: null, w: sw }), w: sw }], reason_key: 'repair.step_added', reason_args: {} });
  if (from) out.push({ ops: [{ op: 'add_spring', slot: slotId({ kind: 'spring', x: right ? s.x - 1 : s.x + (s.w ?? 1) + 1, y: topAt(from, baseX) ?? f.at[1], host: from.id, face: 'top', x0: null, x1: null, w: null }), strength: 1.0 }], reason_key: 'repair.spring_added', reason_args: {} });
  return out;
}

function bonkGens(w: Work, f: Failure): Cand[] {
  const o = rootOf(w, f.toObj);
  if (!o) return [];
  const out: Cand[] = [];
  if (o.role === 'platform' && o.collision === 'solid') out.push({ ops: [{ op: 'set_collision', target: o.id, mode: 'one_way' }], reason_key: 'repair.bonk_oneway', reason_args: {} });
  const b = objBBox(o);
  const side = Math.abs(b[0] - f.at[0]) < Math.abs(b[2] - f.at[0]) ? 'left' : 'right';
  if (o.shape.k === 'surface') for (const k of [1, 2]) out.push({ ops: [{ op: 'trim', target: o.id, side, cells: k }], reason_key: 'repair.trimmed', reason_args: { cells: k } });
  for (const k of [1, 2]) out.push({ ops: [{ op: 'nudge', group: o.id, dx: 0, dy: -k }], reason_key: 'repair.nudged', reason_args: { cells: k } });
  return out;
}

function goalGens(w: Work, f: Failure, rep: (o: SceneObject) => boolean): Cand[] {
  const goal = w.objs.find((o) => o.role === 'goal' && !o.rel.part_of);
  if (!goal) return [];
  const out: Cand[] = [];
  const host = obj(w, goal.rel.rests_on) ?? floorBelow(w, (objBBox(goal)[0] + objBBox(goal)[2]) / 2, objBBox(goal)[3] - 0.25, 6)?.o;
  if (host && rep(host)) {
    const dir = f.at[0] < objBBox(host)[0] ? -1 : 1; // move toward the frontier
    for (let dx = 1; dx <= 3; dx++) for (let dy = 0; dy <= 3 - dx; dy++) out.push({ ops: [{ op: 'nudge', group: host.id, dx: dir * dx, dy }], reason_key: 'repair.nudged', reason_args: { cells: dx + dy } });
    const ext = dir < 0 ? 'left' : 'right';
    for (let k = 1; k <= 3; k++) out.push({ ops: [{ op: 'extend', target: host.id, side: ext, cells: k }], reason_key: 'repair.extended', reason_args: { cells: k } });
  }
  return out;
}

function startGens(w: Work): Cand[] {
  // N7 on the next-lowest standable surfaces
  const out: Cand[] = [];
  const comp = compileWork(w);
  const g = comp.grid;
  const seen = new Set<string>();
  for (let c = 1; c < Math.min(g.w, 48) && out.length < 6; c++) {
    for (let r = g.h - 1; r >= 2; r--) {
      if (!g.standable(c, r)) continue;
      const o = floorBelow(w, c + 0.5, r - 0.25, 0.6)?.o;
      if (!o || seen.has(o.id) || o.role === 'ceiling') break;
      seen.add(o.id);
      out.push({ ops: [{ op: 'place_start', at: [c + 0.5, r], x_repair: true } as EditOp], reason_key: 'norm.start_placed', reason_args: {} });
      break;
    }
  }
  return out;
}

function flagGens(w: Work, f: Failure, rep: (o: SceneObject) => boolean): Cand[] {
  const out: Cand[] = [];
  const o = rootOf(w, f.toObj) ?? (f.flag?.at ? surfaceAt(w, [f.flag.at[0], f.flag.at[1]]) : undefined);
  if (f.flag?.code === 'spawn_unsafe') return out;
  if (!o) return out;
  if (o.shape.k === 'surface') for (const side of ['left', 'right'] as const) for (let k = 1; k <= 3; k++) out.push({ ops: [{ op: 'extend', target: o.id, side, cells: k }], reason_key: 'repair.extended', reason_args: { cells: k } });
  if (rep(o) && f.flag?.at) {
    const b = objBBox(o);
    const dir = f.flag.at[0] < b[0] ? -1 : 1;
    for (let k = 1; k <= 2; k++) out.push({ ops: [{ op: 'nudge', group: o.id, dx: -dir * k, dy: 0 }], reason_key: 'repair.nudged', reason_args: { cells: k } });
  }
  return out;
}

/** Analyses per round and per search (deterministic caps that keep a build inside its RPC budget). */
const PER_ROUND = 10;
const TOTAL = 24;
/** Local windowed re-solves per round: cheap, so more candidates are screened before a whole-level analysis. */
const LOCAL_PER_ROUND = 24;

/** A drawn hazard right after the frontier (spikes or lava too long to clear): a step over it, or a spring before it. */
function hazardRunGens(w: Work, f: Failure): Cand[] {
  const out: Cand[] = [];
  const [ax, ay] = f.at;
  const dir = f.to && f.to[0] < ax ? -1 : 1;
  const hz = w.objs.filter((o) => (o.role === 'spikes' || o.role === 'lava') && !o.rel.part_of).map((o) => ({ o, b: objBBox(o) }))
    .filter(({ b }) => Math.abs((dir > 0 ? b[0] : b[2]) - ax) <= 4 && b[3] >= ay - 1.5 && b[1] <= ay + 1)
    .sort((p, q) => Math.abs(p.b[0] - ax) - Math.abs(q.b[0] - ax));
  const h = hz[0];
  if (!h) return out;
  const mid = (h.b[0] + h.b[2]) / 2;
  const floor = floorBelow(w, ax, ay - 0.25, 1)?.o;
  for (const sw of [2, 3]) out.push({ ops: [{ op: 'add_step', slot: slotId({ kind: 'step', x: mid, y: Math.round(ay - 2), host: null, face: null, x0: null, x1: null, w: sw }), w: sw }], reason_key: 'repair.step_added', reason_args: {} });
  if (floor) {
    const sx = dir > 0 ? h.b[0] - 1 : h.b[2] + 1;
    out.push({ ops: [{ op: 'add_spring', slot: slotId({ kind: 'spring', x: sx, y: topAt(floor, sx) ?? ay, host: floor.id, face: 'top', x0: null, x1: null, w: null }), strength: 1.0 }], reason_key: 'repair.spring_added', reason_args: {} });
  }
  return out;
}

function gensFor(f: Failure, w: Work, level: ReturnType<typeof lightLevel>, movable: (o: SceneObject) => boolean, profile: Parameters<typeof gMax>[0]): Cand[] {
  const hmaxRun = hMax(profile, profile.run_max ? 'run' : 'walk');
  switch (f.kind) {
    case 'gap_too_wide':
      return gapGens(w, f, movable, profile);
    case 'ledge_too_high':
      return ledgeGens(w, f, movable, hmaxRun);
    case 'head_bonk':
      return bonkGens(w, f);
    case 'wall_too_tall':
      return wallGens(w, f, hmaxRun);
    case 'goal_unreachable':
      return [...goalGens(w, f, movable), ...gapGens(w, f, movable, profile), ...ledgeGens(w, f, movable, hmaxRun)];
    case 'spawn_trapped':
      return startGens(w);
    case 'key_unreachable':
      return [...gapGens(w, f, movable, profile), ...ledgeGens(w, f, movable, hmaxRun)];
    case 'hard_flag':
      return flagGens(w, f, movable);
  }
  void level;
  return [];
}

export interface RepairOut {
  applied: string[];
  report: PlaytestReport;
  approx: boolean;
  warnings: MessageRef[];
}

/** Run the repair search on the runner's work (mutates it and appends R records). */
export function repairSearch(R: Runner, a: AssembleInput, report0: PlaytestReport, approx0: boolean, o: { stage: Stage; maxChain: number; exclude: ReadonlySet<string> }): RepairOut {
  let report = report0;
  let approx = approx0;
  const applied: string[] = [];
  const warnings: MessageRef[] = [];
  const profile = R.ctx.profile;
  const baseFlags = hardFlags(report0);
  const budget = { n: 0 };
  // a repair may move kid terrain but never a ground spanning the screen (nudging the floor would carry the world)
  const movable = (x: SceneObject): boolean => !(x.role === 'ground' && objBBox(x)[2] - objBBox(x)[0] > 24) && !isDynamic(x) && (isFloor(x) || x.shape.k === 'wall' || x.role === 'goal');
  for (let round = 1; round <= REPAIR.max_rounds && applied.length < o.maxChain; round++) {
    const failing = !report.solvable || hardFlags(report).some((f) => f.code !== 'unsolvable' && f.severity === 'hard');
    if (!failing) break;
    const level = lightLevel(a, compileWork(R.w), R.w);
    const f = classifyFailure(level, report, R.w, profile, baseFlags);
    if (!f) break;
    let cands: Cand[] = [...gensFor(f, R.w, level, movable, profile), ...(f.kind !== 'hard_flag' && f.kind !== 'spawn_trapped' ? hazardRunGens(R.w, f) : [])];
    // the bot's diagnosis and the drawing disagree (or nothing fits it): re-classify from the geometry
    if (cands.length < 2 && !report.solvable && report.frontier?.blocking) {
      const g = classifyFailure(level, { ...report, frontier: { reached: report.frontier.reached ?? [], blocking: null } }, R.w, profile, baseFlags);
      if (g && (g.kind !== f.kind || g.toObj !== f.toObj)) cands.push(...gensFor(g, R.w, level, movable, profile), ...hazardRunGens(R.w, g));
    }
    cands = cands.filter((c) => c.ops.every((op) => !o.exclude.has(editId(op)))).slice(0, REPAIR.max_candidates);
    if (!cands.length) {
      if (f.kind === 'gap_too_wide') warnings.push({ key: 'repair.failed', args: { gap: Math.round(f.need), max: 3 } });
      break;
    }
    // price every candidate in a sandbox (cheap: geometry only), then measure in cost order
    const priced: { c: Cand; cost: number; x: number; w: Work }[] = [];
    for (const c of cands) {
      const sb = new Runner(cloneWork(R.w), R.ctx, [], R.base);
      let cost = 0;
      let ok = true;
      for (const op of c.ops) {
        const r = sb.run(op, { by: 'auto', stage: o.stage, tier: 'faithful' });
        if (!r || r.rec.status !== 'applied') {
          ok = false;
          break;
        }
        cost += r.cost;
      }
      if (!ok) continue;
      const first = c.ops[0];
      const tgt = 'group' in first ? first.group : 'target' in first ? first.target : '';
      priced.push({ c, cost, x: typeof tgt === 'string' ? (obj(R.w, tgt) ? objBBox(obj(R.w, tgt)!)[0] : 0) : 0, w: sb.w });
    }
    priced.sort((p, q) => p.cost - q.cost || p.x - q.x || editId(p.c.ops[0]).localeCompare(editId(q.c.ops[0])));
    const evals: Evaluated[] = [];
    const curScore = frontierScore(report);
    let fixes = 0;
    // an unsolvable blocker with a known target is screened locally first: only candidates that get the player past
    // it (or that the local search cannot decide) pay for a whole-level analysis; timed blockers skip the screen
    const target = !report.solvable && f.to && f.kind !== 'spawn_trapped' && f.kind !== 'hard_flag' && !approx ? f.to : null;
    let queue = priced.slice(0, PER_ROUND);
    if (target) {
      const pass = priced.slice(0, LOCAL_PER_ROUND).filter((p) => {
        const lr = localReach(lightLevel(a, compileWork(p.w), p.w), [f.at[0], f.at[1]], target[0] + (target[0] >= f.at[0] ? 0.5 : -0.5));
        return lr.passed || lr.goal || lr.approx;
      });
      // nothing gets past locally: the local check may be wrong (timing), so fall back to the cheapest candidates
      if (pass.length) queue = pass.slice(0, PER_ROUND);
    }
    for (const p of queue) {
      if (budget.n >= TOTAL) break;
      budget.n++;
      const lv = lightLevel(a, compileWork(p.w), p.w);
      const rr = analyzeSafe(lv, 'fast', profile);
      const fixed = rr.report.solvable && (report.solvable ? hardFlags(rr.report).length < hardFlags(report).length : true);
      const gain = frontierScore(rr.report) - curScore;
      evals.push({ c: p.c, cost: p.cost, report: rr.report, fixed, gain, x: p.x });
      approx = rr.approx;
      if (fixed && ++fixes >= 1 + REPAIR.alts_kept) break;
    }
    const fixing = evals.filter((e) => e.fixed);
    let chosen: Evaluated | undefined = fixing[0];
    if (!chosen) {
      const adv = evals.filter((e) => e.gain > 0).sort((p, q) => q.gain / Math.max(0.25, q.cost) - p.gain / Math.max(0.25, p.cost) || p.cost - q.cost);
      chosen = adv[0];
    }
    if (!chosen) {
      if (f.kind === 'gap_too_wide') warnings.push({ key: 'repair.failed', args: { gap: Math.round(f.need), max: 3 } });
      break;
    }
    const ids: string[] = [];
    for (const op of chosen.c.ops) {
      const r = R.run(op, { by: 'auto', stage: o.stage, tier: 'faithful', cls: op.op === 'place_start' || op.op === 'set_collision' ? 'N' : 'R', required: true, group: 'repair', reason_key: chosen.c.reason_key, reason_args: chosen.c.reason_args, depends_on: applied.slice(-1) });
      if (r && r.rec.status === 'applied') ids.push(r.rec.id);
    }
    if (!ids.length) break;
    applied.push(...ids);
    if (fixing.length > 1 || chosen.fixed) {
      R.w.st.repair_alts.push({
        group: `alts.${f.kind}.${f.toObj ?? 'x'}`, kind: f.kind, chosen: ids,
        options: (fixing.length ? fixing : [chosen]).slice(0, 1 + REPAIR.alts_kept).map((e) => ({ cid: editId(e.c.ops[0]), ops: e.c.ops, cost: e.cost })),
      });
    }
    report = chosen.report;
  }
  return { applied, report, approx, warnings };
}
