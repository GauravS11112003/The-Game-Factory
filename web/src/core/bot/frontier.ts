/**
 * Why a level is unsolvable (§4.2 frontier, §4.3 `unsolvable`): the reached standing cells and the one blocking
 * jump the repair search should fix, classified by failure kind with the numbers a kid-facing card needs
 * ("This jump is 9 squares. A running jump does 8. You have 1 square of run-up.").
 */
import { CELL } from '../sim/tiles.ts';
import type { DGoal, DKey, DSpikes } from '../sim/world.ts';
import type { Blocking, CellXY, FailureKind, Frontier, LevelV2 } from '../types.gen.ts';
import type { Explorer } from './explore.ts';
import { reachFor } from './envelope.ts';
import { objectsIn, r2 } from './context.ts';

export interface FrontierResult {
  frontier: Frontier;
  reason: 'no_start' | 'no_goal' | 'goal_unreachable' | 'key_unreachable';
  /** Message for the card: key and args (messages.json frontier.*). */
  message_key: string;
  args: Record<string, string | number>;
  /** Where a step / spring would go (feet, px) and what kind of fix fits. */
  fixAt: { x: number; y: number; dir: number; kind: FailureKind } | null;
}

/**
 * Reached standing positions: feet x / y in cells, de-duplicated per 4 px (docs/v2/requests/F-2.md form 1).
 * `only` restricts to nodes flagged in a reachability mask.
 */
export function reachedCells(ex: Explorer, cap = 600, only?: Uint8Array): CellXY[] {
  const seen = new Set<string>();
  const out: CellXY[] = [];
  for (const n of ex.nodes) {
    if (only && !only[n.i]) continue;
    const qx = Math.round(n.x / 4);
    const qy = Math.round(n.y / 4);
    const k = `${qx},${qy}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([(qx * 4) / CELL, (qy * 4) / CELL]);
    if (out.length >= cap) break;
  }
  return out;
}

export function diagnose(ex: Explorer, level: LevelV2): FrontierResult {
  const W = ex.sim.W;
  const T = ex.sim.T;
  const reached = reachedCells(ex);
  if (ex.startNode < 0) {
    const at: CellXY = [r2(W.start.x / CELL), r2(W.start.y / CELL)];
    const blocking: Blocking = { from: at, to_object: W.start.id ?? 'start', kind: 'spawn_trapped', need: 'a safe place to stand at the start', have: ex.startFail?.cause ? `the start ${ex.startFail.cause === 'pit' ? 'falls into a pit' : 'is in danger'}` : 'no floor under the start' };
    return { frontier: { reached, blocking }, reason: W.start.id ? 'goal_unreachable' : 'no_start', message_key: 'frontier.spawn_trapped', args: {}, fixAt: null };
  }
  if (!W.goals.length) {
    return { frontier: { reached, blocking: null }, reason: 'no_goal', message_key: 'publish.needs_goal', args: {}, fixAt: null };
  }
  const g = W.defs[W.goals[0]] as DGoal;
  const gx = (g.box[0] + g.box[2]) / 2;
  const gy = g.box[3];
  // keys: a door between us and the goal whose key was never reached
  const keysNeverTouched = W.keys.filter((k) => !ex.touchedAll.has(k));
  const doorsClosed = W.doors.length > 0;
  // frontier node: the reached node closest to the goal (x first, then y)
  let best = ex.startNode;
  let bestD = Infinity;
  for (const n of ex.nodes) {
    const d = Math.abs(gx - n.x) + 0.25 * Math.abs(gy - n.y);
    if (d < bestD) {
      bestD = d;
      best = n.i;
    }
  }
  const F = ex.nodes[best];
  const start = ex.nodes[ex.startNode];
  const from: CellXY = [r2(F.x / CELL), r2(F.y / CELL)];
  if (keysNeverTouched.length && doorsClosed) {
    const k = W.defs[keysNeverTouched[0]] as DKey;
    const blocking: Blocking = { from, to_object: k.id, kind: 'key_unreachable', need: 'reach the key', have: 'the key is out of reach with the door shut' };
    return { frontier: { reached, blocking }, reason: 'key_unreachable', message_key: 'frontier.key_unreachable', args: {}, fixAt: { x: F.x, y: F.y, dir: Math.sign(k.x - F.x) || 1, kind: 'key_unreachable' } };
  }
  const startEdges = start.out.filter((ei) => ex.edges[ei].to >= 0 && ex.nodes[ex.edges[ei].to].surf !== start.surf).length;
  if (ex.nodes.every((n) => n.surf === start.surf) && startEdges === 0 && start.out.length === 0) {
    const blocking: Blocking = { from, to_object: W.start.id ?? 'start', kind: 'spawn_trapped', need: 'a way out of the start', have: 'no move leaves the start' };
    return { frontier: { reached, blocking }, reason: 'goal_unreachable', message_key: 'frontier.spawn_trapped', args: {}, fixAt: null };
  }
  const dir = gx >= F.x ? 1 : -1;
  // the surface run the frontier node stands on, and its end toward the goal
  let endCol = Math.floor(F.x / CELL);
  let farCol = endCol;
  if (F.surf[0] === 'S') {
    const comp = T.comps[Number(F.surf.slice(1))];
    endCol = dir > 0 ? comp.c1 : comp.c0;
    farCol = dir > 0 ? comp.c0 : comp.c1;
  }
  const feetRow = Math.round(F.y / CELL);
  // spikes lying on the run ahead (on its top face) end the run before them: the blocker is the jump over them
  let hazardFar = -1;
  if (F.surf[0] === 'S') {
    const fc = Math.floor(F.x / CELL);
    let near = -1;
    let far = -1;
    const strips = W.spikes
      .map((i) => W.defs[i] as DSpikes)
      .filter((d) => d.facing === 'up' && Math.abs(d.band[3] - F.y) <= 3)
      .map((d) => [Math.floor(d.band[0] / CELL), Math.floor((d.band[2] - 0.01) / CELL)] as [number, number])
      .filter(([a, b]) => (dir > 0 ? a > fc && a <= endCol : b < fc && b >= endCol))
      .sort((p, q) => (dir > 0 ? p[0] - q[0] : q[1] - p[1]));
    for (const [a, b] of strips) {
      if (near < 0) {
        near = dir > 0 ? a : b;
        far = dir > 0 ? b : a;
      } else if (dir > 0 ? a <= far + 2 : b >= far - 2) far = dir > 0 ? Math.max(far, b) : Math.min(far, a);
    }
    if (near >= 0) {
      endCol = near - dir;
      hazardFar = far;
    }
  }
  const runway = Math.max(0, Math.abs(endCol - farCol));
  // the reach of this game's rules: profile, running on/off, double jump on/off
  const reach = reachFor(W.profileId, W.ab);
  const table = reach.g_max;
  const gmax = table[Math.min(table.length - 1, runway)];
  const gmaxRun = reach.g_max_best;
  const apex = reach.apex_c;
  // a wall right after the end?
  const nextCol = endCol + dir;
  let wallH = 0;
  // the world edge is not a wall the kid drew; a hazard strip ahead is a gap, not a wall
  if (hazardFar < 0 && nextCol >= 0 && nextCol < T.w) for (let r = feetRow - 1; r >= 0 && T.blocksSide(nextCol, r); r--) wallH++;
  let kind: FailureKind = 'goal_unreachable';
  let need = '';
  let have = '';
  let key = 'frontier.goal_unreachable';
  let args: Record<string, string | number> = {};
  let toCol = nextCol;
  let toRow = feetRow;
  if (wallH > 0) {
    kind = 'wall_too_tall';
    need = `a wall at most ${Math.floor(apex)} rows tall`;
    have = `${wallH} rows`;
    key = 'frontier.too_tall';
    args = { need: wallH, max: Math.floor(apex) };
  } else {
    // the next floor beyond the gap (any height within reach of the eye); past a hazard strip: the floor after it
    let found = hazardFar >= 0 && hazardFar + dir >= 0 && hazardFar + dir < T.w ? hazardFar + dir : -1;
    for (let k = 1; k <= 18 && found < 0; k++) {
      const c = endCol + dir * k;
      if (c < 0 || c >= T.w) break;
      for (const p of T.pieces[c] ?? []) {
        const y = Math.min(p.yl, p.yr);
        if (y >= (feetRow - 8) * CELL && y <= (feetRow + 10) * CELL) {
          found = c;
          toRow = Math.round(y / CELL);
          break;
        }
      }
    }
    if (found >= 0) {
      toCol = found;
      const gap = Math.abs(found - endCol) - 1;
      const rise = feetRow - toRow;
      const ceilingLow = (() => {
        for (let r = feetRow - 1; r >= Math.max(0, feetRow - 4); r--) if (T.blocksHead(endCol, r)) return true;
        return false;
      })();
      if (rise > Math.floor(apex)) {
        kind = 'ledge_too_high';
        need = `a ledge at most ${Math.floor(apex)} rows up`;
        have = `${rise} rows`;
        key = 'frontier.too_high';
        args = { need: rise, max: Math.floor(apex) };
      } else if (gap > gmax) {
        kind = ceilingLow ? 'head_bonk' : 'gap_too_wide';
        need = `a ${gap}-cell jump`;
        // a longer run-up helps only when running is on and the gap is within the best running jump
        const runUpHelps = W.ab.run && gap <= gmaxRun && runway < reach.runway_for_best;
        have = runUpHelps
          ? `a run-jump does ${gmaxRun} with ≥ ${reach.runway_for_best} cells of runway; you have ${runway}`
          : `the longest jump is ${gmaxRun} cells`;
        key = ceilingLow ? 'frontier.head_bonk' : runUpHelps ? 'frontier.needs_run_up' : 'frontier.too_far';
        args = ceilingLow ? {} : runUpHelps ? { need: gap, max: gmaxRun, have: runway } : { need: gap, max: gmaxRun };
      } else if (ceilingLow) {
        kind = 'head_bonk';
        need = 'more headroom for the jump';
        have = 'a ceiling right above the takeoff';
        key = 'frontier.head_bonk';
      } else {
        need = 'a path to the flag';
        have = 'the next jump does not land anywhere useful';
      }
    } else {
      need = 'a floor to land on';
      have = 'no floor within 18 cells';
    }
  }
  const objs = objectsIn(level, toCol - 0.5, toRow - 1, toCol + 1.5, toRow + 1, ['ground', 'platform', 'wall', 'ceiling']);
  const blocking: Blocking = { from, to_object: objs[0] ?? g.id, kind, need, have };
  return {
    frontier: { reached, blocking }, reason: 'goal_unreachable', message_key: key, args,
    fixAt: { x: dir > 0 ? (endCol + 1) * CELL - 8 : endCol * CELL + 8, y: F.y, dir, kind },
  };
}
