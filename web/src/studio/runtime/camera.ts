/**
 * The game camera's maths (docs/v7/CONTRACTS_V7.md §4.2), pure (no Phaser, tested in node). The canvas always fills the
 * screen (no letterbox bars): the view takes the screen's aspect and the zoom decides how much world it shows.
 *
 *   fixed        the whole world is visible (contain); any spare room shows the backdrop / theme colour around it.
 *   follow       the player is a comfortable size (~1/8 of the view height), never showing past the world when the
 *                world is big enough to fill the screen; smooth look-ahead in the direction of motion and damped
 *                vertical motion with a small dead zone.
 *   auto_scroll  fits the cross axis (a sideways runner sees the world's full height).
 * Zoom = screen (device) px per world px.
 */

export interface Size {
  w: number;
  h: number;
}

export interface CamWorld {
  width: number;
  height: number;
}

export type CamMode = 'fixed' | 'follow' | 'auto_scroll';
export type CamAxis = 'x' | 'y' | 'xy';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** The view (world px) that a zoom shows on a screen of `view` device px. */
export function viewWorldSize(view: Size, zoom: number): Size {
  const z = zoom > 0 ? zoom : 1;
  return { w: view.w / z, h: view.h / z };
}

/** Smallest zoom at which the view fits inside the world (nothing past the edges shows). */
export function fillZoom(view: Size, world: CamWorld): number {
  return Math.max(view.w / Math.max(1, world.width), view.h / Math.max(1, world.height));
}

/** Zoom that shows the whole world. */
export function containZoom(view: Size, world: CamWorld): number {
  return Math.min(view.w / Math.max(1, world.width), view.h / Math.max(1, world.height));
}

/**
 * Follow-camera zoom: the target (its size in world px, wheels included) about 1/8 of the view height, at least
 * ~5 target widths across, the view between 480 and 1500 world px tall; then fill the world when it is big enough.
 */
export function comfortableZoom(view: Size, world: CamWorld, target: Size | null, docZoom = 1): number {
  const th = clamp(target?.h ?? 100, 24, 600);
  const tw = clamp(target?.w ?? 100, 24, 1200);
  let vh = clamp(th * 8, 480, 1500);
  let vw = (vh * view.w) / Math.max(1, view.h);
  const minW = Math.max(tw * 5, 640);
  if (vw < minW) {
    vw = minW;
    vh = (vw * view.h) / Math.max(1, view.w);
  }
  let z = (view.h / vh) * clamp(docZoom || 1, 0.2, 5);
  const fz = fillZoom(view, world);
  // fill the screen with world when that only means zooming in a little; tiny worlds stay centred instead
  if (z < fz && fz <= z * 1.8) z = fz;
  return z;
}

/** Base zoom for a camera mode (see the header). `docZoom` is the world camera's zoom factor (1 = default). */
export function baseZoom(mode: CamMode, view: Size, world: CamWorld, target: Size | null, axis: CamAxis = 'xy', docZoom = 1): number {
  const dz = clamp(docZoom || 1, 0.2, 5);
  if (mode === 'fixed') return containZoom(view, world) * Math.max(1, dz);
  if (mode === 'auto_scroll') {
    const z = axis === 'y' ? view.w / Math.max(1, world.width) : view.h / Math.max(1, world.height);
    return z * Math.max(1, dz);
  }
  return comfortableZoom(view, world, target, dz);
}

/** Speed zoom-out: up to 14% further out at high speed, so fast games see what is coming. */
export function speedZoomFactor(speed: number): number {
  return 1 - Math.min(0.14, Math.max(0, speed - 250) / 9000);
}

/** The camera centre on one axis, clamped to the world (centred when the world is smaller than the view). */
export function clampCenter(c: number, viewSize: number, worldSize: number): number {
  if (worldSize <= viewSize) return worldSize / 2;
  return clamp(c, viewSize / 2, worldSize - viewSize / 2);
}

export interface FollowState {
  x: number;
  y: number;
  lookX: number;
  lookY: number;
}

export interface FollowInput {
  tx: number;
  ty: number;
  vx: number;
  vy: number;
  /** View size in world px. */
  vw: number;
  vh: number;
  dt: number;
  axis: CamAxis;
  snap?: boolean;
}

/**
 * One follow-camera step: look ahead toward where the target is going (smoothed, so turning around glides), track
 * horizontally tightly, damp vertical motion with a dead zone, and never let the target leave the middle 80% / 76%.
 */
export function followStep(s: FollowState, i: FollowInput): FollowState {
  const dt = Math.max(0, Math.min(0.1, i.dt));
  const k = (rate: number): number => (i.snap ? 1 : 1 - Math.exp(-dt * rate));
  const lookTX = clamp(i.vx * 0.4, -i.vw * 0.24, i.vw * 0.24);
  const lookTY = clamp(i.vy * 0.12, -i.vh * 0.08, i.vh * 0.14);
  const lookX = s.lookX + (lookTX - s.lookX) * k(1.6);
  const lookY = s.lookY + (lookTY - s.lookY) * k(1.3);
  let x = s.x;
  let y = s.y;
  if (i.axis !== 'y') {
    const want = i.tx + lookX;
    x += (want - x) * k(7);
    const lim = i.vw * 0.4;
    x = clamp(x, i.tx - lim, i.tx + lim);
  }
  if (i.axis !== 'x') {
    const want = i.ty - i.vh * 0.06 + lookY;
    const dz = i.vh * 0.06;
    const dy = want - y;
    if (i.snap) y = want;
    else if (Math.abs(dy) > dz) y += (dy - Math.sign(dy) * dz) * k(3.2);
    const lim = i.vh * 0.38;
    y = clamp(y, i.ty - lim, i.ty + lim);
  } else if (i.snap) y = i.ty - i.vh * 0.06;
  return { x, y, lookX, lookY };
}

/** Exponential approach of the zoom (gentle, so speed zoom never pumps). */
export function zoomStep(cur: number, target: number, dt: number, rate = 1.4): number {
  if (!(cur > 0)) return target;
  return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) * rate));
}

/**
 * The internal canvas size for a host element: its CSS size times the device pixel ratio (≤ 2), at most ~4.2 MP
 * and at least 320 px tall, so the game is crisp on every screen and the aspect always matches (no bars).
 */
export function canvasSize(cssW: number, cssH: number, dpr: number): Size {
  const w0 = Math.max(160, cssW || 1600);
  const h0 = Math.max(120, cssH || 900);
  let r = clamp(dpr || 1, 1, 2);
  const maxPx = 2560 * 1640;
  if (w0 * r * h0 * r > maxPx) r = Math.sqrt(maxPx / (w0 * h0));
  if (h0 * r < 320) r = 320 / h0;
  return { w: Math.round(w0 * r), h: Math.round(h0 * r) };
}
