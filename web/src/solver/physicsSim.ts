/**
 * Discrete 60 Hz player simulation for the solver (PLAN.md section 11).
 *
 * A port of what Phaser Arcade does to the player body each step with the
 * engine's constants: semi-implicit Euler (vy += g*dt, then pos += v*dt),
 * then tile separation with Arcade's own rules (interesting faces, TILE_BIAS,
 * "separate on the axis with the smaller penetration" when moving
 * diagonally). Keeping the same rules means the solver agrees with the
 * engine about which ledges catch the player and which gaps swallow it.
 *
 * Approximations, all deliberate:
 * - Coyote time, the jump buffer and standing with the body overhanging a
 *   ledge are not modeled: every action starts from the cell's resting
 *   position. A frame-perfect player can therefore do slightly more than the
 *   solver says (about 0.8 cells of extra jump distance). The derived limits
 *   in PLAN.md section 2 (6-cell gap yes, 7 no; 3-cell wall yes, 4 no) are
 *   exactly this model.
 * - Moving platforms are one-way support along their whole swept path: the
 *   player can land on any cell the platform ever covers, and never bumps
 *   into it from below or the side.
 * - Doors are passable (ignored), enemies are ignored, keys and coins have
 *   no physics.
 * - Bounce pads are solid tiles whose top launches the player at
 *   BOUNCE_VY * strength; the sim treats "landing on a pad" as a node from
 *   which only bounce actions exist, like the engine's auto-trampoline.
 */
import type { Level } from '../types';
import { TILE_HAZARD, TILE_SOLID } from '../types';
import {
  BOUNCE_VY,
  CELL,
  GAME_H,
  GAME_W,
  GRAVITY,
  GRID_H,
  GRID_W,
  JUMP_CUT_VY,
  JUMP_VY,
  PLAYER_H,
  PLAYER_W,
  RUN_SPEED,
} from '../game/constants';

export const DT = 1 / 60;
/** Phaser.Physics.Arcade.World.TILE_BIAS default. */
export const TILE_BIAS = 16;
/** Arcade's default maxVelocity is 10000; the engine clamps vy to 1200. */
const MAX_VY = 1200;

export interface SimWorld {
  readonly w: number;
  readonly h: number;
  /** 1 = solid tile (grid '1', includes bounce pad tiles). */
  readonly solid: Uint8Array;
  /** 1 = hazard tile (grid '2'): death on overlap. */
  readonly hazard: Uint8Array;
  /** 1 = a moving platform covers this cell somewhere on its path: one-way support. */
  readonly oneWay: Uint8Array;
  /** bounce strength of a pad tile (0 = not a pad). */
  readonly bounce: Float32Array;
  /** World-pixel rect of the goal (the goal cell plus the cell above), or null. */
  readonly goal: { left: number; top: number; right: number; bottom: number } | null;
  /** player_start standing cell, or null. */
  readonly start: { x: number; y: number } | null;
}

export interface SimBody {
  /** top-left of the PLAYER_W x PLAYER_H body, pixels */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** the deltas of the current step (Arcade's deltaX/deltaY) */
  dx: number;
  dy: number;
  blockedDown: boolean;
  blockedUp: boolean;
  blockedLeft: boolean;
  blockedRight: boolean;
  /** jump button state last frame */
  jumpHeld: boolean;
  /** a player-initiated jump is in progress (eligible for the jump cut) */
  jumpActive: boolean;
}

export interface FrameInput {
  dir: -1 | 0 | 1;
  /** jump button held this frame */
  jump: boolean;
}

export type StepResult = 'ok' | 'dead' | 'goal';

export function newBody(x: number, y: number): SimBody {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    dx: 0,
    dy: 0,
    blockedDown: false,
    blockedUp: false,
    blockedLeft: false,
    blockedRight: false,
    jumpHeld: false,
    jumpActive: false,
  };
}

export function cloneBody(b: SimBody): SimBody {
  return { ...b };
}

/** Body top-left for a player resting on standing cell (cx, cy): centered in the cell, feet on its bottom edge. */
export function bodyAtCell(cx: number, cy: number): { x: number; y: number } {
  return { x: cx * CELL + (CELL - PLAYER_W) / 2, y: (cy + 1) * CELL - PLAYER_H };
}

export function buildWorld(level: Level): SimWorld {
  const w = level.grid.w || GRID_W;
  const h = level.grid.h || GRID_H;
  const n = w * h;
  const solid = new Uint8Array(n);
  const hazard = new Uint8Array(n);
  const oneWay = new Uint8Array(n);
  const bounce = new Float32Array(n);
  const rows = level.grid.rows;
  for (let y = 0; y < h && y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < w && x < row.length; x++) {
      if (row[x] === TILE_SOLID) solid[y * w + x] = 1;
      else if (row[x] === TILE_HAZARD) hazard[y * w + x] = 1;
    }
  }

  let goal: SimWorld['goal'] = null;
  let start: SimWorld['start'] = null;
  for (const e of level.entities) {
    if (e.type === 'goal' && e.x != null && e.y != null && !goal) {
      goal = { left: e.x * CELL, top: (e.y - 1) * CELL, right: (e.x + 1) * CELL, bottom: (e.y + 1) * CELL };
    } else if (e.type === 'player_start' && e.x != null && e.y != null && !start) {
      start = { x: e.x, y: e.y };
    } else if (e.type === 'bounce_pad' && e.bbox) {
      const [x0, y0, x1, y1] = e.bbox;
      const s = e.strength ?? 1;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x >= 0 && x < w && y >= 0 && y < h) {
            // Pads sit on solid tiles by contract; make sure the sim agrees even if the grid forgot.
            solid[y * w + x] = 1;
            bounce[y * w + x] = s;
          }
        }
      }
    } else if (e.type === 'moving_platform' && e.bbox) {
      const [x0, y0, x1, y1] = e.bbox;
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      const path = e.path && e.path.length > 0 ? e.path : [[x0, y0] as [number, number]];
      const mark = (px: number, py: number): void => {
        for (let y = py; y < py + bh; y++) {
          for (let x = px; x < px + bw; x++) {
            if (x >= 0 && x < w && y >= 0 && y < h) oneWay[y * w + x] = 1;
          }
        }
      };
      mark(path[0][0], path[0][1]);
      for (let i = 1; i < path.length; i++) {
        const [ax, ay] = path[i - 1];
        const [bx, by] = path[i];
        const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
        for (let s = 0; s <= steps; s++) {
          const t = steps === 0 ? 0 : s / steps;
          mark(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t));
        }
      }
    }
  }
  return { w, h, solid, hazard, oneWay, bounce, goal, start };
}

export function isSolid(world: SimWorld, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return false;
  return world.solid[cy * world.w + cx] === 1;
}

function intersects(b: SimBody, left: number, top: number, right: number, bottom: number): boolean {
  return !(b.x + PLAYER_W <= left || b.y + PLAYER_H <= top || b.x >= right || b.y >= bottom);
}

/** Port of Phaser's TileCheckX for the player body against one tile. */
function tileCheckX(b: SimBody, faceLeft: boolean, faceRight: boolean, tileLeft: number, tileRight: number): number {
  let ox = 0;
  if (b.dx < 0) {
    if (faceRight && b.x < tileRight) {
      ox = b.x - tileRight;
      if (ox < -TILE_BIAS) ox = 0;
    }
  } else if (b.dx > 0) {
    if (faceLeft && b.x + PLAYER_W > tileLeft) {
      ox = b.x + PLAYER_W - tileLeft;
      if (ox > TILE_BIAS) ox = 0;
    }
  }
  if (ox !== 0) {
    if (ox < 0) b.blockedLeft = true;
    else b.blockedRight = true;
    b.x -= ox;
    b.vx = 0;
  }
  return ox;
}

/** Port of Phaser's TileCheckY. */
function tileCheckY(b: SimBody, faceTop: boolean, faceBottom: boolean, tileTop: number, tileBottom: number): number {
  let oy = 0;
  if (b.dy < 0) {
    if (faceBottom && b.y < tileBottom) {
      oy = b.y - tileBottom;
      if (oy < -TILE_BIAS) oy = 0;
    }
  } else if (b.dy > 0) {
    if (faceTop && b.y + PLAYER_H > tileTop) {
      oy = b.y + PLAYER_H - tileTop;
      if (oy > TILE_BIAS) oy = 0;
    }
  }
  if (oy !== 0) {
    if (oy < 0) b.blockedUp = true;
    else b.blockedDown = true;
    b.y -= oy;
    b.vy = 0;
  }
  return oy;
}

/** Port of Phaser's SeparateTile for a solid tile at cell (cx, cy). */
function separateTile(world: SimWorld, b: SimBody, cx: number, cy: number): void {
  const tileLeft = cx * CELL;
  const tileTop = cy * CELL;
  const tileRight = tileLeft + CELL;
  const tileBottom = tileTop + CELL;
  const faceLeft = !isSolid(world, cx - 1, cy);
  const faceRight = !isSolid(world, cx + 1, cy);
  const faceTop = !isSolid(world, cx, cy - 1);
  const faceBottom = !isSolid(world, cx, cy + 1);
  const faceH = faceLeft || faceRight;
  const faceV = faceTop || faceBottom;
  if (!faceH && !faceV) return;
  if (!intersects(b, tileLeft, tileTop, tileRight, tileBottom)) return;

  let minX = 0;
  let minY = 1;
  const adx = Math.abs(b.dx);
  const ady = Math.abs(b.dy);
  if (adx > ady) minX = -1;
  else if (adx < ady) minY = -1;
  if (b.dx !== 0 && b.dy !== 0 && faceH && faceV) {
    minX = Math.min(Math.abs(b.x - tileRight), Math.abs(b.x + PLAYER_W - tileLeft));
    minY = Math.min(Math.abs(b.y - tileBottom), Math.abs(b.y + PLAYER_H - tileTop));
  }

  if (minX < minY) {
    if (faceH) {
      const ox = tileCheckX(b, faceLeft, faceRight, tileLeft, tileRight);
      if (ox !== 0 && !intersects(b, tileLeft, tileTop, tileRight, tileBottom)) return;
    }
    if (faceV) tileCheckY(b, faceTop, faceBottom, tileTop, tileBottom);
  } else {
    if (faceV) {
      const oy = tileCheckY(b, faceTop, faceBottom, tileTop, tileBottom);
      if (oy !== 0 && !intersects(b, tileLeft, tileTop, tileRight, tileBottom)) return;
    }
    if (faceH) tileCheckX(b, faceLeft, faceRight, tileLeft, tileRight);
  }
}

/**
 * One 60 Hz frame: apply input the way Player.update does, integrate like
 * Arcade, resolve tiles, then check hazards, the void and the goal.
 */
export function stepFrame(world: SimWorld, b: SimBody, input: FrameInput): StepResult {
  // Input, mirroring Player.update: grounded means the previous step ended blocked down.
  b.vx = input.dir * RUN_SPEED;
  if (input.jump && !b.jumpHeld && b.blockedDown) {
    b.vy = JUMP_VY;
    b.jumpActive = true;
  }
  if (!input.jump && b.jumpHeld && b.jumpActive && b.vy < JUMP_CUT_VY) {
    b.vy = JUMP_CUT_VY;
    b.jumpActive = false;
  }
  b.jumpHeld = input.jump;

  // Integrate (semi-implicit Euler, like World.updateMotion + Body.update).
  b.vy += GRAVITY * DT;
  if (b.vy > MAX_VY) b.vy = MAX_VY;
  const prevBottom = b.y + PLAYER_H;
  b.dx = b.vx * DT;
  b.dy = b.vy * DT;
  b.x += b.dx;
  b.y += b.dy;
  b.blockedDown = false;
  b.blockedUp = false;
  b.blockedLeft = false;
  b.blockedRight = false;

  // World bounds: left, right and top are walls (the engine's setBoundsCollision), the bottom is open.
  if (b.x < 0) {
    b.x = 0;
    b.vx = 0;
    b.blockedLeft = true;
  } else if (b.x + PLAYER_W > GAME_W) {
    b.x = GAME_W - PLAYER_W;
    b.vx = 0;
    b.blockedRight = true;
  }
  if (b.y < 0) {
    b.y = 0;
    if (b.vy < 0) b.vy = 0;
    b.blockedUp = true;
  }

  // Solid tiles in and around the body, row-major like Arcade's tile list.
  const cx0 = Math.max(0, Math.floor(b.x / CELL) - 1);
  const cx1 = Math.min(world.w - 1, Math.floor((b.x + PLAYER_W) / CELL) + 1);
  const cy0 = Math.max(0, Math.floor(b.y / CELL) - 1);
  const cy1 = Math.min(world.h - 1, Math.floor((b.y + PLAYER_H) / CELL) + 1);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (world.solid[cy * world.w + cx] === 1) separateTile(world, b, cx, cy);
    }
  }

  // One-way platform cells: support only when falling onto them from above.
  if (b.dy > 0 && !b.blockedDown) {
    const bottom = b.y + PLAYER_H;
    const rowTop = Math.floor(prevBottom / CELL);
    const rowBottom = Math.min(world.h - 1, Math.floor(bottom / CELL));
    const colL = Math.max(0, Math.floor(b.x / CELL));
    const colR = Math.min(world.w - 1, Math.floor((b.x + PLAYER_W - 1e-6) / CELL));
    outer: for (let cy = Math.max(0, rowTop); cy <= rowBottom; cy++) {
      const tileTop = cy * CELL;
      if (prevBottom > tileTop + 1e-6 || bottom <= tileTop) continue;
      for (let cx = colL; cx <= colR; cx++) {
        if (world.oneWay[cy * world.w + cx] === 1 && world.solid[cy * world.w + cx] === 0) {
          b.y = tileTop - PLAYER_H;
          b.vy = 0;
          b.blockedDown = true;
          break outer;
        }
      }
    }
  }

  if (b.blockedDown && b.vy >= 0) b.jumpActive = false;

  // Hazards (strict AABB, same as Arcade's TileIntersectsBody) and the void.
  if (b.y > GAME_H) return 'dead';
  const hx0 = Math.max(0, Math.floor(b.x / CELL));
  const hx1 = Math.min(world.w - 1, Math.floor((b.x + PLAYER_W - 1e-6) / CELL));
  const hy0 = Math.max(0, Math.floor(b.y / CELL));
  const hy1 = Math.min(world.h - 1, Math.floor((b.y + PLAYER_H - 1e-6) / CELL));
  for (let cy = hy0; cy <= hy1; cy++) {
    for (let cx = hx0; cx <= hx1; cx++) {
      if (world.hazard[cy * world.w + cx] === 1) return 'dead';
    }
  }

  const g = world.goal;
  if (g && intersects(b, g.left, g.top, g.right, g.bottom)) return 'goal';
  return 'ok';
}

/** Bounce pads launch on contact, bypassing the jump logic. */
export function applyBounce(b: SimBody, strength: number): void {
  b.vy = BOUNCE_VY * strength;
  b.jumpActive = false;
  b.blockedDown = false;
}
