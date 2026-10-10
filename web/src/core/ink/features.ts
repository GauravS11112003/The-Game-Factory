/**
 * Glyph features (§3.2 InkComponent.f) and the richer geometry the grammar needs. Definitions (normative for the
 * canvas path; lane C's paper features follow the same definitions, docs/v2/CONTRACTS.md §3.10):
 *   fill     ink area / bbox area
 *   circ     4π·A / P² of the largest closed outline (0 for open ink, 1 for a dot)
 *   straight chord / path length of the longest stroke
 *   zigN     monotone runs (perpendicular reversals + 1, hysteresis 0.12 cell) per cell along the principal axis
 *   zigAmp   median peak-to-trough amplitude of those reversals (cells)
 *   aspect   major / minor extent along the principal axes (minor ≥ the pen width)
 *   holes    outlined (not filled) closed loops
 *   w        median pen width (cells)
 *   corners  turns > 45° on the RDP(max(0.08, 0.35·w)) polylines
 *   spokes   open strokes pointing radially out of a closed loop
 *   bumps    radius maxima (prominence ≥ 6% of the mean radius) around the largest closed outline
 *   is_dot   a tap, or max side ≤ 0.9 cell with fill ≥ 0.5
 */
import type { ComponentFeatures, InkColor, InkStroke } from '../types.gen.ts';
import {
  bboxOf, dist, mean, pca, polyArea, polyCentroid, polyLength, polyPerimeter, rdp, rectUnion, resample, turnAngle,
} from '../util/geom.ts';
import type { P, Pca, Rect } from '../util/geom.ts';
import { isClosedStroke, strokeBBox, strokeInkArea, strokeLength, strokeMedianW, strokePts } from './stroke.ts';

export interface Geo {
  strokes: InkStroke[];
  color: InkColor;
  bbox: Rect; // ink extents (with pen width)
  core: Rect; // centreline extents
  w: number;
  len: number; // total centreline length
  area: number; // ink area
  closed: boolean;
  outline: P[] | null; // largest closed outline
  enclosed: number; // area inside that outline
  diam: number; // max bbox side
  cx: number;
  cy: number;
  pca: Pca;
  angle: number; // principal axis (deg)
  straight: number;
  longest: InkStroke;
  zigN: number;
  zigAmp: number;
  reversals: number;
  teeth: number;
  extent: number; // along the principal axis
  corners: number;
  spokes: number;
  bumps: number;
  holes: number;
  fill: number;
  circ: number;
  aspect: number;
  isDot: boolean;
}

function allPts(strokes: readonly InkStroke[]): P[] {
  const out: P[] = [];
  for (const s of strokes) for (const p of s.pts) out.push([p[0], p[1]]);
  return out;
}

/** Perpendicular reversals of a polyline sequence projected on (ux, uy), with hysteresis. */
function zigzag(seq: P[], ux: number, uy: number): { reversals: number; amps: number[] } {
  const H = 0.12;
  if (seq.length < 3) return { reversals: 0, amps: [] };
  const v = seq.map((p) => -p[0] * uy + p[1] * ux);
  let dir = 0; // +1 rising, −1 falling
  let ext = v[0]; // running extreme in the current direction
  let lastExtreme = v[0];
  let reversals = 0;
  const amps: number[] = [];
  let lo = v[0];
  let hi = v[0];
  for (let i = 1; i < v.length; i++) {
    const x = v[i];
    if (dir === 0) {
      hi = Math.max(hi, x);
      lo = Math.min(lo, x);
      if (hi - v[0] > H) {
        dir = 1;
        ext = hi;
      } else if (v[0] - lo > H) {
        dir = -1;
        ext = lo;
      }
      continue;
    }
    if (dir > 0) {
      if (x > ext) ext = x;
      else if (ext - x > H) {
        reversals++;
        amps.push(Math.abs(ext - lastExtreme));
        lastExtreme = ext;
        dir = -1;
        ext = x;
      }
    } else {
      if (x < ext) ext = x;
      else if (x - ext > H) {
        reversals++;
        amps.push(Math.abs(ext - lastExtreme));
        lastExtreme = ext;
        dir = 1;
        ext = x;
      }
    }
  }
  amps.push(Math.abs(ext - lastExtreme));
  return { reversals, amps: amps.slice(1) };
}

/** Concatenate strokes along the principal axis, each oriented the same way, resampled at 0.1 cell. */
function axisSequence(strokes: readonly InkStroke[], ux: number, uy: number): P[] {
  const parts = strokes
    .filter((s) => s.kind !== 'dot')
    .map((s) => {
      let pts = strokePts(s);
      const u0 = pts[0][0] * ux + pts[0][1] * uy;
      const u1 = pts[pts.length - 1][0] * ux + pts[pts.length - 1][1] * uy;
      if (u1 < u0) pts = pts.reverse();
      return { pts: resample(pts, 0.1), u: Math.min(u0, u1) };
    })
    .sort((a, b) => a.u - b.u);
  const out: P[] = [];
  for (const p of parts) out.push(...p.pts);
  return out;
}

function countCorners(s: InkStroke): number {
  if (s.kind === 'dot' || s.pts.length < 3) return 0;
  const w = strokeMedianW(s);
  const closed = isClosedStroke(s);
  const simp = rdp(strokePts(s), Math.max(0.08, 0.35 * w));
  let n = 0;
  const m = simp.length;
  if (closed && m >= 4) {
    const ring = simp.slice(0, dist(simp[0], simp[m - 1]) < 0.3 ? m - 1 : m);
    for (let i = 0; i < ring.length; i++) {
      if (turnAngle(ring[(i + ring.length - 1) % ring.length], ring[i], ring[(i + 1) % ring.length]) > 45) n++;
    }
    return n;
  }
  for (let i = 1; i < m - 1; i++) if (turnAngle(simp[i - 1], simp[i], simp[i + 1]) > 45) n++;
  return n;
}

function countBumps(outline: P[]): number {
  const perim = polyPerimeter(outline);
  if (perim < 1) return 0;
  const ring = resample([...outline, outline[0]], perim / 96);
  if (ring.length > 3 && dist(ring[0], ring[ring.length - 1]) < perim / 200) ring.pop();
  const c = polyCentroid(outline);
  const raw = ring.map((p) => dist(p, c));
  const n = raw.length;
  if (n < 12) return 0;
  const r = raw.map((_, i) => (raw[(i - 2 + n) % n] + raw[(i - 1 + n) % n] + raw[i] + raw[(i + 1) % n] + raw[(i + 2) % n]) / 5);
  const rm = mean(r);
  let bumps = 0;
  for (let i = 0; i < n; i++) {
    let isMax = true;
    let lo = Infinity;
    for (let k = -8; k <= 8; k++) {
      if (k === 0) continue;
      const rk = r[(i + k + n) % n];
      if (Math.abs(k) <= 4 && rk > r[i]) isMax = false;
      lo = Math.min(lo, rk);
    }
    if (isMax && r[i] - lo >= 0.06 * rm) {
      bumps++;
      i += 3; // a plateau counts once
    }
  }
  return bumps;
}

function countSpokes(strokes: readonly InkStroke[], outline: P[] | null, outlineStroke: InkStroke | null): number {
  if (!outline) return 0;
  const c = polyCentroid(outline);
  const rMean = mean(outline.map((p) => dist(p, c)));
  let n = 0;
  for (const s of strokes) {
    if (s === outlineStroke || s.kind === 'dot' || isClosedStroke(s)) continue;
    const L = strokeLength(s);
    if (L < 0.3 * rMean) continue;
    const a = s.pts[0] as P;
    const b = s.pts[s.pts.length - 1] as P;
    const [near, far] = dist(a, c) <= dist(b, c) ? [a, b] : [b, a];
    const dn = dist(near, c);
    const df = dist(far, c);
    if (dn > rMean * 1.35 + 0.3 || df < dn + 0.25 * rMean) continue;
    const rx = near[0] - c[0];
    const ry = near[1] - c[1];
    const sx = far[0] - near[0];
    const sy = far[1] - near[1];
    const cos = (rx * sx + ry * sy) / (Math.hypot(rx, ry) * Math.hypot(sx, sy) + 1e-9);
    if (cos > Math.cos((35 * Math.PI) / 180)) n++;
  }
  return n;
}

export function computeGeo(strokes: readonly InkStroke[]): Geo {
  const list = [...strokes];
  let bbox: Rect = strokeBBox(list[0]);
  for (const s of list.slice(1)) bbox = rectUnion(bbox, strokeBBox(s));
  const pts = allPts(list);
  const core = bboxOf(pts, 0);
  const widths = list.map((s) => strokeMedianW(s)).sort((a, b) => a - b);
  const w = widths[widths.length >> 1] ?? 0.5;
  const len = list.reduce((a, s) => a + strokeLength(s), 0);
  const area = list.reduce((a, s) => a + strokeInkArea(s), 0);
  let outline: P[] | null = null;
  let outlineStroke: InkStroke | null = null;
  let enclosed = 0;
  let holes = 0;
  for (const s of list) {
    if (!isClosedStroke(s)) continue;
    if (s.kind === 'line') holes++;
    const a = polyArea(strokePts(s));
    if (a > enclosed) {
      enclosed = a;
      outline = strokePts(s);
      outlineStroke = s;
    }
  }
  const longest = list.reduce((best, s) => (strokeLength(s) > strokeLength(best) ? s : best), list[0]);
  const bw = bbox[2] - bbox[0];
  const bh = bbox[3] - bbox[1];
  const diam = Math.max(bw, bh);
  const p = pca(pts.length ? pts : [[bbox[0], bbox[1]]]);
  const isDot = list.every((s) => s.kind === 'dot') || (diam <= 0.9 && area / Math.max(1e-6, bw * bh) >= 0.5);
  const lpts = strokePts(longest);
  const lLen = polyLength(lpts);
  const straight = longest.kind === 'dot' ? 0 : lLen > 1e-6 ? Math.min(1, dist(lpts[0], lpts[lpts.length - 1]) / lLen) : 1;
  const seq = axisSequence(list, p.ux, p.uy);
  const zz = zigzag(seq, p.ux, p.uy);
  const extent = Math.max(p.major, 1e-6);
  const amps = [...zz.amps].sort((a, b) => a - b);
  const zigAmp = amps.length ? amps[amps.length >> 1] : 0;
  const corners = list.reduce((a, s) => a + countCorners(s), 0);
  const fill = Math.min(1, area / Math.max(1e-6, bw * bh));
  let circ = 0;
  if (isDot) circ = 1;
  else if (outline) {
    const P2 = polyPerimeter(outline);
    circ = P2 > 1e-6 ? Math.min(1, (4 * Math.PI * enclosed) / (P2 * P2)) : 0;
  }
  const minor = Math.max(p.minor + w, w, 1e-3);
  const aspect = (p.major + w) / minor;
  return {
    strokes: list, color: list[0].color, bbox, core, w, len, area, closed: !!outline, outline, enclosed, diam,
    cx: (bbox[0] + bbox[2]) / 2, cy: (bbox[1] + bbox[3]) / 2, pca: p, angle: p.angle, straight, longest,
    zigN: zz.reversals ? (zz.reversals + 1) / extent : 0, zigAmp, reversals: zz.reversals, teeth: Math.ceil(zz.reversals / 2), extent,
    corners, spokes: countSpokes(list, outline, outlineStroke), bumps: outline ? countBumps(outline) : 0, holes, fill,
    circ, aspect, isDot,
  };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function featuresOf(g: Geo): ComponentFeatures {
  return {
    fill: r3(g.fill), circ: r3(g.circ), straight: r3(g.straight), zigN: r3(g.zigN), zigAmp: r3(g.zigAmp),
    aspect: r3(g.aspect), holes: g.holes, w: r3(g.w), corners: g.corners, spokes: g.spokes, bumps: g.bumps,
    is_dot: g.isDot,
  };
}
