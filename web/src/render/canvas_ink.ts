/**
 * Canvas2D ink renderer (PLAN_V2 §7.4): rasterizes ArtDoc layers with linear filtering for play (chunk textures),
 * preview, thumbnails and seeds. Same geometry as the SVG serializer (core/art/outline.ts).
 */
import type { ArtDoc, ArtLayer, ArtPath, ArtStyle } from '../core/art/types.ts';
import type { RectCells } from '../core/types.gen.ts';
import { pathBoxPx, strokePolygons } from '../core/art/outline.ts';
import { paintPaper, paintVignette } from './paper.ts';

const CELL = 16;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DrawOpts {
  recolor?: string; // every ink drawn in this colour (underlays)
  alpha?: number; // global multiplier
  exclude?: ReadonlySet<string>; // object ids to skip (morphs draw them separately)
  dx?: number; // logical px added to every x (parallax offset)
  dy?: number;
  strokesOnly?: boolean; // underlays: the ink lines, without fills and hatches
}

function tracePolyline(ctx: Ctx2D, pts: ArrayLike<number>, closed: boolean, dx: number, dy: number): void {
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i] * CELL + dx;
    const y = pts[i + 1] * CELL + dy;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (closed) ctx.closePath();
}

function hatchClip(ctx: Ctx2D, p: ArtPath, s: ArtStyle, o: DrawOpts, dx: number, dy: number): void {
  const h = s.hatch!;
  const [bx0, by0, bx1, by1] = pathBoxPx(p, s);
  ctx.save();
  ctx.beginPath();
  tracePolyline(ctx, p.pts, true, dx, dy);
  ctx.clip();
  const a = (h.angle_deg * Math.PI) / 180;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const nx = -uy;
  const ny = ux;
  const x0 = bx0 + dx;
  const y0 = by0 + dy;
  const x1 = bx1 + dx;
  const y1 = by1 + dy;
  // spacing anchored at the layer origin so hatches line up across chunks and objects
  const ox = dx;
  const oy = dy;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => (x - ox) * nx + (y - oy) * ny);
  const m0 = Math.min(...corners);
  const m1 = Math.max(...corners);
  const diag = Math.hypot(x1 - x0, y1 - y0) + 4;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const tc = (cx - ox) * ux + (cy - oy) * uy;
  ctx.beginPath();
  for (let k = Math.floor(m0 / h.spacing_px); k <= Math.ceil(m1 / h.spacing_px); k++) {
    const d = k * h.spacing_px;
    const px = ox + nx * d + ux * tc;
    const py = oy + ny * d + uy * tc;
    ctx.moveTo(px - ux * diag, py - uy * diag);
    ctx.lineTo(px + ux * diag, py + uy * diag);
  }
  ctx.strokeStyle = o.recolor ?? h.color ?? s.stroke ?? '#1F1B18';
  ctx.globalAlpha = h.alpha * (s.opacity ?? 1) * (o.alpha ?? 1);
  ctx.lineWidth = h.width_px;
  ctx.lineCap = 'butt';
  ctx.stroke();
  ctx.restore();
}

/** Draw one path; the context transform maps logical (world) px to canvas px. */
export function drawPath(ctx: Ctx2D, p: ArtPath, s: ArtStyle, o: DrawOpts = {}): void {
  const dx = o.dx ?? 0;
  const dy = o.dy ?? 0;
  const op = (s.opacity ?? 1) * (o.alpha ?? 1);
  const n = p.pts.length / 2;
  if (s.fill && p.closed && n >= 3 && !o.strokesOnly) {
    ctx.globalAlpha = (s.fill_opacity ?? 1) * op;
    ctx.fillStyle = o.recolor ?? s.fill;
    ctx.beginPath();
    tracePolyline(ctx, p.pts, true, dx, dy);
    ctx.fill('nonzero');
  }
  if (s.hatch && p.closed && n >= 3 && !o.strokesOnly) hatchClip(ctx, p, s, o, dx, dy);
  if (!s.stroke) return;
  ctx.globalAlpha = op;
  if (p.w && p.w.length) {
    ctx.fillStyle = o.recolor ?? s.stroke;
    ctx.beginPath();
    for (const poly of strokePolygons(p.pts, p.w, p.closed)) {
      for (let i = 0; i + 1 < poly.length; i += 2) {
        if (i === 0) ctx.moveTo(poly[i] + dx, poly[i + 1] + dy);
        else ctx.lineTo(poly[i] + dx, poly[i + 1] + dy);
      }
      ctx.closePath();
    }
    ctx.fill('nonzero');
    return;
  }
  if (n === 1) {
    ctx.fillStyle = o.recolor ?? s.stroke;
    ctx.beginPath();
    ctx.arc(p.pts[0] * CELL + dx, p.pts[1] * CELL + dy, (s.width ?? 2) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.strokeStyle = o.recolor ?? s.stroke;
  ctx.lineWidth = s.width ?? 2;
  ctx.lineCap = s.cap ?? 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(s.dash ?? []);
  ctx.beginPath();
  tracePolyline(ctx, p.pts, p.closed, dx, dy);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawPaths(ctx: Ctx2D, doc: ArtDoc, paths: readonly ArtPath[], o: DrawOpts = {}, clipPx?: [number, number, number, number]): void {
  for (const p of paths) {
    if (o.exclude && p.object_id && o.exclude.has(p.object_id)) continue;
    const s = doc.styles[p.style];
    if (!s) continue;
    if (clipPx) {
      const b = pathBoxPx(p, s);
      const dx = o.dx ?? 0;
      const dy = o.dy ?? 0;
      if (b[2] + dx < clipPx[0] || b[0] + dx > clipPx[2] || b[3] + dy < clipPx[1] || b[1] + dy > clipPx[3]) continue;
    }
    drawPath(ctx, p, s, o);
  }
  ctx.globalAlpha = 1;
}

let scratch: HTMLCanvasElement | OffscreenCanvas | null = null;
function scratchCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (!scratch) scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  return scratch;
}

/** Draw a layer (honouring its group opacity) into ctx; the transform maps logical px to canvas px. */
export function drawLayer(ctx: Ctx2D, doc: ArtDoc, l: ArtLayer, o: DrawOpts = {}, clipPx?: [number, number, number, number]): void {
  const op = l.opacity ?? 1;
  if (op >= 0.999) {
    drawPaths(ctx, doc, l.paths, o, clipPx);
    return;
  }
  // group opacity: draw opaque into a scratch canvas, then composite once (overlaps never double-darken)
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const sc = scratchCanvas(W, H);
  const sctx = sc.getContext('2d') as Ctx2D | null;
  if (!sctx) return;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, W, H);
  const t = ctx.getTransform();
  sctx.setTransform(t);
  drawPaths(sctx, doc, l.paths, o, clipPx);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = op;
  ctx.drawImage(sc as CanvasImageSource, 0, 0, W, H, 0, 0, W, H);
  ctx.restore();
  ctx.globalAlpha = 1;
}

export const INK_LAYERS = ['decoration', 'signs', 'terrain'] as const;
const UNDERLAY_LAYERS = new Set(['decoration', 'signs', 'terrain', 'entities']);

/**
 * Draw the view rect (cells) of an ArtDoc to fill the context's canvas (§11.3g).
 * style 'final': paper, parallax, ink, entities, player, foreground and vignette.
 * style 'underlay': only the ink, in remix gray, for drawing over (editor underlays).
 */
export function drawInk(ctx: CanvasRenderingContext2D, doc: ArtDoc, view: RectCells, o: { style?: 'final' | 'underlay'; layers?: string[] } = {}): void {
  const style = o.style ?? 'final';
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const vw = Math.max(1e-6, (view[2] - view[0]) * CELL);
  const vh = Math.max(1e-6, (view[3] - view[1]) * CELL);
  const scale = Math.min(W / vw, H / vh);
  const camX = view[0] * CELL;
  const camY = view[1] * CELL;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -camX * scale, -camY * scale);
  if (style === 'final' && (!o.layers || o.layers.includes('paper'))) paintPaper(ctx, doc.theme, camX, camY, vw, vh, scale);
  const clip: [number, number, number, number] = [camX, camY, camX + vw, camY + vh];
  const layers = [...doc.layers].sort((a, b) => a.depth - b.depth);
  for (const l of layers) {
    if (l.id === 'paper') continue;
    if (o.layers && !o.layers.includes(String(l.id))) continue;
    if (style === 'underlay' && !UNDERLAY_LAYERS.has(String(l.id))) continue;
    const dx = (1 - l.scroll) * camX;
    drawLayer(ctx, doc, l, style === 'underlay' ? { dx, recolor: '#B0B0B0', alpha: 0.75, strokesOnly: true } : { dx }, clip);
  }
  if (style === 'final' && (!o.layers || o.layers.includes('paper'))) paintVignette(ctx, camX, camY, vw, vh);
  ctx.restore();
}

/**
 * Rasterize one chunk of the given layers into a fresh canvas: logical px [x0, x0 + w) × [0, h) at scale r.
 * Used for terrain chunks (scroll 1) and parallax chunks (layer coordinates).
 */
export function rasterizeChunk(doc: ArtDoc, layerIds: readonly string[], x0: number, w: number, h: number, r: number, exclude?: ReadonlySet<string>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * r);
  c.height = Math.ceil(h * r);
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.setTransform(r, 0, 0, r, -x0 * r, 0);
  const clip: [number, number, number, number] = [x0, 0, x0 + w, h];
  const layers = doc.layers.filter((l) => layerIds.includes(String(l.id))).sort((a, b) => a.depth - b.depth);
  for (const l of layers) drawLayer(ctx, doc, l, exclude ? { exclude } : {}, clip);
  return c;
}

/** Bake a set of local paths (sprite frame, cells) into a canvas at `px` canvas px per logical px. */
export function bakePaths(doc: ArtDoc, paths: readonly ArtPath[], box: RectCells, px: number, pad = 2): { canvas: HTMLCanvasElement; ox: number; oy: number } {
  const c = document.createElement('canvas');
  const w = (box[2] - box[0]) * CELL + pad * 2;
  const h = (box[3] - box[1]) * CELL + pad * 2;
  c.width = Math.max(2, Math.ceil(w * px));
  c.height = Math.max(2, Math.ceil(h * px));
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.setTransform(px, 0, 0, px, (-box[0] * CELL + pad) * px, (-box[1] * CELL + pad) * px);
    drawPaths(ctx, doc, paths);
  }
  // origin of the local (0, 0) inside the canvas, normalized
  return { canvas: c, ox: (-box[0] * CELL + pad) / w, oy: (-box[1] * CELL + pad) / h };
}
