/**
 * The editor's adapter to the v7 game look (docs/v7/CONTRACTS_V7.md §4.1, §5): AI variants, cleaned-up sketches,
 * terrain under ground lines and the painted backdrop, so the canvas shows what the runtime plays.
 *
 * Lane R2 owns the real renderers in `web/src/studio/theme/art.ts` (artImage, artCanvas, objectLook, renderTerrain,
 * renderBackdrop, and renderDrawing's `polish`). This file probes for them the way render.ts probes for
 * renderBackground: when they exist they are used, otherwise small fallbacks here draw the same things (SVGs through
 * an Image from a Blob URL, a gradient fill under ground strokes, the backdrop's sky and tiled layers).
 */
import type { ArtVariant, Backdrop, BackdropLayer, StudioTheme, TerrainSkin } from '../../core/types.gen.ts';
import * as themeRender from '../theme/render.ts';
import { mix } from '../theme/color.ts';
import { drawOrder, localToWorld } from '../model/doc.ts';
import type { SDoc, SObj, SScene, SWorld, Vec } from '../model/types.ts';
import { drawBackground, isDark } from './render.ts';

// ---- lane R2 probe ----------------------------------------------------------------------------------------------

// A glob, not an import: the file may not exist yet in this branch, and then this is just {}.
const laneMods = import.meta.glob('../theme/art.ts', { eager: true }) as Record<string, Record<string, unknown>>;
const laneArt: Record<string, unknown> = Object.values(laneMods)[0] ?? {};
const failed = new Set<string>();

function lane<T>(name: string): T | null {
  if (failed.has(name)) return null;
  const f = laneArt[name] ?? (themeRender as Record<string, unknown>)[name];
  return typeof f === 'function' ? (f as T) : null;
}

function laneFailed(name: string, e: unknown): void {
  failed.add(name);
  console.warn(`theme/art ${name} failed; using the editor fallback`, e);
}

/** True when lane R2's art renderers are in this build (for diagnostics). */
export const hasLaneArt = (): boolean => Object.keys(laneArt).length > 0;

// ---- which look plays -------------------------------------------------------------------------------------------

export type ObjLook = 'ai' | 'sketch' | 'raw';

export const docLook = (doc: Pick<SDoc, 'look'>): 'game' | 'sketch' => (doc.look === 'sketch' ? 'sketch' : 'game');

export const isGroundObj = (o: Pick<SObj, 'physics'>): boolean => o.physics.shape === 'line';

/** The variant an object plays (its chosen one, else the first). */
export function chosenVariant(o: Pick<SObj, 'art'>, id?: string | null): ArtVariant | null {
  const vs = o.art?.variants ?? [];
  const want = id === undefined ? o.art?.chosen : id;
  return vs.find((v) => v.id === want) ?? (id === undefined ? vs[0] ?? null : null);
}

/** `raw` in the sketch look; `ai` when the object plays AI art that exists; else the cleaned-up sketch. */
export function objectLook(o: SObj, doc: SDoc): ObjLook {
  const fn = lane<(o: unknown, d: unknown) => ObjLook>('objectLook');
  if (fn) {
    try {
      const v = fn(o, doc);
      if (v === 'ai' || v === 'sketch' || v === 'raw') return v;
    } catch (e) {
      laneFailed('objectLook', e);
    }
  }
  if (docLook(doc) === 'sketch') return 'raw';
  if (o.art?.use === 'ai' && (chosenVariant(o) || (isGroundObj(o) && o.art.terrain))) return 'ai';
  return 'sketch';
}

// ---- SVG images -------------------------------------------------------------------------------------------------

interface ImgEntry { img: HTMLImageElement | null; state: 'loading' | 'ready' | 'error'; url: string | null; waiters: Set<() => void> }
const images = new Map<string, ImgEntry>();

/** Make sure the root <svg> has a width and height (Firefox will not draw an SVG image without them). */
export function sizedSvg(svg: string, w?: number, h?: number): string {
  const m = /<svg\b[^>]*>/i.exec(svg);
  if (!m) return svg;
  const tag = m[0];
  if (/\swidth\s*=/.test(tag) && /\sheight\s*=/.test(tag)) return svg;
  let vw = w ?? 0;
  let vh = h ?? 0;
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb) { vw = Number(vb[1]) || vw; vh = Number(vb[2]) || vh; }
  if (!(vw > 0) || !(vh > 0)) return svg;
  const clean = tag.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  const sized = clean.replace(/^<svg\b/i, `<svg width="${vw}" height="${vh}"`);
  return svg.slice(0, m.index) + sized + svg.slice(m.index + tag.length);
}

/** A Blob URL for an SVG (cached; for <img> previews in cards). */
export function svgUrl(svg: string): string {
  let e = images.get(svg);
  if (!e) {
    e = { img: null, state: 'loading', url: null, waiters: new Set() };
    images.set(svg, e);
    startLoad(svg, e);
  }
  if (!e.url) e.url = URL.createObjectURL(new Blob([sizedSvg(svg)], { type: 'image/svg+xml' }));
  return e.url;
}

function startLoad(svg: string, e: ImgEntry): void {
  const done = (img: HTMLImageElement | null): void => {
    e.img = img;
    e.state = img ? 'ready' : 'error';
    for (const w of [...e.waiters]) { try { w(); } catch { /* a closed view */ } }
    e.waiters.clear();
  };
  const fn = lane<(svg: string) => Promise<HTMLImageElement>>('artImage');
  if (fn) {
    try {
      void fn(svg).then(done, () => done(null));
      return;
    } catch (err) {
      laneFailed('artImage', err);
    }
  }
  e.url ??= URL.createObjectURL(new Blob([sizedSvg(svg)], { type: 'image/svg+xml' }));
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => done(img);
  img.onerror = () => done(null);
  img.src = e.url;
}

/** The loaded image for an SVG, or null while it loads (`onReady` is called once it is there). */
export function artImage(svg: string, onReady?: () => void): HTMLImageElement | null {
  let e = images.get(svg);
  if (!e) {
    e = { img: null, state: 'loading', url: null, waiters: new Set() };
    images.set(svg, e);
    startLoad(svg, e);
  }
  if (e.state === 'ready') return e.img;
  if (e.state === 'loading' && onReady) e.waiters.add(onReady);
  return null;
}

/** Resolves when the SVG is loaded (or failed). */
export function loadArt(svg: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = artImage(svg, () => resolve(images.get(svg)?.img ?? null));
    if (img) resolve(img);
    else if (images.get(svg)?.state === 'error') resolve(null);
  });
}

// ---- variant bitmaps --------------------------------------------------------------------------------------------

interface Raster { bucket: number; canvas: HTMLCanvasElement }
interface RasterSlot { have: Raster | null; want: number | null }
const rasters = new WeakMap<ArtVariant, RasterSlot>();
const MAX_TEX = 4096;

const bucketOf = (px: number, size: number): number => {
  const b = 2 ** (Math.round(Math.log2(Math.max(0.05, px)) * 2) / 2);
  return Math.min(b, MAX_TEX / Math.max(1, size));
};

function rasterize(img: CanvasImageSource, w: number, h: number, bucket: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * bucket));
  c.height = Math.max(1, Math.round(h * bucket));
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  return c;
}

/**
 * The variant rasterized at about `pxPerUnit` device px per viewBox unit (bucketed), or null while its image loads
 * (an older, blurrier raster is returned while a sharper one renders). The canvas covers the variant's viewBox
 * (`w × h`), so draw it into the object's drawing box.
 */
export function variantBitmap(v: ArtVariant, pxPerUnit: number, onReady: () => void): Raster | null {
  const bucket = bucketOf(pxPerUnit, Math.max(v.w, v.h));
  let slot = rasters.get(v);
  if (!slot) { slot = { have: null, want: null }; rasters.set(v, slot); }
  if (slot.have && Math.abs(slot.have.bucket - bucket) < 1e-6) return slot.have;
  const laneCanvas = lane<(v: ArtVariant, scale: number) => Promise<HTMLCanvasElement>>('artCanvas');
  if (laneCanvas) {
    if (slot.want !== null && Math.abs(slot.want - bucket) < 1e-6) return slot.have;
    slot.want = bucket;
    const s = slot;
    try {
      void laneCanvas(v, bucket).then((canvas) => {
        if (s.want === bucket) { s.have = { bucket, canvas }; s.want = null; }
        onReady();
      }, (e) => { laneFailed('artCanvas', e); s.want = null; onReady(); });
      return slot.have;
    } catch (e) {
      laneFailed('artCanvas', e);
      slot.want = null;
    }
  }
  const img = artImage(v.svg, onReady);
  if (!img) return slot.have;
  slot.have = { bucket, canvas: rasterize(img, v.w, v.h, bucket) };
  return slot.have;
}

// ---- terrain ----------------------------------------------------------------------------------------------------

/** Device-space camera off the current transform (the renderBackground convention, v6 integration note). */
function deviceCam(ctx: CanvasRenderingContext2D): { x: number; y: number; zoom: number } {
  const m = ctx.getTransform();
  const zoom = m.a || 1;
  return { x: -m.e / zoom, y: -m.f / (m.d || zoom), zoom };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The land colours when there is no skin: from the stroke colour and the theme, never a bare wire. */
export function plainSkin(o: SObj, theme: StudioTheme): TerrainSkin {
  const ink = o.drawing.strokes[0]?.color && /^#[0-9a-f]{6}$/i.test(o.drawing.strokes[0].color) ? o.drawing.strokes[0].color : theme.palette?.good ?? '#3bb273';
  const bg = theme.palette?.bg ?? '#f6f1e7';
  const dark = isDark(bg);
  const top = mix(ink, bg, dark ? 0.45 : 0.55);
  return {
    fill: [top, mix(top, dark ? '#000000' : '#3a2e25', 0.35)],
    surface: ink,
    surface_width: Math.max(6, (o.drawing.strokes[0]?.width ?? 6) * 1.6),
    decor: [],
    decor_every: 220,
    rev: 0,
  };
}

/**
 * Land under a ground line: `ctx` is in world coordinates (and clipped to the world). Lane R2's renderTerrain when
 * it exists, else a gradient polygon from every stroke down to the world's bottom, a tiled texture, the surface band
 * and decorations along the top (seeded by the object id, so they never jump).
 */
export function drawTerrain(ctx: CanvasRenderingContext2D, o: SObj, skin: TerrainSkin | null, theme: StudioTheme, world: SWorld, onReady: () => void): void {
  const fn = lane<(ctx: CanvasRenderingContext2D, o: unknown, s: TerrainSkin | null, t: StudioTheme, w: SWorld, cam: unknown) => void>('renderTerrain');
  if (fn) {
    ctx.save();
    try {
      fn(ctx, o, skin, theme, world, deviceCam(ctx));
      ctx.restore();
      return;
    } catch (e) {
      ctx.restore();
      laneFailed('renderTerrain', e);
    }
  }
  const s = skin ?? plainSkin(o, theme);
  const fill = (s.fill?.length ? s.fill : ['#8d6e63', '#5d4037']) as string[];
  const bottom = world.height + 4;
  for (const st of o.drawing.strokes) {
    const pts = (st.points as Vec[]).map((p) => localToWorld(o, p));
    if (pts.length < 2) continue;
    const top = Math.min(...pts.map((p) => p[1]));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], bottom);
    for (const p of pts) ctx.lineTo(p[0], p[1]);
    ctx.lineTo(pts[pts.length - 1][0], bottom);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    fill.forEach((c, i) => g.addColorStop(fill.length === 1 ? 0 : i / (fill.length - 1), c));
    ctx.fillStyle = g;
    ctx.fill();
    if (s.texture_svg) {
      const img = artImage(s.texture_svg, onReady);
      const pat = img ? ctx.createPattern(img, 'repeat') : null;
      if (pat) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = pat;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    if ((s.surface_width ?? 14) > 0) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = s.surface ?? '#3bb273';
      ctx.lineWidth = s.surface_width ?? 14;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();
    if (s.decor?.length) drawDecor(ctx, o, pts, s, onReady);
  }
}

function drawDecor(ctx: CanvasRenderingContext2D, o: SObj, pts: Vec[], s: TerrainSkin, onReady: () => void): void {
  const decor = s.decor ?? [];
  const every = Math.max(40, s.decor_every ?? 220);
  const rnd = seeded(hashStr(o.id));
  let next = every * (0.3 + rnd());
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    while (walked + len >= next) {
      const t = (next - walked) / (len || 1);
      const v = decor[Math.floor(rnd() * decor.length)];
      const img = v ? artImage(v.svg, onReady) : null;
      if (v && img) {
        const k = 0.8 + rnd() * 0.4;
        const w = v.w * k;
        const hgt = v.h * k;
        ctx.drawImage(img, ax + (bx - ax) * t - w / 2, ay + (by - ay) * t - hgt + (s.surface_width ?? 14) * 0.3, w, hgt);
      }
      next += every * (0.6 + rnd() * 0.8);
    }
    walked += len;
  }
}

// ---- backdrop ---------------------------------------------------------------------------------------------------

const layerRasters = new WeakMap<BackdropLayer, Raster>();

/**
 * The painted world behind everything; `ctx` is in world coordinates and clipped to the world. Lane R2's
 * renderBackdrop (device-space camera, like renderBackground) when it exists, else the sky gradient and the layers
 * tiled along the bottom (or top), with a little parallax as the editor pans.
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D, b: Backdrop, theme: StudioTheme, world: SWorld, onReady: () => void): void {
  const fn = lane<(ctx: CanvasRenderingContext2D, b: Backdrop, w: SWorld, cam: unknown, view: unknown) => void>('renderBackdrop');
  if (fn) {
    ctx.save();
    try {
      fn(ctx, b, world, deviceCam(ctx), { w: ctx.canvas.width, h: ctx.canvas.height });
      ctx.restore();
      return;
    } catch (e) {
      ctx.restore();
      laneFailed('renderBackdrop', e);
    }
  }
  const sky = (b.sky ?? []) as string[];
  if (sky.length) {
    const g = ctx.createLinearGradient(0, 0, 0, world.height);
    sky.forEach((c, i) => g.addColorStop(sky.length === 1 ? 0 : i / (sky.length - 1), c));
    ctx.fillStyle = g;
  } else ctx.fillStyle = theme.palette?.bg ?? '#f6f1e7';
  ctx.fillRect(0, 0, world.width, world.height);
  const cam = deviceCam(ctx);
  const viewH = Math.min(world.height, 900);
  for (const layer of (b.layers ?? []) as BackdropLayer[]) {
    const hgt = layer.anchor === 'fill' ? world.height : viewH * (layer.height ?? 0.5);
    const w = layer.w * (hgt / layer.h);
    const y = layer.anchor === 'top' ? 0 : layer.anchor === 'fill' ? 0 : world.height - hgt;
    const img = artImage(layer.svg, onReady);
    if (!img) continue;
    let r = layerRasters.get(layer);
    const bucket = bucketOf(cam.zoom * (hgt / layer.h), layer.w);
    if (!r || Math.abs(r.bucket - bucket) > 1e-6) {
      r = { bucket, canvas: rasterize(img, layer.w, layer.h, bucket) };
      layerRasters.set(layer, r);
    }
    const shift = Math.max(0, cam.x) * (1 - (layer.depth ?? 0.5)) * 0.35;
    if (layer.tile_x === false) {
      ctx.drawImage(r.canvas, 0, y, world.width, hgt);
      continue;
    }
    const start = (shift % w) - w;
    for (let x = start; x < world.width; x += w) ctx.drawImage(r.canvas, x, y, w + 0.5, hgt);
  }
}

/** The world behind the objects: the backdrop in the game look when there is one, else the theme background. */
export function drawWorldBack(ctx: CanvasRenderingContext2D, doc: SDoc, world: SWorld, cam: { x: number; y: number; zoom: number; width: number; height: number }, onReady: () => void): void {
  if (docLook(doc) === 'game' && doc.backdrop && ((doc.backdrop.layers?.length ?? 0) > 0 || (doc.backdrop.sky?.length ?? 0) > 0)) {
    drawBackdrop(ctx, doc.backdrop, doc.theme, world, onReady);
    return;
  }
  drawBackground(ctx, doc.theme, world, cam);
}

// ---- polished sketch --------------------------------------------------------------------------------------------

/** renderDrawing with lane R2's `polish` (ignored by renderers that do not know it: then it is the v6 look). */
export function renderLook(o: SObj, theme: StudioTheme, scale: number, pad: number, polish: boolean, recolorMap?: Map<string, string> | null): HTMLCanvasElement {
  const opts = { scale, pad, recolorMap: recolorMap ?? undefined, ...(polish ? { polish: true } : {}) };
  return themeRender.renderDrawing(o.drawing, theme, opts as themeRender.RenderOpts);
}

// ---- whole scenes (cards, thumbnails) ---------------------------------------------------------------------------

/** Every SVG a scene's game look needs. */
function sceneSvgs(doc: SDoc, scene: SScene): string[] {
  const out: string[] = [];
  if (docLook(doc) === 'game') for (const l of (doc.backdrop?.layers ?? []) as BackdropLayer[]) out.push(l.svg);
  for (const o of scene.objects) {
    if (objectLook(o, doc) !== 'ai') continue;
    const v = chosenVariant(o);
    if (v && !isGroundObj(o)) out.push(v.svg);
    const t = o.art?.terrain;
    if (t && isGroundObj(o)) {
      if (t.texture_svg) out.push(t.texture_svg);
      for (const d of (t.decor ?? []) as ArtVariant[]) out.push(d.svg);
    }
  }
  return out;
}

/** Draw one object at its place; `ctx` is in world coordinates. */
function drawObjectWorld(ctx: CanvasRenderingContext2D, o: SObj, doc: SDoc, world: SWorld, z: number, onReady: () => void, forceVariant?: string | null): void {
  const look = forceVariant !== undefined ? (forceVariant ? 'ai' : 'sketch') : objectLook(o, doc);
  if (look !== 'raw' && isGroundObj(o)) {
    drawTerrain(ctx, o, look === 'ai' ? o.art?.terrain ?? null : null, doc.theme, world, onReady);
    return;
  }
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.rotate((o.rotation * Math.PI) / 180);
  ctx.scale(o.scale, o.scale);
  const v = look === 'ai' ? chosenVariant(o, forceVariant ?? undefined) : null;
  const bmp = v ? variantBitmap(v, z * o.scale, onReady) : null;
  if (v && bmp) {
    ctx.drawImage(bmp.canvas, -o.drawing.w / 2, -o.drawing.h / 2, o.drawing.w, o.drawing.h);
  } else if (o.drawing.strokes.length) {
    const k = Math.max(0.05, z * o.scale);
    const art = renderLook(o, doc.theme, k, Math.ceil(12 * k) + 2, look === 'sketch');
    ctx.scale(1 / k, 1 / k);
    ctx.drawImage(art, -art.width / 2, -art.height / 2);
  }
  ctx.restore();
}

/**
 * The scene in its current look, drawn into `width × height` (filled, aspect kept; `region` picks the window), once
 * every image it needs has loaded. For the restyle card, the compare card and thumbnails.
 */
export async function sceneLookCanvas(doc: SDoc, scene: SScene, width: number, height: number, o: { region?: { x: number; y: number; w: number; h: number } } = {}): Promise<HTMLCanvasElement> {
  await Promise.all(sceneSvgs(doc, scene).map(loadArt));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const world = scene.world;
  const reg = o.region ?? { x: 0, y: 0, w: world.width, h: world.height };
  const z = Math.max(width / reg.w, height / reg.h);
  ctx.fillStyle = doc.theme.palette?.bg ?? '#f6f1e7';
  ctx.fillRect(0, 0, width, height);
  ctx.translate((width - reg.w * z) / 2 - reg.x * z, (height - reg.h * z) / 2 - reg.y * z);
  ctx.scale(z, z);
  ctx.beginPath();
  ctx.rect(0, 0, world.width, world.height);
  ctx.clip();
  const noop = (): void => undefined;
  drawWorldBack(ctx, doc, world, { x: reg.x, y: reg.y, zoom: z, width, height }, noop);
  for (const ob of drawOrder(scene.objects)) {
    if (ob.template || ob.hidden) continue;
    if (!ob.drawing.strokes.length) continue;
    drawObjectWorld(ctx, ob, doc, world, z, noop);
  }
  return c;
}

/** The start window of a scene for a 16:9 picture (big worlds show their first screen). */
export function startRegion(world: SWorld, aspect = 16 / 9): { x: number; y: number; w: number; h: number } {
  if (world.width / world.height > aspect * 1.4) return { x: 0, y: 0, w: Math.min(world.width, world.height * aspect), h: world.height };
  if (world.height / world.width > 1.4 / aspect) return { x: 0, y: Math.max(0, world.height - world.width / aspect), w: world.width, h: Math.min(world.height, world.width / aspect) };
  return { x: 0, y: 0, w: world.width, h: world.height };
}

/** The area around one object (with some room), for a close-up of it in its scene. */
export function objectRegion(o: SObj, world: SWorld, aspect = 1): { x: number; y: number; w: number; h: number } {
  const size = Math.max(o.drawing.w, o.drawing.h) * o.scale;
  let w = Math.max(size * 1.6, 120);
  let h = w / aspect;
  if (h < o.drawing.h * o.scale * 1.6) { h = o.drawing.h * o.scale * 1.6; w = h * aspect; }
  return { x: Math.max(0, Math.min(world.width - w, o.x - w / 2)), y: Math.max(0, Math.min(world.height - h, o.y - h / 2)), w: Math.min(w, world.width), h: Math.min(h, world.height) };
}

/** The maker's drawing of one object, cleaned up (the "Yours" tile): a canvas about `size` px on its long side. */
export function sketchTile(o: SObj, theme: StudioTheme, size: number, polish = true): HTMLCanvasElement {
  const long = Math.max(o.drawing.w, o.drawing.h, 1);
  const k = (size * 0.8) / long;
  // renderDrawing caches its canvases: hand out a copy (a DOM node lives in one place, and callers style it)
  const src = renderLook(o, theme, k, Math.ceil(size * 0.06), polish);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}
