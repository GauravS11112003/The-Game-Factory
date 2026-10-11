/**
 * Body shapes from drawings (docs/v6/CONTRACTS_V6.md §2 physics.shape), pure. All coordinates are object-local px
 * (before scale and rotation) around the object's centre.
 *   auto   → convex hull of the points, grown by half the stroke width. Static bodies whose hull is a poor fit
 *            (covered area < 85%: a cup, a star, two pipes) are split instead: closed strokes into ≤ 8 convex parts (ear clipping +
 *            Hertel-Mehlhorn merging, no dependency), open strokes into chains like `line`.
 *   box    → the drawing's bounding box. circle → radius max(w, h) / 2 at the box centre.
 *   line   → every stroke becomes a chain of thick segments following the pen (terrain).
 */
import type { Drawing } from '../../core/types.gen.ts';

export type Pt = [number, number];

export interface Segment {
  a: Pt;
  b: Pt;
  r: number; // half thickness
}

export type ShapeSpec =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'box'; cx: number; cy: number; w: number; h: number }
  | { kind: 'poly'; parts: Pt[][] }
  | { kind: 'chain'; segments: Segment[]; parts?: Pt[][] };

interface StrokeLike {
  points: Pt[];
  width: number;
  closed: boolean;
}

export function strokesOf(d: Drawing | null | undefined): StrokeLike[] {
  const out: StrokeLike[] = [];
  for (const s of d?.strokes ?? []) {
    if (!s || !Array.isArray(s.points)) continue;
    const pts: Pt[] = [];
    for (const p of s.points) {
      if (!Array.isArray(p)) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
    }
    if (pts.length) out.push({ points: pts, width: Math.max(1, Math.min(80, Number(s.width) || 6)), closed: s.closed === true && pts.length > 2 });
  }
  return out;
}

export function bounds(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Monotone-chain convex hull, counter-clockwise in a y-up sense (clockwise on screen). */
export function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polyArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Ramer-Douglas-Peucker simplification. */
export function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bd = eps;
    for (let i = s + 1; i < e; i++) {
      // distance to the chord (to the point itself when a closed outline starts and ends at the same place)
      const d = len < 1e-9 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay) : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > bd) {
        bd = d;
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

/** Grow a convex polygon outward from its centroid by `d`. */
export function grow(poly: Pt[], d: number): Pt[] {
  if (d <= 0 || poly.length < 3) return poly;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of poly) {
    cx += x;
    cy += y;
  }
  cx /= poly.length;
  cy /= poly.length;
  return poly.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / l) * d, y + ((y - cy) / l) * d] as Pt;
  });
}

function isConvex(poly: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

function pointInTri(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Ear clipping: triangles as index triples (null when the polygon is not simple enough). */
export function earClip(poly: Pt[]): [number, number, number][] | null {
  const n = poly.length;
  if (n < 3) return null;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (polyArea(poly) < 0) idx.reverse(); // make it positive-area
  const tris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = poly[ia];
      const b = poly[ib];
      const c = poly[ic];
      if (cross(a, b, c) <= 1e-9) continue; // reflex
      let inside = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(poly[j], a, b, c)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** Merge triangles sharing edges into convex polygons (Hertel-Mehlhorn). Returns index lists. */
export function mergeConvex(poly: Pt[], tris: [number, number, number][]): number[][] {
  const polys: number[][] = tris.map((t) => [...t]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const A = polys[i];
        const B = polys[j];
        for (let ai = 0; ai < A.length; ai++) {
          const a0 = A[ai];
          const a1 = A[(ai + 1) % A.length];
          const bj = B.findIndex((v, k) => v === a1 && B[(k + 1) % B.length] === a0);
          if (bj < 0) continue;
          // splice B (minus the shared edge) into A after a0
          const rest: number[] = [];
          for (let k = 2; k < B.length; k++) rest.push(B[(bj + k) % B.length]);
          const U = [...A.slice(0, ai + 1), ...rest, ...A.slice(ai + 1)];
          if (isConvex(U.map((v) => poly[v]))) {
            polys[i] = U;
            polys.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  return polys;
}

/** A closed outline as ≤ maxParts convex polygons (null when it cannot be done). */
export function decompose(outline: Pt[], maxParts = 8): Pt[][] | null {
  let poly = rdp([...outline, outline[0]], 2.5);
  poly.pop();
  // drop duplicates
  poly = poly.filter((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.5;
  });
  if (poly.length < 3) return null;
  if (isConvex(poly)) return [poly];
  const tris = earClip(poly);
  if (!tris) return null;
  const parts = mergeConvex(poly, tris).map((ix) => ix.map((i) => poly[i])).filter((p) => Math.abs(polyArea(p)) > 4);
  return parts.length && parts.length <= maxParts ? parts : null;
}

/** A stroke as thick segments (simplified so long terrain stays light). */
export function chainSegments(s: StrokeLike, minR = 4): Segment[] {
  const r = Math.max(minR, s.width / 2);
  const pts = rdp(s.closed ? [...s.points, s.points[0]] : s.points, 1.5);
  const out: Segment[] = [];
  if (pts.length === 1) return [{ a: pts[0], b: pts[0], r }];
  for (let i = 1; i < pts.length; i++) out.push({ a: pts[i - 1], b: pts[i], r });
  return out;
}

/** The body shape for a drawing (see the header). `body` is the PhysicsDef body. */
export function shapeFor(d: Drawing | null | undefined, shape: string, body: string, w0 = Number(d?.w) || 0, h0 = Number(d?.h) || 0): ShapeSpec {
  const strokes = strokesOf(d);
  const all = strokes.flatMap((s) => s.points);
  const avgW = strokes.length ? strokes.reduce((a, s) => a + s.width, 0) / strokes.length : 6;
  if (!all.length) {
    // invisible box (zones, spawners, sensors)
    return { kind: 'box', cx: 0, cy: 0, w: Math.max(4, w0), h: Math.max(4, h0) };
  }
  const bb = bounds(all);
  const half = avgW / 2;
  const bw = bb.maxX - bb.minX + avgW;
  const bh = bb.maxY - bb.minY + avgW;
  const cx = (bb.minX + bb.maxX) / 2;
  const cy = (bb.minY + bb.maxY) / 2;
  if (shape === 'line') return { kind: 'chain', segments: strokes.flatMap((s) => chainSegments(s)) };
  if (shape === 'circle') return { kind: 'circle', cx, cy, r: Math.max(3, Math.max(bw, bh) / 2) };
  if (shape === 'box') return { kind: 'box', cx, cy, w: Math.max(4, bw), h: Math.max(4, bh) };
  const hull = convexHull(all);
  const hullArea = Math.abs(polyArea(hull));
  if (hull.length < 3 || hullArea < 16) {
    // a dot or a straight line: a box around it (thin lines stay thin)
    if ((body === 'static' || body === 'kinematic') && strokes.length) return { kind: 'chain', segments: strokes.flatMap((s) => chainSegments(s)) };
    return { kind: 'box', cx, cy, w: Math.max(4, bw), h: Math.max(4, bh) };
  }
  if (body === 'static' || body === 'kinematic') {
    const closed = strokes.filter((s) => s.closed);
    const covered = closed.reduce((a, s) => a + Math.abs(polyArea(s.points)), 0);
    const fit = Math.min(1, covered / hullArea);
    if (fit < 0.85) {
      const parts: Pt[][] = [];
      const segments: Segment[] = [];
      for (const s of strokes) {
        if (s.closed) {
          const dec = decompose(s.points);
          if (dec) parts.push(...dec.map((p) => grow(p, s.width / 2)));
          else parts.push(grow(convexHull(s.points), s.width / 2));
        } else segments.push(...chainSegments(s));
      }
      if (parts.length + segments.length > 0) return { kind: 'chain', segments, parts };
    }
  }
  return { kind: 'poly', parts: [grow(hull, half)] };
}
