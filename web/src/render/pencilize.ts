/**
 * A pencil copy of a raster drawing (PLAN_V2 §8.4: ghosts are "a 45%-alpha pencil copy of the runner's own
 * character"; the run endpoint gives the runner's sprite as a PNG). The drawing's own ink is kept as coloured-pencil
 * strokes over a 45° hatch, a plain paper background is keyed out, the sprite is trimmed to its ink and its feet
 * centre found, so the engine can stand it on the ground and animate it like any one-drawing character.
 */
import { ART } from '../core/params.ts';

export interface PencilSprite {
  canvas: HTMLCanvasElement;
  feet: [number, number]; // canvas px
  px: number; // canvas px per logical px
}

const MAX_SRC = 256;

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Turn an image into a pencil sprite about `heightPx` logical px tall (30 = the player's body). `color` is the pencil
 * (graphite-violet by default); `keepHue` (0..1) mixes the drawing's own colours back in. Null when the image has no
 * ink or cannot be read (a cross-origin image without CORS taints the canvas).
 */
export function pencilize(img: CanvasImageSource & { width: number; height: number }, o: { heightPx?: number; maxWidthPx?: number; color?: string; keepHue?: number } = {}): PencilSprite | null {
  const sw = Number(img.width) || 0;
  const sh = Number(img.height) || 0;
  if (sw < 2 || sh < 2) return null;
  const s = Math.min(1, MAX_SRC / Math.max(sw, sh));
  const w = Math.max(2, Math.round(sw * s));
  const h = Math.max(2, Math.round(sh * s));
  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // tainted
  }
  const d = data.data;
  // an opaque image (a photo or a PNG on white): key out the border colour (the paper)
  let opaque = true;
  for (let i = 3; i < d.length; i += 4 * 7) if (d[i] < 250) {
    opaque = false;
    break;
  }
  let bg: [number, number, number] | null = null;
  if (opaque) {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    const take = (x: number, y: number): void => {
      const k = (y * w + x) * 4;
      rs.push(d[k]);
      gs.push(d[k + 1]);
      bs.push(d[k + 2]);
    };
    for (let x = 0; x < w; x += 3) {
      take(x, 0);
      take(x, h - 1);
    }
    for (let y = 0; y < h; y += 3) {
      take(0, y);
      take(w - 1, y);
    }
    const med = (a: number[]): number => a.sort((p, q) => p - q)[a.length >> 1];
    bg = [med(rs), med(gs), med(bs)];
  }
  const pencil = hexRgb(o.color ?? ART.palette.pencil_violet);
  const keep = Math.max(0, Math.min(1, o.keepHue ?? 0.35));
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      let a = d[k + 3] / 255;
      const r = d[k];
      const g = d[k + 1];
      const b = d[k + 2];
      if (bg) {
        const dist = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
        a *= Math.max(0, Math.min(1, (dist - 38) / 40));
      }
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      // how much "ink" the pixel holds: dark or saturated pixels are ink, paper-light ones fade out
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      let ink = a * Math.max(1 - lum, sat * 0.9);
      if (!bg && a > 0.5) ink = Math.max(ink, a * 0.55); // transparent PNGs: the drawn shape is all ink
      if (ink < 0.06) {
        d[k + 3] = 0;
        continue;
      }
      // a 45° hatch modulates the pencil (lines every 4 px), the grain of a coloured pencil
      const hatch = ((x + y) & 3) < 2 ? 1 : 0.7;
      d[k] = Math.round(pencil[0] * (1 - keep) + r * keep);
      d[k + 1] = Math.round(pencil[1] * (1 - keep) + g * keep);
      d[k + 2] = Math.round(pencil[2] * (1 - keep) + b * keep);
      d[k + 3] = Math.round(255 * Math.min(1, ink * 1.25) * hatch);
      if (d[k + 3] > 24) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  if (x1 < x0 || y1 < y0) return null;
  ctx.putImageData(data, 0, 0);
  const pad = 2;
  const cw = x1 - x0 + 1 + pad * 2;
  const ch = y1 - y0 + 1 + pad * 2;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.drawImage(work, x0 - pad, y0 - pad, cw, ch, 0, 0, cw, ch);
  // feet: the centre of the lowest ink row band (the bottom 8% of the drawing)
  const band = Math.max(1, Math.round((y1 - y0 + 1) * 0.08));
  let fx = 0;
  let fn = 0;
  for (let y = y1 - band + 1; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        fx += x;
        fn++;
      }
    }
  const feetX = fn ? fx / fn - x0 + pad : (x1 - x0) / 2 + pad;
  const feetY = y1 - y0 + 1 + pad;
  const heightPx = o.heightPx ?? 30;
  const maxW = o.maxWidthPx ?? 40;
  let px = (y1 - y0 + 1) / heightPx;
  if ((x1 - x0 + 1) / px > maxW) px = (x1 - x0 + 1) / maxW;
  return { canvas: out, feet: [feetX, feetY], px: Math.max(0.25, px) };
}

/** Load an image URL for pencilize (CORS-enabled, so the canvas stays readable). */
export function loadImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const t = setTimeout(() => res(null), timeoutMs);
      img.onload = () => {
        clearTimeout(t);
        res(img);
      };
      img.onerror = () => {
        clearTimeout(t);
        res(null);
      };
      img.src = url;
    } catch {
      res(null);
    }
  });
}
