/**
 * The bot boundary for lane B. `analyzeSafe` calls lane A's `analyze` (the same Sim the engine plays); if the bot
 * throws (not landed yet, or a bug), the build still completes with an envelope-based approximation marked
 * `approx: true`, so the child always gets a level and the repair search still has a frontier to work on.
 * `classifyFailure` turns a report into the repair search's failure kind (§3.7), from the bot's `frontier.blocking`
 * when present, otherwise from the geometry around the frontier.
 */
import { analyze } from '../bot/index.ts';
import { FLAGS } from '../params.ts';
import type { PhysicsProfile } from '../sim/types.ts';
import type { CellXY, EGoal, Entity, FailureKind, Flag, LevelV2, PlaytestReport, Tier } from '../types.gen.ts';
import { levelHash } from '../build/hash.ts';
import { decodeRow } from '../build/tiles.ts';
import { gMax, hMax } from '../edits/envelope.ts';
import { hardFlags } from '../edits/invariants.ts';
import { floorBelow, objBBox, topAt } from '../edits/work.ts';
import type { Work } from '../edits/work.ts';
import { CORE_VERSION } from '../util/version.ts';

export interface Failure {
  kind: FailureKind;
  at: CellXY; // where the route stops
  to: CellXY | null; // the unreached target
  toObj: string | null;
  fromObj: string | null;
  need: number;
  have: number;
  flag: Flag | null;
}

// ---- envelope reachability (fallback when the bot is unavailable) --------------------------------------

interface ReachGrid {
  w: number;
  h: number;
  ch: (c: number, r: number) => string;
}

function gridOf(level: LevelV2): ReachGrid {
  const rows = level.compiled.tiles.rows.map((r) => decodeRow(r));
  const h = rows.length;
  const w = level.world.w;
  return { w, h, ch: (c, r) => (c < 0 || c >= w ? '#' : r < 0 || r >= h ? '.' : rows[r][c] ?? '.') };
}

const FLOOR = new Set(['#', '=', '/', '\\', 'a', 'b', 'c', 'd', 'X']);
const BLOCK = new Set(['#', 'X']);

export interface Reach {
  reached: Set<number>;
  key: (c: number, r: number) => number;
  standable: (c: number, r: number) => boolean;
  goal: boolean;
  start: [number, number];
}

export function approxReach(level: LevelV2, p: PhysicsProfile): Reach {
  const g = gridOf(level);
  const hazard = new Set<number>();
  const key = (c: number, r: number): number => r * 4096 + c;
  for (const e of level.compiled.entities) {
    if (e.type === 'spikes' && e.face === 'top') for (let c = Math.floor(e.x0); c < Math.ceil(e.x1); c++) hazard.add(key(c, Math.round(e.y)));
  }
  const standable = (c: number, r: number): boolean => {
    if (c < 0 || c >= g.w || r < 2 || r >= g.h) return false;
    if (!FLOOR.has(g.ch(c, r)) || hazard.has(key(c, r))) return false;
    const a1 = g.ch(c, r - 1);
    const a2 = g.ch(c, r - 2);
    return !FLOOR.has(a1) && a1 !== '~' && !BLOCK.has(a2);
  };
  const start = level.compiled.entities.find((e) => e.type === 'player_start') as Extract<Entity, { type: 'player_start' }> | undefined;
  const sc = start ? Math.floor(start.x) : 1;
  let sr = start ? Math.round(start.y) : 22;
  for (let k = 0; k < 6 && !standable(sc, sr); k++) sr++;
  const reached = new Set<number>();
  const queue: [number, number][] = [];
  if (standable(sc, sr)) {
    reached.add(key(sc, sr));
    queue.push([sc, sr]);
  }
  const hmax = hMax(p, p.run_max ? 'run' : 'walk');
  const clearUp = (c: number, r: number, rows: number): number => {
    let k = 0;
    while (k < rows && !BLOCK.has(g.ch(c, r - 3 - k))) k++;
    return k;
  };
  const visit = (c: number, r: number): void => {
    const k = key(c, r);
    if (reached.has(k) || !standable(c, r)) return;
    reached.add(k);
    queue.push([c, r]);
  };
  while (queue.length) {
    const [c, r] = queue.shift()!;
    for (const d of [-1, 1]) {
      // walk, slopes and step assist
      for (const dr of [0, -1, 1]) if (standable(c + d, r + dr) && (dr === 0 || isSlope(g.ch(c + d, r + dr)) || isSlope(g.ch(c, r)))) visit(c + d, r + dr);
      // walk off a ledge
      if (!FLOOR.has(g.ch(c + d, r)) && !BLOCK.has(g.ch(c + d, r - 1)) && !BLOCK.has(g.ch(c + d, r - 2))) {
        for (const dc of [d, 2 * d]) for (let rr = r; rr < g.h; rr++) {
          if (BLOCK.has(g.ch(c + dc, rr - 1)) && rr > r) break;
          if (standable(c + dc, rr)) {
            visit(c + dc, rr);
            break;
          }
        }
      }
      // jumps: runway behind (c, r) in direction d
      let runway = 0;
      while (runway < 3 && standable(c - d * (runway + 1), r)) runway++;
      const reach = gMax(p, runway) + 1;
      const head = clearUp(c, r, hmax);
      for (let dc = 1; dc <= reach + 4; dc++) {
        for (let rr = r - Math.min(hmax, head); rr <= Math.min(g.h - 1, r + 12); rr++) {
          const extra = rr > r ? Math.floor((rr - r) / 2) : 0;
          if (dc > reach + extra) continue;
          if (!standable(c + d * dc, rr)) continue;
          // the arc must not pass through a solid column taller than the jump
          const apexFeet = Math.min(r, rr) - Math.min(hmax, head);
          let blocked = false;
          for (let k = 1; k < dc && !blocked; k++) if (BLOCK.has(g.ch(c + d * k, apexFeet - 1))) blocked = true;
          if (!blocked) visit(c + d * dc, rr);
        }
      }
    }
    // drop through one-way
    if (g.ch(c, r) === '=') for (let rr = r + 1; rr < g.h; rr++) if (standable(c, rr)) {
      visit(c, rr);
      break;
    }
  }
  const goalE = level.compiled.entities.find((e) => e.type === 'goal') as EGoal | undefined;
  let goal = false;
  if (goalE) {
    const t = goalE.trigger;
    for (const k of reached) {
      const c = k % 4096;
      const r = Math.floor(k / 4096);
      if (c + 1 >= t[0] - 0.3 && c <= t[2] + 0.3 && r >= t[1] - 0.5 && r - 1.75 <= t[3] + 0.5) {
        goal = true;
        break;
      }
    }
  }
  return { reached, key, standable, goal, start: [sc, sr] };
}

function isSlope(ch: string): boolean {
  return ch === '/' || ch === '\\' || ch === 'a' || ch === 'b' || ch === 'c' || ch === 'd';
}

export function approxReport(level: LevelV2, p: PhysicsProfile): PlaytestReport {
  const rr = approxReach(level, p);
  const hasGoal = level.compiled.entities.some((e) => e.type === 'goal');
  const reached: CellXY[] = [...rr.reached].map((k) => [k % 4096, Math.floor(k / 4096)] as CellXY).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const solvable = hasGoal && rr.goal;
  return {
    solvable, reason: !hasGoal ? 'no_goal' : solvable ? null : 'goal_unreachable',
    frontier: solvable ? null : { reached: reached.slice(-64), blocking: null },
    route: [], segments: [], C: 0, F: 0, score: 0, band: 'trivial', C_skilled: 0, fastest_ms: 0, par_ms: 0, casual_clear_s: 0,
    flags: solvable ? [] : [{ id: 'f_unsolvable', code: 'unsolvable', severity: 'block', object_ids: [], fix_cids: [], message_key: 'frontier.goal_unreachable', args: {} }],
    reachable: reached.map((c) => `${c[0]}:${c[1]}`), setpiece_order: [], slots: {}, engaged_enemies: 0, actions_per_screen: 0,
    trace: [], level_hash: levelHash(level), core_version: CORE_VERSION, approx: true,
  };
}

export interface SafeReport {
  report: PlaytestReport;
  approx: boolean;
  error: string | null;
}

export function analyzeSafe(level: LevelV2, mode: 'fast' | 'full', p: PhysicsProfile, tier?: Tier): SafeReport {
  try {
    const r = analyze(level, tier ? { mode, tier } : { mode });
    return { report: r, approx: false, error: null };
  } catch (e) {
    return { report: approxReport(level, p), approx: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- failure classification ----------------------------------------------------------------------

function objAtCell(w: Work, c: number, r: number): string | null {
  const f = floorBelow(w, c + 0.5, r - 0.25, 0.75);
  return f ? f.o.id : null;
}

/** The first failure the repair search should address, in route order (§3.7). */
export function classifyFailure(level: LevelV2, r: PlaytestReport, w: Work, p: PhysicsProfile, baseFlags: readonly Flag[] = []): Failure | null {
  if (r.solvable) {
    const had = new Set(baseFlags.map((f) => f.code));
    const hf = hardFlags(r).filter((f) => f.code !== 'long_segment' && !(had.has(f.code) && false));
    const f = hf[0];
    if (!f) return null;
    return { kind: 'hard_flag', at: f.at ?? [0, 0], to: f.at ?? null, toObj: f.object_ids?.[0] ?? null, fromObj: null, need: 0, have: 0, flag: f };
  }
  const b = r.frontier?.blocking ?? null;
  if (b) {
    const toO = w.objs.find((o) => o.id === b.to_object);
    let to: CellXY | null = null;
    if (toO) {
      const bb = objBBox(toO);
      to = [bb[0], bb[1]];
    }
    return {
      kind: b.kind, at: b.from, to, toObj: b.to_object || null, fromObj: objAtCell(w, Math.floor(b.from[0]), Math.round(b.from[1])),
      need: Number.parseFloat(b.need) || 0, have: Number.parseFloat(b.have) || 0, flag: null,
    };
  }
  if (r.reason === 'no_start') return { kind: 'spawn_trapped', at: [0, 0], to: null, toObj: null, fromObj: null, need: 0, have: 0, flag: null };
  // geometric: the envelope frontier and the nearest unreached floor beyond it
  const rr = approxReach(level, p);
  if (rr.reached.size < 4) return { kind: 'spawn_trapped', at: rr.start, to: null, toObj: null, fromObj: null, need: 4, have: rr.reached.size, flag: null };
  const cells = [...rr.reached].map((k) => [k % 4096, Math.floor(k / 4096)] as [number, number]);
  const goalE = level.compiled.entities.find((e) => e.type === 'goal') as EGoal | undefined;
  const keyE = level.compiled.entities.find((e) => e.type === 'key');
  if (r.reason === 'key_unreachable' && keyE) {
    const kc = keyE as { x: number; y: number };
    return { kind: 'key_unreachable', at: cells[cells.length - 1], to: [kc.x, kc.y], toObj: objAtCell(w, Math.floor(kc.x), Math.ceil(kc.y + 1)), fromObj: null, need: 0, have: 0, flag: null };
  }
  const dir = goalE && goalE.x < rr.start[0] ? -1 : 1;
  const front = cells.reduce((a, b) => (dir > 0 ? (b[0] > a[0] || (b[0] === a[0] && b[1] < a[1]) ? b : a) : b[0] < a[0] ? b : a));
  // nearest unreached standable cell beyond the frontier
  let target: [number, number] | null = null;
  for (let dc = 1; dc < 40 && !target; dc++) {
    const c = front[0] + dir * dc;
    let best: number | null = null;
    for (let row = 2; row < 27; row++) if (rr.standable(c, row) && !rr.reached.has(rr.key(c, row))) {
      if (best === null || Math.abs(row - front[1]) < Math.abs(best - front[1])) best = row;
    }
    if (best !== null) target = [c, best];
  }
  if (!target) {
    if (goalE) return { kind: 'goal_unreachable', at: front, to: [goalE.x, goalE.y], toObj: goalE.id, fromObj: objAtCell(w, front[0], front[1]), need: 0, have: 0, flag: null };
    return null;
  }
  const rise = front[1] - target[1];
  const gap = Math.abs(target[0] - front[0]) - 1;
  let runway = 0;
  while (runway < 6 && rr.reached.has(rr.key(front[0] - dir * (runway + 1), front[1]))) runway++;
  const fromObj = objAtCell(w, front[0], front[1]);
  const toObj = objAtCell(w, target[0], target[1]);
  const hmax = hMax(p, runway >= 3 && p.run_max ? 'run' : 'walk');
  // a solid column between them taller than the jump → wall
  const G = gridOf(level);
  for (let c = front[0] + dir; c !== target[0]; c += dir) {
    let top = front[1];
    while (top > 0 && BLOCK.has(G.ch(c, top - 1))) top--;
    if (front[1] - top > hmax) {
      const wallObj = w.objs.find((o) => o.shape.k === 'wall' && c >= o.shape.x && c < o.shape.x + (o.shape.w ?? 1));
      return { kind: 'wall_too_tall', at: front, to: [c, top], toObj: wallObj?.id ?? toObj, fromObj, need: front[1] - top, have: hmax, flag: null };
    }
  }
  if (rise > hmax) return { kind: 'ledge_too_high', at: front, to: target, toObj, fromObj, need: rise, have: hmax, flag: null };
  const gm = gMax(p, runway);
  if (gap > gm) return { kind: 'gap_too_wide', at: front, to: target, toObj, fromObj, need: gap, have: gm, flag: null };
  // something above the takeoff stops the arc
  const g = G;
  for (let k = 3; k <= hmax + 2; k++) {
    if (BLOCK.has(g.ch(front[0], front[1] - k)) || BLOCK.has(g.ch(front[0] + dir, front[1] - k))) {
      const over = w.objs.find((o) => {
        const bb = objBBox(o);
        return front[0] + 0.5 >= bb[0] - 1 && front[0] + 0.5 <= bb[2] + 1 && Math.abs(bb[1] - (front[1] - k)) <= 1.01 && o.shape.k !== 'point';
      });
      return { kind: 'head_bonk', at: front, to: target, toObj: over?.id ?? null, fromObj, need: rise + 2, have: k - 1, flag: null };
    }
  }
  return { kind: 'goal_unreachable', at: front, to: target, toObj: goalE?.id ?? toObj, fromObj, need: gap, have: gm, flag: null };
}

/** Frontier size for "did the frontier advance" (the bot's reachable nodes, or the envelope's). */
export function frontierScore(r: PlaytestReport): number {
  if (r.solvable) return 1e6 - hardFlags(r).length * 1000;
  return (r.reachable?.length ?? 0) + (r.frontier?.reached?.length ?? 0) * 0.01;
}

export { topAt, FLAGS };
