/**
 * Render geometry shared by the Canvas2D and SVG renderers, so play and goldens draw the same shapes.
 * A variable-width marker stroke is the union of one quad per segment and one disc per join/end, every polygon
 * positively oriented, filled once with the nonzero rule: no seams, no double-darkening at joints, no holes.
 */
import { CELL, signedArea, turnDeg } from './geom.ts';
import type { ArtPath, ArtStyle, ArtDoc } from './types.ts';

function disc(cx: number, cy: number, r: number): number[] {
  const n = r < 2 ? 8 : r < 4 ? 12 : 16;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return out;
}

function orient(p: number[]): number[] {
  if (signedArea(p) >= 0) return p;
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

/** Polygons (px, in the path's frame × CELL) of a variable-width stroke. */
export function strokePolygons(pts: ArrayLike<number>, w: ArrayLike<number>, closed: boolean): number[][] {
  const n = Math.floor(pts.length / 2);
  const out: number[][] = [];
  if (n === 0) return out;
  const X = (i: number): number => pts[2 * i] * CELL;
  const Y = (i: number): number => pts[2 * i + 1] * CELL;
  const W = (i: number): number => Math.max(0.5, (w.length ? w[Math.min(i, w.length - 1)] : 2) / 2);
  if (n === 1) {
    out.push(orient(disc(X(0), Y(0), W(0))));
    return out;
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = X(i);
    const ay = Y(i);
    const bx = X(j);
    const by = Y(j);
    const L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-6) continue;
    const nx = -(by - ay) / L;
    const ny = (bx - ax) / L;
    const wa = W(i);
    const wb = W(j);
    out.push(orient([ax + nx * wa, ay + ny * wa, bx + nx * wb, by + ny * wb, bx - nx * wb, by - ny * wb, ax - nx * wa, ay - ny * wa]));
  }
  for (let i = 0; i < n; i++) {
    const end = !closed && (i === 0 || i === n - 1);
    if (!end) {
      const a = (i - 1 + n) % n;
      const c = (i + 1) % n;
      const t = turnDeg([X(a), Y(a)], [X(i), Y(i)], [X(c), Y(c)]);
      if (t < 4 && Math.abs(W(a) - W(c)) < 0.4) continue;
    }
    out.push(orient(disc(X(i), Y(i), W(i))));
  }
  return out;
}

/** Bounding box (px) of a path including its stroke width. */
export function pathBoxPx(p: ArtPath, s: ArtStyle | undefined): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < p.pts.length; i += 2) {
    x0 = Math.min(x0, p.pts[i]);
    y0 = Math.min(y0, p.pts[i + 1]);
    x1 = Math.max(x1, p.pts[i]);
    y1 = Math.max(y1, p.pts[i + 1]);
  }
  const pad = (p.w ? Math.max(...p.w) : (s?.width ?? 2)) / 2 + 1;
  return [x0 * CELL - pad, y0 * CELL - pad, x1 * CELL + pad, y1 * CELL + pad];
}

export const PAPER_THEMES = {
  sketchbook: { base: '#FBF6EA', dot: 'rgba(31,27,24,0.16)' },
  notebook: { base: '#FCFBF6', rule: 'rgba(143,184,222,0.55)', margin: 'rgba(224,69,58,0.45)' },
  graph: { base: '#FBFBF7', grid: 'rgba(44,123,229,0.10)' },
  kraft: { base: '#D9C2A0', fibre: 'rgba(90,60,30,0.10)' },
} as const;

export function styleOf(doc: ArtDoc, key: string): ArtStyle | undefined {
  return doc.styles[key];
}
