/**
 * Skin pictures for the renderers (docs/v3/CONTRACTS_V3.md "Skin on levels"): one module-level cache of prepared
 * canvases shared by the game, thumbnails and share cards, so a remount (preview ↔ test) or a feed card re-skins in
 * the same frame without fetching again. Phaser's own loader is per-Game, which would flash the kid's ink on every
 * remount; the engine adds these canvases to its texture bank instead.
 *
 * Loading: PNG / JPEG / WebP through an <img> (crossOrigin only for other origins); SVG fetched as text and
 * rasterized at a crisp size. Sprites are prepared once: a white backdrop is keyed out when the picture has no
 * transparency of its own (an SVG with a paper rect, a PNG whose background removal failed), then the transparent
 * margin is trimmed so "feet on the bottom edge" means the drawn feet. Any failure resolves null and the kid's ink
 * stays; failures are retried after a short cool-down. Nothing here ever throws.
 */
import type { RectCells } from '../core/types.gen.ts';
import { fitRects, SKIN_PARALLAX } from '../core/art/skin.ts';
import type { SkinFit, SkinSpec } from '../core/art/skin.ts';

const CELL = 16;

export type SkinImageKind = 'sprite' | 'backdrop';

/** A prepared picture: `canvas` holds exactly the drawn content (sprites trimmed), w × h canvas px. */
export interface SkinImage {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
}

const LIMITS: Record<SkinImageKind, { side: number; h: number }> = {
  sprite: { side: 640, h: 640 },
  backdrop: { side: 4096, h: 1080 },
};
const MAX_ENTRIES = 48;
const RETRY_MS = 20_000;
const TIMEOUT_MS = 15_000;

const cache = new Map<string, SkinImage>();
const failed = new Map<string, number>();
const inflight = new Map<string, Promise<SkinImage | null>>();

const keyOf = (url: string, kind: SkinImageKind): string => `${kind}|${url}`;

/** The prepared picture if it is ready, null if it failed recently, undefined if not loaded (yet). */
export function peekSkinImage(url: string, kind: SkinImageKind = 'sprite'): SkinImage | null | undefined {
  const k = keyOf(url, kind);
  const hit = cache.get(k);
  if (hit) {
    // LRU: most recently used last
    cache.delete(k);
    cache.set(k, hit);
    return hit;
  }
  const t = failed.get(k);
  if (t !== undefined) {
    if (Date.now() - t < RETRY_MS) return null;
    failed.delete(k);
  }
  return undefined;
}

/** Load and prepare a picture once (shared by every caller); resolves null when it can't be shown. */
export function loadSkinImage(url: string, kind: SkinImageKind = 'sprite'): Promise<SkinImage | null> {
  if (!url || typeof document === 'undefined') return Promise.resolve(null);
  const now = peekSkinImage(url, kind);
  if (now !== undefined) return Promise.resolve(now);
  const k = keyOf(url, kind);
  const running = inflight.get(k);
  if (running) return running;
  const p = fetchPicture(url, kind)
    .then((img) => (img ? prepare(img, kind) : null))
    .catch(() => null)
    .then((res) => {
      inflight.delete(k);
      if (res) {
        cache.set(k, res);
        while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      } else {
        failed.set(k, Date.now());
        console.warn('skin picture unavailable, keeping the drawing:', url);
      }
      return res;
    });
  inflight.set(k, p);
  return p;
}

/** Every picture a skin uses, loaded (or given up on) within `timeoutMs`. */
export function skinImagesReady(skin: SkinSpec | null, timeoutMs = 6000): Promise<void> {
  if (!skin) return Promise.resolve();
  const jobs: Promise<unknown>[] = [];
  for (const o of skin.objects) if (o.mode !== 'ink') jobs.push(loadSkinImage(o.url, 'sprite'));
  if (skin.backdrop) jobs.push(loadSkinImage(skin.backdrop.url, 'backdrop'));
  if (!jobs.length) return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, timeoutMs);
    void Promise.all(jobs).then(() => {
      clearTimeout(t);
      res();
    });
  });
}

// ---- fetching -----------------------------------------------------------------------------------------------

function crossOrigin(url: string): boolean {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== location.origin;
  } catch {
    return false;
  }
}

function isSvg(url: string): boolean {
  return /^data:image\/svg\+xml/i.test(url) || /\.svg(?:[?#]|$)/i.test(url);
}

function imageFrom(src: string, cors: boolean): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    try {
      const img = new Image();
      if (cors) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const t = setTimeout(() => res(null), TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(t);
        res(img.naturalWidth > 0 && img.naturalHeight > 0 ? img : null);
      };
      img.onerror = () => {
        clearTimeout(t);
        res(null);
      };
      img.src = src;
    } catch {
      res(null);
    }
  });
}

/** An SVG rasterized at a crisp size: its width / height are set from the viewBox so the long side is `side` px. */
async function svgPicture(url: string, side: number): Promise<HTMLImageElement | null> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return null;
    const text = await r.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
    const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    let w = parseFloat(svg.getAttribute('width') ?? '');
    let h = parseFloat(svg.getAttribute('height') ?? '');
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      w = vb[2];
      h = vb[3];
    } else if (w > 0 && h > 0) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    else {
      w = 512;
      h = 512;
    }
    const k = side / Math.max(w, h);
    svg.setAttribute('width', String(Math.round(w * k)));
    svg.setAttribute('height', String(Math.round(h * k)));
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' });
    const src = URL.createObjectURL(blob);
    const img = await imageFrom(src, false);
    URL.revokeObjectURL(src);
    return img;
  } catch {
    return null;
  }
}

async function fetchPicture(url: string, kind: SkinImageKind): Promise<HTMLImageElement | null> {
  if (isSvg(url)) {
    const img = await svgPicture(url, LIMITS[kind].side);
    if (img) return img;
  }
  return imageFrom(url, crossOrigin(url));
}

// ---- preparing ----------------------------------------------------------------------------------------------

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * Key out a white backdrop: only when the picture has (almost) no transparent border and its border is mostly
 * near-white. A flood fill from the border clears the connected light pixels (outlines stop it), then the pixels
 * along the cut get a soft alpha so the edge isn't jagged.
 */
function keyWhite(d: ImageData): void {
  const { width: W, height: H, data } = d;
  let border = 0;
  let clear = 0;
  let white = 0;
  const light = (i: number): number => Math.min(data[i], data[i + 1], data[i + 2]);
  const visit = (x: number, y: number): void => {
    const i = (y * W + x) * 4;
    border++;
    if (data[i + 3] < 16) clear++;
    else if (light(i) >= 232) white++;
  };
  for (let x = 0; x < W; x++) {
    visit(x, 0);
    visit(x, H - 1);
  }
  for (let y = 1; y < H - 1; y++) {
    visit(0, y);
    visit(W - 1, y);
  }
  if (!border || clear / border > 0.1 || white / border < 0.8) return;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (x: number, y: number): void => {
    const p = y * W + x;
    if (seen[p]) return;
    seen[p] = 1;
    if (light(p * 4) < 225 || data[p * 4 + 3] < 8) return;
    stack[sp++] = p;
  };
  for (let x = 0; x < W; x++) {
    push(x, 0);
    push(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    push(0, y);
    push(W - 1, y);
  }
  const cut = new Uint8Array(W * H);
  while (sp > 0) {
    const p = stack[--sp];
    cut[p] = 1;
    data[p * 4 + 3] = 0;
    const x = p % W;
    const y = (p - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  // soften the cut: light pixels touching it fade with their lightness
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (cut[p]) continue;
      const near = (x > 0 && cut[p - 1]) || (x < W - 1 && cut[p + 1]) || (y > 0 && cut[p - W]) || (y < H - 1 && cut[p + W]);
      if (!near) continue;
      const l = light(p * 4);
      if (l > 170) data[p * 4 + 3] = Math.round(data[p * 4 + 3] * Math.max(0, Math.min(1, (255 - l) / 85)));
    }
}

function alphaBox(d: ImageData, min = 10): [number, number, number, number] | null {
  const { width: W, height: H, data } = d;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4 + 3] < min) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

function prepare(img: HTMLImageElement, kind: SkinImageKind): SkinImage | null {
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  if (!(nw > 0 && nh > 0)) return null;
  const lim = LIMITS[kind];
  const s = Math.min(1, lim.side / Math.max(nw, nh), lim.h / nh);
  const c = canvas(nw * s, nh * s);
  const ctx = c.getContext('2d', { willReadFrequently: kind === 'sprite' });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  let data: ImageData;
  try {
    // a tainted canvas can't become a WebGL texture: treat it as unavailable rather than break the game
    data = kind === 'sprite' ? ctx.getImageData(0, 0, c.width, c.height) : ctx.getImageData(0, 0, 1, 1);
  } catch {
    return null;
  }
  if (kind === 'backdrop') return { canvas: c, w: c.width, h: c.height };
  keyWhite(data);
  const b = alphaBox(data);
  if (!b) return null;
  ctx.putImageData(data, 0, 0);
  const [x0, y0, x1, y1] = b;
  if (x0 === 0 && y0 === 0 && x1 === c.width && y1 === c.height) return { canvas: c, w: c.width, h: c.height };
  const out = canvas(x1 - x0, y1 - y0);
  out.getContext('2d')?.drawImage(c, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return { canvas: out, w: out.width, h: out.height };
}

// ---- drawing ------------------------------------------------------------------------------------------------

/** Draw a picture into a box (any units of the context's transform) by its fit rule. */
export function drawSkinFitted(ctx: CanvasRenderingContext2D, img: SkinImage, box: RectCells, fit: SkinFit): void {
  const rects = fitRects(img.w, img.h, box, fit);
  if (!rects.length) return;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = 1;
  for (const [x, y, w, h] of rects) ctx.drawImage(img.canvas, x, y, w, h);
  ctx.restore();
}

/** A texture-ready canvas covering `box` (cells) at `px` canvas px per logical px, the picture placed by `fit`. */
export function composeSkin(img: SkinImage, box: RectCells, fit: SkinFit, px: number): { canvas: HTMLCanvasElement; px: number } {
  const wl = (box[2] - box[0]) * CELL;
  const hl = (box[3] - box[1]) * CELL;
  // keep textures within 4096 px a side
  const k = Math.min(px, 4096 / Math.max(1, wl), 4096 / Math.max(1, hl));
  const c = canvas(Math.ceil(wl * k), Math.ceil(hl * k));
  const ctx = c.getContext('2d');
  if (ctx) drawSkinFitted(ctx, img, [0, 0, c.width, c.height], fit);
  return { canvas: c, px: k };
}

/**
 * The backdrop as seen from a camera at `camX` (world px), drawn in world px: scaled to the world height, scrolling
 * at SKIN_PARALLAX × the camera, repeated sideways as far as the view needs.
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D, img: SkinImage, camX: number, viewW: number, worldH: number): void {
  const h = worldH;
  const w = (img.w / img.h) * h;
  if (!(w > 0)) return;
  const origin = camX * (1 - SKIN_PARALLAX);
  const k0 = Math.floor((camX - origin) / w);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 1;
  for (let k = k0; origin + k * w < camX + viewW; k++) ctx.drawImage(img.canvas, origin + k * w, 0, w + 0.5, h);
  ctx.restore();
}
