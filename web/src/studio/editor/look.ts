/**
 * The editor's view of the v7 game look (docs/v7/CONTRACTS_V7.md §4.1, §5). Lane R2's `theme/art.ts` draws it (the
 * same functions the runtime uses, so the canvas matches play exactly): `objectBitmap` for every object (AI variant
 * or cleaned-up sketch, or raw strokes in the sketch look), `renderTerrain` for ground lines, `renderLookBackground`
 * for the backdrop or theme background. This file adds what the editor needs on top: the compare-card preview
 * override, Blob URLs for <img> tiles, whole-scene pictures for cards and thumbnails, and the "Yours" tile.
 */
import type { ArtVariant, StudioTheme, TerrainSkin } from '../../core/types.gen.ts';
import {
  chosenVariant as laneChosen, isTerrainObject, objectBitmap, objectLook as laneLook, onArtReady, preloadArt, prepSvg, renderLookBackground,
  renderTerrain, type LookBitmap,
} from '../theme/art.ts';
import { mix } from '../theme/color.ts';
import { renderDrawing, type RenderOpts } from '../theme/render.ts';
import { drawOrder } from '../model/doc.ts';
import { asGameDoc, type SDoc, type SObj, type SScene, type SWorld } from '../model/types.ts';
import { isDark } from './render.ts';

export type ObjLook = 'ai' | 'sketch' | 'raw';

export { onArtReady };

export const docLook = (doc: Pick<SDoc, 'look'>): 'game' | 'sketch' => (doc.look === 'sketch' ? 'sketch' : 'game');

export const isGroundObj = (o: Pick<SObj, 'physics'>): boolean => isTerrainObject({ id: '', physics: o.physics });

/** The variant an object plays (its chosen one, else the first); with `id`, exactly that variant or null. */
export function chosenVariant(o: Pick<SObj, 'art' | 'id'>, id?: string | null): ArtVariant | null {
  if (id === undefined) return laneChosen(o);
  return o.art?.variants.find((v) => v.id === id) ?? null;
}

/** `raw` in the sketch look; `ai` when the object plays AI art that exists; else the cleaned-up sketch. */
export function objectLook(o: SObj, doc: SDoc): ObjLook {
  return laneLook(o, doc);
}

/**
 * The object as it should look on the canvas: the doc's look, or a previewed one (`variant` id = that AI version,
 * null = the maker's drawing) for the compare card's hover.
 */
export function lookObject(o: SObj, preview?: { variant: string | null } | null): { obj: SObj; look: 'game' | 'sketch' | null } {
  if (!preview) return { obj: o, look: null };
  if (!preview.variant || !o.art) return { obj: { ...o, art: o.art ? { ...o.art, use: 'sketch' } : null }, look: 'game' };
  return { obj: { ...o, art: { ...o.art, use: 'ai', chosen: preview.variant } }, look: 'game' };
}

/** The object's bitmap at about `pxPerUnit` device px per local unit (bucketed so zooming re-renders rarely). */
export function lookBitmap(o: SObj, doc: SDoc, pxPerUnit: number, recolorMap: Map<string, string> | null, preview?: { variant: string | null } | null): LookBitmap | null {
  const size = Math.max(o.drawing.w, o.drawing.h, 1);
  let scale = 2 ** (Math.round(Math.log2(Math.max(0.05, pxPerUnit)) * 2) / 2);
  scale = Math.min(scale, 4096 / (size + 80));
  const { obj, look } = lookObject(o, preview);
  return objectBitmap(obj, look ? { look, backdrop: doc.backdrop ?? null } : doc, doc.theme, { scale, recolorMap });
}

/** Draw a LookBitmap with `ctx` in the object's local units (translated, rotated and scaled to the object). */
export function drawLookBitmap(ctx: CanvasRenderingContext2D, b: LookBitmap): void {
  ctx.drawImage(b.canvas, -b.ox / b.scale, -b.oy / b.scale, b.canvas.width / b.scale, b.canvas.height / b.scale);
}

/** Land under a ground line; `ctx` is in world coordinates. `skin` null = the theme's default land. */
export function drawTerrain(ctx: CanvasRenderingContext2D, o: SObj, skin: TerrainSkin | null, theme: StudioTheme, world: SWorld, others: SObj[] = []): void {
  renderTerrain(ctx, o, skin, theme, world, null, { others: others.filter((x) => x.id !== o.id), look: skin ? 'ai' : 'sketch' });
}

/** The world behind the objects (backdrop in the game look, else the theme background); `ctx` in world coordinates. */
export function drawWorldBack(ctx: CanvasRenderingContext2D, doc: SDoc, world: SWorld): void {
  // device-space camera read off the current transform (the renderBackground convention, v6 integration note)
  const m = ctx.getTransform();
  const zoom = m.a || 1;
  ctx.save();
  try {
    renderLookBackground(ctx, doc, doc.theme, world, { x: -m.e / zoom, y: -m.f / (m.d || zoom), zoom }, { w: ctx.canvas.width, h: ctx.canvas.height });
  } catch (e) {
    console.warn('renderLookBackground failed', e);
  }
  ctx.restore();
}

/** The land colours of a ground line without a skin (for the inspector's swatch). */
export function plainSkin(o: SObj, theme: StudioTheme): TerrainSkin {
  const ink = o.drawing.strokes[0]?.color && /^#[0-9a-f]{6}$/i.test(o.drawing.strokes[0].color) ? o.drawing.strokes[0].color : theme.palette?.good ?? '#3bb273';
  const bg = theme.palette?.bg ?? '#f6f1e7';
  const top = mix(ink, bg, isDark(bg) ? 0.45 : 0.55);
  return { fill: [top, mix(top, isDark(bg) ? '#000000' : '#3a2e25', 0.35)], surface: ink, surface_width: 12, decor: [], decor_every: 220, rev: 0 };
}

// ---- <img> tiles ------------------------------------------------------------------------------------------------

const urls = new Map<string, string>();

/** A Blob URL for an SVG (cached; for <img> previews in cards and panels). */
export function svgUrl(svg: string): string {
  let u = urls.get(svg);
  if (!u) {
    u = URL.createObjectURL(new Blob([prepSvg(svg)], { type: 'image/svg+xml' }));
    urls.set(svg, u);
    if (urls.size > 200) {
      const [k, old] = urls.entries().next().value as [string, string];
      URL.revokeObjectURL(old);
      urls.delete(k);
    }
  }
  return u;
}

// ---- whole scenes (cards, thumbnails) ---------------------------------------------------------------------------

/**
 * The scene in its current look, drawn into `width × height` (filled, aspect kept; `region` picks the window), once
 * its art has loaded (at most a few seconds). For the restyle card and thumbnails.
 */
export async function sceneLookCanvas(doc: SDoc, scene: SScene, width: number, height: number, o: { region?: { x: number; y: number; w: number; h: number } } = {}): Promise<HTMLCanvasElement> {
  await preloadArt(asGameDoc(doc), 6000);
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
  drawWorldBack(ctx, doc, world);
  const grounds = scene.objects.filter(isGroundObj);
  for (const ob of drawOrder(scene.objects)) {
    if (ob.template || ob.hidden || !ob.drawing.strokes.length) continue;
    const look = objectLook(ob, doc);
    if (look !== 'raw' && isGroundObj(ob)) {
      drawTerrain(ctx, ob, look === 'ai' ? ob.art?.terrain ?? null : null, doc.theme, world, grounds);
      continue;
    }
    const b = lookBitmap(ob, doc, z * ob.scale, null);
    if (!b) continue;
    ctx.save();
    ctx.translate(ob.x, ob.y);
    ctx.rotate((ob.rotation * Math.PI) / 180);
    ctx.scale(ob.scale, ob.scale);
    drawLookBitmap(ctx, b);
    ctx.restore();
  }
  return c;
}

/** The start window of a scene for a 16:9 picture (big worlds show their first screen). */
export function startRegion(world: SWorld, aspect = 16 / 9): { x: number; y: number; w: number; h: number } {
  if (world.width / world.height > aspect * 1.4) return { x: 0, y: 0, w: Math.min(world.width, world.height * aspect), h: world.height };
  if (world.height / world.width > 1.4 / aspect) return { x: 0, y: Math.max(0, world.height - world.width / aspect), w: world.width, h: Math.min(world.height, world.width / aspect) };
  return { x: 0, y: 0, w: world.width, h: world.height };
}

/** The maker's drawing of one object, cleaned up (the "Yours" tile): a fresh canvas about `size` px on its long side. */
export function sketchTile(o: SObj, theme: StudioTheme, size: number, polish = true): HTMLCanvasElement {
  const long = Math.max(o.drawing.w, o.drawing.h, 1);
  const k = (size * 0.8) / long;
  const opts: RenderOpts = { scale: k, pad: Math.ceil(size * 0.06), ...(polish ? { polish: true } : {}) };
  // renderDrawing caches its canvases: hand out a copy (a DOM node lives in one place, and callers style it)
  const src = renderDrawing(o.drawing, theme, opts);
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')?.drawImage(src, 0, 0);
  return c;
}
