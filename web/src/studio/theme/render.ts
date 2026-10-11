/**
 * Drawings → pixels under a theme (docs/v6/CONTRACTS_V6.md §4). Shared by the Studio canvas and the runtime, so what
 * the maker sees while drawing is what plays. v6 skeleton: plain strokes; lane R adds the theme styles (marker, ink,
 * neon glow, pixel, chalk, comic outline + halftone, crayon, watercolor, wobble, palette recolour, closed-shape fills).
 */
import type { Drawing, StudioTheme } from '../../core/types.gen.ts';

export interface RenderOpts {
  scale?: number; // pixels per drawing unit (default 1)
  pad?: number; // extra pixels around the drawing (default 8)
}

/** The drawing on a transparent canvas sized to its strokes (+ pad), centred on the drawing's (0, 0). */
export function renderDrawing(d: Drawing, theme: StudioTheme | null, o: RenderOpts = {}): HTMLCanvasElement {
  const scale = o.scale ?? 1;
  const pad = o.pad ?? 8;
  const w = Math.max(2, Math.ceil((d.w || 2) * scale + pad * 2));
  const h = Math.max(2, Math.ceil((d.h || 2) * scale + pad * 2));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const ws = theme?.stroke?.width_scale ?? 1;
  for (const s of d.strokes ?? []) {
    const width = (s.width ?? 6) * ws;
    const color = s.color ?? '#1f1b18';
    if (s.points.length === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s.points[0][0], s.points[0][1], width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (s.closed) ctx.closePath();
    if (s.fill) {
      ctx.fillStyle = s.fill;
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  return c;
}
