/**
 * Library symbol match (§8.1, H21): a paper (or canvas) glyph is compared with every library type's 3 registered
 * symbol samples. Each glyph is normalized to a 32 × 32 raster with its aspect kept (the longer side spans the
 * raster, the shorter one is centred), its skeleton (the stroke centrelines, blob outlines and dot centres) is
 * rendered at 1 px, and the symmetric chamfer distance is taken between the two renders. Distances are converted
 * back to cells through the glyph's own size, so the 0.12-cell threshold means the same on a small or a big drawing.
 *
 * A type matches when the ink colour is the symbol's colour and the mean of its two best sample distances is
 * ≤ LIBRARY.chamfer_max_c. The best match wins; ties go to the lower type id, then the higher version.
 * Pure arithmetic only (no trig), so the result is identical in the browser and in Node.
 */
import { LIBRARY } from '../params.ts';
import type { InkStroke, LibraryType } from '../types.gen.ts';

const N = LIBRARY.symbol_norm_px; // 32
const BIG = 1e9;

interface Raster {
  on: Uint8Array; // N × N skeleton pixels
  count: number;
  scale: number; // cells per raster px
}

function glyphPoints(strokes: readonly InkStroke[]): [number, number][][] {
  const out: [number, number][][] = [];
  for (const s of strokes) {
    if (!s.pts?.length) continue;
    const pts = s.pts.map((p) => [p[0], p[1]] as [number, number]);
    if (s.kind === 'dot' || pts.length === 1) out.push([pts[0]]);
    else if (s.kind === 'blob' || s.closed) out.push([...pts, pts[0]]);
    else out.push(pts);
  }
  return out;
}

/** Render a glyph's skeleton into an N × N raster, aspect kept, longer side spanning N − 1 px. */
export function rasterGlyph(strokes: readonly InkStroke[]): Raster | null {
  const polys = glyphPoints(strokes);
  if (!polys.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const pl of polys) for (const [x, y] of pl) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const side = Math.max(x1 - x0, y1 - y0, 1e-3);
  const k = (N - 1) / side; // raster px per cell
  const ox = ((N - 1) - (x1 - x0) * k) / 2;
  const oy = ((N - 1) - (y1 - y0) * k) / 2;
  const on = new Uint8Array(N * N);
  let count = 0;
  const plot = (x: number, y: number): void => {
    const c = Math.round(ox + (x - x0) * k);
    const r = Math.round(oy + (y - y0) * k);
    if (c < 0 || c >= N || r < 0 || r >= N) return;
    const i = r * N + c;
    if (!on[i]) {
      on[i] = 1;
      count++;
    }
  };
  for (const pl of polys) {
    if (pl.length === 1) {
      plot(pl[0][0], pl[0][1]);
      continue;
    }
    for (let i = 1; i < pl.length; i++) {
      const [ax, ay] = pl[i - 1];
      const [bx, by] = pl[i];
      const lenPx = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * k;
      const steps = Math.max(1, Math.ceil(lenPx * 2));
      for (let s = 0; s <= steps; s++) plot(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
    }
  }
  return count ? { on, count, scale: 1 / k } : null;
}

/** Two-pass chamfer distance transform (Borgefors 3-4, divided by 3 → ≈ Euclidean px). */
function distanceField(r: Raster): Float64Array {
  const d = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) d[i] = r.on[i] ? 0 : BIG;
  const at = (c: number, rr: number): number => (c < 0 || c >= N || rr < 0 || rr >= N ? BIG : d[rr * N + c]);
  for (let rr = 0; rr < N; rr++) {
    for (let c = 0; c < N; c++) {
      const i = rr * N + c;
      let v = d[i];
      v = Math.min(v, at(c - 1, rr) + 3, at(c, rr - 1) + 3, at(c - 1, rr - 1) + 4, at(c + 1, rr - 1) + 4);
      d[i] = v;
    }
  }
  for (let rr = N - 1; rr >= 0; rr--) {
    for (let c = N - 1; c >= 0; c--) {
      const i = rr * N + c;
      let v = d[i];
      v = Math.min(v, at(c + 1, rr) + 3, at(c, rr + 1) + 3, at(c + 1, rr + 1) + 4, at(c - 1, rr + 1) + 4);
      d[i] = v;
    }
  }
  for (let i = 0; i < N * N; i++) d[i] = d[i] / 3;
  return d;
}

/** Mean distance (px) from A's skeleton pixels to B's skeleton. */
function directed(a: Raster, fieldB: Float64Array): number {
  let s = 0;
  for (let i = 0; i < N * N; i++) if (a.on[i]) s += fieldB[i];
  return s / Math.max(1, a.count);
}

/** Symmetric chamfer distance between two glyphs, in cells of the first glyph's size. */
export function chamferCells(glyph: readonly InkStroke[], sample: readonly InkStroke[]): number | null {
  const a = rasterGlyph(glyph);
  const b = rasterGlyph(sample);
  if (!a || !b) return null;
  const px = (directed(a, distanceField(b)) + directed(b, distanceField(a))) / 2;
  return px * a.scale;
}

function inkColor(strokes: readonly InkStroke[]): string | null {
  // the majority colour by stroke count (paper re-inks; a glyph is drawn with one marker)
  const n = new Map<string, number>();
  for (const s of strokes) n.set(s.color, (n.get(s.color) ?? 0) + 1);
  let best: string | null = null;
  let bv = -1;
  for (const [c, v] of [...n.entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1))) if (v > bv) {
    best = c;
    bv = v;
  }
  return best;
}

/** §11.3(b) `matchSymbol`: the library type whose registered symbol this glyph is, or null. */
export function matchSymbol(glyph: InkStroke[], lib: LibraryType[]): { type_id: string; version: number; dist: number } | null {
  if (!glyph?.length || !lib?.length) return null;
  const color = inkColor(glyph);
  const ga = rasterGlyph(glyph);
  if (!ga) return null;
  const fieldA = distanceField(ga);
  let best: { type_id: string; version: number; dist: number } | null = null;
  const types = [...lib].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : b.version - a.version));
  for (const t of types) {
    const sym = t.symbol;
    if (!sym || !sym.samples?.length) continue;
    if (color && sym.color && sym.color !== color && !(color === 'pencil' || color === 'draft')) continue;
    const ds: number[] = [];
    for (const sample of sym.samples) {
      const b = rasterGlyph(sample);
      if (!b) continue;
      const px = (directed(ga, distanceField(b)) + directed(b, fieldA)) / 2;
      ds.push(px * ga.scale);
    }
    if (!ds.length) continue;
    ds.sort((a, b) => a - b);
    const dist = ds.length >= 2 ? (ds[0] + ds[1]) / 2 : ds[0];
    if (dist > LIBRARY.chamfer_max_c + 1e-9) continue;
    const d = Math.round(dist * 1000) / 1000;
    if (!best || d < best.dist) best = { type_id: t.id, version: t.version, dist: d };
  }
  return best;
}
