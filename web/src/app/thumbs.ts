/**
 * Thumbnails (§7.9): feed cards render through the engine's ArtDoc → Canvas2D path (renderThumbnail) and are cached in
 * IndexedDB by `id@version`; a server PNG is used when the card carries one. Object thumbnails in "What I saw" paint the
 * kid's own strokes.
 */
import type { InkDoc, LevelV2, RectCells } from '../core/types.gen.ts';
import { renderThumbnail } from '../engine/index.ts';
import { paintFit } from '../editor/paint.ts';
import { strokesBBox } from '../editor/geom.ts';
import { api, type ImaginedGameStatus, type LevelCard } from './api.ts';
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
    let ok = false;
    let painted: Promise<boolean> | null = null;
    try {
      painted = renderThumbnail(c, level, inkFromLevel(level));
      ok = true;
    } catch {
      ok = drawLevelThumb(c, level);
    }
    box.replaceChildren(c);
    // skinned levels repaint once their Firefly pictures load: cache that repaint, not the ink-only first frame.
    // (false = nothing was pending, the first paint already had every picture; this canvas is never repainted by others)
    if (painted) await painted.catch(() => false);
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

const CAPTURE_MESSAGE = 'draw-play:thumbnail';
const CAPTURE_TIMEOUT_MS = 15000;
const captures = new Map<string, Promise<string | null>>();
let captureQueue: Promise<unknown> = Promise.resolve();

/** A generated game's play URL that posts its first drawn frame back to this page. */
export function captureUrl(playUrl: string): string {
  return `${playUrl}${playUrl.includes('?') ? '&' : '?'}capture=1`;
}

/** Upload the first frame a capture-enabled game frame posts (once per draft). Resolves to its data URL. */
export function watchFirstFrame(frame: HTMLIFrameElement, draftId: string, timeoutMs = CAPTURE_TIMEOUT_MS): Promise<string | null> {
  const pending = captures.get(draftId);
  if (pending) return pending;
  const done = new Promise<string | null>((resolve) => {
    const finish = (png: string | null): void => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(png);
    };
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.contentWindow || e.data?.type !== CAPTURE_MESSAGE) return;
      const png = e.data.png;
      if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) return finish(null);
      finish(png);
      void fetch(png).then((r) => r.blob()).then((blob) => api.imaginedThumbnail(draftId, blob)).catch(() => undefined);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
  });
  captures.set(draftId, done);
  void done.then((png) => { if (!png) captures.delete(draftId); });
  return done;
}

/** Play a game invisibly (one at a time) just long enough to keep its first frame. */
function captureFirstFrame(game: ImaginedGameStatus): Promise<string | null> {
  const pending = captures.get(game.draft_id);
  if (pending) return pending;
  const run = captureQueue.then(() => {
    // Kept inside the viewport (transparent): browsers pause offscreen cross-origin frames.
    const frame = h('iframe', { src: captureUrl(game.play_url!), sandbox: 'allow-scripts', referrerPolicy: 'no-referrer',
      tabindex: -1, 'aria-hidden': 'true', title: '' });
    Object.assign(frame.style, { position: 'fixed', left: '0', top: '0', width: '640px', height: '360px', border: '0',
      opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    const result = watchFirstFrame(frame, game.draft_id);
    document.body.append(frame);
    return result.finally(() => frame.remove());
  });
  captureQueue = run.catch(() => null);
  return run;
}

/** A generated game's cover: its stored first frame, or one captured now when the game has none yet. */
export function generatedThumb(game: ImaginedGameStatus, fallback: HTMLElement): HTMLElement {
  const box = h('div', { class: 'thumb' });
  const show = (src: string): void => { box.replaceChildren(h('img', { src, alt: '', decoding: 'async' })); };
  const capture = (): void => {
    if (game.status !== 'ready' || !game.play_url) return;
    void captureFirstFrame(game).then((png) => {
      if (!png) return;
      game.thumbnail_url = png;
      show(png);
      if (fallback.isConnected) fallback.replaceWith(box);
    });
  };
  if (game.thumbnail_url) {
    const img = h('img', { src: game.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async' });
    img.onerror = () => { box.replaceWith(fallback); lazy(fallback, capture); };
    box.append(img);
    return box;
  }
  lazy(fallback, capture);
  return fallback;
}
