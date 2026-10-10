/**
 * The playtest bot (lane A, §4.1-4.3): analyze(level) plays the level in the real Sim and returns the
 * PlaytestReport — reachability, the min-expected-deaths route with engine-exact windows, segments split at
 * checkpoints, the difficulty model (C, F, score, band, casual clear time, par), designer-grade flags, the slots
 * the designer may fill, the frontier of an unsolvable level, and the bot's input trace (a replayable run).
 *
 * Modes: 'fast' (reachability + route, best-first toward the goal, estimated windows) and 'full' (exhaustive
 * exploration within a deterministic frame budget, measured windows, softlock / dead-end / unreachable flags).
 *
 * The level's game rules (level.rules, the resolved per-game snapshot) drive everything: the physics profile, the
 * abilities the bot may use (run, double jump, stomp, fast fall), hearts (soft failures cost a heart before a life;
 * see difficulty/model.ts) and lives (game-over restarts in casual_clear_s). The frontier quotes the reach of those
 * rules ("You can jump 6" with double jump; no run-up advice when running is off).
 */
import { levelHash } from '../build/hash.ts';
import { UNBOUNDED_F, deathProbHearts, levelStats, parMs, segmentStats, sigmaOf } from '../difficulty/model.ts';
import type { SegmentInput, SegmentStats } from '../difficulty/model.ts';
import { inputsToTrace } from '../replay/verify.ts';
import { SimCore, clockMs } from '../sim/core.ts';
import type { SimState } from '../sim/core.ts';
import { CELL } from '../sim/tiles.ts';
import { firebarReach } from '../sim/world.ts';
import type { DEnemy, DFirebar, DSaw, DSpikes } from '../sim/world.ts';
import type { Flag, LevelV2, PlaytestReport, RouteKind, RouteStep, Segment, Tier } from '../types.gen.ts';
import { CORE_VERSION } from '../util/version.ts';
import { cellsXY, objectBox, r2 } from './context.ts';
import type { Ctx, RStep } from './context.ts';
import { A_JUMP, A_WALK, EV_BONK, Explorer, GOAL, act } from './explore.ts';
import type { BEdge } from './explore.ts';
import { computeFlags } from './flags.ts';
import { diagnose, reachedCells } from './frontier.ts';
import { Measurer } from './measure.ts';
import type { StepWindows } from './measure.ts';
import { forward, frameCost, pathTo, reachableFrom, routeCost, toGoal } from './route.ts';
import { computeSlots, emptySlots } from './slots.ts';

export { freeFlight, gMaxTable, jumpArcs, measureEnvelope, measureJump, reachFor, template } from './envelope.ts';
export type { EnvelopeTable, Flight, JumpArc, Reach, ReachAbilities } from './envelope.ts';

export interface AnalyzeOptions {
  mode: 'fast' | 'full';
  profile?: 'casual' | 'skilled';
  segments?: string[];
  legacy_measure?: boolean;
  /** Tier the level was built for (flag severities); defaults to level.design.tier, else faithful. */
  tier?: Tier;
  /** Simulated-frame budget multiplier (1 = default). */
  budget?: number;
}

/** Deterministic simulated-frame budgets per screen (the bot has no clock; §4.1 budgets are met by bounding work). */
export const BOT_BUDGET = { fast_per_screen: 200_000, full_per_screen: 400_000, measure_per_screen: 200_000 } as const;

const DROP_KINDS = new Set<RouteKind>(['drop', 'dropthrough']);

function frameMs(f: number): number {
  return clockMs(f);
}

function baseReport(level: LevelV2): PlaytestReport {
  let hash = '';
  try {
    hash = levelHash(level);
  } catch {
    hash = '';
  }
  return {
    solvable: false, reason: null, frontier: null, route: [], segments: [], C: 0, F: 0, score: 0, band: 'trivial', C_skilled: 0,
    fastest_ms: 0, par_ms: 0, casual_clear_s: 0, flags: [], reachable: [], setpiece_order: [], slots: emptySlots(),
    engaged_enemies: 0, actions_per_screen: 0, trace: [], level_hash: hash, core_version: CORE_VERSION, approx: false,
  };
}

function buildSteps(ex: Explorer, path: BEdge[]): RStep[] {
  const steps: RStep[] = [];
  const blank = (): StepWindows => ({ w: UNBOUNDED_F, h: UNBOUNDED_F, phi: null, L: 0, Ls: 0, v: 0, measured: false });
  for (const e of path) {
    const from = ex.nodes[e.from];
    let kind: RouteKind = e.kind;
    if (kind === 'walk' && from.timed) kind = 'timed_pass';
    const prev = steps[steps.length - 1];
    const mergeable = (kind === 'walk' || kind === 'wait' || kind === 'ride') && prev && prev.kind === kind;
    if (mergeable) {
      prev.edges.push(e);
      prev.to = e.to;
      prev.frames += e.frames;
      continue;
    }
    const required = !(kind === 'walk' || kind === 'wait' || kind === 'ride');
    steps.push({
      i: steps.length, kind, edges: [e], from: e.from, to: e.to, frames: e.frames, required, win: blank(), pc: 0, ps: 0, seg: 0,
      startF: 0, endF: 0, pressF: -1, leaveF: -1, camX: null, takeoff: [e.takeoffX, e.takeoffY], land: [e.landX, e.landY],
      apexY: Number.isFinite(e.apexY) ? e.apexY : e.takeoffY, bonk: false, cps: [], path: [], setpiece: null, blind: false,
    });
  }
  return steps;
}

interface TraceResult {
  inputs: number[];
  ok: boolean;
  entMin: Float64Array;
  entFirstF: Float64Array;
  stomped: Set<number>;
  objPath: [number, number, number][]; // feet samples with global frame
}

/** Replays the route with the camera on, phase-aligned at timed nodes; fills the per-step trace fields. */
function tracePass(ex: Explorer, steps: RStep[]): TraceResult {
  const sim = ex.sim;
  const W = sim.W;
  sim.camOff = false;
  const nDefs = W.defs.length;
  const entMin = new Float64Array(nDefs).fill(Infinity);
  const entFirstF = new Float64Array(nDefs).fill(Infinity);
  const stomped = new Set<number>();
  const inputs: number[] = [];
  const objPath: [number, number, number][] = [];
  const watch: number[] = [];
  for (let i = 0; i < nDefs; i++) {
    const k = W.defs[i].k;
    if (k === 'spikes' || k === 'enemy' || k === 'saw' || k === 'firebar') watch.push(i);
  }
  let cur: SimState = ex.nodes[ex.startNode].snap;
  let F = 0;
  let ok = true;
  for (const s of steps) {
    s.startF = F;
    let first = true;
    let wasGnd = true;
    for (const e of s.edges) {
      const node = ex.nodes[e.from];
      // phase alignment: wait in place until the state matches the node the edge was verified from
      if (node.timed) {
        sim.load(cur);
        let matched = ex.nodeKeyOf(sim.S).key === node.key;
        let waited = 0;
        const zeros: number[] = [];
        while (!matched && waited < Math.min(900, Math.ceil(node.period * 2) + 60)) {
          sim.tick(0);
          zeros.push(0);
          waited++;
          if (sim.S.p.mode !== 0) break;
          matched = ex.nodeKeyOf(sim.S).key === node.key;
        }
        if (matched && waited > 0) {
          cur = sim.snap();
          for (const z of zeros) inputs.push(z);
          F += waited;
        }
      }
      const F0 = F;
      const track = (sm: SimCore, f: number): void => {
        const P = sm.S.p;
        const g = F0 + f + 1;
        for (const ev of sm.ev) {
          if (ev.type === 'jump' && s.pressF < 0) {
            s.pressF = g;
            s.camX = sm.S.cam.x;
            s.takeoff = [P.x, P.y];
          }
          if (ev.type === 'stomp' && ev.id) {
            const idx = W.byId.get(ev.id);
            if (idx !== undefined) stomped.add(idx);
          }
        }
        if (P.gnd === 0 && wasGnd && s.leaveF < 0) {
          s.leaveF = g;
          if (s.camX === null && DROP_KINDS.has(s.kind)) s.camX = sm.S.cam.x;
        }
        wasGnd = P.gnd > 0;
        if (P.y < s.apexY) s.apexY = P.y;
        if ((f & 1) === 0) {
          s.path.push([P.x, P.y]);
          objPath.push([P.x, P.y, g]);
        }
        const bx0 = P.x - 6;
        const bx1 = P.x + 6;
        const by0 = P.y - 28;
        const by1 = P.y;
        for (const i of watch) {
          const d = W.defs[i];
          const st = sm.S.e[i];
          let x0: number;
          let y0: number;
          let x1: number;
          let y1: number;
          if (d.k === 'spikes') {
            const b = (d as DSpikes).band;
            x0 = b[0]; y0 = b[1]; x1 = b[2]; y1 = b[3];
          } else if (d.k === 'enemy') {
            if (st.on === 0) continue;
            const de = d as DEnemy;
            x0 = st.x - de.hw; x1 = st.x + de.hw; y0 = st.y - de.h; y1 = st.y;
          } else if (d.k === 'saw') {
            const r = (d as DSaw).rHit;
            x0 = st.x - r; x1 = st.x + r; y0 = st.y - r; y1 = st.y + r;
          } else {
            const fb = d as DFirebar;
            const r = firebarReach(fb.balls);
            x0 = fb.x - r; x1 = fb.x + r; y0 = fb.y - r; y1 = fb.y + r;
          }
          const dx = Math.max(x0 - bx1, bx0 - x1, 0);
          const dy = Math.max(y0 - by1, by0 - y1, 0);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < entMin[i]) entMin[i] = dist;
          if (dist <= 2 * CELL && g < entFirstF[i]) entFirstF[i] = g;
        }
      };
      // a merged walk is replayed as one continuous run (the cell-by-cell edges would inflate the time)
      let o = null as ReturnType<typeof ex.run> | null;
      if (s.kind === 'walk' && s.edges.length > 1 && first) {
        const last = s.edges[s.edges.length - 1];
        const tx = last.to >= 0 ? ex.nodes[last.to].x : last.landX;
        const dir = tx >= cur.p.x ? 1 : -1;
        const saveMin = entMin.slice();
        const savePath = s.path.length;
        const saveObj = objPath.length;
        const run = ex.run(cur, act(A_WALK, { dir, xt: last.to >= 0 ? tx : tx + dir * 4, speed: 2 }), true, track);
        const okRun = last.to === GOAL ? run.res === 'goal' : run.res === 'node' && !!run.snap && ex.surfOf(run.snap).surf === ex.nodes[last.to].surf;
        if (okRun) {
          o = run;
          if (o.inputs) for (const v of o.inputs) inputs.push(v);
          F += o.frames;
          s.takeoff = [cur.p.x, cur.p.y];
          s.land = [o.landX || (o.snap ? o.snap.p.x : tx), o.landY || (o.snap ? o.snap.p.y : cur.p.y)];
          for (const c of o.cps) if (!s.cps.includes(c)) s.cps.push(c);
          if (o.snap) cur = o.snap;
          first = false;
          break;
        }
        entMin.set(saveMin);
        s.path.length = savePath;
        objPath.length = saveObj;
      }
      o = ex.run(cur, e.act, true, track);
      if (o.inputs) for (const v of o.inputs) inputs.push(v);
      F += o.frames;
      if (first && e.act.t === A_JUMP && s.pressF < 0 && o.takeoffX) s.takeoff = [o.takeoffX, o.takeoffY];
      if (first && e.act.t !== A_JUMP) s.takeoff = [ex.nodes[e.from].x, ex.nodes[e.from].y];
      first = false;
      s.land = [o.landX || o.snap?.p.x || s.land[0], o.landY || o.snap?.p.y || s.land[1]];
      if (o.ev & EV_BONK) s.bonk = true;
      for (const c of o.cps) if (!s.cps.includes(c)) s.cps.push(c);
      let success = false;
      if (e.to === GOAL) success = o.res === 'goal';
      else if (o.res === 'node' && o.snap) success = ex.surfOf(o.snap).surf === ex.nodes[e.to].surf;
      if (!success) {
        ok = false;
        if (e.to >= 0) cur = ex.nodes[e.to].snap;
      } else if (o.snap) cur = o.snap;
    }
    s.endF = F;
    s.frames = F - s.startF;
    if (s.kind !== 'walk' && s.kind !== 'wait' && s.kind !== 'ride' && s.kind !== 'timed_pass' && s.camX !== null) {
      const lx = s.land[0] / CELL;
      s.blind = lx < s.camX + 0.5 || lx > s.camX + 47.5;
    }
  }
  sim.camOff = true;
  return { inputs, ok, entMin, entFirstF, stomped, objPath };
}

function unsolvableReport(level: LevelV2, ex: Explorer | null, rep: PlaytestReport, tier: Tier, mode: 'fast' | 'full', reasonOverride?: PlaytestReport['reason']): PlaytestReport {
  if (!ex) {
    rep.reason = reasonOverride ?? 'no_start';
    rep.flags.push({ id: 'unsolvable.0', code: 'unsolvable', severity: 'block', frame: null, at: null, object_ids: [], fix_cids: [], message_key: 'flag.unsolvable', args: { need: 'The level needs a start.' } });
    return rep;
  }
  const fr = diagnose(ex, level);
  rep.reason = reasonOverride ?? fr.reason;
  rep.frontier = fr.frontier;
  rep.reachable = reachedCells(ex, 4000).map(([x, y]) => `${x},${y}`);
  const b = fr.frontier.blocking;
  rep.flags.push({
    id: 'unsolvable.0', code: 'unsolvable', severity: 'block', frame: null, at: b?.from ?? null, object_ids: b ? [b.to_object] : [], fix_cids: [],
    message_key: 'flag.unsolvable', args: { need: frontierSentence(fr.message_key, fr.args, b?.need ?? ''), frontier_key: fr.message_key, kind: b?.kind ?? 'goal_unreachable', ...fr.args },
  });
  const ctx: Ctx = {
    level, sim: ex.sim, W: ex.sim.W, ex, tier, mode, steps: [], segs: [], routeNodes: new Set(), d2g: new Float64Array(ex.nodes.length + 1).fill(Infinity),
    reach: reachableFrom(ex, ex.startNode), C: 0, entMin: new Float64Array(ex.sim.W.defs.length).fill(Infinity),
    entFirstF: new Float64Array(ex.sim.W.defs.length).fill(Infinity), stomped: new Set(), traceOk: true,
  };
  for (const f of computeFlags(ctx)) if (f.code === 'entity_error' || f.code === 'spawn_unsafe') rep.flags.push(f);
  rep.slots = computeSlots(ctx, fr);
  rep.approx = ex.approx;
  return rep;
}

/** The English form of a frontier message (the UI uses message_key + args from messages.json). */
function frontierSentence(key: string, a: Record<string, string | number>, fallback: string): string {
  switch (key) {
    case 'frontier.needs_run_up': return `This jump is ${a.need} squares. A running jump does ${a.max}. You have ${a.have} squares of run-up.`;
    case 'frontier.too_far': return `This jump is ${a.need} squares. You can jump ${a.max}.`;
    case 'frontier.too_high': return `This ledge is ${a.need} rows up. You can jump ${a.max}.`;
    case 'frontier.too_tall': return `This wall is ${a.need} rows tall. You can jump ${a.max}.`;
    case 'frontier.head_bonk': return 'The ceiling stops this jump.';
    case 'frontier.key_unreachable': return 'Nobody can reach the key with the door shut.';
    case 'frontier.spawn_trapped': return 'You start in a spot with no way out.';
    case 'frontier.goal_unreachable': return fallback ? `Nobody can reach your flag yet: ${fallback}.` : 'Nobody can reach your flag yet.';
    default: return fallback;
  }
}

export interface LocalReach {
  /** A standing spot at or past `toX` (or the goal) was reached from `from`. */
  passed: boolean;
  /** Furthest standing x reached toward `toX` (cells). */
  reached_x: number;
  /** The level's goal itself was touched. */
  goal: boolean;
  /** The frame budget ran out before an answer (treat `passed: false` as unknown). */
  approx: boolean;
  frames: number;
}

/**
 * Windowed local re-solve (§4.1 "a local re-solve of ±1.5 screens inside the design loop"): can a player standing at
 * `from` (feet, cells) get to a standing spot at or past `toX`? Explores only within the window (from.x … toX plus
 * `margin_c`, default 1.5 screens of 48 cells on each side), best-first toward toX, in fast mode. Entity clocks start
 * at 0 at `from`, so this is a geometric check for repairs and candidates; the full analysis stays authoritative.
 */
export function localReach(level: LevelV2, from: [number, number], toX: number, o?: { margin_c?: number; budget?: number }): LocalReach {
  const out: LocalReach = { passed: false, reached_x: from[0], goal: false, approx: false, frames: 0 };
  let sim: SimCore;
  try {
    sim = new SimCore(level, { seed: 1, startAt: from });
  } catch {
    return out;
  }
  const dir: 1 | -1 = toX >= from[0] ? 1 : -1;
  const margin = (o?.margin_c ?? 72) * CELL;
  const lo = Math.min(from[0], toX) * CELL - margin;
  const hi = Math.max(from[0], toX) * CELL + margin;
  const cells = Math.max(1, (hi - lo) / CELL);
  const mult = typeof o?.budget === 'number' && o.budget > 0 ? o.budget : 1;
  const budget = Math.round(BOT_BUDGET.fast_per_screen * (cells / 48) * mult);
  const ex = new Explorer(sim, {
    mode: 'fast', legacy: false, sigma: sigmaOf('casual'), budget, stopAtGoal: true, targetX: toX * CELL, targetDir: dir, bounds: [lo, hi],
  });
  ex.explore();
  out.frames = ex.frames;
  out.approx = ex.approx;
  let best = from[0] * CELL;
  for (const n of ex.nodes) if (dir * (n.x - best) > 0) best = n.x;
  out.reached_x = r2(best / CELL);
  out.goal = ex.edges.some((e) => e.to === GOAL);
  out.passed = ex.targetNode >= 0 || out.goal;
  return out;
}

export function analyze(level: LevelV2, o: AnalyzeOptions): PlaytestReport {
  const mode: 'fast' | 'full' = o?.mode === 'full' ? 'full' : 'fast';
  const profile = o?.profile === 'skilled' ? 'skilled' : 'casual';
  const legacy = !!o?.legacy_measure;
  const tier: Tier = o?.tier ?? level?.design?.tier ?? 'faithful';
  const rep = baseReport(level);
  let sim: SimCore;
  try {
    sim = new SimCore(level, { seed: 1 });
  } catch (err) {
    rep.reason = 'no_start';
    rep.flags.push({ id: 'entity_error.0', code: 'entity_error', severity: 'block', frame: null, at: null, object_ids: [], fix_cids: [], message_key: 'flag.entity_error', args: { what: err instanceof Error ? err.message : String(err) } });
    return rep;
  }
  const W = sim.W;
  const screens = Math.max(1, Math.round(W.wPx / (48 * CELL)));
  const mult = typeof o?.budget === 'number' && o.budget > 0 ? o.budget : 1;
  const budget = (mode === 'full' ? BOT_BUDGET.full_per_screen : BOT_BUDGET.fast_per_screen) * screens * mult;
  const sigmaC = sigmaOf('casual');
  const sigmaS = sigmaOf('skilled');
  if (!W.start.id) return unsolvableReport(level, null, rep, tier, mode, 'no_start');
  let ex = new Explorer(sim, { mode, legacy, sigma: sigmaC, budget, stopAtGoal: mode === 'fast' });
  ex.explore();
  if (ex.startNode < 0) return unsolvableReport(level, ex, rep, tier, mode);
  if (!W.goals.length) return unsolvableReport(level, ex, rep, tier, mode, 'no_goal');
  if (mode === 'fast' && !ex.goalFound && ex.approx) {
    // the greedy search ran out of budget: one exhaustive pass (full action set, BFS) before calling it unsolvable
    const ex2 = new Explorer(new SimCore(level, { seed: 1 }), {
      mode: 'full', legacy, sigma: sigmaC, budget: BOT_BUDGET.full_per_screen * screens * mult, stopAtGoal: true,
    });
    ex2.explore();
    if (ex2.goalFound) {
      ex = ex2;
      sim = ex2.sim;
    }
  }
  const N = ex.nodes.length;
  const d2g = toGoal(ex, routeCost);
  const fwd = forward(ex, ex.startNode, routeCost);
  const path = pathTo(ex, fwd, GOAL);
  if (!path.length) return unsolvableReport(level, ex, rep, tier, mode);
  const fastP = forward(ex, ex.startNode, frameCost);
  const fastPath = Number.isFinite(fastP.dist[N]) ? pathTo(ex, fastP, GOAL) : path;
  const reach = reachableFrom(ex, ex.startNode);
  // cost-to-goal per (surface, key/door state) for window success tests
  const surfCost = new Map<string, number>();
  for (const n of ex.nodes) {
    if (!Number.isFinite(d2g[n.i])) continue;
    const k = `${n.surf}|${n.key.split('|')[1] ?? ''}`;
    const prev = surfCost.get(k);
    if (prev === undefined || d2g[n.i] < prev) surfCost.set(k, d2g[n.i]);
  }
  const steps = buildSteps(ex, path);
  const routeNodes = new Set<number>();
  routeNodes.add(ex.startNode);
  for (const e of path) if (e.to >= 0) routeNodes.add(e.to);
  const tr = tracePass(ex, steps);
  // bot fastest: the frame-cheapest path, replayed with continuous runs
  let fastestF = tr.inputs.length;
  {
    const ft = fastPath === path ? tr : tracePass(ex, buildSteps(ex, fastPath));
    if (ft.ok && ft.inputs.length > 0) fastestF = Math.min(fastestF, ft.inputs.length);
  }
  // windows: measured (full) or estimated (fast)
  const meas = new Measurer(ex, surfCost, ex.frames + BOT_BUDGET.measure_per_screen * screens * mult, legacy);
  // segments: split after each step that activated a checkpoint
  let seg = 0;
  const segEnds: (number | null)[] = [];
  for (const s of steps) {
    s.seg = seg;
    if (s.cps.length) {
      segEnds[seg] = s.cps[s.cps.length - 1];
      seg++;
    }
  }
  const nSeg = steps.length && steps[steps.length - 1].seg < seg ? seg : seg + 1;
  const segIds = Array.from({ length: Math.max(1, nSeg) }, (_, k) => `seg${k}`);
  const wanted = o?.segments && o.segments.length ? new Set(o.segments) : null;
  for (const s of steps) {
    const e0 = s.edges[0];
    if (!s.required) continue;
    const doMeasure = mode === 'full' && (!wanted || wanted.has(segIds[s.seg]));
    s.win = doMeasure ? meas.measure(ex.nodes[e0.from], e0) : meas.quick(ex.nodes[e0.from], e0);
    s.pc = deathProbHearts(s.win, sigmaC, W.hearts);
    s.ps = deathProbHearts(s.win, sigmaS, W.hearts);
  }
  // difficulty model
  const goalId = W.defs[W.goals[0]].id;
  const startId = W.start.id ?? 'start';
  const segInputs: SegmentInput[] = segIds.map((id, k) => ({
    id,
    from: k === 0 ? startId : W.defs[segEnds[k - 1] as number]?.id ?? `seg${k - 1}`,
    to: segEnds[k] !== undefined && segEnds[k] !== null ? W.defs[segEnds[k] as number].id : goalId,
    T_ms: 0,
    actions: [],
  }));
  for (const s of steps) {
    const si = segInputs[Math.min(s.seg, segInputs.length - 1)];
    si.T_ms += frameMs(s.frames);
    if (s.required) si.actions.push(s.win);
  }
  // hearts are carried action to action inside a segment (a respawn refills them); lives add game-over restarts
  const segsC: SegmentStats[] = segInputs.map((s) => segmentStats(s, sigmaC, W.hearts));
  const segsS: SegmentStats[] = segInputs.map((s) => segmentStats(s, sigmaS, W.hearts));
  {
    const next = new Array<number>(segInputs.length).fill(0);
    for (const s of steps) {
      if (!s.required) continue;
      const k = Math.min(s.seg, segInputs.length - 1);
      const j = next[k]++;
      const dc = segsC[k].d?.[j];
      const ds = segsS[k].d?.[j];
      if (typeof dc === 'number') s.pc = dc;
      if (typeof ds === 'number') s.ps = ds;
    }
  }
  const lc = levelStats(segsC, { lives: W.lives });
  const ls = levelStats(segsS, { lives: W.lives });
  const main = profile === 'skilled' ? ls : lc;
  const mainSegs = profile === 'skilled' ? segsS : segsC;
  // setpieces met by the route, in order
  const spFirst: { name: string; f: number }[] = [];
  for (const sp of level.setpieces ?? []) {
    let f = Infinity;
    for (const id of sp.ids) {
      const di = W.byId.get(id);
      if (di !== undefined) f = Math.min(f, tr.entFirstF[di]);
      const ob = (level.objects ?? []).find((x) => x.id === id);
      const box = ob ? objectBox(ob) : null;
      if (box) {
        for (const [x, y, g] of tr.objPath) {
          if (g >= f) break;
          const cx = x / CELL;
          const cy = y / CELL;
          if (cx >= box[0] - 2 && cx <= box[2] + 2 && cy - 1.75 <= box[3] + 2 && cy >= box[1] - 2) {
            f = g;
            break;
          }
        }
      }
    }
    if (Number.isFinite(f)) spFirst.push({ name: sp.name, f });
  }
  spFirst.sort((a, b) => a.f - b.f || (a.name < b.name ? -1 : 1));
  for (const sp of spFirst) {
    const st = steps.find((s) => sp.f >= s.startF && sp.f <= s.endF);
    if (st && !st.setpiece) st.setpiece = sp.name;
  }
  const ctx: Ctx = {
    level, sim, W, ex, tier, mode, steps, segs: mainSegs, routeNodes, d2g, reach, C: main.C, entMin: tr.entMin, entFirstF: tr.entFirstF,
    stomped: tr.stomped, traceOk: tr.ok,
  };
  const flags: Flag[] = computeFlags(ctx);
  const slots = computeSlots(ctx, null);
  // report
  const route: RouteStep[] = steps.map((s) => ({
    i: s.i, kind: s.kind, from: cellsXY(s.takeoff[0], s.takeoff[1]), to: cellsXY(s.land[0], s.land[1]), frames: s.frames,
    w_f: r2(Math.min(UNBOUNDED_F, s.win.w)), h_f: r2(Math.min(UNBOUNDED_F, s.win.h)), phi_f: s.win.phi === null ? null : r2(Math.min(UNBOUNDED_F, s.win.phi)),
    lethal: r2(s.win.L), p_death_casual: Math.round(s.pc * 10000) / 10000, p_death_skilled: Math.round(s.ps * 10000) / 10000,
    blind: s.blind, segment: segIds[Math.min(s.seg, segIds.length - 1)], setpiece: s.setpiece,
  }));
  const segments: Segment[] = mainSegs.map((s) => ({
    id: s.id, from: s.from, to: s.to, E: Math.round(s.E * 10000) / 10000, A: Math.round(s.A * 10000) / 10000, T_ms: Math.round(s.T_ms),
    F_s: r2(s.F_s), actions: s.actions,
  }));
  // reach halo keys: "x,y" feet positions in cells, de-duplicated per 4 px (F-2)
  const reachable: string[] = reachedCells(ex, 20000, reach).map(([x, y]) => `${x},${y}`);
  let engaged = 0;
  for (const i of W.enemies) if (tr.stomped.has(i) || tr.entMin[i] <= 2 * CELL) engaged++;
  const required = steps.filter((s) => s.required).length;
  const fastest_ms = frameMs(Math.round(fastestF));
  rep.solvable = true;
  rep.reason = null;
  rep.route = route;
  rep.segments = segments;
  rep.C = Math.round(main.C * 10000) / 10000;
  rep.F = r2(main.F);
  rep.score = main.score;
  rep.band = main.band;
  rep.C_skilled = Math.round(ls.C * 10000) / 10000;
  rep.fastest_ms = fastest_ms;
  rep.par_ms = parMs(fastest_ms);
  rep.casual_clear_s = r2(lc.casual_clear_s);
  rep.flags = flags;
  rep.reachable = reachable;
  rep.setpiece_order = spFirst.map((s) => s.name);
  rep.slots = slots;
  rep.engaged_enemies = engaged;
  rep.actions_per_screen = r2(required / screens);
  // the trace replays from frame 0 (verifyRun, the bot ghost): the spawn's settle inputs come first
  rep.trace = inputsToTrace(ex.startInputs.length ? [...ex.startInputs, ...tr.inputs] : tr.inputs);
  rep.approx = ex.approx || !tr.ok;
  return rep;
}
