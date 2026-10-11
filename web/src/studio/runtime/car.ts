/**
 * Car wheel maths (docs/v7/CONTRACTS_V7.md §4.2), pure (no Phaser, tested in node).
 *
 * - wheelAnchor: where a wheel joint attaches. The maker's drawing wins: the wheel sits where it was drawn relative to
 *   the body, unless the joint's `at`/`to_at` agree with the drawing within half a wheel (then the joint is kept). A
 *   wheel drawn far from the body goes to the joint's `at` when that is on the body, else to a bottom corner.
 * - suspensionClamp: the hard travel limit of a wheel around its anchor, in the body's frame (a soft spring does the
 *   bouncing; this guarantees a wheel never drifts off or detaches, however hard the landing).
 */

export type Vec2 = [number, number];

export interface AnchorBody {
  x: number;
  y: number;
  /** Degrees, clockwise. */
  rotation: number;
  scale: number;
  /** Drawing box (local px, before scale). */
  w: number;
  h: number;
}

export interface AnchorWheel {
  x: number;
  y: number;
  /** World radius. */
  r: number;
}

export interface WheelAnchor {
  /** Body-local attach point (px, before the body's scale), like JointDef.at. */
  at: Vec2;
  /** Wheel-local point, like JointDef.to_at. */
  to_at: Vec2;
  source: 'drawn' | 'joint' | 'corner';
}

/** World → body-local (unrotated, unscaled) coordinates. */
export function toBodyLocal(b: AnchorBody, x: number, y: number): Vec2 {
  const a = (-(b.rotation || 0) * Math.PI) / 180;
  const dx = x - b.x;
  const dy = y - b.y;
  const s = b.scale > 0 ? b.scale : 1;
  return [(dx * Math.cos(a) - dy * Math.sin(a)) / s, (dx * Math.sin(a) + dy * Math.cos(a)) / s];
}

/** Body-local → world. */
export function fromBodyLocal(b: AnchorBody, p: Vec2): Vec2 {
  const a = ((b.rotation || 0) * Math.PI) / 180;
  const s = b.scale > 0 ? b.scale : 1;
  const x = p[0] * s;
  const y = p[1] * s;
  return [b.x + x * Math.cos(a) - y * Math.sin(a), b.y + x * Math.sin(a) + y * Math.cos(a)];
}

/** Distance from a local point to the body's drawing box (0 inside). */
function outsideBox(b: AnchorBody, p: Vec2): number {
  const dx = Math.max(0, Math.abs(p[0]) - b.w / 2);
  const dy = Math.max(0, Math.abs(p[1]) - b.h / 2);
  return Math.hypot(dx, dy);
}

export function wheelAnchor(body: AnchorBody, wheel: AnchorWheel, at: Vec2 | null | undefined, toAt: Vec2 | null | undefined): WheelAnchor {
  const s = body.scale > 0 ? body.scale : 1;
  const rl = Math.max(2, wheel.r / s); // wheel radius in body-local px
  const drawn = toBodyLocal(body, wheel.x, wheel.y);
  const j: Vec2 = at && Number.isFinite(at[0]) && Number.isFinite(at[1]) ? [at[0], at[1]] : [0, 0];
  const t: Vec2 = toAt && Number.isFinite(toAt[0]) && Number.isFinite(toAt[1]) ? [toAt[0], toAt[1]] : [0, 0];
  const drawnNear = outsideBox(body, drawn) <= Math.max(rl * 2.5, Math.max(body.w, body.h) * 0.35);
  if (drawnNear) {
    const agrees = Math.hypot(j[0] - drawn[0], j[1] - drawn[1]) <= rl / 2 && Math.hypot(t[0], t[1]) <= rl / 2;
    return agrees ? { at: j, to_at: t, source: 'joint' } : { at: drawn, to_at: [0, 0], source: 'drawn' };
  }
  // drawn somewhere else entirely: trust the joint if it points at the body, else a bottom corner on the wheel's side
  if (outsideBox(body, j) <= rl * 1.5 && (j[0] !== 0 || j[1] !== 0)) return { at: j, to_at: [0, 0], source: 'joint' };
  const side = (drawn[0] || j[0] || -1) < 0 ? -1 : 1;
  const cx = side * Math.max(0, body.w / 2 - rl * 0.9);
  return { at: [cx, body.h / 2], to_at: [0, 0], source: 'corner' };
}

/**
 * Keep a wheel within its travel: `dx, dy` is the wheel centre minus its anchor (world px), `angle` the body's angle
 * (radians). Sideways (along the body's x) it may move ±lat, along the body's y between −up and +down. Returns the
 * clamped offset (world px) and which local axes hit a limit, or null when it is inside.
 */
export function suspensionClamp(dx: number, dy: number, angle: number, lat: number, up: number, down: number):
  { dx: number; dy: number; hitX: number; hitY: number } | null {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const cx = Math.max(-lat, Math.min(lat, lx));
  const cy = Math.max(-up, Math.min(down, ly));
  if (cx === lx && cy === ly) return null;
  return { dx: cx * c - cy * s, dy: cx * s + cy * c, hitX: Math.sign(lx - cx), hitY: Math.sign(ly - cy) };
}

/** Suspension travel for a wheel of radius r (world px): a little sideways play, more up and down. */
export function travelFor(r: number): { lat: number; up: number; down: number } {
  const rr = Math.max(4, r);
  return { lat: Math.max(1, rr * 0.06), up: Math.max(3, rr * 0.32), down: Math.max(2, rr * 0.22) };
}
