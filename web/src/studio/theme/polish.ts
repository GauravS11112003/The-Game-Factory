/**
 * The cleaned-up sketch (docs/v7/CONTRACTS_V7.md §4.3), geometry only and pure (no DOM, tested in node): smooth the hand
 * jitter but keep corners, close strokes whose ends nearly meet (trimming the overshoot), and even out the line weight
 * so a sketch reads as finished game art instead of a scribble. render.ts paints the result (fills, highlight, shadow).
 */

export type Pt = [number, number];

const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Drop points closer than `min` to the previous kept one (the last point always stays). */
export function dedupe(pts: Pt[], min = 0.8): Pt[] {
  if (pts.length < 2) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= min) out.push(pts[i]);
    else if (i === pts.length - 1 && out.length > 1) out[out.length - 1] = pts[i];
  }
  return out;
}

export function pathLength(pts: Pt[], closed = false): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) L += dist(pts[pts.length - 1], pts[0]);
  return L;
}

/** Evenly spaced points along the path (spacing `step`), keeping every original corner-ish vertex position close. */
export function resampleEven(pts: Pt[], closed: boolean, step: number): Pt[] {
  if (pts.length < 2) return pts.slice();
  const src = closed ? [...pts, pts[0]] : pts;
  const out: Pt[] = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1];
    const b = src[i];
    const d = dist(a, b);
    if (d < 1e-9) continue;
    let t = step - carry;
    while (t <= d) {
      out.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d]);
      t += step;
    }
    carry = d - (t - step);
  }
  if (closed) {
    if (out.length > 2 && dist(out[out.length - 1], out[0]) < step * 0.5) out.pop();
  } else if (dist(out[out.length - 1], src[src.length - 1]) > 1e-6) out.push(src[src.length - 1]);
  return out;
}

/**
 * Corners: points where the direction turns by more than `deg` degrees, measured over a neighbourhood of `k` points
 * on each side (so jitter does not count), keeping only the sharpest point of each bend.
 */
export function cornerFlags(pts: Pt[], closed: boolean, deg = 50, k = 3): boolean[] {
  const n = pts.length;
  const turn = new Array<number>(n).fill(0);
  const at = (i: number): Pt | null => (closed ? pts[((i % n) + n) % n] : i >= 0 && i < n ? pts[i] : null);
  for (let i = 0; i < n; i++) {
    const a = at(i - k) ?? at(0);
    const b = pts[i];
    const c = at(i + k) ?? at(n - 1);
    if (!a || !c || a === b || c === b) continue;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu < 1e-6 || lv < 1e-6) continue;
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
    turn[i] = (Math.acos(cos) * 180) / Math.PI;
  }
  const flags = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (turn[i] < deg) continue;
    let peak = true;
    for (let j = -k; j <= k && peak; j++) {
      if (!j) continue;
      const q = closed ? ((i + j) % n + n) % n : i + j;
      if (q < 0 || q >= n) continue;
      if (turn[q] > turn[i] || (turn[q] === turn[i] && q < i)) peak = false;
    }
    flags[i] = peak;
  }
  if (!closed && n) {
    flags[0] = true;
    flags[n - 1] = true;
  }
  return flags;
}

/** Weighted moving average (1-2-3-2-1) that leaves corners (and open ends) where they are. */
export function denoise(pts: Pt[], closed: boolean, corners: boolean[], passes = 2): Pt[] {
  let cur = pts.slice();
  const n = cur.length;
  if (n < 5) return cur;
  const W = [1, 2, 3, 2, 1];
  for (let pass = 0; pass < passes; pass++) {
    const next: Pt[] = cur.map((p) => [p[0], p[1]] as Pt);
    for (let i = 0; i < n; i++) {
      if (corners[i]) continue;
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let j = -2; j <= 2; j++) {
        let q = i + j;
        if (closed) q = ((q % n) + n) % n;
        else if (q < 0 || q >= n) continue;
        // do not smear across a corner
        if (j !== 0 && corners[q] && Math.abs(j) > 1) continue;
        const w = W[j + 2];
        sx += cur[q][0] * w;
        sy += cur[q][1] * w;
        sw += w;
      }
      next[i] = [sx / sw, sy / sw];
    }
    cur = next;
  }
  return cur;
}

/** Chaikin corner cutting; vertices flagged as corners are kept sharp. */
export function chaikin(pts: Pt[], closed: boolean, iterations = 2, corners?: boolean[]): Pt[] {
  let cur = pts.slice();
  let flags = corners ? corners.slice() : new Array<boolean>(cur.length).fill(false);
  if (!closed && cur.length) {
    flags[0] = true;
    flags[cur.length - 1] = true;
  }
  for (let it = 0; it < iterations; it++) {
    const n = cur.length;
    if (n < 3) break;
    const out: Pt[] = [];
    const of: boolean[] = [];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p = cur[i];
      const q = cur[(i + 1) % n];
      const fp = flags[i];
      const fq = flags[(i + 1) % n];
      if (fp) {
        out.push(p);
        of.push(true);
      }
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      of.push(false);
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
      of.push(false);
      if (!closed && i === segs - 1 && fq) {
        out.push(q);
        of.push(true);
      }
    }
    cur = out;
    flags = of;
  }
  return cur;
}

/** Ramer-Douglas-Peucker (open polyline). */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s];
    const b = pts[e];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let best = -1;
    let bd = eps;
    for (let i = s + 1; i < e; i++) {
      const d = len < 1e-9 ? dist(pts[i], a) : Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len;
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

/**
 * Should an open stroke be closed? Its ends are near each other compared with its size and width, and it is long
 * enough to be an outline rather than a short arc. Returns the trimmed point list (overshoot past the meeting point
 * cut off) or null to leave it open.
 */
export function closeIfNear(pts: Pt[], width: number): Pt[] | null {
  const n = pts.length;
  if (n < 4) return null;
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
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 10) return null;
  // the closest pair between the first and the last 20% of the stroke (kids overshoot the start)
  const span = Math.max(1, Math.floor(n * 0.2));
  let bi = 0;
  let bj = n - 1;
  let bd = dist(pts[0], pts[n - 1]);
  for (let i = 0; i < span; i++) {
    for (let j = n - 1; j >= n - span && j > i + 2; j--) {
      const d = dist(pts[i], pts[j]);
      if (d < bd - 1e-9) {
        bd = d;
        bi = i;
        bj = j;
      }
    }
  }
  const limit = Math.max(10, width * 2.5, diag * 0.16);
  if (bd > limit) return null;
  const kept = pts.slice(bi, bj + 1);
  if (kept.length < 3) return null;
  // a short arc whose ends happen to be close is not an outline
  if (pathLength(kept) < Math.max(bd * 3, diag * 1.6)) return null;
  return kept;
}

/** Even line weight: pull widths toward the drawing's median, then cap them relative to the object's size. */
export function polishWidth(width: number, median: number, objSize: number, closed: boolean): number {
  const w = Math.max(0.5, width) * 0.5 + Math.max(0.5, median) * 0.5;
  const cap = Math.max(2.2, Math.min(6.5, objSize * 0.045));
  return Math.max(Math.min(width, 1.6), Math.min(w, closed ? cap : cap * 1.6));
}

export interface PolishStrokeIn {
  points: Pt[];
  width: number;
  closed: boolean;
}

export interface PolishStrokeOut {
  points: Pt[];
  width: number;
  closed: boolean;
  /** True when polish closed a stroke the maker left open. */
  autoClosed: boolean;
}

/** One stroke cleaned up (smooth, corners kept, maybe closed). Deterministic. */
export function polishStroke(s: PolishStrokeIn, width: number): PolishStrokeOut {
  let pts = dedupe(s.points, 0.6);
  let closed = s.closed && pts.length > 2;
  let autoClosed = false;
  if (pts.length < 2) return { points: pts, width, closed: false, autoClosed: false };
  if (!closed) {
    const c = closeIfNear(pts, width);
    if (c) {
      pts = c;
      closed = true;
      autoClosed = true;
    }
  }
  if (closed && pts.length > 3 && dist(pts[0], pts[pts.length - 1]) < 0.5) pts = pts.slice(0, -1);
  const L = pathLength(pts, closed);
  if (L < 6 || pts.length < 3) return { points: pts, width, closed, autoClosed };
  const step = Math.max(2.5, Math.min(6, L / 60));
  let rs = resampleEven(pts, closed, step);
  if (rs.length < 5) return { points: pts, width, closed, autoClosed };
  const k = Math.max(2, Math.round(10 / step));
  const corners = cornerFlags(rs, closed, 48, k);
  rs = denoise(rs, closed, corners, 2);
  // simplify (corners survive: they are the extreme points) and round off again
  const keepIdx = new Set<number>();
  corners.forEach((f, i) => f && keepIdx.add(i));
  let simple: Pt[];
  let flags: boolean[];
  if (closed) {
    const seq = [...rs, rs[0]];
    const sim = simplify(seq, 0.6);
    sim.pop();
    simple = sim;
  } else simple = simplify(rs, 0.6);
  // re-attach corner flags by position
  const cornerPts = rs.filter((_, i) => keepIdx.has(i));
  flags = simple.map((p) => cornerPts.some((c) => dist(c, p) < 0.01));
  if (simple.length < 3) {
    simple = rs;
    flags = corners;
  }
  const out = chaikin(simple, closed, 2, flags);
  return { points: out, width, closed, autoClosed };
}

/** Median of the stroke widths (6 when there are none). */
export function medianWidth(widths: number[]): number {
  if (!widths.length) return 6;
  const s = [...widths].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
