/**
 * Stroke cleanup (PLAN_V2 §7.2): resample to 0.125 cell, 2 Chaikin iterations between corners (turns > 60° are
 * kept), RDP ε 0.075 cell; widths smoothed (window 9) and clamped to 3-10 px; taps become dots ≥ 10 px; near-touching
 * ends (≤ 3 px) of closed shapes are closed. Paper strokes arrive as vectors and are re-inked in the canonical
 * marker palette by the renderer (owner decision 5).
 */
import type { InkColor, InkStroke, Origin } from '../types.gen.ts';
import { ART } from '../params.ts';
import { CELL, chaikin, clamp, dist, polyLen, rdp, resample, smoothWidths, turnDeg } from './geom.ts';
import type { V } from './geom.ts';

export interface CleanStroke {
  id: string;
  color: InkColor;
  origin: Origin;
  kind: InkStroke['kind'];
  v: V[]; // centreline [x, y, w_px]
  closed: boolean;
  dot: boolean; // a tap: v has one vertex whose w is the diameter
}

export interface CleanOpts {
  rdpEps?: number; // cells; 0 keeps the dense resampled line (terrain is aligned first, simplified after)
  minDotPx?: number; // taps render as dots ≥ 10 px; creature eyes use a smaller floor
  widthPx?: readonly [number, number];
  widthScale?: number;
}

const C = ART.clean;

function widthAt(s: InkStroke, i: number): number {
  const w = s.w.length === s.pts.length ? s.w[i] : s.w.length ? s.w[Math.min(i, s.w.length - 1)] : 0.6;
  return (Number.isFinite(w) && w > 0 ? w : 0.6) * CELL;
}

export function cleanStroke(s: InkStroke, o: CleanOpts = {}): CleanStroke {
  const eps = o.rdpEps ?? C.rdp_eps_c;
  const [wmin, wmax] = o.widthPx ?? (C.width_px as readonly [number, number]);
  const ws = o.widthScale ?? 1;
  const raw: V[] = [];
  s.pts.forEach((p, i) => {
    const prev = raw[raw.length - 1];
    if (prev && dist(prev[0], prev[1], p[0], p[1]) < 1e-6) return;
    raw.push([p[0], p[1], widthAt(s, i) * ws]);
  });
  const base = { id: s.id, color: s.color, origin: s.origin, kind: s.kind };
  const L = polyLen(raw);
  if (raw.length === 0) return { ...base, v: [], closed: false, dot: false };
  if (s.kind === 'dot' || raw.length === 1 || L < 0.12) {
    let cx = 0;
    let cy = 0;
    let wm = 0;
    for (const p of raw) {
      cx += p[0];
      cy += p[1];
      wm = Math.max(wm, p[2]);
    }
    const ext = raw.length > 1 ? L * CELL : 0;
    const d = Math.max(o.minDotPx ?? C.tap_min_px, wm, ext);
    return { ...base, v: [[cx / raw.length, cy / raw.length, d]], closed: true, dot: true };
  }
  const ends = dist(raw[0][0], raw[0][1], raw[raw.length - 1][0], raw[raw.length - 1][1]);
  const closed = s.closed || s.kind === 'blob' || (raw.length > 3 && L > 0.75 && ends * CELL <= C.close_ends_px);
  if (closed && raw.length > 2 && ends < 1e-6) raw.pop();

  // corners on the raw line (turn > 60°) split it into pieces that are smoothed independently. A coarsely
  // vectorized closed blob (few points) only keeps its sharp corners (> 100°: a triangle flag stays pointy, a
  // pentagon-ish monster becomes round again)
  const n = raw.length;
  const cornerDeg = closed && n < 8 ? 100 : C.corner_keep_deg;
  const corners: number[] = [];
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    const a = raw[(i - 1 + n) % n];
    const b = raw[i];
    const c = raw[(i + 1) % n];
    if (turnDeg(a, b, c) > cornerDeg) corners.push(i);
  }

  let v: V[] = [];
  if (closed && corners.length === 0) {
    const loop = resample([...raw, raw[0]], C.resample_c);
    loop.pop();
    v = chaikin(loop, C.chaikin_iters, true);
  } else {
    const cuts = closed ? [...corners, corners[0] + n] : [0, ...corners, n - 1];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const piece: V[] = [];
      for (let i = cuts[k]; i <= cuts[k + 1]; i++) piece.push(raw[i % n]);
      const sm = chaikin(resample(piece, C.resample_c), C.chaikin_iters, false);
      if (v.length) sm.shift();
      v.push(...sm);
    }
    if (closed && v.length > 2) v.pop(); // the loop's last corner repeats the first
  }
  smoothWidths(v, C.width_window, closed);
  for (const p of v) p[2] = clamp(p[2], wmin, wmax);
  if (eps > 0 && v.length > 2) {
    if (closed) {
      const r = rdp([...v, v[0]], eps);
      r.pop();
      v = r.length >= 3 ? r : v;
    } else v = rdp(v, eps);
  }
  return { ...base, v, closed, dot: false };
}

/** Simplify an already-cleaned (dense) stroke, e.g. after top-edge alignment. */
export function simplify(c: CleanStroke, eps: number): CleanStroke {
  if (c.dot || c.v.length < 3) return c;
  if (c.closed) {
    const r = rdp([...c.v, c.v[0]], eps);
    r.pop();
    return { ...c, v: r.length >= 3 ? r : c.v };
  }
  return { ...c, v: rdp(c.v, eps) };
}

export function strokeBox(cs: CleanStroke[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cs)
    for (const p of c.v) {
      const h = p[2] / CELL / 2;
      x0 = Math.min(x0, p[0] - h);
      y0 = Math.min(y0, p[1] - h);
      x1 = Math.max(x1, p[0] + h);
      y1 = Math.max(y1, p[1] + h);
    }
  if (x0 === Infinity) return [0, 0, 0, 0];
  return [x0, y0, x1, y1];
}

/** Map cleaned strokes through x' = ox + (x − ax)·s, y' = oy + (y − ay)·s (widths scale too, clamped). */
export function transformStrokes(cs: CleanStroke[], ax: number, ay: number, s: number, ox: number, oy: number): CleanStroke[] {
  const ws = clamp(Math.sqrt(s), 0.6, 1.4);
  return cs.map((c) => ({
    ...c,
    v: c.v.map((p) => [ox + (p[0] - ax) * s, oy + (p[1] - ay) * s, c.dot ? p[2] * clamp(s, 0.5, 1.5) : clamp(p[2] * ws, 2, 12)] as V),
  }));
}
