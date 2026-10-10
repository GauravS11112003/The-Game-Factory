/**
 * Thumbnails and share cards (PLAN_V2 §7.9): the same ArtDoc → Canvas2D path as play (entities, player and goal
 * included), cached in IndexedDB by `id@version`. The 640 × 360 share card uploaded at publish is render/sharecard.ts.
 */
import type { InkDoc, LevelInk, LevelV2, RectCells, Theme } from '../core/types.gen.ts';
import { buildArt } from '../core/art/artdoc.ts';
import type { ArtDoc } from '../core/art/types.ts';
import { drawInk } from './canvas_ink.ts';

const VIEW_W = 48;
const VIEW_H = 27;

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

export function renderThumbnail(c: HTMLCanvasElement, level: LevelV2, ink: InkDoc | LevelInk | null, o: { view?: RectCells; theme?: Theme } = {}): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const view = o.view ?? defaultView(level);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  try {
    drawInk(ctx, artFor(level, ink, 1, o.theme), view);
  } catch (e) {
    // never take a feed down: an empty paper card with the level's title
    ctx.fillStyle = '#FBF6EA';
    ctx.fillRect(0, 0, c.width, c.height);
    console.warn('thumbnail failed', level.id, e);
  }
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

/** An object URL of the level's thumbnail (w × h), rendered once and cached by id@version. */
export async function thumbnailURL(level: LevelV2, ink: InkDoc | LevelInk | null, w = 384, h = 216): Promise<string> {
  const key = `${level.id}@${level.version}:${w}x${h}`;
  const hit = await idbGet(key);
  if (hit) return URL.createObjectURL(hit);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  renderThumbnail(c, level, ink);
  const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/png'));
  if (!blob) return c.toDataURL('image/png');
  void idbPut(key, blob);
  return URL.createObjectURL(blob);
}
