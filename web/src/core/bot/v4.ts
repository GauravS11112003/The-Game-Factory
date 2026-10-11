/**
 * v4 playtest reports (docs/v4/CONTRACTS_V4.md §1.4) for levels the standing-node explorer cannot judge: the
 * macro-action search (search4.ts) plays them, the found run is replayed in a fresh Sim to confirm the win, and the
 * report is built from that run. `solvable` is only ever true for a confirmed win. These reports are approximate
 * (`approx: true`): the route is the run as played (walks and jumps split at jump presses), windows are not measured,
 * so the difficulty numbers are rough; flags carry entity errors and, when unsolved, the unsolvable block.
 */
import { UNBOUNDED_F, levelStats, parMs, segmentStats, sigmaOf } from '../difficulty/model.ts';
import type { SegmentInput } from '../difficulty/model.ts';
import { inputsToTrace } from '../replay/verify.ts';
import { simulateInputs } from '../replay/run.ts';
import { SimCore, clockMs } from '../sim/core.ts';
import { CELL } from '../sim/tiles.ts';
import type { SimWorld } from '../sim/world.ts';
import type { Flag, LevelV2, PlaytestReport, RouteKind, RouteStep } from '../types.gen.ts';
import { cellsXY, r2 } from './context.ts';
import { macroSearch } from './search4.ts';
import type { SearchResult } from './search4.ts';
import { emptySlots } from './slots.ts';

/** Does the level need the macro search (a mode, a rule key, or a gravity flip the explorer cannot play)? */
export function needsSearch(W: SimWorld): boolean {
  return W.mode !== 'platformer' || W.usesKeys.length > 0 || W.flips;
}

/** Some rule wins the level (a level may then have no goal flag). */
export function hasWinRule(W: SimWorld): boolean {
  return W.rules.some((r) => r.then.some((a) => a.a.kind === 'win'));
}

function errorFlags(W: SimWorld): Flag[] {
  return W.errors.map((er, n) => ({
    id: `entity_error.${n}`, code: 'entity_error', severity: 'warn', frame: null, at: null, object_ids: [er.id], fix_cids: [],
    message_key: 'flag.entity_error', args: { what: er.message },
  }));
}

/** The route as played: walks and jumps split at jump presses (flaps count as jumps), segments at checkpoints. */
function routeOf(level: LevelV2, inputs: number[]): { route: RouteStep[]; segs: SegmentInput[]; required: number } {
  const steps: { kind: RouteKind; from: [number, number]; to: [number, number]; f0: number; f1: number; seg: number }[] = [];
  const segEnds: string[] = [];
  let cur: (typeof steps)[number] | null = null;
  let seg = 0;
  const run = simulateInputs(level, inputs, {
    onTick: (sim, f) => {
      const P = sim.S.p;
      const at: [number, number] = [P.x, P.y];
      if (!cur) cur = { kind: 'walk', from: at, to: at, f0: 0, f1: 0, seg };
      let jumped = false;
      for (const ev of sim.ev) {
        if (ev.type === 'jump' || ev.type === 'double_jump') jumped = true;
        if (ev.type === 'checkpoint' && ev.id) {
          segEnds[seg] = ev.id;
          seg++;
        }
      }
      if (jumped) {
        cur.to = at;
        cur.f1 = f;
        steps.push(cur);
        cur = { kind: 'jump', from: at, to: at, f0: f, f1: f, seg };
      } else if (cur.kind === 'jump' && P.gnd > 0 && f > cur.f0 + 1) {
        cur.to = at;
        cur.f1 = f + 1;
        steps.push(cur);
        cur = { kind: 'walk', from: at, to: at, f0: f + 1, f1: f + 1, seg };
      } else {
        cur.to = at;
        cur.f1 = f + 1;
        cur.seg = Math.min(cur.seg, seg);
      }
    },
  });
  if (cur) steps.push(cur);
  const W = run.sim.W;
  const nSeg = seg + 1;
  const kept = steps.filter((s) => s.f1 > s.f0 || s.kind === 'jump');
  const route: RouteStep[] = kept.map((s, i) => ({
    i, kind: s.kind, from: cellsXY(s.from[0], s.from[1]), to: cellsXY(s.to[0], s.to[1]), frames: s.f1 - s.f0, w_f: UNBOUNDED_F, h_f: UNBOUNDED_F,
    phi_f: null, lethal: 0, p_death_casual: 0, p_death_skilled: 0, blind: false, segment: `seg${Math.min(s.seg, nSeg - 1)}`, setpiece: null,
  }));
  const startId = W.start.id ?? 'start';
  const goalId = W.goals.length ? W.defs[W.goals[0]].id : 'win';
  const segs: SegmentInput[] = Array.from({ length: nSeg }, (_, k) => ({
    id: `seg${k}`, from: k === 0 ? startId : segEnds[k - 1], to: k < segEnds.length ? segEnds[k] : goalId, T_ms: 0, actions: [],
  }));
  for (const s of kept) {
    const sg = segs[Math.min(s.seg, nSeg - 1)];
    sg.T_ms += clockMs(s.f1 - s.f0);
    if (s.kind === 'jump') sg.actions.push({ w: UNBOUNDED_F, h: UNBOUNDED_F, phi: null, L: 0, Ls: 0 });
  }
  return { route, segs, required: kept.filter((s) => s.kind === 'jump').length };
}

/**
 * The v4 search report. `rep` is the base report (hash, version); `budget` the simulated-frame budget; `pre` an earlier
 * search result to reuse.
 */
export function searchReport(level: LevelV2, rep: PlaytestReport, budget: number, pre: SearchResult | null = null): PlaytestReport {
  const sim = new SimCore(level, { seed: 1 });
  const W = sim.W;
  const r = pre ?? macroSearch(sim, budget);
  rep.approx = true;
  // confirm the run from frame 0 in a fresh Sim: the report claims only what the Sim did
  let inputs: number[] = [];
  if (r.solved) {
    const run = simulateInputs(level, r.inputs);
    if (run.sim.S.won === 1) inputs = r.inputs.slice(0, run.winFrame);
  }
  const reached = r.reached.slice(0, 4000).map(([x, y]) => `${r2(x)},${r2(y)}`);
  if (!inputs.length) {
    rep.solvable = false;
    rep.reason = W.goals.length || hasWinRule(W) ? 'goal_unreachable' : 'no_goal';
    rep.frontier = { reached: r.reached.slice(0, 600).map(([x, y]) => [r2(x), r2(y)] as [number, number]), blocking: null };
    rep.reachable = reached;
    rep.flags = [
      {
        id: 'unsolvable.0', code: 'unsolvable', severity: 'block', frame: null, at: null, object_ids: [], fix_cids: [], message_key: 'flag.unsolvable',
        args: { need: rep.reason === 'no_goal' ? 'The level needs a goal or a rule that wins.' : 'Nobody could win this level yet.', kind: 'goal_unreachable', approx: r.approx ? 1 : 0 },
      },
      ...errorFlags(W),
    ];
    rep.slots = emptySlots();
    return rep;
  }
  const { route, segs, required } = routeOf(level, inputs);
  const sc = sigmaOf('casual');
  const ss = sigmaOf('skilled');
  const segsC = segs.map((s) => segmentStats(s, sc, W.hearts));
  const segsS = segs.map((s) => segmentStats(s, ss, W.hearts));
  const lc = levelStats(segsC, { lives: W.lives });
  const ls = levelStats(segsS, { lives: W.lives });
  const screens = Math.max(1, Math.round(W.wPx / (48 * CELL)));
  const fastest = clockMs(inputs.length);
  rep.solvable = true;
  rep.reason = null;
  rep.route = route;
  rep.segments = segsC.map((s) => ({
    id: s.id, from: s.from, to: s.to, E: Math.round(s.E * 10000) / 10000, A: Math.round(s.A * 10000) / 10000, T_ms: Math.round(s.T_ms), F_s: r2(s.F_s),
    actions: s.actions,
  }));
  rep.C = Math.round(lc.C * 10000) / 10000;
  rep.F = r2(lc.F);
  rep.score = lc.score;
  rep.band = lc.band;
  rep.C_skilled = Math.round(ls.C * 10000) / 10000;
  rep.fastest_ms = fastest;
  rep.par_ms = parMs(fastest);
  rep.casual_clear_s = r2(lc.casual_clear_s);
  rep.flags = errorFlags(W);
  rep.reachable = reached;
  rep.slots = emptySlots();
  rep.actions_per_screen = r2(required / screens);
  rep.trace = inputsToTrace(inputs);
  return rep;
}
