/**
 * The camera (§6.2): one pure function shared by the engine (which interpolates it for rendering) and the bot's
 * blind-jump check. Horizontal only; the full 27-row height is always visible.
 *
 * - Look-ahead: 6 cells toward the facing direction. While |vx| > 0.5 × walk speed it swings at 0.8 cell/frame;
 *   otherwise it eases toward the facing side at 12 cells / 0.5 s.
 * - Dead zone 4 cells wide around the target (player x + look-ahead); outside it the view centre lerps 0.1 per
 *   frame toward the dead-zone edge.
 * - Clamped to [0, world.w − 48]. `no_backscroll` (SMB mode) never scrolls left past max_x.
 */
import { CAMERA } from '../params.ts';
import type { World } from '../types.gen.ts';
import type { CameraState, SimView } from './types.ts';

const VIEW_W = CAMERA.view_w_c;
const SLOW_RATE = (2 * CAMERA.look_ahead_c) / (CAMERA.look_ease_s * 60);
const FAST_RATE = 0.8;
const DEFAULT_WALK = 96;

function clampX(x: number, world: World): number {
  const max = Math.max(0, (world?.w ?? VIEW_W) - VIEW_W);
  return x < 0 ? 0 : x > max ? max : x;
}

export function initCamera(playerX: number, world: World, mode: 'follow' | 'no_backscroll', walkPxS: number): CameraState {
  const look = CAMERA.look_ahead_c;
  const x = clampX(playerX + look - VIEW_W / 2, world);
  return { x, look, facing: 1, max_x: x, mode, walk_px_s: walkPxS };
}

/** Core step on raw numbers (the sim calls this every frame). x in cells, vx in px/s. */
export function camStep(c: CameraState, x: number, vx: number, facing: 1 | -1, world: World, walkPxS?: number): CameraState {
  const walk = walkPxS ?? c.walk_px_s ?? DEFAULT_WALK;
  const want = facing * CAMERA.look_ahead_c;
  const fast = Math.abs(vx) > CAMERA.look_ahead_min_speed_frac * walk;
  const rate = fast ? FAST_RATE : SLOW_RATE;
  let look = c.look;
  if (look < want) look = Math.min(want, look + rate);
  else if (look > want) look = Math.max(want, look - rate);
  const target = x + look;
  const centre = c.x + VIEW_W / 2;
  const half = CAMERA.dead_zone_c / 2;
  let desired = centre;
  if (target > centre + half) desired = target - half;
  else if (target < centre - half) desired = target + half;
  let nx = c.x + (desired - centre) * CAMERA.lerp_per_frame;
  nx = clampX(nx, world);
  let maxX = c.max_x;
  if (c.mode === 'no_backscroll') {
    if (nx < maxX) nx = maxX;
    maxX = nx;
  } else if (nx > maxX) maxX = nx;
  return { x: nx, look, facing, max_x: maxX, mode: c.mode, walk_px_s: walk };
}

/** §11.3(b) cameraStep(c, v, world): the same rule driven by a SimView. */
export function cameraStep(c: CameraState, v: SimView, world: World): CameraState {
  const p = v?.player;
  if (!c || !p || typeof p.x !== 'number') return c;
  return camStep(c, p.x, p.state === 'dead' ? 0 : p.vx, p.facing < 0 ? -1 : 1, world);
}

/** Is a world x (cells) inside the view of camera c? `margin` shrinks the view on both sides. */
export function inView(c: CameraState, x: number, margin = 0): boolean {
  return x >= c.x + margin && x <= c.x + VIEW_W - margin;
}
