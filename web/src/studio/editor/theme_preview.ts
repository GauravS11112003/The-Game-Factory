/**
 * A small picture of a theme (orchestrator, docs/v6/CONTRACTS_V6.md §9): the theme's world background with a sample
 * sketch (a hero, a hill, a coin, a cloud) drawn through the theme's stroke style. Used by the Styles gallery.
 */
import type { Drawing, StudioTheme } from '../../core/types.gen.ts';
import { WORLD_DEFAULTS } from '../model/types.ts';
import { renderDrawing } from '../theme/render.ts';
import { drawBackground } from './render.ts';

const W = 480;
const H = 270;

type Pts = [[number, number], ...[number, number][]];
const circle = (cx: number, cy: number, r: number, n = 18): Pts =>
  Array.from({ length: n + 1 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * r, cy + Math.sin((i / n) * Math.PI * 2) * r]) as Pts;

/** The sample sketch, in world px of a 480 × 270 scene: [drawing, centre x, centre y]. */
const SAMPLE: [Drawing, number, number][] = [
  // rolling hill
  [{ w: 500, h: 60, strokes: [{ points: Array.from({ length: 26 }, (_, i) => [i * 20 - 250, Math.sin(i / 3.2) * 18 + 10]) as Pts, color: '#3a7d44', width: 7, closed: false }] }, 240, 228],
  // hero: body, eyes, legs
  [{ w: 60, h: 80, strokes: [
    { points: circle(0, -10, 24), color: '#e4572e', width: 6, closed: true, fill: null },
    { points: [[-8, -14]], color: '#1f1b18', width: 7, closed: false },
    { points: [[8, -14]], color: '#1f1b18', width: 7, closed: false },
    { points: [[-10, 12], [-14, 34]], color: '#1f1b18', width: 6, closed: false },
    { points: [[10, 12], [14, 34]], color: '#1f1b18', width: 6, closed: false },
  ] }, 150, 178],
  // coin
  [{ w: 34, h: 34, strokes: [{ points: circle(0, 0, 14, 14), color: '#f2a541', width: 5, closed: true, fill: null }, { points: [[0, -6], [0, 6]], color: '#f2a541', width: 4, closed: false }] }, 300, 150],
  [{ w: 34, h: 34, strokes: [{ points: circle(0, 0, 14, 14), color: '#f2a541', width: 5, closed: true, fill: null }, { points: [[0, -6], [0, 6]], color: '#f2a541', width: 4, closed: false }] }, 350, 140],
  // cloud
  [{ w: 110, h: 50, strokes: [{ points: [[-50, 14], [-44, -6], [-24, -14], [-10, -26], [12, -24], [26, -12], [46, -8], [52, 14], [-50, 14]], color: '#2e86ab', width: 5, closed: true, fill: null }] }, 360, 60],
];

export function themePreview(theme: StudioTheme, w = W, h = H): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W * 2;
  c.height = H * 2;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.scale(2, 2);
  const world = { ...WORLD_DEFAULTS, width: W, height: H };
  try {
    drawBackground(ctx, theme, world, { x: 0, y: 0, zoom: 1, width: W, height: H });
  } catch {
    ctx.fillStyle = theme.palette?.bg ?? '#f6f1e7';
    ctx.fillRect(0, 0, W, H);
  }
  for (const [d, x, y] of SAMPLE) {
    try {
      const img = renderDrawing(d, theme, { pad: 12 });
      ctx.drawImage(img, x - img.width / 2, y - img.height / 2);
    } catch {
      /* a style that fails to render leaves the background alone */
    }
  }
  return c;
}
