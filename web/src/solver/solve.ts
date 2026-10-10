/**
 * Solvability check (PLAN.md section 11). Owned by lane B.
 *
 * Nodes are standing cells (x, y): the player's feet rest on the bottom edge
 * of cell y, supported by a solid or platform cell at y+1, with cells y and
 * y-1 free. From each node the action set is simulated with physicsSim.ts
 * until the body lands, dies or 3 s pass; each landing is an edge. BFS from
 * player_start. The result lists every reachable standing cell as "x,y" and
 * a reason when unsolvable: no_start, no_goal, goal_unreachable.
 */
import type { Level } from '../types';
import { CELL, PLAYER_H, PLAYER_W } from '../game/constants';
import {
  applyBounce,
  bodyAtCell,
  cloneBody,
  newBody,
  stepFrame,
  type FrameInput,
  type SimBody,
  type SimWorld,
  buildWorld,
} from './physicsSim';

export interface SolveResult {
  solvable: boolean;
  /** "x,y" standing cells reachable from player_start */
  reachable: string[];
  reason?: string;
}

/** 3 s at 60 Hz: longer than any jump or bounce arc inside the 27-row grid. */
const MAX_FRAMES = 180;
/** One cell of walking at RUN_SPEED takes exactly 6 frames (160 px/s * 6/60 = 16 px). */
const WALK_FRAMES = 6;
const JUMP_HOLDS = [6, 12, MAX_FRAMES];
const DIRS: ReadonlyArray<-1 | 0 | 1> = [-1, 0, 1];

type Policy = (frame: number, b: SimBody, airborneSeen: boolean) => FrameInput | null;

interface Node {
  x: number;
  y: number;
  /** support cell is a bounce pad: the engine launches immediately, so only bounce actions apply */
  pad: number;
}

function cellFree(world: SimWorld, cx: number, cy: number): boolean {
  if (cx < 0 || cx >= world.w) return false;
  if (cy < 0) return true;
  if (cy >= world.h) return false;
  const i = cy * world.w + cx;
  return world.solid[i] === 0 && world.hazard[i] === 0;
}

function supported(world: SimWorld, cx: number, cy: number): boolean {
  const sy = cy + 1;
  if (cx < 0 || cx >= world.w || sy < 0 || sy >= world.h) return false;
  const i = sy * world.w + cx;
  return world.solid[i] === 1 || world.oneWay[i] === 1;
}

function padStrength(world: SimWorld, cx: number, cy: number): number {
  const sy = cy + 1;
  if (cx < 0 || cx >= world.w || sy < 0 || sy >= world.h) return 0;
  return world.bounce[sy * world.w + cx];
}

/**
 * Map a landed body to a standing node. The body is centered on a cell; when
 * that cell has no support (the body landed overhanging a ledge) the
 * neighbor under the body's other half is used instead.
 */
function nodeOf(world: SimWorld, b: SimBody): Node | null {
  const cy = Math.floor((b.y + PLAYER_H - 1) / CELL);
  const cx = Math.floor((b.x + PLAYER_W / 2) / CELL);
  const candidates = [cx, Math.floor(b.x / CELL), Math.floor((b.x + PLAYER_W - 1e-6) / CELL)];
  for (const x of candidates) {
    if (cellFree(world, x, cy) && cellFree(world, x, cy - 1) && supported(world, x, cy)) {
      return { x, y: cy, pad: padStrength(world, x, cy) };
    }
  }
  return null;
}

/**
 * Run one action. Returns the node the body comes to rest on, or null when
 * it died, timed out, or landed somewhere that is not a standing cell. Sets
 * `hitGoal` when the goal was touched at any frame of the action.
 */
function runAction(
  world: SimWorld,
  start: SimBody,
  policy: Policy,
  out: { hitGoal: boolean },
): Node | null {
  const b = cloneBody(start);
  let airborneSeen = false;
  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    const input = policy(frame, b, airborneSeen);
    if (input === null) return nodeOf(world, b);
    const r = stepFrame(world, b, input);
    if (r === 'dead') return null;
    if (r === 'goal') out.hitGoal = true;
    if (!b.blockedDown) airborneSeen = true;
    else if (airborneSeen) return nodeOf(world, b);
  }
  return null;
}

/** Walk one cell; if the ledge ends, keep running and land wherever that leads. */
function walkPolicy(dir: -1 | 1): Policy {
  return (frame, b) => (frame >= WALK_FRAMES && b.blockedDown ? null : { dir, jump: false });
}

/** Walk off the edge and let go: a straight drop next to the ledge. */
function dropPolicy(dir: -1 | 1): Policy {
  return (_frame, _b, airborne) => ({ dir: airborne ? 0 : dir, jump: false });
}

function jumpPolicy(dir: -1 | 0 | 1, hold: number): Policy {
  return (frame) => ({ dir, jump: frame < hold });
}

function bouncePolicy(dir: -1 | 0 | 1): Policy {
  return () => ({ dir, jump: false });
}

export function solve(level: Level): SolveResult {
  const world = buildWorld(level);
  if (!world.start) return { solvable: false, reachable: [], reason: 'no_start' };

  const visited = new Uint8Array(world.w * world.h);
  const reachable: string[] = [];
  const queue: Node[] = [];
  const goalHit = { hitGoal: false };

  const visit = (n: Node | null): void => {
    if (!n) return;
    const i = n.y * world.w + n.x;
    if (visited[i]) return;
    visited[i] = 1;
    reachable.push(`${n.x},${n.y}`);
    queue.push(n);
  };

  // Seed: let the body settle from the start cell (it may have been placed in the air).
  const s = bodyAtCell(world.start.x, world.start.y);
  const seed = newBody(s.x, s.y);
  visit(runAction(world, seed, (_f, b) => (b.blockedDown ? null : { dir: 0, jump: false }), goalHit));

  // The whole reachable set is explored even after the goal is found, so the
  // preview overlay can tint every cell the player can get to.
  let head = 0;
  while (head < queue.length) {
    const n = queue[head++];
    const at = bodyAtCell(n.x, n.y);
    const base = newBody(at.x, at.y);
    base.blockedDown = true;
    // The goal counts when standing in it too.
    const g = world.goal;
    if (g && !(base.x + PLAYER_W <= g.left || base.y + PLAYER_H <= g.top || base.x >= g.right || base.y >= g.bottom)) {
      goalHit.hitGoal = true;
    }

    if (n.pad > 0) {
      for (const dir of DIRS) {
        const b = cloneBody(base);
        applyBounce(b, n.pad);
        visit(runAction(world, b, bouncePolicy(dir), goalHit));
      }
      continue;
    }

    for (const dir of [-1, 1] as const) {
      visit(runAction(world, base, walkPolicy(dir), goalHit));
      visit(runAction(world, base, dropPolicy(dir), goalHit));
    }
    for (const hold of JUMP_HOLDS) {
      for (const dir of DIRS) {
        visit(runAction(world, base, jumpPolicy(dir, hold), goalHit));
      }
    }
  }

  if (!world.goal) return { solvable: false, reachable, reason: 'no_goal' };
  if (goalHit.hitGoal) return { solvable: true, reachable };
  return { solvable: false, reachable, reason: 'goal_unreachable' };
}
