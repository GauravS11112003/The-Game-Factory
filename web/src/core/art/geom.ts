/** Geometry and seeded randomness for the art pipeline (pure, deterministic; no DOM). */
import type { RectCells } from '../types.gen.ts';

export type P = [number, number];
/** A polyline vertex with its width: [x, y, w] (cells, cells, px). */
export type V = [number, number, number];

export const CELL = 16;
const TAU = Math.PI * 2;

/** FNV-1a 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seeded xorshift32 → [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

/** Quantize to 1/64 cell (the ink quantum), so serialized art is stable. */
export function q64(x: number): number {
  return Math.round(x * 64) / 64;
}

export function polyLen(v: ReadonlyArray<V | P>): number {
  let L = 0;
  for (let i = 1; i < v.length; i++) L += dist(v[i - 1][0], v[i - 1][1], v[i][0], v[i][1]);
  return L;
}

/** Turn angle at vertex i (degrees, 0 = straight). */
export function turnDeg(a: V | P, b: V | P, c: V | P): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return 0;
  const cos = clamp((ux * vx + uy * vy) / (lu * lv), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Resample an open polyline at a fixed arc-length step (keeps both ends), interpolating widths. */
export function resample(v: ReadonlyArray<V>, step: number): V[] {
  if (v.length < 2) return v.map((p) => [p[0], p[1], p[2]] as V);
  const out: V[] = [[v[0][0], v[0][1], v[0][2]]];
  let carry = 0;
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1];
    const b = v[i];
    const L = dist(a[0], a[1], b[0], b[1]);
    if (L < 1e-9) continue;
    let t = step - carry;
    while (t < L) {
      const f = t / L;
      out.push([lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)]);
      t += step;
    }
    carry = L - (t - step);
  }
  const last = v[v.length - 1];
  const tail = out[out.length - 1];
  if (dist(tail[0], tail[1], last[0], last[1]) > step * 0.25) out.push([last[0], last[1], last[2]]);
  else out[out.length - 1] = [last[0], last[1], last[2]];
  return out;
}

/** Chaikin corner cutting; open polylines keep their end points. */
export function chaikin(v: ReadonlyArray<V>, iters: number, closed: boolean): V[] {
  let cur: V[] = v.map((p) => [p[0], p[1], p[2]] as V);
  for (let k = 0; k < iters; k++) {
    if (cur.length < 3) return cur;
    const next: V[] = [];
    const n = cur.length;
    if (!closed) next.push(cur[0]);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % n];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], 0.75 * a[2] + 0.25 * b[2]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], 0.25 * a[2] + 0.75 * b[2]]);
    }
    if (!closed) next.push(cur[n - 1]); // the first/last cut points are collinear with the kept ends: no kink
    cur = next;
  }
  return cur;
}

/** Ramer-Douglas-Peucker; returns the kept vertices (ends always kept). */
export function rdp(v: ReadonlyArray<V>, eps: number): V[] {
  if (v.length < 3) return v.slice() as V[];
  const keep = new Uint8Array(v.length);
  keep[0] = 1;
  keep[v.length - 1] = 1;
  const stack: [number, number][] = [[0, v.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = v[i0];
    const b = v[i1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    let best = -1;
    let bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const p = v[i];
      const d = L < 1e-9 ? dist(p[0], p[1], a[0], a[1]) : Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L;
      // a width change is a feature too: keep vertices where the width bends by > 1 px
      const tw = L < 1e-9 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L);
      const dw = Math.abs(p[2] - lerp(a[2], b[2], clamp(tw, 0, 1))) / CELL;
      const s = Math.max(d, dw);
      if (s > best) {
        best = s;
        bi = i;
      }
    }
    if (best > eps && bi > 0) {
      keep[bi] = 1;
      stack.push([i0, bi], [bi, i1]);
    }
  }
  const out: V[] = [];
  for (let i = 0; i < v.length; i++) if (keep[i]) out.push(v[i]);
  return out;
}

/** Moving-average smoothing of the width channel (odd window). */
export function smoothWidths(v: V[], window: number, closed: boolean): void {
  const n = v.length;
  if (n < 3) return;
  const h = Math.floor(window / 2);
  const src = v.map((p) => p[2]);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let k = -h; k <= h; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      s += src[j];
      c++;
    }
    v[i][2] = s / c;
  }
}

export function bboxOfFlat(pts: ArrayLike<number>, pad = 0): RectCells {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return [0, 0, 0, 0];
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export function unionBox(a: RectCells, b: RectCells): RectCells {
  if (a[2] <= a[0] && a[3] <= a[1]) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** A closed polygon approximating a circle (flat, cells), first point not repeated. */
export function circlePts(cx: number, cy: number, r: number, n = 20, phase = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

/** Points of a regular star (flat, cells), closed. */
export function starPts(cx: number, cy: number, r: number, inner: number, points = 5, rot = -Math.PI / 2): number[] {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 === 0 ? r : r * inner;
    const a = rot + (i / (points * 2)) * TAU;
    out.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  return out;
}

export function flat(v: ReadonlyArray<V | P>): number[] {
  const out: number[] = [];
  for (const p of v) out.push(q64(p[0]), q64(p[1]));
  return out;
}

export function widths(v: ReadonlyArray<V>): number[] {
  return v.map((p) => Math.round(p[2] * 100) / 100);
}

/** Add a seeded wobble (perpendicular jitter, amplitude in px) to a polyline, ends included. */
export function wobble(v: V[], ampPx: number, r: () => number, wavelengthC = 1.5): V[] {
  if (v.length < 2) return v;
  const out: V[] = [];
  const ph1 = r() * TAU;
  const ph2 = r() * TAU;
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    if (i > 0) s += dist(v[i - 1][0], v[i - 1][1], v[i][0], v[i][1]);
    const a = v[Math.max(0, i - 1)];
    const b = v[Math.min(v.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    const k = (TAU * s) / wavelengthC;
    const off = ((Math.sin(k + ph1) * 0.65 + Math.sin(2.7 * k + ph2) * 0.35) * ampPx) / CELL;
    out.push([v[i][0] + nx * off, v[i][1] + ny * off, v[i][2]]);
  }
  return out;
}

/** Signed area (px or cells) of a flat polygon; positive = clockwise on a y-down screen. */
export function signedArea(poly: ArrayLike<number>): number {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
  }
  return a / 2;
}

/** Clip a convex polygon (flat) by the half-plane n·p ≤ c (Sutherland-Hodgman). */
export function clipHalfPlane(poly: number[], nx: number, ny: number, c: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[2 * i];
    const ay = poly[2 * i + 1];
    const j = (i + 1) % n;
    const bx = poly[2 * j];
    const by = poly[2 * j + 1];
    const da = nx * ax + ny * ay - c;
    const db = nx * bx + ny * by - c;
    if (da <= 0) out.push(ax, ay);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

/** Voronoi cells of seeds inside a rectangle (each a convex flat polygon). */
export function voronoiCells(seeds: P[], rect: RectCells): number[][] {
  const base = [rect[0], rect[1], rect[2], rect[1], rect[2], rect[3], rect[0], rect[3]];
  return seeds.map((s, i) => {
    let poly = base.slice();
    for (let j = 0; j < seeds.length && poly.length >= 6; j++) {
      if (j === i) continue;
      const o = seeds[j];
      const nx = o[0] - s[0];
      const ny = o[1] - s[1];
      const mx = (o[0] + s[0]) / 2;
      const my = (o[1] + s[1]) / 2;
      poly = clipHalfPlane(poly, nx, ny, nx * mx + ny * my);
    }
    return poly;
  });
}
