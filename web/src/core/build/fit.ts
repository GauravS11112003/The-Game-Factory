/**
 * Geometry fitting (§3.4): ink → fitted shapes. Collision and art both derive from these shapes.
 *
 *  1. Top envelope: per 1 px column, the top of the ink (the bottom for ceilings).
 *  2. Continuous piecewise fit: recursive splitting into ≤ 6 segments, each angle snapped to {0°, ±26.57°, ±45°};
 *     a split is accepted only while the snapped fit deviates by > 0.35 cell. Drawn steps (≥ 55° over ≥ 0.75 cell)
 *     are kept as breaks.
 *  3. Lattice path (DP over the tile alphabet): flats, 1:1 and 1:2 runs, vertical steps only at drawn steps.
 *     1-row height changes become 1:2 ramps (2 cells per row), never staircases, and every column stays within
 *     0.85 cell of the ink top (fit residual ≤ 0.35 + row snap ≤ 0.5).
 * The unstraightened "as drawn" surface (N1 undone) is the per-column row staircase of the raw envelope.
 */
import { FIT } from '../params.ts';
import type { InkStroke, ShapeWall, SurfaceSeg } from '../types.gen.ts';
import { strokeMedianW, strokePts, strokeWidths } from '../ink/stroke.ts';
import { clamp, q16, rdp, roundHalfUp, segAngle, dist } from '../util/geom.ts';
import type { P, Rect } from '../util/geom.ts';

export const STEP = 1 / 16;

export interface Envelope {
  x0: number; // x of sample 0 (cells)
  step: number;
  ys: number[]; // NaN where there is no ink
}

export interface Brk {
  x: number; // vertex x where a vertical step is allowed
  hi: number; // upper y of the drawn step
  lo: number; // lower y
}

/** Per-column top (or bottom) of the ink, 1 px resolution. */
export function envelope(strokes: readonly InkStroke[], mode: 'top' | 'bottom'): Envelope {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const s of strokes) {
    for (const p of s.pts) {
      const r = s.kind === 'dot' ? (s.w[0] ?? 0.5) / 2 : 0;
      minX = Math.min(minX, p[0] - r);
      maxX = Math.max(maxX, p[0] + r);
    }
  }
  if (minX === Infinity) return { x0: 0, step: STEP, ys: [] };
  const x0 = Math.floor(minX * 16) / 16;
  const n = Math.max(1, Math.round((maxX - x0) / STEP) + 1);
  const ys = new Array<number>(n).fill(NaN);
  const top = mode === 'top';
  const put = (x: number, y: number): void => {
    const i = Math.round((x - x0) / STEP);
    if (i < 0 || i >= n) return;
    const cur = ys[i];
    if (Number.isNaN(cur) || (top ? y < cur : y > cur)) ys[i] = y;
  };
  for (const s of strokes) {
    if (s.kind === 'dot') {
      const [cx, cy] = s.pts[0];
      const r = (s.w[0] ?? 0.5) / 2;
      for (let x = cx - r; x <= cx + r + 1e-9; x += STEP) {
        const h = Math.sqrt(Math.max(0, r * r - (x - cx) * (x - cx)));
        put(x, top ? cy - h : cy + h);
      }
      continue;
    }
    const pts = strokePts(s);
    const w = s.kind === 'blob' ? pts.map(() => 0) : strokeWidths(s);
    const ring = s.kind === 'blob' || s.closed ? [...pts, pts[0]] : pts;
    const wr = s.kind === 'blob' || s.closed ? [...w, w[0]] : w;
    if (ring.length === 1) {
      put(ring[0][0], ring[0][1] + (top ? -wr[0] / 2 : wr[0] / 2));
      continue;
    }
    for (let k = 1; k < ring.length; k++) {
      const [ax, ay] = ring[k - 1];
      const [bx, by] = ring[k];
      const ha = wr[k - 1] / 2;
      const hb = wr[k] / 2;
      const dx = bx - ax;
      if (Math.abs(dx) < STEP) {
        const y = top ? Math.min(ay - ha, by - hb) : Math.max(ay + ha, by + hb);
        put((ax + bx) / 2, y);
        continue;
      }
      const xs = Math.min(ax, bx);
      const xe = Math.max(ax, bx);
      for (let x = Math.ceil(xs * 16) / 16; x <= xe + 1e-9; x += STEP) {
        const t = (x - ax) / dx;
        const y = ay + (by - ay) * t;
        const h = ha + (hb - ha) * t;
        put(x, top ? y - h : y + h);
      }
    }
  }
  // close 1-2 px holes so a fast pen stroke stays one surface
  for (let i = 1; i < n - 1; i++) {
    if (!Number.isNaN(ys[i])) continue;
    let j = i;
    while (j < n && Number.isNaN(ys[j])) j++;
    if (j - i <= 3 && i > 0 && j < n) {
      for (let k = i; k < j; k++) ys[k] = ys[i - 1] + ((ys[j] - ys[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return { x0, step: STEP, ys };
}

export function envX(e: Envelope, i: number): number {
  return e.x0 + i * e.step;
}

/** Centreline x extent of strokes (the span a surface covers). */
export function coreSpan(strokes: readonly InkStroke[]): [number, number] {
  let a = Infinity;
  let b = -Infinity;
  for (const s of strokes) {
    for (const p of s.pts) {
      a = Math.min(a, p[0]);
      b = Math.max(b, p[0]);
    }
  }
  return a === Infinity ? [0, 0] : [a, b];
}

/** Drawn steps: polyline pieces steeper than 55° over ≥ 0.75 cell (§3.7 step 2). */
export function drawnSteps(strokes: readonly InkStroke[]): Brk[] {
  const out: Brk[] = [];
  for (const s of strokes) {
    if (s.kind !== 'line' || s.pts.length < 2) continue;
    const simp = rdp(strokePts(s), 0.1);
    for (let k = 1; k < simp.length; k++) {
      const a = simp[k - 1];
      const b = simp[k];
      if (dist(a, b) < FIT.drawn_step.min_len_c) continue;
      if (Math.abs(segAngle(a, b)) < FIT.drawn_step.min_angle_deg) continue;
      out.push({ x: (a[0] + b[0]) / 2, hi: Math.min(a[1], b[1]), lo: Math.max(a[1], b[1]) });
    }
  }
  return out.sort((p, q) => p.x - q.x);
}

// ---- continuous piecewise fit ------------------------------------------------------------------

export const SLOPES = [0, 0.5, -0.5, 1, -1] as const; // dy/dx in cells (y down): −1 rises 45° to the right

export interface CSeg {
  x0: number;
  x1: number;
  s: number;
  c: number; // y = s·x + c
  dev: number;
}

export interface CFit {
  segs: CSeg[];
  residual: number; // max robust deviation over all segments (cells)
}

interface Samples {
  xs: number[];
  ys: number[];
}

function samplesOf(e: Envelope, x0: number, x1: number, stride = 4): Samples {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < e.ys.length; i += stride) {
    const x = envX(e, i);
    if (x < x0 - 1e-9 || x > x1 + 1e-9 || Number.isNaN(e.ys[i])) continue;
    xs.push(x);
    ys.push(e.ys[i]);
  }
  return { xs, ys };
}

function fitLine(xs: number[], ys: number[], i0: number, i1: number): { s: number; c: number; dev: number } {
  let best = { s: 0, c: 0, dev: Infinity };
  const n = i1 - i0;
  if (n <= 0) return { s: 0, c: 0, dev: 0 };
  for (const s of SLOPES) {
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += ys[i] - s * xs[i];
    const c = sum / n;
    const devs: number[] = [];
    for (let i = i0; i < i1; i++) devs.push(Math.abs(ys[i] - s * xs[i] - c));
    devs.sort((a, b) => a - b);
    const dev = devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.95))]; // robust to pen blips
    const score = dev + 0.02 * Math.abs(s);
    if (score < best.dev + 0.02 * Math.abs(best.s) - 1e-9) best = { s, c, dev };
  }
  return best;
}

/** Recursive snapped-angle fit of one break-free span, ≤ maxSegs segments. */
function fitSpan(sm: Samples, maxSegs: number): CSeg[] {
  const { xs, ys } = sm;
  if (!xs.length) return [];
  type Part = { i0: number; i1: number; s: number; c: number; dev: number };
  const mk = (i0: number, i1: number): Part => ({ i0, i1, ...fitLine(xs, ys, i0, i1) });
  const parts: Part[] = [mk(0, xs.length)];
  const minPts = 3; // ≥ 0.5 cell at a 4-sample stride (0.25 cell)
  while (parts.length < maxSegs) {
    let worst = -1;
    for (let k = 0; k < parts.length; k++) if (parts[k].dev > FIT.split_min_dev_c && (worst < 0 || parts[k].dev > parts[worst].dev)) worst = k;
    if (worst < 0) break;
    const p = parts[worst];
    if (p.i1 - p.i0 < 2 * minPts) break;
    let bestSplit = -1;
    let bestScore = Infinity;
    for (let m = p.i0 + minPts; m <= p.i1 - minPts; m++) {
      const a = fitLine(xs, ys, p.i0, m);
      const b = fitLine(xs, ys, m, p.i1);
      const sc = Math.max(a.dev, b.dev);
      if (sc < bestScore - 1e-9) {
        bestScore = sc;
        bestSplit = m;
      }
    }
    if (bestSplit < 0 || bestScore >= p.dev - 1e-6) break;
    parts.splice(worst, 1, mk(p.i0, bestSplit), mk(bestSplit, p.i1));
  }
  return parts.map((p) => ({ x0: xs[p.i0], x1: xs[p.i1 - 1], s: p.s, c: p.c, dev: p.dev }));
}

/** Snapped-angle fit of a whole envelope, split at drawn steps. */
export function fitContinuous(e: Envelope, breaks: readonly Brk[]): CFit {
  const valid: number[] = [];
  e.ys.forEach((y, i) => {
    if (!Number.isNaN(y)) valid.push(i);
  });
  if (!valid.length) return { segs: [], residual: 0 };
  const xa = envX(e, valid[0]);
  const xb = envX(e, valid[valid.length - 1]);
  const cuts = [xa, ...breaks.map((b) => b.x).filter((x) => x > xa + 0.25 && x < xb - 0.25), xb];
  const segs: CSeg[] = [];
  const budget = Math.max(1, FIT.max_segments);
  for (let k = 1; k < cuts.length; k++) {
    const sm = samplesOf(e, cuts[k - 1] + (k > 1 ? 0.1 : 0), cuts[k] - (k < cuts.length - 1 ? 0.1 : 0));
    segs.push(...fitSpan(sm, budget));
  }
  return { segs, residual: segs.reduce((m, s) => Math.max(m, s.dev), 0) };
}

export function evalFit(f: CFit, x: number): number {
  if (!f.segs.length) return 0;
  let best = f.segs[0];
  let bd = Infinity;
  for (const s of f.segs) {
    const d = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  const xc = clamp(x, best.x0, best.x1);
  return best.s * xc + best.c;
}

// ---- lattice path (DP) ------------------------------------------------------------------------

const CLS_FLAT = 0;
const CLS_UP11 = 1;
const CLS_DN11 = 2;
const CLS_UP12 = 3;
const CLS_DN12 = 4;
const CLS_START = 5;
const NCLS = 6;
const CLASS_COST = [0, 0.06, 0.06, 0.03, 0.03, 0];
const CHANGE = 0.35;

export interface LatticeOpts {
  flatOnly?: boolean; // ceilings
  maxDev?: number; // hard bound (I2): 0.85
}

/**
 * Best lattice path over integer columns [cA, cB) for target heights t(c) (cells, at column centres).
 * Vertex heights are multiples of 0.5; a half height only occurs inside a 1:2 pair.
 */
export function latticePath(t: (c: number) => number, cA: number, cB: number, breakXs: ReadonlySet<number>, o: LatticeOpts = {}): SurfaceSeg[] {
  const ncol = cB - cA;
  if (ncol <= 0) return [];
  const maxDev = o.maxDev ?? FIT.max_shift_c;
  let tmin = Infinity;
  let tmax = -Infinity;
  const tv: number[] = [];
  for (let c = cA; c < cB; c++) {
    const v = t(c);
    tv.push(v);
    tmin = Math.min(tmin, v);
    tmax = Math.max(tmax, v);
  }
  const lo2 = Math.max(0, 2 * Math.floor(tmin) - 6);
  const hi2 = Math.min(54, 2 * Math.ceil(tmax) + 6);
  const H = hi2 - lo2 + 1;
  const S = H * NCLS;
  const INF = 1e18;
  let cur = new Float64Array(S).fill(INF);
  const back: Int32Array[] = [];
  // start: any even height, class START
  for (let h = lo2; h <= hi2; h++) if (h % 2 === 0) cur[(h - lo2) * NCLS + CLS_START] = 0;
  for (let ci = 0; ci < ncol; ci++) {
    const x = cA + ci;
    // vertical steps at vertex x
    const stepHere = ci > 0 && (o.flatOnly || breakXs.has(x));
    const jumpFrom = new Int32Array(S).fill(-1);
    if (stepHere) {
      const before = cur.slice();
      for (let h = lo2; h <= hi2; h += 1) {
        if (h % 2) continue;
        let best = INF;
        let arg = -1;
        for (let g = lo2; g <= hi2; g++) {
          if (g % 2) continue;
          for (let k = 0; k < NCLS; k++) {
            const v = before[(g - lo2) * NCLS + k];
            if (v >= INF) continue;
            const cost = v + (g === h ? 0 : (o.flatOnly ? 0.3 : 0.05) + 0.2 * (Math.abs(g - h) / 2));
            if (cost < best) {
              best = cost;
              arg = (g - lo2) * NCLS + k;
            }
          }
        }
        const idx = (h - lo2) * NCLS + CLS_START;
        if (arg >= 0 && best < cur[idx]) {
          cur[idx] = best;
          jumpFrom[idx] = arg;
        }
      }
    }
    const next = new Float64Array(S).fill(INF);
    const bp = new Int32Array(S).fill(-1);
    const target = tv[ci];
    const relax = (fromIdx: number, h2: number, cls: number, prevCls: number, base: number): void => {
      if (h2 < lo2 || h2 > hi2) return;
      const idx = (h2 - lo2) * NCLS + cls;
      const midFrom = Math.floor(fromIdx / NCLS) + lo2;
      const mid = (midFrom + h2) / 4;
      const dev = Math.abs(mid - target);
      let cost = base + dev + CLASS_COST[cls] + (dev > maxDev ? 10 : 0);
      if (prevCls !== CLS_START && prevCls !== cls) cost += CHANGE;
      if (cost < next[idx]) {
        next[idx] = cost;
        bp[idx] = fromIdx;
      }
    };
    for (let g = lo2; g <= hi2; g++) {
      for (let k = 0; k < NCLS; k++) {
        const fromIdx = (g - lo2) * NCLS + k;
        const base = cur[fromIdx];
        if (base >= INF) continue;
        if (g % 2) {
          if (k === CLS_UP12) relax(fromIdx, g - 1, CLS_UP12, CLS_UP12, base);
          else if (k === CLS_DN12) relax(fromIdx, g + 1, CLS_DN12, CLS_DN12, base);
          continue;
        }
        relax(fromIdx, g, CLS_FLAT, k, base);
        if (o.flatOnly) continue;
        relax(fromIdx, g - 2, CLS_UP11, k, base);
        relax(fromIdx, g + 2, CLS_DN11, k, base);
        // a new 1:2 pair starts only from an even height; continuing a finished pair is free of change cost
        relax(fromIdx, g - 1, CLS_UP12, k, base);
        relax(fromIdx, g + 1, CLS_DN12, k, base);
      }
    }
    back.push(bp);
    back.push(jumpFrom);
    cur = next;
  }
  // end on an even height
  let bestIdx = -1;
  let best = INF;
  for (let h = lo2; h <= hi2; h += 1) {
    if (h % 2) continue;
    for (let k = 0; k < NCLS; k++) {
      const v = cur[(h - lo2) * NCLS + k];
      if (v < best) {
        best = v;
        bestIdx = (h - lo2) * NCLS + k;
      }
    }
  }
  if (bestIdx < 0) return [];
  // backtrack: per-column start/end heights (half rows) and classes; a jump separates a column from the last
  const hs = new Array<number>(ncol).fill(0);
  const he = new Array<number>(ncol).fill(0);
  const cls = new Array<number>(ncol).fill(0);
  const jumped = new Array<boolean>(ncol).fill(false);
  let idx = bestIdx;
  for (let ci = ncol - 1; ci >= 0; ci--) {
    const bp = back[2 * ci];
    const jf = back[2 * ci + 1];
    he[ci] = Math.floor(idx / NCLS) + lo2;
    cls[ci] = idx % NCLS;
    const prev = bp[idx] >= 0 ? bp[idx] : idx;
    hs[ci] = Math.floor(prev / NCLS) + lo2;
    if (jf[prev] >= 0) {
      jumped[ci] = true;
      idx = jf[prev];
    } else idx = prev;
  }
  const segs: SurfaceSeg[] = [];
  const famOf = (k: number): number => k;
  let s0 = 0;
  for (let ci = 1; ci <= ncol; ci++) {
    if (ci === ncol || jumped[ci] || famOf(cls[ci]) !== famOf(cls[s0])) {
      const xa = cA + s0;
      const xb = cA + ci;
      const ya = hs[s0] / 2;
      const yb = he[ci - 1] / 2;
      segs.push({ a: [xa, ya], b: [xb, yb], slope: (yb - ya) / (xb - xa) });
      s0 = ci;
    }
  }
  return mergeSegs(segs);
}

/** Merge collinear neighbours (same slope, touching ends). */
export function mergeSegs(segs: SurfaceSeg[]): SurfaceSeg[] {
  const out: SurfaceSeg[] = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && p.slope === s.slope && p.b[0] === s.a[0] && p.b[1] === s.a[1]) p.b = [s.b[0], s.b[1]];
    else out.push({ a: [s.a[0], s.a[1]], b: [s.b[0], s.b[1]], slope: s.slope });
  }
  return out;
}

export interface SurfaceFit {
  raw: SurfaceSeg[]; // per-column staircase of the raw envelope ("as drawn")
  fitted: SurfaceSeg[]; // the straightened lattice path (N1)
  residual: number; // continuous-fit residual (H17, D5)
  maxShift: number; // max per-column |fitted − ink top| (I2)
  span: [number, number]; // integer columns [x0, x1)
  bumpsRaw: number; // 1-row bumps in the raw staircase
}

/** Fit a surface (ground, platform: top envelope; ceiling: bottom envelope, flat only). */
export function fitSurface(strokes: readonly InkStroke[], kind: 'floor' | 'ceiling', worldW: number): SurfaceFit {
  const env = envelope(strokes, kind === 'floor' ? 'top' : 'bottom');
  const [sx0, sx1] = coreSpan(strokes);
  const cA = clamp(roundHalfUp(sx0), 0, worldW);
  let cB = clamp(roundHalfUp(sx1), 0, worldW);
  if (cB <= cA) cB = Math.min(worldW, cA + 1);
  const breaks = kind === 'floor' ? drawnSteps(strokes) : [];
  const cf = fitContinuous(env, breaks);
  // mean raw envelope per column
  const colMean = (c: number): number => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < env.ys.length; i++) {
      const x = envX(env, i);
      if (x >= c && x < c + 1 && !Number.isNaN(env.ys[i])) {
        s += env.ys[i];
        n++;
      }
    }
    if (n) return s / n;
    // nearest sample
    let best = NaN;
    let bd = Infinity;
    for (let i = 0; i < env.ys.length; i++) {
      if (Number.isNaN(env.ys[i])) continue;
      const d = Math.abs(envX(env, i) - (c + 0.5));
      if (d < bd) {
        bd = d;
        best = env.ys[i];
      }
    }
    return Number.isNaN(best) ? 0 : best;
  };
  const raw: SurfaceSeg[] = [];
  const rows: number[] = [];
  for (let c = cA; c < cB; c++) rows.push(clamp(roundHalfUp(colMean(c)), 0, 27));
  for (let i = 0; i < rows.length; i++) raw.push({ a: [cA + i, rows[i]], b: [cA + i + 1, rows[i]], slope: 0 });
  let bumps = 0;
  for (let i = 1; i < rows.length - 1; i++) if (rows[i] !== rows[i - 1] && rows[i + 1] === rows[i - 1]) bumps++;
  const breakXs = new Set(breaks.map((b) => roundHalfUp(b.x)));
  const target = (c: number): number => (cf.segs.length ? evalFit(cf, c + 0.5) : colMean(c));
  const fitted = latticePath(target, cA, cB, breakXs, { flatOnly: kind === 'ceiling' });
  let maxShift = 0;
  for (let c = cA; c < cB; c++) {
    const y = surfaceYAt(fitted, c + 0.5);
    if (y !== null) maxShift = Math.max(maxShift, Math.abs(y - colMean(c)));
  }
  return { raw: mergeSegs(raw), fitted, residual: cf.residual, maxShift, span: [cA, cB], bumpsRaw: bumps };
}

/** Height of a lattice surface at x (the lowest seg covering x wins at vertical steps), or null. */
export function surfaceYAt(segs: readonly SurfaceSeg[], x: number): number | null {
  let y: number | null = null;
  for (const s of segs) {
    if (x < s.a[0] - 1e-9 || x > s.b[0] + 1e-9) continue;
    const t = s.b[0] > s.a[0] ? (x - s.a[0]) / (s.b[0] - s.a[0]) : 0;
    const v = s.a[1] + (s.b[1] - s.a[1]) * t;
    y = y === null ? v : Math.min(y, v);
  }
  return y;
}

export function segsSpan(segs: readonly SurfaceSeg[]): [number, number] {
  if (!segs.length) return [0, 0];
  let a = Infinity;
  let b = -Infinity;
  for (const s of segs) {
    a = Math.min(a, s.a[0], s.b[0]);
    b = Math.max(b, s.a[0], s.b[0]);
  }
  return [a, b];
}

export function segsBBox(segs: readonly SurfaceSeg[], thick = 1): Rect {
  const [a, b] = segsSpan(segs);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of segs) {
    y0 = Math.min(y0, s.a[1], s.b[1]);
    y1 = Math.max(y1, s.a[1], s.b[1]);
  }
  return [a, y0, b, y1 + thick];
}

/** Wall fit: column round(x_centre − w/2), width = fitted width rounded (≥ 1), rows round(y_top)..bottom. */
export function fitWall(strokes: readonly InkStroke[]): ShapeWall {
  let sx = 0;
  let sl = 0;
  let yTop = Infinity;
  let yBot = -Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;
  const pw = strokes.length ? strokeMedianW(strokes[0]) : 0.5;
  for (const s of strokes) {
    const pts = strokePts(s);
    const hw = strokeMedianW(s) / 2;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      yTop = Math.min(yTop, p[1] - hw);
      yBot = Math.max(yBot, p[1] + hw);
      xMin = Math.min(xMin, p[0]);
      xMax = Math.max(xMax, p[0]);
      const L = i > 0 ? dist(pts[i - 1], p) : 0;
      sx += p[0] * (L || 0.01);
      sl += L || 0.01;
    }
  }
  const xc = sl > 0 ? sx / sl : (xMin + xMax) / 2;
  const width = Math.max(1, roundHalfUp(xMax - xMin + pw));
  const col = roundHalfUp(xc - width / 2);
  const y0 = clamp(roundHalfUp(yTop), 0, 26);
  const y1 = clamp(Math.max(y0 + 1, roundHalfUp(yBot)), 1, 27);
  return { k: 'wall', x: col, y0, y1, w: width };
}

/** N13: creature hitbox from the glyph bbox, ≤ 2×2 cells keeping the aspect, ≥ 0.75 cell per side. */
export function fitCreatureBox(bbox: Rect): { w: number; h: number } {
  const bw = Math.max(1e-3, bbox[2] - bbox[0]);
  const bh = Math.max(1e-3, bbox[3] - bbox[1]);
  const s = Math.min(1, FIT.creature_max_c / Math.max(bw, bh));
  return { w: q16(Math.max(FIT.creature_min_c, bw * s)), h: q16(Math.max(FIT.creature_min_c, bh * s)) };
}

/** Sum of a polyline's points (for drift bookkeeping). */
export function centroidOf(pts: readonly P[]): P {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / Math.max(1, pts.length), y / Math.max(1, pts.length)];
}
