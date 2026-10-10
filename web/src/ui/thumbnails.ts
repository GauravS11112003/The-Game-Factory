/**
 * Feed / tree thumbnails (PLAN.md section 10). Owned by lane D.
 *
 * A level with a backdrop shows the backdrop image. Otherwise the grid is
 * drawn as ink on paper, through the engine's renderThumbnail when lane B
 * exports one, else through the fallback below.
 */
import { assetUrl } from '../api';
import * as engine from '../game/index';
import type { Level } from '../types';
import { el } from './dom';

const INK = { black: '#000000', red: '#e53935', green: '#43a047', blue: '#1e88e5', paper: '#ffffff' };

type ThumbFn = (level: Level, width: number) => HTMLCanvasElement;

// Looked up by name at runtime: the engine contract may gain renderThumbnail
// later, and a static import would fail the build until it does.
const ENGINE_THUMBNAIL_EXPORT = 'renderThumbnail';

function engineThumbnail(level: Level, width: number): HTMLCanvasElement | null {
  const fn = (engine as unknown as Record<string, unknown>)[ENGINE_THUMBNAIL_EXPORT];
  if (typeof fn !== 'function') return null;
  try {
    const canvas = (fn as ThumbFn)(level, width);
    return canvas instanceof HTMLCanvasElement ? canvas : null;
  } catch {
    return null;
  }
}

/** Draws grid tiles and entity markers at `width` px (height follows 16:9). */
export function renderGridThumbnail(level: Level, width: number): HTMLCanvasElement {
  const { w, h } = level.grid;
  const scale = width / w;
  const canvas = el('canvas', { width: Math.round(width), height: Math.round(h * scale), className: 'thumb-canvas' });
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = INK.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  level.grid.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '1') {
        ctx.fillStyle = INK.black;
        ctx.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale));
      } else if (ch === '2') {
        ctx.fillStyle = INK.red;
        ctx.beginPath();
        ctx.moveTo(x * scale, (y + 1) * scale);
        ctx.lineTo((x + 0.5) * scale, y * scale + 1);
        ctx.lineTo((x + 1) * scale, (y + 1) * scale);
        ctx.closePath();
        ctx.fill();
      }
    }
  });

  for (const e of level.entities) {
    if (e.bbox) {
      const [x0, y0, x1, y1] = e.bbox;
      ctx.fillStyle = e.type === 'enemy' ? INK.red : INK.black;
      ctx.globalAlpha = e.type === 'bounce_pad' ? 0.35 : 0.85;
      ctx.fillRect(x0 * scale, y0 * scale, (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale);
      ctx.globalAlpha = 1;
    }
    if (e.x === undefined || e.x === null || e.y === undefined || e.y === null) continue;
    const cx = (e.x + 0.5) * scale;
    const cy = (e.y + 0.5) * scale;
    const r = Math.max(1.5, scale * 0.45);
    ctx.beginPath();
    if (e.type === 'goal') {
      ctx.fillStyle = INK.green;
      ctx.rect(cx - r, cy - r * 1.6, r * 2, r * 2.6);
    } else if (e.type === 'coin' || e.type === 'key') {
      ctx.fillStyle = INK.blue;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (e.type === 'player_start') {
      ctx.fillStyle = '#555';
      ctx.rect(cx - r * 0.7, cy - r * 1.8, r * 1.4, r * 2.6);
    } else if (e.type === 'checkpoint') {
      ctx.fillStyle = INK.green;
      ctx.rect(cx - r * 0.2, cy - r * 1.6, r * 0.4, r * 2.4);
    } else {
      continue;
    }
    ctx.fill();
  }
  return canvas;
}

export function renderThumbnail(level: Level, width: number): HTMLCanvasElement {
  return engineThumbnail(level, width) ?? renderGridThumbnail(level, width);
}

/** The card image: the backdrop when there is one, else a drawn grid. */
export function thumbnailFor(level: Level | null | undefined, width = 240, className = ''): HTMLElement {
  const box = el('div', { className: `thumb ${className}`.trim() });
  if (!level) {
    box.append(el('div', { className: 'thumb-empty' }, 'no levels yet'));
    return box;
  }
  const backdrop = assetUrl(level.source.backdrop_url);
  if (backdrop) {
    const img = el('img', { src: backdrop, alt: level.title, loading: 'lazy', width, height: Math.round((width * 9) / 16) });
    img.addEventListener('error', () => img.replaceWith(renderThumbnail(level, width)), { once: true });
    box.append(img);
  } else {
    box.append(renderThumbnail(level, width));
  }
  return box;
}
