/**
 * Pictures of the game for the server (docs/v6/CONTRACTS_V6.md §6): one object alone for /recognize (≤ 256 px),
 * the canvas for the copilot (≤ 1024 px wide) and the 480×270 thumbnail (background + drawings).
 */
import { renderDrawing } from '../theme/render.ts';
import { drawOrder } from '../model/doc.ts';
import type { SDoc, SObj, SScene } from '../model/types.ts';
import { drawBackground } from './render.ts';
import { sceneLookCanvas, startRegion } from './look.ts';

/** base64 (no data: prefix) of a canvas as PNG. */
export function pngBase64(c: HTMLCanvasElement): string {
  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

/** The object's drawing alone on white, at most `max` px on its long side. */
export function objectPng(o: SObj, doc: SDoc, max = 256): string | null {
  if (!o.drawing.strokes.length) return null;
  const size = Math.max(o.drawing.w, o.drawing.h, 1) * o.scale;
  const scale = Math.min(2, (max - 24) / size) * o.scale;
  const art = renderDrawing(o.drawing, doc.theme, { scale, pad: 12 });
  const c = document.createElement('canvas');
  const k = Math.min(1, max / Math.max(art.width, art.height));
  c.width = Math.max(8, Math.round(art.width * k));
  c.height = Math.max(8, Math.round(art.height * k));
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(art, 0, 0, c.width, c.height);
  return pngBase64(c);
}

/** The whole scene drawn into a `width × height` canvas (letterboxed to the world's aspect). */
export function sceneCanvas(doc: SDoc, scene: SScene, width: number, height: number, o: { region?: { x: number; y: number; w: number; h: number } } = {}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const world = scene.world;
  const reg = o.region ?? { x: 0, y: 0, w: world.width, h: world.height };
  const z = Math.max(width / reg.w, height / reg.h);
  const ox = (width - reg.w * z) / 2 - reg.x * z;
  const oy = (height - reg.h * z) / 2 - reg.y * z;
  ctx.fillStyle = doc.theme.palette?.bg ?? '#f6f1e7';
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(z, z);
  ctx.beginPath();
  ctx.rect(0, 0, world.width, world.height);
  ctx.clip();
  drawBackground(ctx, doc.theme, world, { x: reg.x, y: reg.y, zoom: z, width, height });
  ctx.restore();
  for (const ob of drawOrder(scene.objects)) {
    if (ob.template || ob.hidden || !ob.drawing.strokes.length) continue;
    const k = z * ob.scale;
    const art = renderDrawing(ob.drawing, doc.theme, { scale: Math.max(0.05, k), pad: Math.ceil(12 * k) + 2 });
    ctx.save();
    ctx.translate(ox + ob.x * z, oy + ob.y * z);
    ctx.rotate((ob.rotation * Math.PI) / 180);
    ctx.drawImage(art, -art.width / 2, -art.height / 2);
    ctx.restore();
  }
  return c;
}

/** The thumbnail: the first scene's start view (the first 16:9 window for big worlds), 480 × 270. */
export function thumbnailCanvas(doc: SDoc): HTMLCanvasElement {
  const sc = doc.scenes[0];
  const w = sc.world;
  const aspect = 16 / 9;
  let region = { x: 0, y: 0, w: w.width, h: w.height };
  if (w.width / w.height > aspect * 1.4) region = { x: 0, y: 0, w: Math.min(w.width, w.height * aspect), h: w.height };
  else if (w.height / w.width > 1.4 / aspect) region = { x: 0, y: Math.max(0, w.height - w.width / aspect), w: w.width, h: Math.min(w.height, w.width / aspect) };
  return sceneCanvas(doc, sc, 480, 270, { region });
}

/** The thumbnail as a PNG, in the game's current look (v7: AI art and the backdrop once their images have loaded). */
export async function thumbnailBlob(doc: SDoc): Promise<Blob | null> {
  let c: HTMLCanvasElement;
  try {
    const sc = doc.scenes[0];
    c = await sceneLookCanvas(doc, sc, 480, 270, { region: startRegion(sc.world) });
  } catch {
    try { c = thumbnailCanvas(doc); } catch { return null; }
  }
  return new Promise((resolve) => {
    try {
      c.toBlob((b) => resolve(b), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** The scene for the copilot to look at: ≤ 1024 px wide, aspect kept (capped at 4:1). */
export function snapshotPng(doc: SDoc, scene: SScene): string | null {
  try {
    const w = scene.world;
    const width = Math.min(1024, Math.max(320, Math.round(w.width)));
    const aspect = Math.max(0.25, Math.min(4, w.width / w.height));
    const height = Math.max(120, Math.round(width / aspect));
    return pngBase64(sceneCanvas(doc, scene, width, height));
  } catch {
    return null;
  }
}
