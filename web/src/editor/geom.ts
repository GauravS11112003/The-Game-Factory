/**
 * Vector geometry for the long-canvas editor (§3.2, §6.3). Everything is in cells (16 world px), y down.
 * Pure functions: resampling, RDP simplification, straight-line fitting, hit tests, lasso and eraser splitting.
 */
import type { CellXY, InkStroke, RectCells } from '../core/types.gen.ts';
import { CANVAS, WORLD } from '../core/params.ts';

export interface Pt {
  x: number;
  y: number;
  w: number; // width in cells
}

export const INK_Q = WORLD.ink_quantum; // 1/64 cell

export function q(v: number, step = INK_Q): number {
  return Math.round(v / step) * step;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Polyline length in cells. */
export function polyLength(pts: readonly { x: number; y: number }[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
  return L;
}

/** Resample a polyline to (about) `step` cells between points, interpolating width. Keeps both ends. */
export function resample(pts: readonly Pt[], step: number = CANVAS.resample_c): Pt[] {
  if (pts.length < 2) return pts.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...pts[0] }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a.x, a.y, b.x, b.y);
    if (seg === 0) continue;
    let t = step - carry;
    while (t <= seg) {
      const u = t / seg;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail.x, tail.y, last.x, last.y) > step * 0.25) out.push({ ...last });
  else out[out.length - 1] = { ...last };
  return out;
}

function perpDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return dist(p.x, p.y, a.x, a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(L2);
}

/** Ramer-Douglas-Peucker with ε in cells (iterative, keeps widths of kept points). */
export function rdp<T extends { x: number; y: number }>(pts: readonly T[], eps: number = CANVAS.rdp_eps_c): T[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let best = -1;
    let bestD = eps;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Max perpendicular deviation of the points from the chord first→last (the "straight line" residual, §6.3). */
export function chordResidual(pts: readonly { x: number; y: number }[]): number {
  if (pts.length < 3) return 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let m = 0;
  for (let i = 1; i < pts.length - 1; i++) m = Math.max(m, perpDist(pts[i], a, b));
  return m;
}

/** Marker width from pointer pressure: 0.75 cell ± 20% (§6.3). Mice report 0.5 while pressed. */
export function markerWidth(pressure: number, pointerType: string): number {
  const base = CANVAS.marker_px / WORLD.cell_px;
  const p = pointerType === 'mouse' || !(pressure > 0) ? 0.5 : Math.min(1, Math.max(0, pressure));
  return base * (1 + CANVAS.marker_pressure * (2 * p - 1));
}

/** Turn raw pointer samples into the stored stroke points: resample 0.125 cell, RDP 0.03 cell, 1/64 quantized. */
export function finishPoints(raw: readonly Pt[]): Pt[] {
  const simplified = rdp(resample(raw));
  return simplified.map((p) => ({ x: q(p.x), y: q(p.y), w: q(p.w, 1 / 256) }));
}

export function strokePts(s: InkStroke): Pt[] {
  return s.pts.map((p, i) => ({ x: p[0], y: p[1], w: s.w[Math.min(i, s.w.length - 1)] ?? 0.75 }));
}

export function toStrokeArrays(pts: readonly Pt[]): { pts: CellXY[]; w: number[] } {
  return { pts: pts.map((p) => [q(p.x), q(p.y)] as CellXY), w: pts.map((p) => q(p.w, 1 / 256)) };
}

export function strokeBBox(s: InkStroke): RectCells {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  s.pts.forEach((p, i) => {
    const r = (s.kind === 'dot' ? s.w[0] ?? 0.875 : s.w[Math.min(i, s.w.length - 1)] ?? 0.75) / 2;
    x0 = Math.min(x0, p[0] - r);
    y0 = Math.min(y0, p[1] - r);
    x1 = Math.max(x1, p[0] + r);
    y1 = Math.max(y1, p[1] + r);
  });
  return [x0, y0, x1, y1];
}

export function unionBBox(boxes: readonly RectCells[]): RectCells | null {
  if (!boxes.length) return null;
  const r: RectCells = [Infinity, Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    r[0] = Math.min(r[0], b[0]);
    r[1] = Math.min(r[1], b[1]);
    r[2] = Math.max(r[2], b[2]);
    r[3] = Math.max(r[3], b[3]);
  }
  return r;
}

export function strokesBBox(strokes: readonly InkStroke[]): RectCells | null {
  return unionBBox(strokes.map(strokeBBox));
}

/** Distance from a point to a segment. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + dx * t, ay + dy * t);
}

export function pointInPolygon(x: number, y: number, poly: readonly { x: number; y: number }[] | readonly CellXY[]): boolean {
  let inside = false;
  const n = poly.length;
  const P = (i: number): [number, number] => {
    const p = poly[i] as { x: number; y: number } | CellXY;
    return Array.isArray(p) ? [p[0], p[1]] : [(p as { x: number }).x, (p as { y: number }).y];
  };
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = P(i);
    const [xj, yj] = P(j);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Hit distance of a point to a stroke's inked area (≤ 0 means inside the ink). */
export function strokeHitDist(s: InkStroke, x: number, y: number): number {
  if (s.kind === 'dot') return dist(x, y, s.pts[0][0], s.pts[0][1]) - (s.w[0] ?? 0.875) / 2;
  if ((s.kind === 'blob' || s.closed) && s.pts.length >= 3 && pointInPolygon(x, y, s.pts)) {
    if (s.kind === 'blob') return -1;
    // Small loops (creatures, coins, flags) are picked by their inside; big outlines only by their edge.
    const b = strokeBBox(s);
    return (b[2] - b[0]) * (b[3] - b[1]) <= 12 ? -0.01 : edgeDist(s, x, y);
  }
  return edgeDist(s, x, y);
}

function edgeDist(s: InkStroke, x: number, y: number): number {
  let best = Infinity;
  const n = s.pts.length;
  if (n === 1) return dist(x, y, s.pts[0][0], s.pts[0][1]) - (s.w[0] ?? 0.75) / 2;
  const segs = s.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = s.pts[i];
    const b = s.pts[(i + 1) % n];
    const w = ((s.w[Math.min(i, s.w.length - 1)] ?? 0.75) + (s.w[Math.min(i + 1, s.w.length - 1)] ?? 0.75)) / 2;
    best = Math.min(best, segDist(x, y, a[0], a[1], b[0], b[1]) - w / 2);
  }
  return best;
}

/** Densify a stroke's centreline to `step` cells (for lasso and eraser tests). */
export function densify(s: InkStroke, step = 0.125): Pt[] {
  const pts = strokePts(s);
  if (s.closed && pts.length > 2) pts.push({ ...pts[0] });
  return resample(pts, step);
}

/** Fraction of a stroke's (densified) centreline inside a lasso polygon. */
export function insideFraction(s: InkStroke, poly: readonly { x: number; y: number }[]): number {
  if (s.kind === 'dot') return pointInPolygon(s.pts[0][0], s.pts[0][1], poly) ? 1 : 0;
  const pts = densify(s, 0.25);
  if (!pts.length) return 0;
  let k = 0;
  for (const p of pts) if (pointInPolygon(p.x, p.y, poly)) k++;
  return k / pts.length;
}

/**
 * Eraser scrub (§6.3): remove every centreline point within `r` cells of the eraser path and split lines into the
 * remaining runs. Dots and blobs touched anywhere are deleted whole. Returns null when the stroke is untouched.
 */
export function eraseStroke(s: InkStroke, path: readonly { x: number; y: number }[], r: number): { pts: Pt[] }[] | null {
  const near = (x: number, y: number, pad: number): boolean => {
    if (path.length === 1) return dist(x, y, path[0].x, path[0].y) <= r + pad;
    for (let i = 1; i < path.length; i++) {
      if (segDist(x, y, path[i - 1].x, path[i - 1].y, path[i].x, path[i].y) <= r + pad) return true;
    }
    return false;
  };
  if (s.kind === 'dot') return near(s.pts[0][0], s.pts[0][1], (s.w[0] ?? 0.875) / 2) ? [] : null;
  const dense = densify(s, 0.125);
  const hit = dense.map((p) => near(p.x, p.y, p.w / 2));
  if (!hit.some(Boolean)) return null;
  if (s.kind === 'blob' || s.stamp) return [];
  const runs: { pts: Pt[] }[] = [];
  let cur: Pt[] = [];
  dense.forEach((p, i) => {
    if (hit[i]) {
      if (cur.length) runs.push({ pts: cur });
      cur = [];
    } else cur.push(p);
  });
  if (cur.length) runs.push({ pts: cur });
  return runs
    .filter((run) => run.pts.length >= 2 && polyLength(run.pts) >= 0.2)
    .map((run) => ({ pts: finishPoints(run.pts) }));
}

/** Translate a stroke by (dx, dy) cells. */
export function moved(s: InkStroke, dx: number, dy: number): InkStroke {
  return { ...s, pts: s.pts.map((p) => [q(p[0] + dx), q(p[1] + dy)] as CellXY) };
}

/** A stroke's angle in degrees from horizontal (first → last point), in (-90, 90]. */
export function chordAngleDeg(pts: readonly { x: number; y: number }[]): number {
  if (pts.length < 2) return 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;
  return deg;
}

export function rectsOverlap(a: RectCells, b: RectCells): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function rectCenter(r: RectCells): CellXY {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
}

/** Grow a box to at least `min` cells in each dimension (centred), so thin lines can overlap. */
export function padBox(b: RectCells, min = 1): RectCells {
  const w = b[2] - b[0];
  const hh = b[3] - b[1];
  const dx = Math.max(0, (min - w) / 2);
  const dy = Math.max(0, (min - hh) / 2);
  return [b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy];
}

/** Intersection over union of two boxes (0 when they do not overlap). */
export function iou(a: RectCells, b: RectCells): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Same points and widths (a parent stroke the kid has not moved). */
export function samePts(a: InkStroke, b: InkStroke): boolean {
  if (a.pts.length !== b.pts.length) return false;
  for (let i = 0; i < a.pts.length; i++) {
    if (Math.abs(a.pts[i][0] - b.pts[i][0]) > 1e-6 || Math.abs(a.pts[i][1] - b.pts[i][1]) > 1e-6) return false;
  }
  return true;
}
