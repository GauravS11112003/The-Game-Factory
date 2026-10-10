/**
 * Gameplay diagnosis metrics (docs/v2/diagnosis/gameplay.md).
 *
 * Reuses the v1 solver physics (web/src/solver/physicsSim.ts, a frame-exact
 * port of what Phaser Arcade does to the player) to measure:
 *   1. the jump envelope of the v1 constants (height / distance per hold time),
 *   2. per level: reachable area, shortest routes (fewest jumps, fastest),
 *      number of required jumps, the takeoff window of every required jump
 *      in frames, whether a miss is lethal, hazard/enemy exposure, timer slack,
 *      and a deaths-per-attempt proxy from a simple human timing-noise model.
 *
 * Run (from web/, so the TS imports resolve with the project's toolchain):
 *   cd web && ./node_modules/.bin/vite-node ../docs/v2/diagnosis/gameplay/level_metrics.ts
 * Writes results.json and results.md next to this file.
 *
 * Read-only with respect to v1: imports v1 modules, never edits them.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Level } from '../../../../web/src/types';
import {
  CELL,
  COYOTE_MS,
  BUFFER_MS,
  GRAVITY,
  JUMP_CUT_VY,
  JUMP_VY,
  PLAYER_H,
  PLAYER_W,
  RUN_SPEED,
  GAME_W,
  GRID_W,
  GRID_H,
  BOUNCE_VY,
  DEFAULT_PATROL_SPEED,
} from '../../../../web/src/game/constants';
import {
  applyBounce,
  bodyAtCell,
  buildWorld,
  cloneBody,
  newBody,
  stepFrame,
  type FrameInput,
  type SimBody,
  type SimWorld,
} from '../../../../web/src/solver/physicsSim';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');

// ---------------------------------------------------------------- physics envelope

interface JumpSample {
  holdFrames: number;
  apexPx: number;
  apexCells: number;
  airFrames: number;
  distPx: number;
  distCells: number;
}

/** Jump on an infinite flat floor holding right, release after `hold` frames; measure apex and landing distance. */
function flatJump(hold: number): JumpSample {
  const rows: string[] = [];
  for (let y = 0; y < GRID_H; y++) rows.push(y >= 25 ? '1'.repeat(GRID_W) : '0'.repeat(GRID_W));
  const level = { grid: { w: GRID_W, h: GRID_H, cell: CELL, rows }, entities: [] } as unknown as Level;
  const world = buildWorld(level);
  const at = bodyAtCell(2, 24);
  const b = newBody(at.x, at.y);
  b.blockedDown = true;
  const y0 = b.y;
  const x0 = b.x;
  let apex = 0;
  let frames = 0;
  for (let f = 0; f < 300; f++) {
    stepFrame(world, b, { dir: 1, jump: f < hold });
    frames++;
    apex = Math.max(apex, y0 - b.y);
    if (b.blockedDown && f > 0) break;
  }
  return {
    holdFrames: hold,
    apexPx: +apex.toFixed(1),
    apexCells: +(apex / CELL).toFixed(2),
    airFrames: frames,
    distPx: +(b.x - x0).toFixed(1),
    distCells: +((b.x - x0) / CELL).toFixed(2),
  };
}

// ---------------------------------------------------------------- graph (mirrors solve.ts, but keeps edges)

const MAX_FRAMES = 180;
const WALK_FRAMES = 6;
const JUMP_HOLDS = [6, 12, MAX_FRAMES];
const DIRS: ReadonlyArray<-1 | 0 | 1> = [-1, 0, 1];
type Policy = (frame: number, b: SimBody, airborneSeen: boolean) => FrameInput | null;

interface Node {
  x: number;
  y: number;
  pad: number;
}
type Kind = 'walk' | 'drop' | 'jump' | 'bounce';
interface Edge {
  from: number;
  to: number; // node index, or GOAL
  kind: Kind;
  dir: -1 | 0 | 1;
  hold: number;
  frames: number;
}
const GOAL = -1;

function cellFree(w: SimWorld, cx: number, cy: number): boolean {
  if (cx < 0 || cx >= w.w) return false;
  if (cy < 0) return true;
  if (cy >= w.h) return false;
  const i = cy * w.w + cx;
  return w.solid[i] === 0 && w.hazard[i] === 0;
}
function supported(w: SimWorld, cx: number, cy: number): boolean {
  const sy = cy + 1;
  if (cx < 0 || cx >= w.w || sy < 0 || sy >= w.h) return false;
  const i = sy * w.w + cx;
  return w.solid[i] === 1 || w.oneWay[i] === 1;
}
function padStrength(w: SimWorld, cx: number, cy: number): number {
  const sy = cy + 1;
  if (cx < 0 || cx >= w.w || sy < 0 || sy >= w.h) return 0;
  return w.bounce[sy * w.w + cx];
}
function nodeOf(w: SimWorld, b: SimBody): Node | null {
  const cy = Math.floor((b.y + PLAYER_H - 1) / CELL);
  const cx = Math.floor((b.x + PLAYER_W / 2) / CELL);
  for (const x of [cx, Math.floor(b.x / CELL), Math.floor((b.x + PLAYER_W - 1e-6) / CELL)]) {
    if (cellFree(w, x, cy) && cellFree(w, x, cy - 1) && supported(w, x, cy)) return { x, y: cy, pad: padStrength(w, x, cy) };
  }
  return null;
}

interface ActionOut {
  node: Node | null;
  hitGoal: boolean;
  died: boolean;
  frames: number;
}
function runAction(w: SimWorld, start: SimBody, policy: Policy): ActionOut {
  const b = cloneBody(start);
  let air = false;
  for (let f = 0; f < MAX_FRAMES; f++) {
    const input = policy(f, b, air);
    if (input === null) return { node: nodeOf(w, b), hitGoal: false, died: false, frames: f };
    const r = stepFrame(w, b, input);
    if (r === 'dead') return { node: null, hitGoal: false, died: true, frames: f + 1 };
    if (r === 'goal') return { node: null, hitGoal: true, died: false, frames: f + 1 };
    if (!b.blockedDown) air = true;
    else if (air) return { node: nodeOf(w, b), hitGoal: false, died: false, frames: f + 1 };
  }
  return { node: null, hitGoal: false, died: false, frames: MAX_FRAMES };
}
const walkPolicy = (d: -1 | 1): Policy => (f, b) => (f >= WALK_FRAMES && b.blockedDown ? null : { dir: d, jump: false });
const dropPolicy = (d: -1 | 1): Policy => (_f, _b, air) => ({ dir: air ? 0 : d, jump: false });
const jumpPolicy = (d: -1 | 0 | 1, hold: number): Policy => (f) => ({ dir: d, jump: f < hold });
const bouncePolicy = (d: -1 | 0 | 1): Policy => () => ({ dir: d, jump: false });

interface Graph {
  world: SimWorld;
  nodes: Node[];
  index: Map<string, number>;
  edges: Edge[];
  out: Edge[][];
  startIdx: number;
  goalDirect: boolean;
}

function standingBody(n: Node): SimBody {
  const at = bodyAtCell(n.x, n.y);
  const b = newBody(at.x, at.y);
  b.blockedDown = true;
  return b;
}

function buildGraph(world: SimWorld, extraHazard?: Uint8Array): Graph {
  const w: SimWorld = extraHazard
    ? { ...world, hazard: world.hazard.map((v, i) => (v || extraHazard[i] ? 1 : 0)) as Uint8Array }
    : world;
  const nodes: Node[] = [];
  const index = new Map<string, number>();
  const edges: Edge[] = [];
  const out: Edge[][] = [];
  let goalDirect = false;
  const add = (n: Node | null): number => {
    if (!n) return -2;
    const k = `${n.x},${n.y}`;
    let i = index.get(k);
    if (i === undefined) {
      i = nodes.length;
      nodes.push(n);
      index.set(k, i);
      out.push([]);
    }
    return i;
  };
  if (!w.start) return { world: w, nodes, index, edges, out, startIdx: -2, goalDirect };
  const s = bodyAtCell(w.start.x, w.start.y);
  const settle = runAction(w, newBody(s.x, s.y), (_f, b) => (b.blockedDown ? null : { dir: 0, jump: false }));
  const startIdx = add(settle.node);
  if (startIdx < 0) return { world: w, nodes, index, edges, out, startIdx, goalDirect };
  const g = w.goal;
  let head = 0;
  while (head < nodes.length) {
    const i = head++;
    const n = nodes[i];
    const base = standingBody(n);
    if (g && !(base.x + PLAYER_W <= g.left || base.y + PLAYER_H <= g.top || base.x >= g.right || base.y >= g.bottom)) {
      const e: Edge = { from: i, to: GOAL, kind: 'walk', dir: 0, hold: 0, frames: 0 };
      edges.push(e);
      out[i].push(e);
      goalDirect = true;
    }
    const tryAct = (kind: Kind, dir: -1 | 0 | 1, hold: number, body: SimBody, pol: Policy): void => {
      const r = runAction(w, body, pol);
      let to = -2;
      if (r.hitGoal) to = GOAL;
      else if (r.node) to = add(r.node);
      if (to === -2 || to === i) return;
      const e: Edge = { from: i, to, kind, dir, hold, frames: r.frames };
      edges.push(e);
      out[i].push(e);
    };
    if (n.pad > 0) {
      for (const d of DIRS) {
        const b = cloneBody(base);
        applyBounce(b, n.pad);
        tryAct('bounce', d, 0, b, bouncePolicy(d));
      }
      continue;
    }
    for (const d of [-1, 1] as const) {
      tryAct('walk', d, 0, base, walkPolicy(d));
      tryAct('drop', d, 0, base, dropPolicy(d));
    }
    for (const h of JUMP_HOLDS) for (const d of DIRS) tryAct('jump', d, h, base, jumpPolicy(d, h));
  }
  return { world: w, nodes, index, edges, out, startIdx, goalDirect };
}

/** Dijkstra from start; cost function per edge. Returns the edge path to GOAL or null. */
function shortest(g: Graph, cost: (e: Edge) => number): { path: Edge[]; cost: number } | null {
  if (g.startIdx < 0) return null;
  const N = g.nodes.length;
  const dist = new Float64Array(N + 1).fill(Infinity);
  const prev: Array<Edge | null> = new Array(N + 1).fill(null);
  const GI = N; // goal slot
  dist[g.startIdx] = 0;
  const done = new Uint8Array(N + 1);
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i <= N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === GI) break;
    done[u] = 1;
    for (const e of g.out[u]) {
      const v = e.to === GOAL ? GI : e.to;
      const nd = dist[u] + cost(e);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = e; }
    }
  }
  if (!Number.isFinite(dist[GI])) return null;
  const path: Edge[] = [];
  let v = GI;
  while (v !== g.startIdx) {
    const e = prev[v] as Edge;
    path.push(e);
    v = e.from;
  }
  path.reverse();
  return { path, cost: dist[GI] };
}

/** Min number of jumps from every node to the goal (reverse 0-1 BFS over the edge list). */
function jumpsToGoal(g: Graph): Float64Array {
  const N = g.nodes.length;
  const d = new Float64Array(N + 1).fill(Infinity);
  const GI = N;
  d[GI] = 0;
  const rev: Edge[][] = Array.from({ length: N + 1 }, () => []);
  for (const e of g.edges) rev[e.to === GOAL ? GI : e.to].push(e);
  const dq: number[] = [GI];
  while (dq.length) {
    const v = dq.shift() as number;
    for (const e of rev[v]) {
      const c = e.kind === 'jump' || e.kind === 'bounce' ? 1 : 0;
      if (d[v] + c < d[e.from]) {
        d[e.from] = d[v] + c;
        if (c === 0) dq.unshift(e.from);
        else dq.push(e.from);
      }
    }
  }
  return d;
}

// ---------------------------------------------------------------- jump precision

interface JumpPrecision {
  from: string;
  to: string;
  dir: number;
  /** horizontal cells covered */
  dxCells: number;
  /** vertical rise in cells (positive = up) */
  riseCells: number;
  /** px of takeoff positions (any hold) from which the jump still makes progress */
  windowPx: number;
  windowFrames: number;
  /** number of hold lengths (1..40 frames) that work from the best takeoff */
  holdWindowFrames: number;
  /** of the takeoff positions on the platform that fail, the share that kills */
  missLethalShare: number;
  /** probability a casual player fails this jump (timing noise model) */
  pFail: number;
  /** probability of dying here per attempt */
  pDeath: number;
}

const SIGMA_FRAMES = 3; // ~50 ms takeoff timing SD for a casual player
function phi(z: number): number {
  // standard normal CDF (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function analyzeJump(g: Graph, j2g: Float64Array, e: Edge): JumpPrecision {
  const w = g.world;
  const a = g.nodes[e.from];
  const target = e.to === GOAL ? null : g.nodes[e.to];
  const needBelow = j2g[e.from];
  // the contiguous supported run of standing cells containing `a`
  let l = a.x;
  let r = a.x;
  while (l - 1 >= 0 && cellFree(w, l - 1, a.y) && cellFree(w, l - 1, a.y - 1) && supported(w, l - 1, a.y)) l--;
  while (r + 1 < w.w && cellFree(w, r + 1, a.y) && cellFree(w, r + 1, a.y - 1) && supported(w, r + 1, a.y)) r++;
  const holds = Array.from({ length: 40 }, (_, k) => k + 1);
  const dir = e.dir === 0 ? 0 : e.dir;
  const restY = (a.y + 1) * CELL - PLAYER_H;
  const xMin = l * CELL - (PLAYER_W - 1);
  const xMax = (r + 1) * CELL - 1;
  // per takeoff x: 1 = some hold makes progress, 0 = fails safely, -1 = every hold kills
  const outcome: number[] = [];
  let bestHolds = 0;
  let bestHoldDeadShare = 0;
  for (let x = xMin; x <= xMax; x++) {
    const b = newBody(x, restY);
    b.blockedDown = true;
    let okHolds = 0;
    let deadHolds = 0;
    for (const h of holds) {
      const res = runAction(w, b, jumpPolicy(dir as -1 | 0 | 1, h));
      let progress = false;
      if (res.hitGoal) progress = true;
      else if (res.node) {
        const k = g.index.get(`${res.node.x},${res.node.y}`);
        if (k !== undefined && j2g[k] < needBelow) progress = true;
      }
      if (progress) okHolds++;
      else if (res.died) deadHolds++;
    }
    outcome.push(okHolds > 0 ? 1 : deadHolds === holds.length ? -1 : 0);
    if (okHolds > bestHolds) {
      bestHolds = okHolds;
      const fails = holds.length - okHolds;
      bestHoldDeadShare = fails > 0 ? deadHolds / fails : 0;
    }
  }
  const okPx = outcome.filter((o) => o === 1).length;
  const first = outcome.indexOf(1);
  const last = outcome.lastIndexOf(1);
  const share = (arr: number[]): number | null => {
    const f = arr.filter((o) => o !== 1);
    return f.length ? f.filter((o) => o === -1).length / f.length : null;
  };
  // "early" / "late" relative to the run direction (dir 0: both sides behave alike)
  const before = first > 0 ? outcome.slice(0, first) : [];
  const after = last >= 0 ? outcome.slice(last + 1) : [];
  const early = dir >= 0 ? before : after;
  let lateShare = share(dir >= 0 ? after : before);
  if (lateShare === null && dir !== 0) {
    // the window runs to the platform edge: a late press means running off it
    const edgeX = dir > 0 ? r : l;
    const drop = runAction(w, standingBody({ x: edgeX, y: a.y, pad: 0 }), dropPolicy(dir as -1 | 1));
    lateShare = drop.died ? 1 : 0;
  }
  const earlyShare = share(early) ?? 0;
  const takeoffLethal = 0.5 * earlyShare + 0.5 * (lateShare ?? 0);
  const pxPerFrame = RUN_SPEED / 60;
  const windowFrames = okPx / pxPerFrame;
  const pTake = Math.min(1, 2 * phi(-windowFrames / (2 * SIGMA_FRAMES)));
  // hold precision: only matters when few hold lengths work (>= 30 of 40 means "anything works")
  const pHold = bestHolds >= 30 ? 0 : Math.min(1, 2 * phi(-bestHolds / (2 * SIGMA_FRAMES)));
  const pFail = 1 - (1 - pTake) * (1 - pHold);
  const pDeath = pTake * takeoffLethal + pHold * bestHoldDeadShare;
  const lethal = pFail > 0 ? pDeath / pFail : takeoffLethal;
  return {
    from: `${a.x},${a.y}`,
    to: target ? `${target.x},${target.y}` : 'GOAL',
    dir: e.dir,
    dxCells: target ? target.x - a.x : NaN,
    riseCells: target ? a.y - target.y : NaN,
    windowPx: okPx,
    windowFrames: +windowFrames.toFixed(1),
    holdWindowFrames: bestHolds,
    missLethalShare: +lethal.toFixed(2),
    pFail: +pFail.toFixed(4),
    pDeath: +pDeath.toFixed(4),
  };
}

// ---------------------------------------------------------------- per level

interface LevelMetrics {
  file: string;
  id: string;
  title: string;
  solvable: boolean;
  usedWidthCells: number;
  screens: number;
  reachableStandingCells: number;
  solidCells: number;
  hazardCells: number;
  hazardDensityPct: number;
  hazardsTouchingReachable: number;
  enemies: number;
  enemyOnRequiredRoute: boolean | null;
  solvableWithEnemiesAsWalls: boolean | null;
  movingPlatforms: number;
  bouncePads: number;
  checkpoints: number;
  coins: number;
  coinsOffFastestRoute: number;
  timerSeconds: number | null;
  minJumpRoute: { jumps: number; edges: number; frames: number; seconds: number; pathCells: number } | null;
  fastestRoute: { jumps: number; frames: number; seconds: number; pathCells: number } | null;
  timerSlack: number | null;
  requiredJumps: JumpPrecision[];
  minJumpWindowFrames: number | null;
  medianJumpWindowFrames: number | null;
  expectedDeathsPerAttempt: number;
  pClearFirstTry: number;
  difficultyScore: number;
}

function pathCells(g: Graph, p: Edge[]): number {
  let s = 0;
  for (const e of p) {
    if (e.to === GOAL) continue;
    const a = g.nodes[e.from];
    const b = g.nodes[e.to];
    s += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return s;
}

function analyze(file: string, level: Level): LevelMetrics {
  const world = buildWorld(level);
  const g = buildGraph(world);
  const j2g = jumpsToGoal(g);
  const isJump = (e: Edge): boolean => e.kind === 'jump' || e.kind === 'bounce';
  const minJ = shortest(g, (e) => (isJump(e) ? 100000 : 0) + e.frames + 1);
  const fast = shortest(g, (e) => e.frames + 0.001);
  const rows = level.grid.rows;
  let solid = 0;
  let hazard = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let y = 0; y < rows.length; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x];
      if (c === '1') solid++;
      if (c === '2') hazard++;
      if (c !== '0') { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
  // hazards within one cell of a reachable standing body (2 cells tall)
  const touching = new Set<string>();
  for (const n of g.nodes)
    for (let dy = -2; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = n.x + dx;
        const y = n.y + dy;
        if (y >= 0 && y < rows.length && x >= 0 && x < rows[y].length && rows[y][x] === '2') touching.add(`${x},${y}`);
      }
  // enemies: swept patrol rectangle (+1 row above for the body) as extra hazard
  const enemies = level.entities.filter((e) => e.type === 'enemy' && e.bbox);
  let enemyOnRoute: boolean | null = null;
  let solvableEnemyWalls: boolean | null = null;
  if (enemies.length) {
    const extra = new Uint8Array(world.w * world.h);
    for (const en of enemies) {
      const [x0, y0, x1, y1] = en.bbox as [number, number, number, number];
      const dx = en.patrol?.dx ?? 6;
      const lo = Math.min(x0, x0 + dx);
      const hi = Math.max(x1, x1 + dx);
      for (let y = y0; y <= y1; y++) for (let x = lo; x <= hi; x++) if (x >= 0 && x < world.w && y >= 0 && y < world.h) extra[y * world.w + x] = 1;
    }
    const g2 = buildGraph(world, extra);
    solvableEnemyWalls = shortest(g2, (e) => e.frames + 1) !== null;
    enemyOnRoute = !solvableEnemyWalls;
  }
  const required = minJ ? minJ.path.filter(isJump).filter((e) => e.kind === 'jump').map((e) => analyzeJump(g, j2g, e)) : [];
  const bounces = minJ ? minJ.path.filter((e) => e.kind === 'bounce').length : 0;
  void bounces;
  const windows = required.map((j) => j.windowFrames).sort((a, b) => a - b);
  const expDeaths = required.reduce((s, j) => s + j.pDeath, 0);
  const pClear = required.reduce((p, j) => p * (1 - j.pDeath), 1);
  // coins off the fastest route: coin cell not within 2 cells of any node on the route
  const coins = level.entities.filter((e) => e.type === 'coin' && e.x != null);
  let off = 0;
  if (fast) {
    const routeNodes = new Set<number>();
    for (const e of fast.path) { routeNodes.add(e.from); if (e.to !== GOAL) routeNodes.add(e.to); }
    for (const c of coins) {
      let near = false;
      for (const i of routeNodes) {
        const n = g.nodes[i];
        if (Math.abs(n.x - (c.x as number)) <= 1 && (c.y as number) >= n.y - 4 && (c.y as number) <= n.y) near = true;
      }
      if (!near) off++;
    }
  }
  const timerRule = level.rules.find((r) => /^timer:\d+/.test(r.when));
  const timerSeconds = timerRule ? Number(timerRule.when.split(':')[1]) : null;
  const fastSec = fast ? fast.path.reduce((s, e) => s + e.frames, 0) / 60 : null;
  // Difficulty score 0-100 (proposal, see gameplay.md section 6): precision + lethality + length + density
  const precision = required.reduce((s, j) => s + j.pDeath * 100, 0); // expected deaths x100
  const tightest = windows.length ? Math.max(0, 12 - windows[0]) * 2 : 0; // tight windows matter even if rare
  const lengthTerm = Math.min(15, (minJ ? minJ.path.filter(isJump).length : 0) * 1.5);
  const exposure = Math.min(10, touching.size * 0.5) + (enemyOnRoute ? 10 : 0) + (timerSeconds && fastSec ? Math.max(0, 10 - 10 * (timerSeconds / fastSec - 1) / 2) : 0);
  const score = Math.min(100, Math.round(precision + tightest + lengthTerm + exposure));
  const rnd = (n: number): number => +n.toFixed(2);
  return {
    file,
    id: level.id,
    title: level.title,
    solvable: minJ !== null,
    usedWidthCells: Number.isFinite(minX) ? maxX - minX + 1 : 0,
    screens: +(level.grid.w / 16).toFixed(1), // in SMB-screen units (16 tiles wide)
    reachableStandingCells: g.nodes.length,
    solidCells: solid,
    hazardCells: hazard,
    hazardDensityPct: rnd((100 * hazard) / (level.grid.w * level.grid.h)),
    hazardsTouchingReachable: touching.size,
    enemies: enemies.length,
    enemyOnRequiredRoute: enemyOnRoute,
    solvableWithEnemiesAsWalls: solvableEnemyWalls,
    movingPlatforms: level.entities.filter((e) => e.type === 'moving_platform').length,
    bouncePads: level.entities.filter((e) => e.type === 'bounce_pad').length,
    checkpoints: level.entities.filter((e) => e.type === 'checkpoint').length,
    coins: coins.length,
    coinsOffFastestRoute: off,
    timerSeconds,
    minJumpRoute: minJ
      ? {
          jumps: minJ.path.filter(isJump).length,
          edges: minJ.path.length,
          frames: minJ.path.reduce((s, e) => s + e.frames, 0),
          seconds: rnd(minJ.path.reduce((s, e) => s + e.frames, 0) / 60),
          pathCells: pathCells(g, minJ.path),
        }
      : null,
    fastestRoute: fast
      ? { jumps: fast.path.filter(isJump).length, frames: fast.path.reduce((s, e) => s + e.frames, 0), seconds: rnd(fastSec as number), pathCells: pathCells(g, fast.path) }
      : null,
    timerSlack: timerSeconds && fastSec ? rnd(timerSeconds / fastSec) : null,
    requiredJumps: required,
    minJumpWindowFrames: windows.length ? windows[0] : null,
    medianJumpWindowFrames: windows.length ? windows[Math.floor(windows.length / 2)] : null,
    expectedDeathsPerAttempt: +expDeaths.toFixed(3),
    pClearFirstTry: +pClear.toFixed(3),
    difficultyScore: score,
  };
}

// ---------------------------------------------------------------- synthetic calibration levels

function synth(id: string, title: string, build: (c: string[][]) => void, ents: Level['entities']): Level {
  const c = Array.from({ length: GRID_H }, () => Array<string>(GRID_W).fill('0'));
  build(c);
  return {
    schema_version: 1,
    id,
    game_id: 'calib',
    parent_id: null,
    order_index: 0,
    title,
    author: 'diag',
    created_at: '',
    source: { kind: 'fixture', photo_url: null, backdrop_url: null, template_version: 1 },
    grid: { w: GRID_W, h: GRID_H, cell: CELL, rows: c.map((r) => r.join('')) },
    sprites: { player: null },
    components: [],
    entities: ents,
    rules: [],
    meta: { solvable: true, warnings: [], notes_transcript: '' },
  } as unknown as Level;
}
const fill = (c: string[][], x0: number, y0: number, x1: number, y1: number, ch: string): void => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) c[y][x] = ch;
};

function calibration(): Level[] {
  const se = (gx: number): Level['entities'] => [
    { id: 's', type: 'player_start', x: 2, y: 24 },
    { id: 'g', type: 'goal', x: gx, y: 24 },
  ] as Level['entities'];
  const out: Level[] = [];
  for (const gap of [4, 5, 6]) {
    out.push(
      synth(`calib_gap${gap}`, `Calibration: one ${gap}-cell spike pit`, (c) => {
        fill(c, 0, 25, 47, 26, '1');
        fill(c, 20, 25, 19 + gap, 25, '0');
        fill(c, 20, 26, 19 + gap, 26, '2');
      }, se(40)),
    );
  }
  out.push(
    synth('calib_pillars', 'Calibration: 1-cell pillars 5 apart over a spike floor', (c) => {
      fill(c, 0, 25, 5, 26, '1');
      fill(c, 6, 26, 41, 26, '2');
      for (let x = 11; x <= 36; x += 5) fill(c, x, 23, x, 25, '1');
      fill(c, 42, 25, 47, 26, '1');
    }, se(45)),
  );
  out.push(
    synth('calib_stairs_ceiling', 'Calibration: rising 2-wide steps (+2 rows, 4-cell gaps) under ceiling slabs over spikes', (c) => {
      fill(c, 0, 25, 5, 26, '1');
      fill(c, 6, 26, 47, 26, '2');
      let y = 23;
      for (let x = 10; x <= 34; x += 6) {
        fill(c, x, y, x + 1, 25, '1');
        fill(c, x - 1, y - 7, x + 2, y - 7, '1'); // a ceiling slab 7 rows above each step's surface
        y -= 2;
      }
      fill(c, 40, 15, 47, 25, '1');
    }, [
      { id: 's', type: 'player_start', x: 2, y: 24 },
      { id: 'g', type: 'goal', x: 45, y: 14 },
    ] as Level['entities']),
  );
  return out;
}

// ---------------------------------------------------------------- main

function loadLevels(): Array<{ file: string; level: Level }> {
  const list: Array<{ file: string; level: Level }> = [];
  const fx = join(ROOT, 'shared/fixtures/levels');
  for (const f of readdirSync(fx).filter((f) => f.endsWith('.json')).sort()) list.push({ file: `shared/fixtures/levels/${f}`, level: JSON.parse(readFileSync(join(fx, f), 'utf8')) });
  const inp = join(HERE, 'inputs');
  for (const f of readdirSync(inp).filter((f) => f.endsWith('.json')).sort())
    list.push({ file: `docs/v2/diagnosis/gameplay/inputs/${f}`, level: JSON.parse(readFileSync(join(inp, f), 'utf8')) });
  for (const l of calibration()) list.push({ file: '(synthetic)', level: l });
  return list;
}

function main(): void {
  const holds = [1, 3, 6, 9, 12, 15, 18, 22, 40];
  const envelope = holds.map(flatJump);
  const full = flatJump(200);
  const physics = {
    constants: { GRAVITY, RUN_SPEED, JUMP_VY, JUMP_CUT_VY, COYOTE_MS, BUFFER_MS, BOUNCE_VY, PLAYER_W, PLAYER_H, CELL, DEFAULT_PATROL_SPEED },
    runSpeedCellsPerSec: RUN_SPEED / CELL,
    accelerationFramesToFullSpeed: 0,
    decelerationFramesToStop: 0,
    airControl: 'full and instant (vx = dir * RUN_SPEED every frame, on the ground and in the air)',
    secondsToCrossScreen: +(GAME_W / RUN_SPEED).toFixed(2),
    fullJump: full,
    minHop: envelope[0],
    timeToApexFrames: Math.ceil(-JUMP_VY / GRAVITY * 60),
    envelope,
    bounceApexCells: +((BOUNCE_VY * BOUNCE_VY) / (2 * GRAVITY) / CELL).toFixed(2),
    deathToControlMs: 300,
  };
  const levels = loadLevels().map(({ file, level }) => analyze(file, level));
  const result = { generatedBy: 'docs/v2/diagnosis/gameplay/level_metrics.ts', sigmaFrames: SIGMA_FRAMES, physics, levels };
  writeFileSync(join(HERE, 'results.json'), JSON.stringify(result, null, 2) + '\n');

  // markdown summary
  const L: string[] = [];
  L.push('# Gameplay metrics (generated)', '', `Generated by \`level_metrics.ts\` with the v1 solver physics. Timing-noise model: takeoff SD = ${SIGMA_FRAMES} frames.`, '');
  L.push('## Physics envelope (v1 constants)', '');
  L.push(`- Run speed ${RUN_SPEED} px/s = ${RUN_SPEED / CELL} cells/s, reached in 0 frames, stops in 0 frames, identical in the air.`);
  L.push(`- Full jump: apex ${full.apexCells} cells (${full.apexPx} px), airtime ${full.airFrames} frames, flat distance ${full.distCells} cells.`);
  L.push(`- Shortest hop (1-frame tap): apex ${envelope[0].apexCells} cells, distance ${envelope[0].distCells} cells.`);
  L.push(`- Crossing the whole level at full speed: ${(GAME_W / RUN_SPEED).toFixed(1)} s. Death to control again: 300 ms.`, '');
  L.push('| hold (frames) | apex (cells) | airtime (frames) | distance (cells) |', '|---|---|---|---|');
  for (const s of envelope) L.push(`| ${s.holdFrames} | ${s.apexCells} | ${s.airFrames} | ${s.distCells} |`);
  L.push('', '## Levels', '');
  L.push('| level | solvable | min jumps | fastest s | path cells | tightest window (frames) | median window | hazards near route | enemy required | E[deaths]/attempt | P(clear 1st try) | timer slack | score |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of levels) {
    L.push(
      `| ${m.title} (\`${m.id}\`) | ${m.solvable ? 'yes' : 'NO'} | ${m.minJumpRoute?.jumps ?? '-'} | ${m.fastestRoute?.seconds ?? '-'} | ${m.minJumpRoute?.pathCells ?? '-'} | ${m.minJumpWindowFrames ?? '-'} | ${m.medianJumpWindowFrames ?? '-'} | ${m.hazardsTouchingReachable} | ${m.enemyOnRequiredRoute === null ? 'n/a' : m.enemyOnRequiredRoute ? 'yes' : 'no'} | ${m.expectedDeathsPerAttempt} | ${m.pClearFirstTry} | ${m.timerSlack ?? '-'} | ${m.difficultyScore} |`,
    );
  }
  L.push('', '## Required jumps per level (fewest-jumps route)', '');
  for (const m of levels) {
    L.push(`### ${m.title}`, '');
    if (!m.requiredJumps.length) { L.push('No jump is required.', ''); continue; }
    L.push('| from | to | dx | rise | takeoff window px | frames | hold frames that work (of 40) | miss lethal share | P(fail) | P(death) |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const j of m.requiredJumps) L.push(`| ${j.from} | ${j.to} | ${j.dxCells} | ${j.riseCells} | ${j.windowPx} | ${j.windowFrames} | ${j.holdWindowFrames} | ${j.missLethalShare} | ${j.pFail} | ${j.pDeath} |`);
    L.push('');
  }
  writeFileSync(join(HERE, 'results.md'), L.join('\n') + '\n');
  console.log(L.join('\n'));
}

main();
