/** Per-stroke geometry (§3.2): centreline, widths, extents, ink area, closure. */
import type { InkStroke } from '../types.gen.ts';
import { bboxOf, dist, polyArea, polyLength } from '../util/geom.ts';
import type { P, Rect } from '../util/geom.ts';

export function strokePts(s: InkStroke): P[] {
  return s.pts.map((p) => [p[0], p[1]] as P);
}

/** Width per point (a single width is repeated; a dot's width is its diameter). */
export function strokeWidths(s: InkStroke): number[] {
  const n = s.pts.length;
  if (!s.w.length) return new Array(n).fill(0.5);
  if (s.w.length >= n) return s.w.slice(0, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(s.w[Math.min(i, s.w.length - 1)]);
  return out;
}

export function strokeMedianW(s: InkStroke): number {
  const w = [...strokeWidths(s)].sort((a, b) => a - b);
  return w.length ? w[w.length >> 1] : 0.5;
}

/** Ink extents including half the pen width. */
export function strokeBBox(s: InkStroke): Rect {
  if (s.kind === 'dot') {
    const r = (s.w[0] ?? 0.875) / 2;
    const [x, y] = s.pts[0];
    return [x - r, y - r, x + r, y + r];
  }
  if (s.kind === 'blob') return bboxOf(strokePts(s), 0);
  const w = strokeWidths(s);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  s.pts.forEach(([x, y], i) => {
    const r = w[i] / 2;
    x0 = Math.min(x0, x - r);
    y0 = Math.min(y0, y - r);
    x1 = Math.max(x1, x + r);
    y1 = Math.max(y1, y + r);
  });
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Centreline extents (no pen width): the x range a surface spans. */
export function strokeCoreBBox(s: InkStroke): Rect {
  return bboxOf(strokePts(s), 0);
}

export function strokeLength(s: InkStroke): number {
  if (s.kind === 'dot') return 0;
  const pts = strokePts(s);
  return s.kind === 'blob' || s.closed ? polyLength(pts) + (pts.length > 1 ? dist(pts[pts.length - 1], pts[0]) : 0) : polyLength(pts);
}

/** A closed outline: blobs and closed lines, or a line whose ends nearly meet. */
export function isClosedStroke(s: InkStroke): boolean {
  if (s.kind === 'dot') return false;
  if (s.kind === 'blob' || s.closed) return s.pts.length >= 3;
  if (s.pts.length < 4) return false;
  const w = strokeMedianW(s);
  const gap = dist(s.pts[0] as P, s.pts[s.pts.length - 1] as P);
  const L = polyLength(strokePts(s));
  return gap <= Math.max(0.5, 1.5 * w) && L >= 3 * Math.max(gap, 0.5) && L >= 1.2;
}

/** Ink area in cells² (lines: length × width; blobs: polygon area; dots: disc). */
export function strokeInkArea(s: InkStroke): number {
  if (s.kind === 'dot') {
    const r = (s.w[0] ?? 0.875) / 2;
    return Math.PI * r * r;
  }
  if (s.kind === 'blob') return polyArea(strokePts(s));
  const w = strokeWidths(s);
  let a = 0;
  for (let i = 1; i < s.pts.length; i++) a += dist(s.pts[i - 1] as P, s.pts[i] as P) * ((w[i - 1] + w[i]) / 2);
  const r = (w[0] ?? 0.5) / 2;
  return a + Math.PI * r * r; // round caps
}

/** Distance from a stroke's centreline to another's, minus nothing (centreline to centreline). */
export function strokeCentrelines(s: InkStroke): P[] {
  if (s.kind === 'blob' || (s.closed && s.pts.length > 2)) {
    const pts = strokePts(s);
    return [...pts, pts[0]];
  }
  return strokePts(s);
}
