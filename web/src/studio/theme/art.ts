/**
 * The finished look of a game (docs/v7/CONTRACTS_V7.md §4.1), shared by the runtime and the Studio canvas so both show
 * the same thing. Everything here draws on a 2D canvas; the runtime turns the results into textures.
 *
 * Exported API for the editor (lane E2):
 *
 *   objectLook(obj, doc) → 'ai' | 'sketch' | 'raw'
 *       'raw' when doc.look is 'sketch' (show raw strokes, v6), 'ai' when the object's art.use is 'ai' and it has a
 *       chosen variant (or, for a ground line, a terrain skin), else 'sketch' (the cleaned-up drawing).
 *   chosenVariant(obj) → ArtVariant | null          the variant that plays (art.chosen, else the first).
 *   isTerrainObject(obj) → boolean                    physics.shape === 'line' (ground: drawn with renderTerrain).
 *
 *   objectBitmap(obj, doc, theme, { scale, recolorMap? }) → { canvas, ox, oy, scale, look } | null      (sync)
 *       The object's look rasterized at `scale` device px per local unit; (ox, oy) is the canvas pixel where the
 *       object's local (0, 0) sits, so draw it with ctx in object-local units:
 *         ctx.drawImage(b.canvas, -b.ox / b.scale, -b.oy / b.scale, b.canvas.width / b.scale, b.canvas.height / b.scale)
 *       AI art still loading falls back to the cleaned-up sketch (call onArtReady to redraw when it lands). Returns null
 *       for objects with nothing to draw. In the `game` look, ground lines should use renderTerrain instead.
 *
 *   renderTerrain(ctx, obj, skin | null, theme, world, camera?, { view?, others?, look? })
 *       Solid land for a ground line: fill under every stroke down past the world's bottom, a surface band along the
 *       line, texture and decorations (seeded by the object id). `skin` null (or look not 'ai') = good default land
 *       from the theme. `camera` uses the renderBackground convention (device space: {x, y} = world point at the
 *       canvas's top left, zoom = device px per world px, `view` = canvas size); omit it to draw in the context's
 *       current transform (ctx already in world coordinates). Pass `others` (the scene's other ground objects) so a
 *       line floating above another ground becomes a floating island instead of a pillar.
 *   terrainSkinFor(obj, doc, theme) → ResolvedSkin    the skin renderTerrain uses for that object in the doc's look.
 *
 *   renderBackdrop(ctx, backdrop, world, camera, view?, theme?)
 *       The AI backdrop (sky gradient + parallax layers), device-space camera exactly like renderBackground.
 *   renderLookBackground(ctx, doc, theme, world, camera, view?)
 *       renderBackdrop when the doc is in the `game` look and has a backdrop, else the theme's renderBackground.
 *
 *   artImage(svg) → Promise<HTMLImageElement>        cached per SVG string (Blob URL).
 *   artCanvas(variant, scale) → Promise<HTMLCanvasElement>, artCanvasSync(variant, scale) → canvas | null
 *       The variant rasterized crisp at `scale` px per unit (w × h × scale), cached.
 *   onArtReady(fn) → unsubscribe                       fn() runs (batched) whenever an SVG finishes loading.
 *   preloadArt(doc, timeoutMs?) → Promise<void>        loads every SVG the doc's game look needs.
 *
 *   renderDrawing(..., { polish: true }) lives in render.ts (the cleaned-up sketch).
 */
import type { ArtVariant, Backdrop, BackdropLayer, Drawing, GameDoc, StudioTheme, TerrainSkin } from '../../core/types.gen.ts';
import { renderBackground, type CameraView } from './background.ts';
import { backdropPlacement, svgSize } from './backdrop.ts';
import { fullTheme, isDark, mix, rgba, type FullTheme } from './color.ts';
import { drawingCanvasOrigin, renderDrawing } from './render.ts';
import { hashNums, hashStr, rng } from './rng.ts';
import {
  boxesOverlap, buildTerrain, decorSpots, defaultSkin, offsetLine, pebbleSpots, resolveSkin, type Box, type DecorSpot, type Pt,
  type ResolvedSkin, type TerrainObj, type TerrainPiece,
} from './terrain.ts';

export { backdropPlacement, svgSize } from './backdrop.ts';
export type { ResolvedSkin } from './terrain.ts';

export type Look = 'ai' | 'sketch' | 'raw';

/** What art.ts needs of an object (GameDoc ObjectDef, the editor's SObj and the runtime's NObject all fit). */
export interface LookObj {
  id: string;
  drawing?: Drawing | null;
  x?: number;
  y?: number;
  rotation?: number;
  scale?: number;
  physics?: { shape?: string } | null;
  art?: {
    use?: string;
    chosen?: string | null;
    variants?: ArtVariant[] | null;
    terrain?: TerrainSkin | null;
  } | null;
}

export interface LookDoc {
  look?: string | null;
  backdrop?: Backdrop | null;
}

// ---- looks ------------------------------------------------------------------------------------------

export function isTerrainObject(obj: LookObj | null | undefined): boolean {
  return obj?.physics?.shape === 'line';
}

export function chosenVariant(obj: LookObj | null | undefined): ArtVariant | null {
  const vs = (obj?.art?.variants ?? []).filter((v) => v && typeof v.svg === 'string' && v.svg.includes('<svg'));
  if (!vs.length) return null;
  return vs.find((v) => v.id === obj?.art?.chosen) ?? vs[0];
}

export function objectLook(obj: LookObj | null | undefined, doc: LookDoc | null | undefined): Look {
  if (doc?.look === 'sketch') return 'raw';
  const art = obj?.art;
  if (art?.use === 'ai') {
    if (isTerrainObject(obj) ? !!art.terrain || !!chosenVariant(obj) : !!chosenVariant(obj)) return 'ai';
  }
  return 'sketch';
}

// ---- SVG images ------------------------------------------------------------------------------------

interface ImgEntry {
  img: HTMLImageElement | null;
  url: string | null;
  promise: Promise<HTMLImageElement>;
  ok: boolean;
  failed: boolean;
}

const images = new Map<string, ImgEntry>();
const canvases = new Map<string, HTMLCanvasElement>();
const MAX_IMAGES = 160;
const MAX_CANVASES = 96;
const MAX_ART_PX = 4096;
const listeners = new Set<() => void>();
let notifyQueued = false;

function notify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  const run = (): void => {
    notifyQueued = false;
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        /* a listener's error must not stop the others */
      }
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** Run `fn` whenever art finishes loading (batched per frame). Returns the unsubscribe function. */
export function onArtReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The SVG with an xmlns and an explicit width/height (Firefox needs an intrinsic size to draw it). */
export function prepSvg(svg: string): string {
  const size = svgSize(svg);
  const m = /<svg\b[^>]*>/i.exec(svg);
  if (!m) return svg;
  let tag = m[0].replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (size) tag = tag.replace(/^<svg/i, `<svg width="${size.w}" height="${size.h}"`);
  return svg.slice(0, m.index) + tag + svg.slice(m.index + m[0].length);
}

function entryFor(svg: string): ImgEntry {
  let e = images.get(svg);
  if (e) return e;
  let resolve!: (img: HTMLImageElement) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<HTMLImageElement>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  e = { img: null, url: null, promise, ok: false, failed: false };
  images.set(svg, e);
  if (images.size > MAX_IMAGES) {
    const [k, old] = images.entries().next().value as [string, ImgEntry];
    if (old.url) URL.revokeObjectURL(old.url);
    images.delete(k);
  }
  const entry = e;
  try {
    const url = URL.createObjectURL(new Blob([prepSvg(svg)], { type: 'image/svg+xml' }));
    entry.url = url;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      entry.img = img;
      entry.ok = true;
      resolve(img);
      notify();
    };
    img.onerror = (err) => {
      entry.failed = true;
      reject(err);
    };
    img.src = url;
  } catch (err) {
    entry.failed = true;
    reject(err);
  }
  return entry;
}

/** The SVG as a loaded image (cached per SVG string). Rejects when it cannot be decoded. */
export function artImage(svg: string): Promise<HTMLImageElement> {
  return entryFor(svg).promise;
}

/** The loaded image or null (and starts loading it). */
export function artImageSync(svg: string | null | undefined): HTMLImageElement | null {
  if (!svg) return null;
  const e = entryFor(svg);
  return e.ok ? e.img : null;
}

/** Has this SVG failed to load (bad markup)? */
export function artFailed(svg: string | null | undefined): boolean {
  return !!svg && !!images.get(svg)?.failed;
}

function canvasKey(svg: string, w: number, h: number, scale: number): string {
  return `${hashStr(svg).toString(36)}_${svg.length}_${w}x${h}@${scale}`;
}

function rasterize(img: HTMLImageElement, w: number, h: number, scale: number): HTMLCanvasElement {
  let s = scale;
  if (w * s > MAX_ART_PX || h * s > MAX_ART_PX) s = Math.min(MAX_ART_PX / w, MAX_ART_PX / h);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * s));
  c.height = Math.max(1, Math.ceil(h * s));
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
  }
  (c as HTMLCanvasElement & { __scale?: number }).__scale = s;
  return c;
}

/** The variant rasterized at `scale` px per unit, or null while its SVG loads. Cached. */
export function artCanvasSync(v: { svg: string; w: number; h: number } | null | undefined, scale: number): HTMLCanvasElement | null {
  if (!v || !v.svg) return null;
  const size = svgSize(v.svg);
  const w = v.w > 0 ? v.w : size?.w ?? 100;
  const h = v.h > 0 ? v.h : size?.h ?? 100;
  const s = Math.max(0.05, Math.round(scale * 4) / 4 || 1);
  const key = canvasKey(v.svg, w, h, s);
  const hit = canvases.get(key);
  if (hit) {
    canvases.delete(key);
    canvases.set(key, hit);
    return hit;
  }
  const img = artImageSync(v.svg);
  if (!img) return null;
  const c = rasterize(img, w, h, s);
  canvases.set(key, c);
  if (canvases.size > MAX_CANVASES) canvases.delete(canvases.keys().next().value as string);
  return c;
}

/** The variant rasterized crisp at `scale` px per unit. */
export async function artCanvas(v: { svg: string; w: number; h: number }, scale: number): Promise<HTMLCanvasElement> {
  await artImage(v.svg);
  const c = artCanvasSync(v, scale);
  if (!c) throw new Error('art not available');
  return c;
}

/** Every SVG a doc's game look uses (object variants that play, terrain skins, backdrop layers). */
export function docArtSvgs(doc: GameDoc | (LookDoc & { scenes?: { objects?: LookObj[] }[] }) | null | undefined): string[] {
  const out = new Set<string>();
  if (!doc || (doc as LookDoc).look === 'sketch') return [];
  for (const sc of (doc as { scenes?: { objects?: LookObj[] }[] }).scenes ?? []) {
    for (const o of sc?.objects ?? []) {
      if (objectLook(o, doc as LookDoc) !== 'ai') continue;
      const v = chosenVariant(o);
      if (v && !isTerrainObject(o)) out.add(v.svg);
      const t = o.art?.terrain;
      if (t && isTerrainObject(o)) {
        if (t.surface_svg) out.add(t.surface_svg);
        if (t.texture_svg) out.add(t.texture_svg);
        for (const d of t.decor ?? []) if (d?.svg) out.add(d.svg);
      }
    }
  }
  for (const l of (doc as LookDoc).backdrop?.layers ?? []) if (l?.svg) out.add(l.svg);
  return [...out].filter((s) => typeof s === 'string' && s.includes('<svg'));
}

/** Load every SVG the doc's game look needs (resolves after `timeoutMs` at the latest; failures are skipped). */
export function preloadArt(doc: GameDoc | null | undefined, timeoutMs = 5000): Promise<void> {
  let svgs: string[] = [];
  try {
    svgs = docArtSvgs(doc);
  } catch {
    svgs = [];
  }
  if (!svgs.length || typeof Image === 'undefined') return Promise.resolve();
  const all = Promise.allSettled(svgs.map((s) => artImage(s))).then(() => undefined);
  return Promise.race([all, new Promise<void>((res) => setTimeout(res, timeoutMs))]);
}

// ---- object bitmaps --------------------------------------------------------------------------------

export interface LookBitmap {
  canvas: HTMLCanvasElement;
  /** Canvas pixel of the object's local (0, 0). */
  ox: number;
  oy: number;
  /** Canvas px per local unit. */
  scale: number;
  look: Look;
}

/** Centre of the drawing's points (the art box is centred there; normally (0, 0)). */
export function inkCenter(d: Drawing | null | undefined): Pt {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of d?.strokes ?? []) {
    for (const p of s?.points ?? []) {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : [0, 0];
}

/** The box AI art is drawn into: drawing.w × drawing.h centred on the drawing (falls back to the variant's size). */
export function artBox(obj: LookObj, v: ArtVariant): { cx: number; cy: number; w: number; h: number } {
  const d = obj.drawing;
  const w = Number(d?.w) > 0 ? Number(d?.w) : v.w;
  const h = Number(d?.h) > 0 ? Number(d?.h) : v.h;
  const [cx, cy] = inkCenter(d);
  return { cx, cy, w: Math.max(1, w), h: Math.max(1, h) };
}

/** See the header. */
export function objectBitmap(obj: LookObj, doc: LookDoc | null | undefined, theme: StudioTheme | null,
  o: { scale: number; recolorMap?: Map<string, string> | null; pad?: number }): LookBitmap | null {
  const scale = o.scale > 0 ? o.scale : 1;
  const look = objectLook(obj, doc);
  if (look === 'ai' && !isTerrainObject(obj)) {
    const v = chosenVariant(obj);
    if (v) {
      const b = artBox(obj, v);
      const c = artCanvasSync({ svg: v.svg, w: b.w, h: b.h }, scale);
      if (c) {
        const s = (c as HTMLCanvasElement & { __scale?: number }).__scale ?? scale;
        return { canvas: c, ox: c.width / 2 - b.cx * s, oy: c.height / 2 - b.cy * s, scale: s, look };
      }
    }
  }
  const d = obj.drawing;
  if (!d?.strokes?.length) return null;
  const c = renderDrawing(d, theme, { scale, pad: o.pad, recolorMap: o.recolorMap ?? null, polish: look !== 'raw' });
  const org = drawingCanvasOrigin(c);
  return { canvas: c, ox: org.x, oy: org.y, scale, look: look === 'ai' ? 'sketch' : look };
}

// ---- terrain ------------------------------------------------------------------------------------------

export interface TerrainModel {
  pieces: TerrainPiece[];
  seed: number;
  box: Box;
  world: { width: number; height: number };
  spots: Map<string, DecorSpot[]>;
}

const modelCache = new WeakMap<object, { key: string; model: TerrainModel }>();
const drawingIds = new WeakMap<object, number>();
let drawingSeq = 0;

function drawingId(d: unknown): number {
  if (!d || typeof d !== 'object') return 0;
  let id = drawingIds.get(d);
  if (!id) {
    id = ++drawingSeq;
    drawingIds.set(d, id);
  }
  return id;
}

function objKey(o: LookObj): string {
  return `${o.id}:${drawingId(o.drawing)}:${o.x ?? 0},${o.y ?? 0},${o.rotation ?? 0},${o.scale ?? 1}`;
}

/** Terrain geometry for a line object (cached per object, its placement, the world and its neighbours). */
export function terrainModel(obj: LookObj, world: { width: number; height: number }, others: LookObj[] = []): TerrainModel {
  const key = `${objKey(obj)}|${world.width}x${world.height}|${others.filter((x) => x && x.id !== obj.id).map(objKey).join(';')}`;
  const hit = modelCache.get(obj);
  if (hit && hit.key === key) return hit.model;
  let pieces: TerrainPiece[] = [];
  try {
    pieces = buildTerrain(obj as TerrainObj, world, others as TerrainObj[]);
  } catch {
    pieces = [];
  }
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pieces) {
    box.minX = Math.min(box.minX, p.box.minX);
    box.minY = Math.min(box.minY, p.box.minY - 40);
    box.maxX = Math.max(box.maxX, p.box.maxX);
    box.maxY = Math.max(box.maxY, p.box.maxY);
  }
  const model: TerrainModel = { pieces, seed: hashStr(obj.id || 'ground'), box, world, spots: new Map() };
  modelCache.set(obj, { key, model });
  return model;
}

/** The skin a line object shows in the doc's look (AI skin when it plays, else the theme's land). */
export function terrainSkinFor(obj: LookObj, doc: LookDoc | null | undefined, theme: StudioTheme | FullTheme | null): ResolvedSkin {
  const ft = fullTheme(theme as StudioTheme);
  const first = obj.drawing?.strokes?.[0];
  const r = Math.max(4, (Number(first?.width) || 6) / 2) * (Number(obj.scale) > 0 ? Number(obj.scale) : 1);
  const color = typeof first?.color === 'string' ? first.color : ft.palette.ink;
  if (objectLook(obj, doc) === 'ai' && obj.art?.terrain) return resolveSkin(obj.art.terrain, ft, color, r);
  return defaultSkin(ft, color, r);
}

function spotsFor(model: TerrainModel, skin: ResolvedSkin): DecorSpot[] {
  const n = skin.decor.length || skin.procDecor.length;
  const key = `${n}|${skin.decorEvery}`;
  let s = model.spots.get(key);
  if (!s) {
    s = decorSpots(model.pieces, skin.decorEvery, model.seed, n, { minX: -300, maxX: model.world.width + 300 });
    model.spots.set(key, s);
  }
  return s;
}

function tracePoly(ctx: CanvasRenderingContext2D, pts: Pt[], close = true): void {
  ctx.beginPath();
  if (!pts.length) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
}

/** Only the part of a polyline near the view (with neighbours so joins stay clean). */
function clipRun(run: Pt[], view: Box, pad: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const inside = (a: Pt, b: Pt): boolean => Math.max(a[0], b[0]) >= view.minX - pad && Math.min(a[0], b[0]) <= view.maxX + pad
    && Math.max(a[1], b[1]) >= view.minY - pad && Math.min(a[1], b[1]) <= view.maxY + pad;
  for (let i = 1; i < run.length; i++) {
    if (inside(run[i - 1], run[i])) {
      if (!cur.length) cur.push(run[i - 1]);
      cur.push(run[i]);
    } else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function leftToRight(run: Pt[]): Pt[] {
  return run.length > 1 && run[0][0] > run[run.length - 1][0] ? run.slice().reverse() : run;
}

/** Split a long segment list into points every `step` px (for blades and the textured band). */
function walk(run: Pt[], step: number, fn: (x: number, y: number, ang: number, s: number) => void): void {
  let s0 = 0;
  let next = 0;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1];
    const b = run[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    while (next <= s0 + len) {
      const t = (next - s0) / len;
      fn(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, ang, next);
      next += step;
    }
    s0 += len;
  }
}

function patternFor(ctx: CanvasRenderingContext2D, svg: string, zoom: number): { pat: CanvasPattern; s: number } | null {
  const size = svgSize(svg);
  if (!size) return null;
  const s = Math.max(0.25, Math.min(3, Math.ceil(zoom * 4) / 4));
  const c = artCanvasSync({ svg, w: size.w, h: size.h }, s);
  if (!c) return null;
  const pat = ctx.createPattern(c, 'repeat');
  if (!pat) return null;
  const cs = (c as HTMLCanvasElement & { __scale?: number }).__scale ?? s;
  return { pat, s: cs };
}

function paintLand(ctx: CanvasRenderingContext2D, pc: TerrainPiece, skin: ResolvedSkin, view: Box, zoom: number, seed: number): void {
  const fill = skin.fill.length ? skin.fill : ['#8d6e63', '#5d4037'];
  ctx.save();
  tracePoly(ctx, pc.poly);
  ctx.clip();
  const vb = { minX: Math.max(view.minX, pc.box.minX) - 2, minY: Math.max(view.minY, pc.box.minY) - 2,
    maxX: Math.min(view.maxX, pc.box.maxX) + 2, maxY: Math.min(view.maxY, pc.box.maxY) + 2 };
  if (pc.kind === 'ground') {
    // strata that follow the surface: each deeper colour starts further below the top (with a gentle wave)
    ctx.fillStyle = fill[0];
    ctx.fillRect(vb.minX, vb.minY, vb.maxX - vb.minX, vb.maxY - vb.minY);
    const top = pc.runs[0] ?? [];
    const depths = [0, 64, 150, 290];
    const deep = pc.box.maxY + 10;
    // the run's points around the window, keeping one neighbour outside on each side (long edge extensions)
    let i0 = 0;
    let i1 = top.length - 1;
    while (i0 < top.length - 1 && top[i0 + 1][0] < view.minX - 400) i0++;
    while (i1 > 0 && top[i1 - 1][0] > view.maxX + 400) i1--;
    const near = top.slice(i0, i1 + 1);
    const band = (d: number, color: string, k: number): void => {
      const pts: Pt[] = [];
      for (const p of near) pts.push([p[0], p[1] + d + Math.sin(p[0] / 157 + k * 1.7) * Math.min(10, d * 0.12)]);
      if (pts.length < 2) return;
      pts.push([pts[pts.length - 1][0], deep], [pts[0][0], deep]);
      ctx.fillStyle = color;
      tracePoly(ctx, pts);
      ctx.fill();
    };
    for (let k = 1; k < fill.length; k++) {
      band(depths[k] - 22, mix(fill[k - 1], fill[k], 0.5), k + 0.5);
      band(depths[k], fill[k], k);
    }
  } else {
    const g = ctx.createLinearGradient(0, pc.box.minY, 0, pc.box.maxY);
    fill.forEach((c, i) => g.addColorStop(fill.length === 1 ? 0 : i / (fill.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(vb.minX, vb.minY, vb.maxX - vb.minX, vb.maxY - vb.minY);
  }
  // texture
  if (skin.textureSvg) {
    const p = patternFor(ctx, skin.textureSvg, zoom);
    if (p) {
      p.pat.setTransform(new DOMMatrix().scale(1 / p.s));
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = p.pat;
      ctx.fillRect(vb.minX, vb.minY, vb.maxX - vb.minX, vb.maxY - vb.minY);
      ctx.globalAlpha = 1;
    }
  }
  // strata lines and pebbles (procedural land)
  if (skin.strata && pc.kind === 'ground' && zoom > 0.2) {
    // strata lines need dense points (the wave and the dashes are sampled at the points)
    const top: Pt[] = [];
    const run = pc.runs[0] ?? [];
    for (let i = 0; i < run.length; i++) {
      const p = run[i];
      const q = run[i + 1];
      if (p[0] >= view.minX - 300 && p[0] <= view.maxX + 300) top.push(p);
      if (!q) break;
      const lo = Math.max(Math.min(p[0], q[0]), view.minX - 300);
      const hi = Math.min(Math.max(p[0], q[0]), view.maxX + 300);
      if (hi <= lo || Math.abs(q[0] - p[0]) < 24) continue;
      for (let x = Math.ceil(lo / 12) * 12; x < hi; x += 12) {
        const t = (x - p[0]) / (q[0] - p[0]);
        if (t > 0 && t < 1) top.push([x, p[1] + (q[1] - p[1]) * t]);
      }
    }
    top.sort((a, b) => a[0] - b[0]);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    [44, 108, 205, 340].forEach((d, k) => {
      ctx.strokeStyle = rgba(mix(fill[Math.min(fill.length - 1, k)], '#000000', 0.5), 0.13);
      ctx.beginPath();
      let pen = false;
      top.forEach((p, i) => {
        const y = p[1] + d + Math.sin(p[0] / 97 + k * 2.3) * 7;
        // broken lines read as rock layers, not stripes
        const on = (Math.floor((p[0] + k * 131) / 90) + k) % 4 !== 0;
        if (on && pen) ctx.lineTo(p[0], y);
        else if (on) ctx.moveTo(p[0], y);
        pen = on && i < top.length - 1;
      });
      ctx.stroke();
    });
  }
  if (skin.pebbles && zoom > 0.3) {
    for (const pb of pebbleSpots(vb, seed)) {
      const base = fill[Math.min(fill.length - 1, 1)];
      ctx.fillStyle = mix(base, pb.t < 0.5 ? '#000000' : '#ffffff', 0.16 + pb.t * 0.1);
      ctx.beginPath();
      ctx.ellipse(pb.x, pb.y, pb.r, pb.r * 0.72, pb.t * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = rgba('#ffffff', 0.18);
      ctx.beginPath();
      ctx.ellipse(pb.x - pb.r * 0.25, pb.y - pb.r * 0.25, pb.r * 0.4, pb.r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // a soft shade just under the surface gives the land depth
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const run of pc.runs) {
    for (const part of clipRun(run, view, 80)) {
      ctx.strokeStyle = 'rgba(0,0,0,0.09)';
      ctx.lineWidth = (skin.surfaceWidth + 30) * 2;
      tracePoly(ctx, part, false);
      ctx.stroke();
      ctx.lineWidth = (skin.surfaceWidth + 12) * 2;
      tracePoly(ctx, part, false);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function paintSurface(ctx: CanvasRenderingContext2D, pc: TerrainPiece, skin: ResolvedSkin, view: Box, zoom: number, seed: number): void {
  const sw = skin.surfaceWidth;
  if (sw <= 0 && !skin.surfaceSvg) return;
  const strip = skin.surfaceSvg ? svgSize(skin.surfaceSvg) : null;
  const stripH = strip ? Math.max(sw, Math.min(strip.h, 72)) : 0;
  const stripImg = strip && skin.surfaceSvg ? artCanvasSync({ svg: skin.surfaceSvg, w: (strip.w * stripH) / strip.h, h: stripH },
    Math.max(0.25, Math.min(3, Math.ceil(zoom * 4) / 4))) : null;
  for (const run0 of pc.runs) {
    for (const part0 of clipRun(run0, view, Math.max(60, stripH * 2))) {
      const part = leftToRight(part0);
      if (part.length < 2) continue;
      if (stripImg && strip) {
        // the AI strip, sliced along the line so it follows every slope without seams
        const pat = ctx.createPattern(stripImg, 'repeat-x');
        const cs = (stripImg as HTMLCanvasElement & { __scale?: number }).__scale ?? 1;
        if (pat) {
          const stripW = (strip.w * stripH) / strip.h;
          const step = Math.max(3, 7 / Math.max(0.3, zoom));
          // arc length from the run's start so tiles line up across views
          const s0 = arcTo(run0, part[0]);
          ctx.save();
          ctx.fillStyle = pat;
          walk(part, step, (x, y, ang, s) => {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(ang);
            pat.setTransform(new DOMMatrix().translate(-((s0 + s) % stripW), -stripH * 0.3).scale(1 / cs));
            ctx.fillRect(-0.4, -stripH * 0.3, step + 0.8, stripH);
            ctx.restore();
          });
          ctx.restore();
          continue;
        }
      }
      // the band: between the top and the top pushed down by the surface width
      const lower = offsetLine(part, -sw, false);
      ctx.save();
      if (skin.glow) {
        ctx.shadowColor = skin.surface;
        ctx.shadowBlur = 16;
      }
      ctx.fillStyle = skin.surface;
      tracePoly(ctx, [...part, ...lower.slice().reverse()]);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // dark lip under the band, light rim on top
      ctx.strokeStyle = rgba(skin.edge, 0.55);
      ctx.lineWidth = Math.max(1.5, sw * 0.16);
      tracePoly(ctx, lower, false);
      ctx.stroke();
      ctx.strokeStyle = rgba(mix(skin.surface, '#ffffff', 0.45), 0.85);
      ctx.lineWidth = Math.max(1.2, sw * 0.14);
      tracePoly(ctx, offsetLine(part, -ctx.lineWidth * 0.5, false), false);
      ctx.stroke();
      ctx.restore();
      if (skin.blades && zoom > 0.28) paintBlades(ctx, part, skin, seed);
    }
  }
}

function arcTo(run: Pt[], p: Pt): number {
  let s = 0;
  for (let i = 1; i < run.length; i++) {
    if (run[i - 1][0] === p[0] && run[i - 1][1] === p[1]) return s;
    s += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
  }
  return 0;
}

function paintBlades(ctx: CanvasRenderingContext2D, part: Pt[], skin: ResolvedSkin, seed: number): void {
  const dark = mix(skin.surface, '#000000', 0.18);
  const light = mix(skin.surface, '#ffffff', 0.18);
  ctx.save();
  walk(part, 5, (x, y, ang) => {
    const k = hashNums(seed, Math.round(x / 5));
    const r = (k % 1000) / 1000;
    const h = 3 + r * 6;
    const lean = ((k >> 10) % 100) / 100 - 0.5;
    // the blade points along the surface's up normal
    const nx = Math.sin(ang);
    const ny = -Math.cos(ang);
    const tx = Math.cos(ang);
    const ty = Math.sin(ang);
    ctx.fillStyle = r > 0.55 ? light : dark;
    ctx.beginPath();
    ctx.moveTo(x - tx * 2.2, y - ty * 2.2 + 1);
    ctx.lineTo(x + nx * h + tx * lean * 4, y + ny * h + ty * lean * 4);
    ctx.lineTo(x + tx * 2.2, y + ty * 2.2 + 1);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();
}

function paintWall(ctx: CanvasRenderingContext2D, pc: TerrainPiece, skin: ResolvedSkin): void {
  const fill = skin.fill.length ? skin.fill : ['#8d6e63', '#5d4037'];
  const w = pc.r * 2;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  tracePoly(ctx, pc.line, false);
  ctx.strokeStyle = mix(fill[Math.min(1, fill.length - 1)], '#000000', 0.35);
  ctx.lineWidth = w + 5;
  ctx.stroke();
  ctx.strokeStyle = fill[Math.min(1, fill.length - 1)];
  ctx.lineWidth = w + 1;
  ctx.stroke();
  ctx.strokeStyle = rgba(mix(fill[0], '#ffffff', 0.35), 0.6);
  ctx.lineWidth = Math.max(1.5, w * 0.22);
  ctx.translate(-w * 0.18, -w * 0.12);
  tracePoly(ctx, pc.line, false);
  ctx.stroke();
  ctx.restore();
  // a cap of the surface colour on the top end
  const topPt = pc.line.reduce((a, p) => (p[1] < a[1] ? p : a), pc.line[0]);
  if (topPt) {
    ctx.fillStyle = skin.surface;
    ctx.beginPath();
    ctx.arc(topPt[0], topPt[1], pc.r + 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// procedural decorations, drawn with their base at (0, 0) pointing up, in world px
function procDecor(ctx: CanvasRenderingContext2D, kind: string, skin: ResolvedSkin, r: () => number): void {
  const fill = skin.fill.length ? skin.fill : ['#8d6e63'];
  switch (kind) {
    case 'tuft':
    case 'drytuft': {
      const c = kind === 'drytuft' ? '#b59b5a' : skin.surface;
      const n = 5 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1) - 0.5;
        const h = 9 + r() * 9 - Math.abs(t) * 6;
        ctx.fillStyle = mix(c, i % 2 ? '#000000' : '#ffffff', 0.12 + r() * 0.1);
        ctx.beginPath();
        ctx.moveTo(t * 10 - 2, 1);
        ctx.quadraticCurveTo(t * 12, -h * 0.5, t * 22, -h);
        ctx.quadraticCurveTo(t * 10 + 1, -h * 0.4, t * 10 + 2, 1);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'flower': {
      const h = 14 + r() * 8;
      ctx.strokeStyle = mix(skin.surface, '#000000', 0.25);
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, 1);
      ctx.quadraticCurveTo(3, -h * 0.5, 0, -h);
      ctx.stroke();
      const petal = r() < 0.5 ? skin.accent : mix(skin.accent, '#ffffff', 0.55);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        ctx.fillStyle = petal;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 3.2, -h + Math.sin(a) * 3.2, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffd34e';
      ctx.beginPath();
      ctx.arc(0, -h, 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'rock': {
      const w = 10 + r() * 14;
      const h = w * (0.55 + r() * 0.25);
      const base = mix(fill[Math.min(1, fill.length - 1)], '#8a8a8a', 0.45);
      const pts: Pt[] = [];
      const n = 7;
      for (let k = 0; k <= n; k++) {
        const a = Math.PI + (k / n) * Math.PI;
        const rr = 0.8 + r() * 0.3;
        pts.push([Math.cos(a) * w * 0.5 * rr, Math.sin(a) * h * rr + 3]);
      }
      ctx.fillStyle = base;
      tracePoly(ctx, pts);
      ctx.fill();
      ctx.fillStyle = rgba('#ffffff', 0.22);
      ctx.beginPath();
      ctx.ellipse(-w * 0.12, -h * 0.45 + 3, w * 0.22, h * 0.2, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(mix(base, '#000000', 0.5), 0.6);
      ctx.lineWidth = 1.4;
      tracePoly(ctx, pts);
      ctx.stroke();
      break;
    }
    case 'crater': {
      const w = 22 + r() * 22;
      ctx.fillStyle = rgba(mix(fill[0], '#000000', 0.45), 0.55);
      ctx.beginPath();
      ctx.ellipse(0, 3, w * 0.5, w * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(mix(skin.surface, '#ffffff', 0.4), 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, 2, w * 0.52, w * 0.15, 0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.stroke();
      break;
    }
    case 'shell': {
      const s = 5 + r() * 4;
      ctx.fillStyle = mix('#f7b9a8', skin.accent, 0.2);
      ctx.beginPath();
      ctx.moveTo(0, 1);
      for (let k = 0; k <= 6; k++) {
        const a = Math.PI + (k / 6) * Math.PI;
        ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba('#7a4b3a', 0.5);
      ctx.lineWidth = 1;
      for (let k = 1; k < 6; k++) {
        const a = Math.PI + (k / 6) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(0, 1);
        ctx.lineTo(Math.cos(a) * s * 0.9, Math.sin(a) * s * 0.9);
        ctx.stroke();
      }
      break;
    }
    case 'crystal': {
      const c = skin.accent;
      for (let k = -1; k <= 1; k++) {
        const h = 12 + r() * 12 - Math.abs(k) * 4;
        const w = 4 + r() * 2;
        ctx.save();
        ctx.rotate(k * 0.35);
        ctx.fillStyle = mix(c, k ? '#000000' : '#ffffff', 0.15);
        ctx.beginPath();
        ctx.moveTo(-w, 2);
        ctx.lineTo(-w, -h * 0.75);
        ctx.lineTo(0, -h);
        ctx.lineTo(w, -h * 0.75);
        ctx.lineTo(w, 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = rgba('#ffffff', 0.35);
        ctx.fillRect(-w * 0.6, -h * 0.7, w * 0.4, h * 0.6);
        ctx.restore();
      }
      break;
    }
  }
}

function paintDecor(ctx: CanvasRenderingContext2D, model: TerrainModel, skin: ResolvedSkin, view: Box, zoom: number): void {
  if (zoom < 0.18) return;
  const n = skin.decor.length || skin.procDecor.length;
  if (!n) return;
  for (const sp of spotsFor(model, skin)) {
    if (sp.x < view.minX - 120 || sp.x > view.maxX + 120 || sp.y < view.minY - 160 || sp.y > view.maxY + 60) continue;
    ctx.save();
    ctx.translate(sp.x, sp.y);
    ctx.rotate(((sp.angle * 0.6) * Math.PI) / 180);
    if (skin.decor.length) {
      const v = skin.decor[sp.variant % skin.decor.length];
      const w = v.w * sp.scale;
      const h = v.h * sp.scale;
      const c = artCanvasSync({ svg: v.svg, w, h }, Math.max(0.25, Math.min(3, Math.ceil(zoom * 4) / 4)));
      if (c) {
        if (sp.flip) ctx.scale(-1, 1);
        ctx.drawImage(c, -w / 2, -h * 0.88, w, h);
      }
    } else {
      if (sp.flip) ctx.scale(-1, 1);
      ctx.scale(sp.scale, sp.scale);
      procDecor(ctx, skin.procDecor[sp.variant % skin.procDecor.length], skin, rng(hashNums(model.seed, Math.round(sp.x), Math.round(sp.y))));
    }
    ctx.restore();
  }
}

/**
 * Paint a terrain model for a window. `ctx` must already map world px to its pixels (zoom = pixels per world px);
 * `view` is the visible window in world px. Used by renderTerrain (screen) and the runtime's terrain tiles.
 */
export function paintTerrain(ctx: CanvasRenderingContext2D, model: TerrainModel, skin: ResolvedSkin, view: Box, zoom: number): void {
  if (!model.pieces.length || !boxesOverlap(model.box, { ...view, minY: view.minY - 200 })) return;
  const pad = 60;
  const vb: Box = { minX: view.minX - pad, minY: view.minY - pad, maxX: view.maxX + pad, maxY: view.maxY + pad };
  for (const pc of model.pieces) {
    if (!boxesOverlap(pc.box, { ...vb, minY: vb.minY - 80 })) continue;
    if (pc.kind === 'wall') paintWall(ctx, pc, skin);
    else paintLand(ctx, pc, skin, vb, zoom, model.seed);
  }
  for (const pc of model.pieces) {
    if (pc.kind === 'wall' || !boxesOverlap(pc.box, { ...vb, minY: vb.minY - 80 })) continue;
    paintSurface(ctx, pc, skin, vb, zoom, model.seed);
  }
  paintDecor(ctx, model, skin, vb, zoom);
}

/** See the header. */
export function renderTerrain(ctx: CanvasRenderingContext2D, obj: LookObj, skin: TerrainSkin | ResolvedSkin | null, theme: StudioTheme | null,
  world: { width: number; height: number }, camera?: CameraView | null,
  o: { view?: { w: number; h: number }; others?: LookObj[]; look?: Look } = {}): void {
  try {
    const ft = fullTheme(theme);
    const model = terrainModel(obj, world, o.others ?? []);
    if (!model.pieces.length) return;
    const first = obj.drawing?.strokes?.[0];
    const r = Math.max(4, (Number(first?.width) || 6) / 2) * (Number(obj.scale) > 0 ? Number(obj.scale) : 1);
    const color = typeof first?.color === 'string' ? first.color : ft.palette.ink;
    let rs: ResolvedSkin;
    if (skin && 'procDecor' in skin) rs = skin as ResolvedSkin;
    else if (skin && (o.look ?? 'ai') === 'ai') rs = resolveSkin(skin as TerrainSkin, ft, color, r);
    else rs = defaultSkin(ft, color, r);
    ctx.save();
    let cam: CameraView;
    let vw: number;
    let vh: number;
    if (camera) {
      cam = camera;
      const z = cam.zoom && cam.zoom > 0 ? cam.zoom : 1;
      ctx.setTransform(z, 0, 0, z, -cam.x * z, -cam.y * z);
      vw = o.view?.w ?? ctx.canvas.width;
      vh = o.view?.h ?? ctx.canvas.height;
    } else {
      const m = ctx.getTransform();
      const z = m.a || 1;
      cam = { x: -m.e / z, y: -m.f / (m.d || z), zoom: z };
      vw = o.view?.w ?? ctx.canvas.width;
      vh = o.view?.h ?? ctx.canvas.height;
    }
    const z = cam.zoom && cam.zoom > 0 ? cam.zoom : 1;
    paintTerrain(ctx, model, rs, { minX: cam.x, minY: cam.y, maxX: cam.x + vw / z, maxY: cam.y + vh / z }, z);
    ctx.restore();
  } catch {
    /* a broken skin leaves the ground undrawn rather than breaking the canvas */
  }
}

// ---- backdrop ---------------------------------------------------------------------------------------

function skyColors(backdrop: Backdrop | null | undefined, ft: FullTheme): string[] {
  const sky = (backdrop?.sky ?? []).filter((c) => /^#[0-9a-f]{3,8}$/i.test(String(c)));
  if (sky.length) return sky;
  return isDark(ft.palette.bg) ? [mix(ft.palette.bg, '#000000', 0.3), ft.palette.bg] : [mix(ft.palette.bg, ft.palette.accent2, 0.35), ft.palette.bg];
}

/** A canvas with the backdrop's sky gradient (top to bottom), `h` px tall. */
export function skyCanvas(backdrop: Backdrop | null | undefined, theme: StudioTheme | null, h = 512): HTMLCanvasElement {
  const ft = fullTheme(theme);
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = Math.max(2, Math.round(h));
  const ctx = c.getContext('2d');
  if (ctx) {
    const cols = skyColors(backdrop, ft);
    const g = ctx.createLinearGradient(0, 0, 0, c.height);
    cols.forEach((col, i) => g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), col));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

/** Does the doc's game look use a backdrop? */
export function hasBackdrop(doc: LookDoc | null | undefined): boolean {
  if (!doc || doc.look === 'sketch') return false;
  const b = doc.backdrop;
  return !!b && ((b.layers?.length ?? 0) > 0 || (b.sky?.length ?? 0) > 0);
}

/** See the header. */
export function renderBackdrop(ctx: CanvasRenderingContext2D, backdrop: Backdrop | null | undefined, world: { width: number; height: number },
  camera: CameraView = { x: 0, y: 0, zoom: 1 }, view?: { w: number; h: number }, theme: StudioTheme | null = null): void {
  const v = view ?? { w: ctx.canvas.width, h: ctx.canvas.height };
  const ft = fullTheme(theme);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  try {
    const cols = skyColors(backdrop, ft);
    const g = ctx.createLinearGradient(0, 0, 0, v.h);
    cols.forEach((col, i) => g.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), col));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, v.w, v.h);
    for (const layer of backdrop?.layers ?? []) paintLayer(ctx, layer, world, camera, v);
  } catch {
    /* a broken layer leaves the sky */
  }
  ctx.restore();
}

function paintLayer(ctx: CanvasRenderingContext2D, layer: BackdropLayer, world: { width: number; height: number }, camera: CameraView,
  v: { w: number; h: number }): void {
  if (!layer?.svg || !(layer.w > 0) || !(layer.h > 0)) return;
  const p = backdropPlacement(layer, world, camera, v);
  const c = artCanvasSync({ svg: layer.svg, w: layer.w, h: layer.h }, p.scale);
  if (!c) return;
  const cs = (c as HTMLCanvasElement & { __scale?: number }).__scale ?? p.scale;
  if (p.repeat) {
    const pat = ctx.createPattern(c, 'repeat-x');
    if (!pat) return;
    pat.setTransform(new DOMMatrix().translate(-p.offset, p.y).scale(p.scale / cs));
    ctx.fillStyle = pat;
    const y0 = Math.max(0, p.y);
    const y1 = Math.min(v.h, p.y + p.h);
    if (y1 > y0) ctx.fillRect(0, y0, v.w, y1 - y0);
  } else ctx.drawImage(c, p.x, p.y, p.w, p.h);
}

/** See the header. */
export function renderLookBackground(ctx: CanvasRenderingContext2D, doc: LookDoc | null | undefined, theme: StudioTheme | null,
  world: { width: number; height: number }, camera: CameraView = { x: 0, y: 0, zoom: 1 }, view?: { w: number; h: number }): void {
  if (hasBackdrop(doc)) renderBackdrop(ctx, doc!.backdrop, world, camera, view, theme);
  else renderBackground(ctx, theme, world, camera, view);
}
