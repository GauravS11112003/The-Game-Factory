/**
 * Thumbnails (§7.9): feed cards render through the engine's ArtDoc → Canvas2D path (renderThumbnail) and are cached in
 * IndexedDB by `id@version`; a server PNG is used when the card carries one. Object thumbnails in "What I saw" paint the
 * kid's own strokes.
 */
import type { InkDoc, LevelV2, RectCells } from '../core/types.gen.ts';
import { renderThumbnail } from '../engine/index.ts';
import { paintFit } from '../editor/paint.ts';
import { strokesBBox } from '../editor/geom.ts';
import { api, type LevelCard } from './api.ts';
import { h } from './dom.ts';
import { inkFromLevel } from './ink.ts';
import { thumbGet, thumbPut } from './store.ts';

export function objectThumb(ink: InkDoc | null, strokeIds: string[], bbox: RectCells | null, w = 72, hgt = 54): HTMLCanvasElement {
  const c = h('canvas', { class: 'obj-thumb', width: w * 2, height: hgt * 2 });
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  if (!ink) return c;
  const ids = new Set(strokeIds);
  let strokes = ink.strokes.filter((s) => ids.has(s.id));
  if (!strokes.length && bbox) {
    strokes = ink.strokes.filter((s) => s.pts.some((p) => p[0] >= bbox[0] - 0.3 && p[0] <= bbox[2] + 0.3 && p[1] >= bbox[1] - 0.3 && p[1] <= bbox[3] + 0.3));
  }
  paintFit(c, strokes, strokesBBox(strokes) ?? bbox, { pad: 0.35, bg: '#FBF6EA' });
  return c;
}

/** Draw a level into a canvas (letterboxed first screen by default). Safe when the engine is not ready. */
export function drawLevelThumb(c: HTMLCanvasElement, level: LevelV2, ink?: InkDoc): boolean {
  try {
    renderThumbnail(c, level, ink ?? inkFromLevel(level));
    return true;
  } catch (e) {
    console.warn('renderThumbnail failed', e);
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#FBF6EA';
      ctx.fillRect(0, 0, c.width, c.height);
      const strokes = level.ink?.strokes ?? [];
      paintFit(c, strokes.filter((s) => s.pts.some((p) => p[0] < 48)), [0, 0, 48, 27], { pad: 0, bg: '#FBF6EA' });
    }
    return false;
  }
}

const observed = new WeakMap<Element, () => void>();
let io: IntersectionObserver | null = null;

function lazy(el: Element, run: () => void): void {
  if (typeof IntersectionObserver === 'undefined') return run();
  io ??= new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io?.unobserve(en.target);
      observed.get(en.target)?.();
      observed.delete(en.target);
    }
  }, { rootMargin: '200px' });
  observed.set(el, run);
  io.observe(el);
}

/** A feed card thumbnail (320 × 180), lazily rendered and cached. */
export function levelThumb(card: LevelCard): HTMLElement {
  const box = h('div', { class: 'thumb' });
  const key = `${card.id}@${card.version}`;
  const render = async (): Promise<void> => {
    const cached = await thumbGet(key);
    if (cached) {
      box.replaceChildren(h('img', { src: cached, alt: '' }));
      return;
    }
    const level = card.level ?? (await api.level(card.id, card.version).then((r) => r.level).catch(() => null));
    if (!level) return;
    const c = h('canvas', { width: 640, height: 360 });
    const ok = drawLevelThumb(c, level);
    box.replaceChildren(c);
    if (ok) {
      try {
        await thumbPut(key, c.toDataURL('image/png'));
      } catch {
        /* tainted or unsupported */
      }
    }
  };
  if (card.thumbnail_url) {
    // the server PNG when one was uploaded at publish; a missing or broken one falls back to the local render
    const img = h('img', { src: card.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async' });
    img.onerror = () => {
      img.remove();
      void render();
    };
    box.append(img);
    return box;
  }
  lazy(box, () => void render());
  return box;
}
