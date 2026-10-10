/**
 * Thumbnails and share cards (PLAN_V2 §7.9): the same ArtDoc → Canvas2D path as play (entities, player and goal
 * included), cached in IndexedDB by `id@version`. The 640 × 360 share card uploaded at publish is render/sharecard.ts.
 *
 * Skins (docs/v3 "Skin on levels"): a level with generated art draws it over the objects it replaces and its
 * backdrop behind the ink. Pictures already loaded are drawn in the first paint; otherwise the kid's ink is drawn
 * first and the canvas repaints once the pictures arrive (a broken picture just leaves the ink).
 */
import type { InkDoc, LevelInk, LevelV2, RectCells, Theme } from '../core/types.gen.ts';
import { buildArt } from '../core/art/artdoc.ts';
import { hash32 } from '../core/art/geom.ts';
import { hideSkinned, placementWorldBox, resolveSkin, skinOf, skinSignature } from '../core/art/skin.ts';
import type { SkinPlacement, SkinSpec } from '../core/art/skin.ts';
import type { ArtDoc } from '../core/art/types.ts';
import { drawInk } from './canvas_ink.ts';
import type { DrawInkOptions } from './canvas_ink.ts';
import { drawBackdrop, drawSkinFitted, loadSkinImage, peekSkinImage, skinImagesReady } from './skin.ts';
import type { SkinImage } from './skin.ts';

const VIEW_W = 48;
const VIEW_H = 27;
const CELL = 16;

const docCache = new Map<string, ArtDoc>();

/** The level's ArtDoc, memoized by id@version + hash (thumbnails of a feed reuse it). */
export function artFor(level: LevelV2, ink: InkDoc | LevelInk | null | undefined, seed = 1, theme?: Theme): ArtDoc {
  const th = theme ?? level.rules?.theme;
  const key = `${level.id}@${level.version}|${level.meta?.level_hash ?? ''}|${th ?? ''}|${seed}|${ink ? 'i' : 'n'}`;
  const hit = docCache.get(key);
  if (hit) return hit;
  const doc = buildArt(level, ink ?? level.ink ?? null, { seed, theme: th });
  if (docCache.size > 32) docCache.delete(docCache.keys().next().value as string);
  docCache.set(key, doc);
  return doc;
}

/** The most interesting first view: the first screen, or the screen with the goal when asked. */
function defaultView(level: LevelV2): RectCells {
  void level;
  return [0, 0, VIEW_W, VIEW_H];
}

// ---- skins --------------------------------------------------------------------------------------------------

export interface SkinnedArt {
  /** The skin's placements whose pictures are ready. */
  ready: { p: SkinPlacement; img: SkinImage }[];
  backdrop: SkinImage | null;
  /** Some picture is still loading: repaint when `skinImagesReady` resolves. */
  pending: boolean;
  skin: SkinSpec | null;
}

/** What of the level's skin can be drawn right now (starting the loads of the rest). */
export function skinnedArt(level: LevelV2, ink: InkDoc | LevelInk | null | undefined, doc: ArtDoc): SkinnedArt {
  const skin = skinOf(level);
  const out: SkinnedArt = { ready: [], backdrop: null, pending: false, skin };
  if (!skin) return out;
  let placements: SkinPlacement[] = [];
  try {
    placements = resolveSkin(level, ink ?? level.ink ?? null, doc, skin);
  } catch (e) {
    console.warn('skin placement failed', level.id, e);
  }
  for (const p of placements) {
    const img = peekSkinImage(p.url, 'sprite');
    if (img === undefined) {
      out.pending = true;
      void loadSkinImage(p.url, 'sprite');
    } else if (img) out.ready.push({ p, img });
  }
  if (skin.backdrop) {
    const img = peekSkinImage(skin.backdrop.url, 'backdrop');
    if (img === undefined) {
      out.pending = true;
      void loadSkinImage(skin.backdrop.url, 'backdrop');
    } else out.backdrop = img;
  }
  return out;
}

const STATIC_AFTER = 'terrain';

/**
 * drawInk with the level's skin: the backdrop after the paper (the graphite parallax skipped), static pictures after
 * the terrain, entity pictures after the entities, the character's picture after the player layer. Returns what was
 * drawn (`pending` = repaint later).
 */
export function drawLevelArt(ctx: CanvasRenderingContext2D, level: LevelV2, ink: InkDoc | LevelInk | null | undefined, doc: ArtDoc, view: RectCells, o: { layers?: string[] } = {}): SkinnedArt {
  const sk = skinnedArt(level, ink, doc);
  if (!sk.ready.length && !sk.backdrop) {
    drawInk(ctx, doc, view, o.layers ? { layers: o.layers } : {});
    return sk;
  }
  const hidden = new Set<string>();
  for (const r of sk.ready) for (const id of r.p.hide) hidden.add(id);
  const d = hideSkinned(doc, hidden);
  const vw = (view[2] - view[0]) * CELL;
  const worldH = (doc.world.h ?? VIEW_H) * CELL;
  const draw = (c: CanvasRenderingContext2D, kinds: SkinPlacement['target']['kind'][]): void => {
    for (const { p, img } of sk.ready) {
      if (!kinds.includes(p.target.kind)) continue;
      const b = placementWorldBox(p);
      drawSkinFitted(c, img, [b[0] * CELL, b[1] * CELL, b[2] * CELL, b[3] * CELL], p.fit);
    }
  };
  const opts: DrawInkOptions = {
    ...(o.layers ? { layers: o.layers } : {}),
    ...(sk.backdrop ? { skip: new Set(['far', 'clouds', 'mid']) } : {}),
    hook: (c, after) => {
      if (after === 'paper' && sk.backdrop) drawBackdrop(c, sk.backdrop, view[0] * CELL, vw, worldH);
      else if (after === STATIC_AFTER) draw(c, ['object']);
      else if (after === 'entities') draw(c, ['entity']);
      else if (after === 'player') draw(c, ['player']);
    },
  };
  drawInk(ctx, d, view, opts);
  return sk;
}

/** The character's picture, when the level's skin has one ready (share cards stand it in the scene themselves). */
export function playerSkin(sk: SkinnedArt): { p: SkinPlacement; img: SkinImage } | null {
  return sk.ready.find((r) => r.p.target.kind === 'player') ?? null;
}

// ---- thumbnails ---------------------------------------------------------------------------------------------

const paints = new WeakMap<HTMLCanvasElement, number>();

/**
 * Draw the level's thumbnail. Resolves true when it repainted with skin pictures that were still loading (the canvas
 * shows the kid's ink until then); a later call on the same canvas cancels the pending repaint.
 */
export function renderThumbnail(c: HTMLCanvasElement, level: LevelV2, ink: InkDoc | LevelInk | null, o: { view?: RectCells; theme?: Theme } = {}): Promise<boolean> {
  const token = (paints.get(c) ?? 0) + 1;
  paints.set(c, token);
  const paint = (): SkinnedArt | null => {
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const view = o.view ?? defaultView(level);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    try {
      return drawLevelArt(ctx, level, ink, artFor(level, ink, 1, o.theme), view);
    } catch (e) {
      // never take a feed down: an empty paper card with the level's title
      ctx.fillStyle = '#FBF6EA';
      ctx.fillRect(0, 0, c.width, c.height);
      console.warn('thumbnail failed', level.id, e);
      return null;
    }
  };
  const first = paint();
  if (!first?.pending) return Promise.resolve(false);
  return skinImagesReady(first.skin).then(() => {
    if (paints.get(c) !== token) return false;
    paint();
    return true;
  });
}

// ---- IndexedDB cache (by id@version); every access is guarded: private windows may refuse storage ----

const DB = 'dal-thumbs-v2';
const STORE = 'png';
let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') return res(null);
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
      rq.onblocked = () => res(null);
    } catch {
      res(null);
    }
  });
  return dbp;
}

async function idbGet(key: string): Promise<Blob | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const rq = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      rq.onsuccess = () => res((rq.result as Blob | undefined) ?? null);
      rq.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}

async function idbPut(key: string, b: Blob): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(b, key);
  } catch {
    /* storage full or refused: thumbnails just re-render */
  }
}

/** An object URL of the level's thumbnail (w × h), rendered once (skin pictures included) and cached by id@version. */
export async function thumbnailURL(level: LevelV2, ink: InkDoc | LevelInk | null, w = 384, h = 216): Promise<string> {
  const skin = skinOf(level);
  const sig = skin ? `:s${hash32(skinSignature(skin)).toString(36)}` : '';
  const key = `${level.id}@${level.version}:${w}x${h}${sig}`;
  const hit = await idbGet(key);
  if (hit) return URL.createObjectURL(hit);
  if (skin) await skinImagesReady(skin);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  void renderThumbnail(c, level, ink);
  const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/png'));
  if (!blob) return c.toDataURL('image/png');
  void idbPut(key, blob);
  return URL.createObjectURL(blob);
}
