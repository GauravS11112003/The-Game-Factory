/**
 * World backgrounds (docs/v6/CONTRACTS_V6.md §4.3): the 14 BackgroundDef styles as parallax layers.
 *
 * Exported API:
 *   backgroundLayers(theme) → BgLayer[]: canvases painted once at the 1600×900 reference view, back to front, cached
 *       per theme. Each layer says how it moves: `factor` (0 = fixed to the screen, 1 = locked to the world),
 *       `tileX`/`tileY` (repeats), `anchor` (fill the view, sit on its bottom, or hang from its top).
 *   layerPlacement(layer, world, camera, view) → where to draw a layer for a camera (shared by the 2D renderer below and
 *       the Phaser runtime, which turns layers into TileSprites).
 *   renderBackground(ctx, theme, world, camera, view?): paints the background for a camera on a 2D context
 *       (`camera.x/y` = world point at the view's top left, `zoom` = screen px per world px; `view` defaults to the
 *       canvas size). The Studio editor calls this for its live canvas.
 */
import type { StudioTheme } from '../../core/types.gen.ts';
import { fullTheme, isDark, mix, rgba, type FullTheme } from './color.ts';
import { hashStr, rng } from './rng.ts';

export const REF_W = 1600;
export const REF_H = 900;

export interface BgLayer {
  canvas: HTMLCanvasElement;
  factor: number;
  tileX: boolean;
  tileY: boolean;
  anchor: 'fill' | 'bottom' | 'top';
  /** Tiled textures that belong to the world (paper grain, grid) scale with the camera zoom. */
  worldScale?: boolean;
}

export interface CameraView {
  x: number;
  y: number;
  zoom?: number;
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Texture offset inside the tile (px of the layer canvas) and the tile scale. */
  tileX: number;
  tileY: number;
  tileScale: number;
}

const layerCache = new Map<string, BgLayer[]>();

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(w));
  c.height = Math.max(2, Math.round(h));
  return [c, c.getContext('2d')];
}

function col(ft: FullTheme, i: number, d: string): string {
  return ft.background.colors[i] ?? d;
}

function vgrad(ctx: CanvasRenderingContext2D, w: number, h: number, stops: string[]): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** A seamless height profile: a sum of sines with whole cycles over `w`. */
function profile(seed: number, w: number, base: number, amp: number, cycles: number[]): (x: number) => number {
  const r = rng(seed);
  const waves = cycles.map((n, i) => ({ n, a: amp / (i + 1) ** 0.9, p: r() * Math.PI * 2 }));
  return (x) => base + waves.reduce((s, k) => s + k.a * Math.sin((x / w) * Math.PI * 2 * k.n + k.p), 0);
}

function ridge(w: number, h: number, color: string, f: (x: number) => number, top?: string): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  if (!ctx) return c;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 4) ctx.lineTo(x, f(x));
  ctx.lineTo(w, h);
  ctx.closePath();
  if (top) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
  } else ctx.fillStyle = color;
  ctx.fill();
  return c;
}

function sun(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2.6);
  g.addColorStop(0, rgba(color, 0.35));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function starTile(seed: number, size: number, n: number, rMax: number, color: string): HTMLCanvasElement {
  const [c, ctx] = canvas(size, size);
  if (!ctx) return c;
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * size;
    const y = r() * size;
    const rr = 0.4 + r() ** 3 * rMax;
    ctx.globalAlpha = 0.35 + r() * 0.65;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
    if (rr > rMax * 0.6) {
      ctx.globalAlpha *= 0.5;
      ctx.fillRect(x - rr * 3, y - 0.5, rr * 6, 1);
      ctx.fillRect(x - 0.5, y - rr * 3, 1, rr * 6);
    }
  }
  return c;
}

function fillLayer(paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): BgLayer {
  const [c, ctx] = canvas(REF_W, REF_H);
  if (ctx) paint(ctx, REF_W, REF_H);
  return { canvas: c, factor: 0, tileX: false, tileY: false, anchor: 'fill' };
}

function bottomLayer(c: HTMLCanvasElement, factor: number): BgLayer {
  return { canvas: c, factor, tileX: true, tileY: false, anchor: 'bottom' };
}

function cloudTile(seed: number, w: number, h: number, color: string, n: number, size: number): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  if (!ctx) return c;
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const cx = ((i + r() * 0.6) / n) * w;
    const cy = h * (0.2 + r() * 0.6);
    const s = size * (0.6 + r() * 0.8);
    ctx.fillStyle = color;
    for (let k = 0; k < 6; k++) {
      const bx = cx + (k - 2.5) * s * 0.42 + (r() - 0.5) * s * 0.2;
      const by = cy - Math.sin((k / 5) * Math.PI) * s * 0.35 + (r() - 0.5) * s * 0.1;
      const rr = s * (0.28 + Math.sin((k / 5) * Math.PI) * 0.22);
      for (const dx of [-w, 0, w]) {
        ctx.beginPath();
        ctx.arc(bx + dx, by, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return c;
}

function treeTile(seed: number, w: number, h: number, color: string, count: number, minH: number, maxH: number): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  if (!ctx) return c;
  const r = rng(seed);
  ctx.fillStyle = color;
  ctx.fillRect(0, h - 30, w, 30);
  for (let i = 0; i < count; i++) {
    const x = ((i + r() * 0.8) / count) * w;
    const th = minH + r() * (maxH - minH);
    const tw = th * (0.32 + r() * 0.12);
    for (const dx of [-w, 0, w]) {
      const bx = x + dx;
      ctx.beginPath();
      // stacked pine tiers
      for (let k = 0; k < 3; k++) {
        const ty = h - 24 - th + (k * th) / 4;
        const tw2 = tw * (0.55 + k * 0.25);
        ctx.moveTo(bx, ty);
        ctx.lineTo(bx + tw2 / 2, ty + th * 0.42);
        ctx.lineTo(bx - tw2 / 2, ty + th * 0.42);
        ctx.closePath();
      }
      ctx.fill();
      ctx.fillRect(bx - tw * 0.06, h - 30 - th * 0.15, tw * 0.12, th * 0.2);
    }
  }
  return c;
}

function skyline(seed: number, w: number, h: number, color: string, windows: string | null, minH: number, maxH: number): HTMLCanvasElement {
  const [c, ctx] = canvas(w, h);
  if (!ctx) return c;
  const r = rng(seed);
  let x = 0;
  while (x < w) {
    const bw = 50 + r() * 90;
    const bh = minH + r() * (maxH - minH);
    const bwClamped = Math.min(bw, w - x);
    ctx.fillStyle = color;
    ctx.fillRect(x, h - bh, bwClamped, bh);
    if (r() < 0.3) ctx.fillRect(x + bwClamped * 0.4, h - bh - 24, 4, 24);
    if (windows) {
      ctx.fillStyle = windows;
      for (let wy = h - bh + 14; wy < h - 12; wy += 22) {
        for (let wx = x + 10; wx < x + bwClamped - 14; wx += 18) if (r() < 0.45) ctx.fillRect(wx, wy, 7, 10);
      }
    }
    x += bwClamped + 4 + r() * 10;
  }
  return c;
}

function build(ft: FullTheme): BgLayer[] {
  const P = ft.palette;
  const seed = hashStr(ft.id + ft.background.style);
  const dark = isDark(P.bg);
  const style = ft.background.style;
  const L: BgLayer[] = [];
  switch (style) {
    case 'solid':
      L.push(fillLayer((ctx, w, h) => {
        ctx.fillStyle = col(ft, 0, P.bg);
        ctx.fillRect(0, 0, w, h);
      }));
      break;
    case 'paper': {
      const base = col(ft, 0, P.bg);
      L.push(fillLayer((ctx, w, h) => {
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, w, h);
        const g = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.75);
        g.addColorStop(0, rgba(base, 0));
        g.addColorStop(1, rgba(mix(base, P.ink, 0.5), 0.12));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }));
      const [c, ctx] = canvas(256, 256);
      if (ctx) {
        const r = rng(seed);
        for (let i = 0; i < 900; i++) {
          ctx.fillStyle = rgba(P.ink, 0.02 + r() * 0.04);
          ctx.fillRect(r() * 256, r() * 256, 1 + r() * 1.5, 1 + r() * 1.5);
        }
        ctx.fillStyle = rgba(col(ft, 1, P.ink), 0.09);
        for (let y = 16; y < 256; y += 32) for (let x = 16; x < 256; x += 32) {
          ctx.beginPath();
          ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      L.push({ canvas: c, factor: 1, tileX: true, tileY: true, anchor: 'fill', worldScale: true });
      break;
    }
    case 'gradient':
      L.push(fillLayer((ctx, w, h) => vgrad(ctx, w, h, ft.background.colors.length >= 2 ? ft.background.colors
        : [mix(P.bg, P.accent2, 0.35), P.bg])));
      break;
    case 'grid': {
      const base = col(ft, 0, P.bg);
      const line = col(ft, 1, mix(base, dark ? '#ffffff' : P.accent2, 0.3));
      L.push(fillLayer((ctx, w, h) => {
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, w, h);
      }));
      const [c, ctx] = canvas(128, 128);
      if (ctx) {
        ctx.strokeStyle = rgba(line, 0.35);
        ctx.lineWidth = 1;
        for (let i = 0; i < 128; i += 32) {
          ctx.beginPath();
          ctx.moveTo(i + 0.5, 0);
          ctx.lineTo(i + 0.5, 128);
          ctx.moveTo(0, i + 0.5);
          ctx.lineTo(128, i + 0.5);
          ctx.stroke();
        }
        ctx.strokeStyle = rgba(line, 0.75);
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, 128, 128);
      }
      L.push({ canvas: c, factor: 1, tileX: true, tileY: true, anchor: 'fill', worldScale: true });
      break;
    }
    case 'stars':
    case 'space': {
      const a = col(ft, 0, dark ? P.bg : '#0b1026');
      const b = col(ft, 1, mix(a, P.accent2, 0.25));
      L.push(fillLayer((ctx, w, h) => {
        vgrad(ctx, w, h, [a, b]);
        if (style === 'space') {
          const r = rng(seed ^ 3);
          for (let i = 0; i < 7; i++) {
            const x = r() * w;
            const y = r() * h;
            const rr = 160 + r() * 340;
            const c = i % 2 ? col(ft, 2, P.accent) : col(ft, 3, P.accent2);
            const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
            g.addColorStop(0, rgba(c, 0.22));
            g.addColorStop(0.5, rgba(c, 0.08));
            g.addColorStop(1, rgba(c, 0));
            ctx.fillStyle = g;
            ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
          }
          sun(ctx, w * 0.82, h * 0.22, 46, mix(col(ft, 2, P.accent), '#ffffff', 0.2));
        }
      }));
      L.push({ canvas: starTile(seed, 512, 160, 1.2, '#ffffff'), factor: 0.05, tileX: true, tileY: true, anchor: 'fill' });
      L.push({ canvas: starTile(seed ^ 9, 768, 50, 2.4, mix('#ffffff', P.accent2, 0.15)), factor: 0.18, tileX: true, tileY: true, anchor: 'fill' });
      break;
    }
    case 'city': {
      const top = col(ft, 0, mix(P.bg, P.accent2, dark ? 0.15 : 0.35));
      const bot = col(ft, 1, P.bg);
      L.push(fillLayer((ctx, w, h) => {
        vgrad(ctx, w, h, [top, bot]);
        sun(ctx, w * 0.75, h * 0.3, 54, dark ? mix('#ffffff', P.accent2, 0.2) : mix(P.accent, '#ffffff', 0.3));
      }));
      const far = col(ft, 2, mix(bot, P.ink, dark ? 0.15 : 0.18));
      const near = col(ft, 3, mix(bot, P.ink, dark ? 0.3 : 0.38));
      L.push(bottomLayer(skyline(seed, 1024, 520, far, null, 140, 420), 0.12));
      L.push(bottomLayer(skyline(seed ^ 5, 1024, 420, near, rgba(dark ? P.accent : '#fff7c2', dark ? 0.7 : 0.55), 90, 320), 0.35));
      break;
    }
    case 'hills': {
      const top = col(ft, 0, mix(P.bg, P.accent2, 0.3));
      const bot = col(ft, 1, P.bg);
      L.push(fillLayer((ctx, w, h) => {
        vgrad(ctx, w, h, [top, bot]);
        sun(ctx, w * 0.78, h * 0.24, 48, mix(P.accent, '#fff3b0', 0.5));
      }));
      const far = col(ft, 2, mix(P.good, bot, 0.55));
      const near = col(ft, 3, mix(P.good, bot, 0.25));
      L.push(bottomLayer(ridge(1600, 460, far, profile(seed, 1600, 170, 70, [1, 2, 5])), 0.1));
      L.push(bottomLayer(ridge(1600, 340, near, profile(seed ^ 7, 1600, 120, 55, [2, 3, 7]), mix(near, '#ffffff', 0.1)), 0.3));
      break;
    }
    case 'clouds': {
      const top = col(ft, 0, mix(P.accent2, '#ffffff', 0.45));
      const bot = col(ft, 1, mix(P.bg, '#ffffff', 0.3));
      L.push(fillLayer((ctx, w, h) => vgrad(ctx, w, h, [top, bot])));
      const cloud = col(ft, 2, dark ? mix(P.bg, '#ffffff', 0.18) : '#ffffff');
      L.push({ canvas: cloudTile(seed, 1600, 420, rgba(cloud, 0.55), 5, 170), factor: 0.06, tileX: true, tileY: false, anchor: 'top' });
      L.push({ canvas: cloudTile(seed ^ 1, 1600, 560, rgba(cloud, 0.9), 4, 220), factor: 0.2, tileX: true, tileY: false, anchor: 'top' });
      break;
    }
    case 'neon_grid': {
      const a = col(ft, 0, '#12002a');
      const b = col(ft, 1, '#3d0b5c');
      const line = col(ft, 2, P.accent);
      const sunC = col(ft, 3, P.accent2);
      L.push(fillLayer((ctx, w, h) => {
        const hz = h * 0.62;
        vgrad(ctx, w, hz, [a, b]);
        // striped synth sun
        const sx = w / 2;
        const sy = hz - 20;
        const R = 170;
        const g = ctx.createLinearGradient(0, sy - R, 0, sy + R);
        g.addColorStop(0, mix(sunC, '#fff3a0', 0.4));
        g.addColorStop(1, line);
        ctx.save();
        ctx.beginPath();
        ctx.arc(sx, sy, R, Math.PI, 0);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = g;
        ctx.fillRect(sx - R, sy - R, R * 2, R * 2);
        ctx.fillStyle = b;
        for (let k = 0; k < 7; k++) ctx.fillRect(sx - R, sy - R * 0.55 + k * k * 4 + k * 10, R * 2, 2 + k * 1.6);
        ctx.restore();
        // floor
        ctx.fillStyle = mix(a, '#000000', 0.4);
        ctx.fillRect(0, hz, w, h - hz);
        ctx.strokeStyle = line;
        ctx.shadowColor = line;
        ctx.shadowBlur = 10;
        ctx.lineWidth = 2;
        for (let k = 0; k < 14; k++) {
          const t = (k / 14) ** 2;
          const y = hz + t * (h - hz);
          ctx.globalAlpha = 0.25 + t * 0.75;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.8;
        for (let k = -20; k <= 20; k++) {
          ctx.beginPath();
          ctx.moveTo(sx + k * 30, hz);
          ctx.lineTo(sx + k * 260, h);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      }));
      const [c, ctx] = canvas(1600, 420);
      if (ctx) {
        const f = profile(seed, 1600, 300, 70, [3, 5, 9]);
        ctx.beginPath();
        ctx.moveTo(0, 420);
        for (let x = 0; x <= 1600; x += 40) ctx.lineTo(x, f(x) + (x % 80 === 0 ? -30 : 10));
        ctx.lineTo(1600, 420);
        ctx.closePath();
        ctx.fillStyle = mix(a, '#000000', 0.2);
        ctx.fill();
        ctx.strokeStyle = rgba(line, 0.8);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      L.push({ canvas: c, factor: 0.08, tileX: true, tileY: false, anchor: 'bottom' });
      // the floor overlays the mountains' base: re-add it as a fixed strip
      L.push(fillLayer((ctx, w, h) => {
        const hz = h * 0.62;
        ctx.drawImage(L[0].canvas, 0, hz, w, h - hz, 0, hz, w, h - hz);
      }));
      break;
    }
    case 'halftone': {
      const base = col(ft, 0, P.bg);
      const dotC = col(ft, 1, mix(P.accent, base, 0.55));
      L.push(fillLayer((ctx, w, h) => {
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = dotC;
        const step = 26;
        for (let y = 0; y < h + step; y += step) {
          for (let x = 0; x < w + step; x += step) {
            const t = Math.min(1, Math.max(0, (x / w) * 0.6 + (y / h) * 0.6 - 0.2));
            const r = 1 + t * 9;
            ctx.beginPath();
            ctx.arc(x + ((y / step) % 2) * (step / 2), y, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        const g = ctx.createRadialGradient(w * 0.3, h * 0.35, 0, w * 0.3, h * 0.35, w * 0.6);
        g.addColorStop(0, rgba(base, 0.85));
        g.addColorStop(1, rgba(base, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }));
      break;
    }
    case 'waves': {
      const top = col(ft, 0, mix(P.accent2, '#ffffff', 0.55));
      const sea = col(ft, 1, P.accent2);
      L.push(fillLayer((ctx, w, h) => {
        vgrad(ctx, w, h, [top, mix(top, P.bg, 0.5)]);
        sun(ctx, w * 0.2, h * 0.25, 44, mix(P.accent, '#fff6c0', 0.6));
      }));
      const shades = [mix(sea, '#ffffff', 0.35), sea, mix(sea, '#000000', 0.25)];
      [0.15, 0.35, 0.6].forEach((f, i) => {
        const h = 260 + i * 60;
        const fn = profile(seed ^ (i * 13), 1600, 40 + i * 14, 12 + i * 4, [8 + i * 2, 13, 21]);
        L.push(bottomLayer(ridge(1600, h, shades[i], fn, mix(shades[i], '#ffffff', 0.2)), f));
      });
      break;
    }
    case 'dunes': {
      const top = col(ft, 0, mix(P.accent, '#ffe9b0', 0.6));
      const bot = col(ft, 1, mix(P.bg, '#ffd28a', 0.4));
      L.push(fillLayer((ctx, w, h) => {
        vgrad(ctx, w, h, [top, bot]);
        sun(ctx, w * 0.7, h * 0.28, 62, mix('#fff3c4', P.accent, 0.2));
      }));
      const sand = col(ft, 2, mix('#e8b86a', P.accent, 0.25));
      [0.1, 0.3, 0.55].forEach((f, i) => {
        const c = mix(sand, i === 0 ? bot : '#7a4a1e', i === 0 ? 0.45 : i * 0.18);
        const fn = profile(seed ^ (i * 31), 1600, 150 - i * 30, 60 - i * 10, [1 + i, 2 + i, 4]);
        L.push(bottomLayer(ridge(1600, 380 - i * 60, c, fn, mix(c, '#ffffff', 0.15)), f));
      });
      break;
    }
    case 'forest': {
      const top = col(ft, 0, dark ? mix(P.bg, P.accent2, 0.2) : mix(P.good, '#ffffff', 0.6));
      const bot = col(ft, 1, mix(top, P.bg, 0.5));
      L.push(fillLayer((ctx, w, h) => {
        vgrad(ctx, w, h, [top, bot]);
        sun(ctx, w * 0.25, h * 0.22, 40, dark ? '#f2f0d8' : mix('#fff6c8', P.accent, 0.15));
      }));
      const tree = col(ft, 2, dark ? mix(P.bg, '#000000', 0.3) : mix(P.good, '#0d2a1a', 0.35));
      [0.1, 0.28, 0.55].forEach((f, i) => {
        const c = mix(tree, bot, 0.6 - i * 0.28);
        L.push(bottomLayer(treeTile(seed ^ (i * 17), 1600, 420 + i * 40, c, 18 - i * 4, 160 + i * 40, 300 + i * 50), f));
      });
      break;
    }
  }
  return L;
}

/** The layers of a theme's background (cached per theme content). */
export function backgroundLayers(theme: StudioTheme | null): BgLayer[] {
  const ft = fullTheme(theme);
  const key = JSON.stringify([ft.id, ft.background, ft.palette]);
  let L = layerCache.get(key);
  if (!L) {
    try {
      L = build(ft);
    } catch {
      L = [];
    }
    if (layerCache.size > 24) layerCache.delete(layerCache.keys().next().value as string);
    layerCache.set(key, L);
  }
  return L;
}

/** Where a layer goes for this camera, in view pixels (see the header). */
export function layerPlacement(layer: BgLayer, world: { width: number; height: number }, cam: CameraView,
  view: { w: number; h: number }, parallax = true): Placement {
  const zoom = cam.zoom && cam.zoom > 0 ? cam.zoom : 1;
  const s = view.h / REF_H; // reference → view
  const f = parallax ? layer.factor : layer.factor >= 1 ? 1 : 0;
  if (layer.anchor === 'fill' && !layer.tileX && !layer.tileY) return { x: 0, y: 0, w: view.w, h: view.h, tileX: 0, tileY: 0, tileScale: 1 };
  if (layer.worldScale) {
    // world-locked texture: scrolls 1:1 with the world and scales with the zoom
    return { x: 0, y: 0, w: view.w, h: view.h, tileX: cam.x * f, tileY: cam.y * f, tileScale: zoom };
  }
  if (layer.anchor === 'fill') {
    return { x: 0, y: 0, w: view.w, h: view.h, tileX: (cam.x * zoom * f) / s, tileY: (cam.y * zoom * f) / s, tileScale: s };
  }
  const h = layer.canvas.height * s;
  const camBottom = cam.y + view.h / zoom;
  let y: number;
  if (layer.anchor === 'bottom') {
    const below = Math.max(0, world.height - camBottom) * zoom * f * 0.5; // camera above the world's floor → layer sinks
    y = view.h - h + below;
  } else {
    const above = Math.max(0, cam.y) * zoom * f * 0.3;
    y = -above;
  }
  return { x: 0, y, w: view.w, h, tileX: (cam.x * zoom * f) / s, tileY: 0, tileScale: s };
}

/** Paint the background for a camera onto a 2D context (the Studio editor's live canvas and thumbnails). */
export function renderBackground(ctx: CanvasRenderingContext2D, theme: StudioTheme | null,
  world: { width: number; height: number }, camera: CameraView = { x: 0, y: 0, zoom: 1 },
  view?: { w: number; h: number }): void {
  const v = view ?? { w: ctx.canvas.width, h: ctx.canvas.height };
  const ft = fullTheme(theme);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = ft.palette.bg;
  ctx.fillRect(0, 0, v.w, v.h);
  try {
    for (const layer of backgroundLayers(theme)) {
      const p = layerPlacement(layer, world, camera, v, ft.background.parallax);
      if (!layer.tileX && !layer.tileY) {
        ctx.drawImage(layer.canvas, p.x, p.y, p.w, p.h);
        continue;
      }
      const pat = ctx.createPattern(layer.canvas, layer.tileX && layer.tileY ? 'repeat' : layer.tileX ? 'repeat-x' : 'repeat-y');
      if (!pat) continue;
      const m = new DOMMatrix().translate(p.x, p.y).scale(p.tileScale).translate(-p.tileX, -p.tileY);
      pat.setTransform(m);
      ctx.fillStyle = pat;
      ctx.fillRect(p.x, Math.max(0, p.y), p.w, Math.min(v.h, p.y + p.h) - Math.max(0, p.y));
    }
  } catch {
    /* a broken layer leaves the plain background colour */
  }
  ctx.restore();
}
