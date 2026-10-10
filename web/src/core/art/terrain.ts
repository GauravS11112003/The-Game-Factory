/**
 * Top-edge alignment and tile geometry (PLAN_V2 §7.3): "what you see is what you stand on".
 *
 * For each terrain object Δ(x) = collision_top(x) − ink_top(x) is computed per world-px column from the compiled
 * tiles (the surface the player really stands on), bounded by the N1 shift (≤ 0.85 cell), smoothed over 5 px and
 * applied to every vertex of the object's strokes; a per-vertex pass then removes the remaining residual, so the
 * drawn line's top edge lies within 1 px of collision while the stroke keeps its own width and lower-edge texture.
 */
import type { LevelV2, SceneObject } from '../types.gen.ts';
import { ART } from '../params.ts';
import { CELL, clamp, lerp } from './geom.ts';
import type { V } from './geom.ts';
import type { CleanStroke } from './clean.ts';

export interface Grid {
  w: number;
  h: number;
  rows: string[];
}

export function decodeRow(row: string, w: number): string {
  let out = '';
  for (const m of row.matchAll(/([0-9]*)([.#=/\\abcd~X])/g)) out += m[2].repeat(m[1] ? Number(m[1]) : 1);
  if (out.length < w) out += '.'.repeat(w - out.length);
  return out.length > w ? out.slice(0, w) : out;
}

export function decodeGrid(level: LevelV2): Grid {
  const w = level.world.w;
  const h = level.world.h ?? 27;
  const rows: string[] = [];
  const src = level.compiled?.tiles?.rows ?? [];
  for (let r = 0; r < h; r++) rows.push(decodeRow(src[r] ?? `${w}.`, w));
  return { w, h, rows };
}

export function at(g: Grid, c: number, r: number): string {
  if (r < 0 || r >= g.h || c < 0 || c >= g.w) return '.';
  return g.rows[r][c];
}

const FLOOR = '#=/\\abcdX';
const COVER = '#=/\\abcdX~';
export const isFloor = (ch: string): boolean => FLOOR.includes(ch);
export const isSolid = (ch: string): boolean => ch === '#' || ch === 'X';
export const isSlope = (ch: string): boolean => '/\\abcd'.includes(ch);

/** Walkable floor height inside a cell, px from the cell top, at fraction fx ∈ [0, 1] (§2.4 table). */
export function floorPx(ch: string, fx: number): number | null {
  switch (ch) {
    case '#':
    case '=':
    case 'X':
      return 0;
    case '/':
      return 16 - 16 * fx;
    case '\\':
      return 16 * fx;
    case 'a':
      return 16 - 8 * fx;
    case 'b':
      return 8 - 8 * fx;
    case 'c':
      return 8 * fx;
    case 'd':
      return 8 + 8 * fx;
    default:
      return null;
  }
}

/** A floor cell whose top is open (nothing sits on it). */
export function exposed(g: Grid, c: number, r: number): boolean {
  return isFloor(at(g, c, r)) && !COVER.includes(at(g, c, r - 1));
}

/** The walkable collision top (cells) at world x nearest to yHint, within maxDy, or null. */
export function surfaceTop(g: Grid, x: number, yHint: number, maxDy: number): number | null {
  const c = Math.floor(x);
  const fx = clamp(x - c, 0, 1);
  let best: number | null = null;
  let bd = Infinity;
  for (let r = Math.floor(yHint - maxDy) - 1; r <= Math.ceil(yHint + maxDy) + 1; r++) {
    if (!exposed(g, c, r)) continue;
    const f = floorPx(at(g, c, r), fx);
    if (f === null) continue;
    const top = r + f / CELL;
    const d = Math.abs(top - yHint);
    if (d <= maxDy && d < bd) {
      bd = d;
      best = top;
    }
  }
  return best;
}

/** The underside (cells) of a solid run at world x nearest to yHint (ceilings). */
export function surfaceBottom(g: Grid, x: number, yHint: number, maxDy: number): number | null {
  const c = Math.floor(x);
  let best: number | null = null;
  let bd = Infinity;
  for (let r = Math.floor(yHint - maxDy) - 1; r <= Math.ceil(yHint + maxDy) + 1; r++) {
    if (!isSolid(at(g, c, r)) || isFloor(at(g, c, r + 1))) continue;
    const d = Math.abs(r + 1 - yHint);
    if (d <= maxDy && d < bd) {
      bd = d;
      best = r + 1;
    }
  }
  return best;
}

// ---- per-column ink envelope ------------------------------------------------------------------------

const STEEP_COS = 0.4; // segments steeper than ~66° are walls, not tops

/** Rasterize the top (or bottom) envelope of strokes into world-px columns [Xa, Xb]. */
export function inkEnvelope(cs: readonly CleanStroke[], Xa: number, Xb: number, face: 'top' | 'bottom'): Float64Array {
  const env = new Float64Array(Xb - Xa + 1).fill(face === 'top' ? Infinity : -Infinity);
  for (const s of cs) {
    if (s.dot) continue;
    const n = s.v.length;
    const segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = s.v[i];
      const b = s.v[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const cos = Math.abs(dx) / len;
      if (cos < STEEP_COS) continue;
      const lo = Math.ceil(Math.min(a[0], b[0]) * CELL);
      const hi = Math.floor(Math.max(a[0], b[0]) * CELL);
      for (let X = Math.max(lo, Xa); X <= Math.min(hi, Xb); X++) {
        const t = clamp((X / CELL - a[0]) / dx, 0, 1);
        const y = lerp(a[1], b[1], t);
        const hw = lerp(a[2], b[2], t) / 2 / CELL / cos;
        const k = X - Xa;
        if (face === 'top') env[k] = Math.min(env[k], y - hw);
        else env[k] = Math.max(env[k], y + hw);
      }
    }
  }
  return env;
}

function fittedY(o: SceneObject, x: number): number | null {
  if (o.shape.k !== 'surface' || !o.shape.segs.length) return null;
  const segs = [...o.shape.segs].sort((p, q) => Math.min(p.a[0], p.b[0]) - Math.min(q.a[0], q.b[0]));
  let best: number | null = null;
  let bd = Infinity;
  for (const s of segs) {
    const [x0, y0] = s.a[0] <= s.b[0] ? s.a : s.b;
    const [x1, y1] = s.a[0] <= s.b[0] ? s.b : s.a;
    if (x >= x0 && x <= x1) return x1 - x0 < 1e-9 ? Math.min(y0, y1) : lerp(y0, y1, (x - x0) / (x1 - x0));
    const d = x < x0 ? x0 - x : x - x1;
    if (d < bd) {
      bd = d;
      best = x < x0 ? y0 : y1;
    }
  }
  return best;
}

export interface AlignResult {
  strokes: CleanStroke[];
  residualPx: number; // max |art_top − collision_top| over samples every 4 px
  aligned: boolean;
}

function strokesBoundsPx(cs: readonly CleanStroke[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of cs)
    for (const p of s.v) {
      const h = p[2] / 2 / CELL;
      lo = Math.min(lo, p[0] - h);
      hi = Math.max(hi, p[0] + h);
    }
  return [Math.floor(lo * CELL), Math.ceil(hi * CELL)];
}

function fillGaps(d: Float64Array): boolean {
  let first = -1;
  for (let i = 0; i < d.length; i++)
    if (Number.isFinite(d[i])) {
      first = i;
      break;
    }
  if (first < 0) return false;
  for (let i = 0; i < first; i++) d[i] = d[first];
  let prev = first;
  for (let i = first + 1; i < d.length; i++) {
    if (!Number.isFinite(d[i])) continue;
    for (let k = prev + 1; k < i; k++) d[k] = lerp(d[prev], d[i], (k - prev) / (i - prev));
    prev = i;
  }
  for (let i = prev + 1; i < d.length; i++) d[i] = d[prev];
  return true;
}

function boxSmooth(d: Float64Array, window: number): Float64Array {
  const h = Math.floor(window / 2);
  const out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = -h; k <= h; k++) {
      const j = i + k;
      if (j < 0 || j >= d.length) continue;
      s += d[j];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

function vertexCos(v: V[], i: number, closed: boolean): number {
  const n = v.length;
  const a = v[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
  const b = v[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  return L < 1e-9 ? 1 : Math.abs(dx) / L;
}

/** Align a surface object's strokes onto the collision top (or, for ceilings, the underside). */
export function alignSurface(o: SceneObject, cs: CleanStroke[], g: Grid, face: 'top' | 'bottom'): AlignResult {
  const maxShift = ART.align.max_shift_c;
  if (!cs.length) return { strokes: cs, residualPx: 0, aligned: false };
  const [Xa, Xb] = strokesBoundsPx(cs);
  const env = inkEnvelope(cs, Xa, Xb, face);
  const col = new Float64Array(Xb - Xa + 1).fill(NaN);
  const delta = new Float64Array(Xb - Xa + 1).fill(NaN);
  for (let X = Xa; X <= Xb; X++) {
    const k = X - Xa;
    const ink = env[k];
    const xc = (X + 0.5) / CELL;
    const hint = fittedY(o, xc) ?? (Number.isFinite(ink) ? ink : null);
    if (hint === null) continue;
    const t = face === 'top' ? surfaceTop(g, xc, hint, 1.25) : surfaceBottom(g, xc, hint, 1.5);
    if (t === null) continue;
    col[k] = t;
    if (Number.isFinite(ink)) delta[k] = clamp(t - ink, -maxShift, maxShift);
  }
  if (!fillGaps(delta)) return { strokes: cs, residualPx: 0, aligned: false };
  const sm = boxSmooth(delta, ART.align.smooth_px);
  const idx = (x: number): number => clamp(Math.round(x * CELL) - Xa, 0, sm.length - 1);
  const shifted: CleanStroke[] = cs.map((s) => ({ ...s, v: s.v.map((p) => [p[0], p[1] + sm[idx(p[0])], p[2]] as V) }));
  // pass 2: per-vertex residual (top edge of a thick line at x is y ∓ (w/2)/cos θ)
  for (const s of shifted) {
    if (s.dot) continue;
    for (let i = 0; i < s.v.length; i++) {
      const p = s.v[i];
      const cos = vertexCos(s.v, i, s.closed);
      if (cos < STEEP_COS) continue;
      const k = idx(p[0]);
      const target = col[k];
      if (!Number.isFinite(target)) continue;
      const edge = face === 'top' ? p[1] - p[2] / 2 / CELL / cos : p[1] + p[2] / 2 / CELL / cos;
      const res = target - edge;
      const already = sm[k];
      if (Math.abs(res) * CELL > 0.25) p[1] += clamp(res, -maxShift - already, maxShift - already);
    }
  }
  // measure: samples every 4 px where collision exists under the ink
  const env2 = inkEnvelope(shifted, Xa, Xb, face);
  let worst = 0;
  for (let X = Xa; X <= Xb; X += 4) {
    const k = X - Xa;
    if (!Number.isFinite(col[k]) || !Number.isFinite(env2[k])) continue;
    worst = Math.max(worst, Math.abs(col[k] - env2[k]) * CELL);
  }
  return { strokes: shifted, residualPx: worst, aligned: true };
}

/** Align a wall: centre its stroke on the wall column(s) and put its top on the wall's top row. */
export function alignWall(o: SceneObject, cs: CleanStroke[], g: Grid): AlignResult {
  if (o.shape.k !== 'wall' || !cs.length) return { strokes: cs, residualPx: 0, aligned: false };
  const { x, y0, y1 } = o.shape;
  const r0 = Math.round(y0);
  const r1 = Math.max(r0 + 1, Math.round(y1));
  let bestC = -1;
  let bestN = 0;
  for (let c = Math.floor(x - 1.5); c <= Math.floor(x + 1.5); c++) {
    let n = 0;
    for (let r = r0; r < r1; r++) if (isSolid(at(g, c, r))) n++;
    if (n > bestN || (n === bestN && bestC >= 0 && Math.abs(c + 0.5 - x) < Math.abs(bestC + 0.5 - x))) {
      bestN = n;
      bestC = c;
    }
  }
  if (bestC < 0 || bestN === 0) return { strokes: cs, residualPx: 0, aligned: false };
  let c0 = bestC;
  let c1 = bestC + 1;
  const wantW = Math.max(1, Math.round(o.shape.w ?? 1));
  while (c1 - c0 < wantW && isSolid(at(g, c1, r0 + Math.floor((r1 - r0) / 2)))) c1++;
  while (c1 - c0 < wantW && isSolid(at(g, c0 - 1, r0 + Math.floor((r1 - r0) / 2)))) c0--;
  let top = r0;
  for (let r = r0 - 2; r < r1; r++)
    if (isSolid(at(g, bestC, r))) {
      top = r;
      break;
    }
  let sx = 0;
  let n = 0;
  let inkTop = Infinity;
  for (const s of cs)
    for (const p of s.v) {
      sx += p[0];
      n++;
      inkTop = Math.min(inkTop, p[1] - p[2] / 2 / CELL);
    }
  const m = ART.align.max_shift_c;
  const dx = clamp((c0 + c1) / 2 - sx / n, -m, m);
  const dy = clamp(top - inkTop, -m, m);
  const strokes = cs.map((s) => ({ ...s, v: s.v.map((p) => [p[0] + dx, p[1] + dy, p[2]] as V) }));
  return { strokes, residualPx: Math.abs(top - (inkTop + dy)) * CELL, aligned: true };
}

// ---- coverage: every collision top has art above it ----------------------------------------------------

export interface TopRun {
  pts: [number, number][]; // the collision top polyline (cells)
  oneWay: boolean;
}

/** Exposed walkable tops that no aligned terrain stroke covers within 1.5 px, as continuous runs. */
export function uncoveredTops(g: Grid, aligned: readonly CleanStroke[]): TopRun[] {
  const Xa = 0;
  const Xb = g.w * CELL;
  const env: Float64Array[] = [];
  // a column can carry several stacked surfaces: rasterize each stroke separately and test all
  for (const s of aligned) env.push(inkEnvelope([s], Xa, Xb, 'top'));
  const covered = (X: number, top: number): boolean => {
    for (const e of env) if (Math.abs(e[X - Xa] - top) * CELL <= 1.5) return true;
    return false;
  };
  const runs: TopRun[] = [];
  for (let r = 0; r < g.h; r++) {
    let cur: TopRun | null = null;
    let lastC = -2;
    let lastY = NaN;
    for (let c = 0; c < g.w; c++) {
      const ch = at(g, c, r);
      if (!exposed(g, c, r) || ch === 'X') {
        cur = null;
        continue;
      }
      let ok = 0;
      for (const fx of [0.15, 0.5, 0.85]) {
        const top = r + (floorPx(ch, fx) ?? 0) / CELL;
        if (covered(Math.floor((c + fx) * CELL), top)) ok++;
      }
      if (ok >= 2) {
        cur = null;
        continue;
      }
      const yl = r + (floorPx(ch, 0) ?? 0) / CELL;
      const yr = r + (floorPx(ch, 1) ?? 0) / CELL;
      const oneWay = ch === '=';
      if (cur && lastC === c - 1 && Math.abs(lastY - yl) < 1e-6 && cur.oneWay === oneWay) {
        cur.pts.push([c + 1, yr]);
      } else {
        cur = { pts: [[c, yl], [c + 1, yr]], oneWay };
        runs.push(cur);
      }
      lastC = c;
      lastY = yr;
    }
  }
  // slope runs continue diagonally across rows: join runs whose ends meet
  runs.sort((p, q) => p.pts[0][0] - q.pts[0][0]);
  const out: TopRun[] = [];
  for (const run of runs) {
    const prev = out.find(
      (o) => o.oneWay === run.oneWay && Math.abs(o.pts[o.pts.length - 1][0] - run.pts[0][0]) < 1e-6 &&
        Math.abs(o.pts[o.pts.length - 1][1] - run.pts[0][1]) < 1e-6,
    );
    if (prev) prev.pts.push(...run.pts.slice(1));
    else out.push(run);
  }
  return out;
}

/** Exposed side faces and undersides of solid masses (vertical / horizontal runs, cells). */
export function solidEdges(g: Grid): { pts: [number, number][]; kind: 'side' | 'bottom' | 'top' }[] {
  const out: { pts: [number, number][]; kind: 'side' | 'bottom' | 'top' }[] = [];
  const solidish = (ch: string): boolean => ch === '#' || isSlope(ch) || ch === 'X';
  for (const side of [-1, 1]) {
    for (let c = 0; c < g.w; c++) {
      let start = -1;
      for (let r = 0; r <= g.h; r++) {
        const edge = r < g.h && at(g, c, r) === '#' && !solidish(at(g, c + side, r)) && c + side >= 0 && c + side < g.w;
        if (edge && start < 0) start = r;
        if (!edge && start >= 0) {
          const x = side < 0 ? c : c + 1;
          out.push({ pts: [[x, start], [x, r]], kind: 'side' });
          start = -1;
        }
      }
    }
  }
  for (let r = 0; r < g.h - 1; r++) {
    let start = -1;
    for (let c = 0; c <= g.w; c++) {
      const edge = c < g.w && at(g, c, r) === '#' && !solidish(at(g, c, r + 1)) && at(g, c, r + 1) !== '~';
      if (edge && start < 0) start = c;
      if (!edge && start >= 0) {
        out.push({ pts: [[start, r + 1], [c, r + 1]], kind: 'bottom' });
        start = -1;
      }
    }
  }
  return out;
}

// ---- fills -----------------------------------------------------------------------------------------

export interface Region {
  polys: number[][]; // flat polygons (cells)
}

/** Solid mass regions (merged rectangles + slope wedges), split into masses and one-row floating solids. */
export function solidRegions(g: Grid): { mass: number[][]; light: number[][] } {
  const mass: number[][] = [];
  const light: number[][] = [];
  // horizontal runs of '#', merged vertically when the span repeats
  const open = new Map<string, { c0: number; c1: number; r0: number; r1: number }>();
  const flush = (k: string): void => {
    const b = open.get(k)!;
    open.delete(k);
    const poly = [b.c0, b.r0, b.c1, b.r0, b.c1, b.r1, b.c0, b.r1];
    const thick = b.r1 - b.r0 > 1 || isFloor(at(g, b.c0, b.r1)) || isFloor(at(g, b.c1 - 1, b.r1));
    (thick ? mass : light).push(poly);
  };
  for (let r = 0; r < g.h; r++) {
    const spans: string[] = [];
    let c = 0;
    while (c < g.w) {
      if (at(g, c, r) !== '#') {
        c++;
        continue;
      }
      const c0 = c;
      while (c < g.w && at(g, c, r) === '#') c++;
      spans.push(`${c0}:${c}`);
    }
    for (const k of [...open.keys()]) if (!spans.includes(k)) flush(k);
    for (const k of spans) {
      const b = open.get(k);
      if (b && b.r1 === r) b.r1 = r + 1;
      else {
        if (b) flush(k);
        const [c0, c1] = k.split(':').map(Number);
        open.set(k, { c0, c1, r0: r, r1: r + 1 });
      }
    }
  }
  for (const k of [...open.keys()]) flush(k);
  // slope wedges: the area under the floor line inside the cell
  for (let r = 0; r < g.h; r++)
    for (let c = 0; c < g.w; c++) {
      const ch = at(g, c, r);
      if (!isSlope(ch)) continue;
      const yl = r + floorPx(ch, 0)! / CELL;
      const yr = r + floorPx(ch, 1)! / CELL;
      mass.push([c, yl, c + 1, yr, c + 1, r + 1, c, r + 1]);
    }
  return { mass, light };
}

/** Lava runs: maximal horizontal runs of '~' whose cell above is not lava (the drawn top). */
export function lavaRuns(g: Grid): { x0: number; x1: number; y: number; depth: number }[] {
  const out: { x0: number; x1: number; y: number; depth: number }[] = [];
  for (let r = 0; r < g.h; r++) {
    let c = 0;
    while (c < g.w) {
      if (at(g, c, r) !== '~' || at(g, c, r - 1) === '~') {
        c++;
        continue;
      }
      const c0 = c;
      while (c < g.w && at(g, c, r) === '~' && at(g, c, r - 1) !== '~') c++;
      let depth = 1;
      while (at(g, c0, r + depth) === '~') depth++;
      out.push({ x0: c0, x1: c, y: r, depth });
    }
  }
  return out;
}

/** Columns with no floor in the bottom row: pits (an abyss scribble goes there, §7.1 rule 6). */
export function pitRuns(g: Grid): [number, number][] {
  const out: [number, number][] = [];
  const r = g.h - 1;
  let c = 0;
  while (c < g.w) {
    const ch = at(g, c, r);
    if (isFloor(ch) || ch === '~') {
      c++;
      continue;
    }
    const c0 = c;
    while (c < g.w && !isFloor(at(g, c, r)) && at(g, c, r) !== '~') c++;
    out.push([c0, c]);
  }
  return out;
}
