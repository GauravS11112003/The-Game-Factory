/**
 * Plane geometry in cells (x right, y down). Pure and allocation-light; shared by ink, scene, build and design.
 * Not used by sim/bot/replay (their own step code avoids trig), so Math.atan2/hypot are fine here.
 */
export type P = [number, number];
export type Rect = [number, number, number, number]; // [x0, y0, x1, y1], half-open

export const EPS = 1e-9;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Quantize to 1/16 cell (one world px), the format's cell precision (§2.1). */
export function q16(x: number): number {
  return Math.round(x * 16) / 16;
}

/** Quantize to 1/64 cell, the ink precision (§3.2). */
export function q64(x: number): number {
  return Math.round(x * 64) / 64;
}

/** Round half away from zero at .5 boundaries in a way that is identical in every JS engine. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

export function dist(a: P, b: P): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function polyLength(pts: readonly P[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

export function bboxOf(pts: readonly P[], pad = 0): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return [0, 0, 0, 0];
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function rectUnion(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function rectGrow(r: Rect, d: number): Rect {
  return [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
}

export function rectW(r: Rect): number {
  return r[2] - r[0];
}

export function rectH(r: Rect): number {
  return r[3] - r[1];
}

export function rectCenter(r: Rect): P {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}

export function rectContains(r: Rect, p: P): boolean {
  return p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3];
}

export function rectInside(inner: Rect, outer: Rect): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a[0] <= b[2] + margin && b[0] <= a[2] + margin && a[1] <= b[3] + margin && b[1] <= a[3] + margin;
}

/** Gap between two rects (0 when they overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}

/** Overlap length of [a0, a1] and [b0, b1] (0 when disjoint). */
export function overlap1(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function distPtSeg(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > EPS ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function orient(a: P, b: P, c: P): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function segsIntersect(a: P, b: P, c: P, d: P): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function distSegSeg(a: P, b: P, c: P, d: P): number {
  if (segsIntersect(a, b, c, d)) return 0;
  return Math.min(distPtSeg(a, c, d), distPtSeg(b, c, d), distPtSeg(c, a, b), distPtSeg(d, a, b));
}

/** Minimum distance between two polylines (a single point counts as a degenerate polyline). */
export function distPolyPoly(A: readonly P[], B: readonly P[]): number {
  if (!A.length || !B.length) return Infinity;
  let best = Infinity;
  const na = Math.max(1, A.length - 1);
  const nb = Math.max(1, B.length - 1);
  for (let i = 0; i < na; i++) {
    const a0 = A[i];
    const a1 = A[Math.min(i + 1, A.length - 1)];
    for (let j = 0; j < nb; j++) {
      const d = distSegSeg(a0, a1, B[j], B[Math.min(j + 1, B.length - 1)]);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  return best;
}

export function distPtPoly(p: P, A: readonly P[]): number {
  if (A.length === 1) return dist(p, A[0]);
  let best = Infinity;
  for (let i = 1; i < A.length; i++) best = Math.min(best, distPtSeg(p, A[i - 1], A[i]));
  return best;
}

/** Ramer-Douglas-Peucker simplification. */
export function rdp(pts: readonly P[], eps: number): P[] {
  if (pts.length <= 2) return pts.map((p) => [p[0], p[1]] as P);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let dmax = 0;
    let idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = distPtSeg(pts[i], pts[i0], pts[i1]);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (idx >= 0 && dmax > eps) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out: P[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push([pts[i][0], pts[i][1]]);
  return out;
}

/** Resample a polyline at a fixed arc-length step (keeps both ends). */
export function resample(pts: readonly P[], step: number): P[] {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]] as P);
  const out: P[] = [[pts[0][0], pts[0][1]]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = dist(a, b);
    if (L < EPS) continue;
    let t = step - carry;
    while (t <= L) {
      out.push([a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L]);
      t += step;
    }
    carry = L - (t - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail, last) > step * 0.25) out.push([last[0], last[1]]);
  return out;
}

export function polyArea(poly: readonly P[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return Math.abs(s) / 2;
}

export function polyPerimeter(poly: readonly P[]): number {
  if (poly.length < 2) return 0;
  return polyLength(poly) + dist(poly[poly.length - 1], poly[0]);
}

export function polyCentroid(poly: readonly P[]): P {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < EPS) {
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / Math.max(1, poly.length), sy / Math.max(1, poly.length)];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPoly(p: P, poly: readonly P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi + EPS) + xi) inside = !inside;
  }
  return inside;
}

/** Principal axes of a point set: centre, axis angle (degrees, (−90, 90], 0 = horizontal, + = rising to the right). */
export interface Pca {
  cx: number;
  cy: number;
  angle: number;
  ux: number;
  uy: number;
  major: number; // extent along the axis
  minor: number; // extent across it
}

export function pca(pts: readonly P[]): Pca {
  const n = pts.length;
  if (!n) return { cx: 0, cy: 0, angle: 0, ux: 1, uy: 0, major: 0, minor: 0 };
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // radians, axis direction in screen coords
  let ux = Math.cos(th);
  let uy = Math.sin(th);
  if (ux < 0 || (Math.abs(ux) < EPS && uy > 0)) {
    ux = -ux;
    uy = -uy;
  }
  let lo = Infinity;
  let hi = -Infinity;
  let plo = Infinity;
  let phi = -Infinity;
  for (const p of pts) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const u = dx * ux + dy * uy;
    const v = -dx * uy + dy * ux;
    if (u < lo) lo = u;
    if (u > hi) hi = u;
    if (v < plo) plo = v;
    if (v > phi) phi = v;
  }
  // screen y is down: "rising to the right" is a negative uy
  let angle = (-Math.atan2(uy, ux) * 180) / Math.PI;
  if (angle <= -90) angle += 180;
  if (angle > 90) angle -= 180;
  return { cx, cy, angle, ux, uy, major: hi - lo, minor: phi - plo };
}

/** Angle of the segment a→b in degrees, (−90, 90], 0 = horizontal, + = rising to the right. */
export function segAngle(a: P, b: P): number {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  if (dx < 0) {
    dx = -dx;
    dy = -dy;
  }
  let ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (ang <= -90) ang += 180;
  if (ang > 90) ang -= 180;
  return ang;
}

/** Turning angle at b (degrees, 0 = straight on, 180 = full reversal). */
export function turnAngle(a: P, b: P, c: P): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < EPS || lv < EPS) return 0;
  const cos = clamp((ux * vx + uy * vy) / (lu * lv), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(s.length - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function mean(xs: readonly number[]): number {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Deep clone of plain JSON data (the core targets ES2022 without structuredClone). */
export function clone<T>(x: T): T {
  return x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T);
}

/** Number formatting for ids and digests: at most `d` decimals, no trailing zeros. */
export function fmt(x: number, d = 2): string {
  const f = 10 ** d;
  const v = Math.round(x * f) / f;
  return Object.is(v, -0) ? '0' : String(v);
}
