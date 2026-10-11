/**
 * The Studio's adapter to lane R's theme renderer (docs/v6/CONTRACTS_V6.md §4.3): object bitmaps come from
 * `renderDrawing` (cached per drawing, theme and zoom bucket) and the world background from `renderBackground` once
 * lane R exports it; until then a plain paper / gradient fallback paints the world. Switching is automatic.
 */
import type { StudioTheme } from '../../core/types.gen.ts';
import * as themeRender from '../theme/render.ts';
import type { SDrawing, SObj, SWorld } from '../model/types.ts';

export interface Camera { x: number; y: number; zoom: number; width: number; height: number }

type BgFn = (ctx: CanvasRenderingContext2D, theme: StudioTheme, world: SWorld, camera: Camera) => void;

function laneRBackground(): BgFn | null {
  const fn = (themeRender as Record<string, unknown>).renderBackground;
  return typeof fn === 'function' ? (fn as BgFn) : null;
}

let bgFailed = false;

/**
 * Paint the world (0, 0)–(width, height). `ctx` is already in world coordinates (scaled by the zoom) and clipped to
 * the world rect; `cam` is the visible window in world px.
 */
export function drawBackground(ctx: CanvasRenderingContext2D, theme: StudioTheme, world: SWorld, cam: Camera): void {
  const lane = bgFailed ? null : laneRBackground();
  if (lane) {
    try {
      ctx.save();
      lane(ctx, theme, world, cam);
      ctx.restore();
      return;
    } catch (e) {
      ctx.restore();
      bgFailed = true;
      console.warn('renderBackground failed; using the paper fallback', e);
    }
  }
  paperBackground(ctx, theme, world, cam);
}

export function isDark(hex: string | undefined): boolean {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return false;
  const n = parseInt(hex.slice(1), 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l < 0.45;
}

function paperBackground(ctx: CanvasRenderingContext2D, theme: StudioTheme, world: SWorld, cam: Camera): void {
  const bg = theme.palette?.bg ?? '#f6f1e7';
  const colors = (theme.background?.colors ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const style = theme.background?.style ?? 'paper';
  if (colors.length >= 2 && style !== 'paper' && style !== 'solid') {
    const g = ctx.createLinearGradient(0, 0, 0, world.height);
    colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
    ctx.fillStyle = g;
  } else ctx.fillStyle = colors[0] ?? bg;
  ctx.fillRect(0, 0, world.width, world.height);
  if (style === 'solid') return;
  // a quiet dot grid helps judge distances (paper) or a line grid (grid / blueprint)
  const dark = isDark(bg);
  const step = 40;
  const x0 = Math.max(0, Math.floor(cam.x / step) * step);
  const y0 = Math.max(0, Math.floor(cam.y / step) * step);
  const x1 = Math.min(world.width, cam.x + cam.width / cam.zoom);
  const y1 = Math.min(world.height, cam.y + cam.height / cam.zoom);
  if (cam.zoom < 0.18) return;
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.10)' : 'rgba(31,27,24,0.10)';
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.07)' : 'rgba(31,27,24,0.06)';
  ctx.lineWidth = 1 / cam.zoom;
  if (style === 'grid') {
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    return;
  }
  const r = Math.max(1, 1.3 / cam.zoom);
  for (let x = x0; x <= x1; x += step) for (let y = y0; y <= y1; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
}

// ---- object bitmaps ----------------------------------------------------------------------------------------------

interface Cached { drawing: SDrawing; theme: StudioTheme; bucket: number; canvas: HTMLCanvasElement }

const MAX_TEX = 4096;

export class BitmapCache {
  private map = new Map<string, Cached>();

  /** The object's drawing at roughly `pxPerUnit` device px per local unit (bucketed so zooming re-renders rarely). */
  get(o: SObj, theme: StudioTheme, pxPerUnit: number): { canvas: HTMLCanvasElement; bucket: number } | null {
    if (!o.drawing.strokes.length) return null;
    const size = Math.max(o.drawing.w, o.drawing.h, 1);
    let bucket = 2 ** (Math.round(Math.log2(Math.max(0.05, pxPerUnit)) * 2) / 2);
    bucket = Math.min(bucket, MAX_TEX / (size + 80));
    const key = o.id;
    const c = this.map.get(key);
    if (c && c.drawing === o.drawing && c.theme === theme && Math.abs(c.bucket - bucket) < 1e-6) return c;
    const maxW = o.drawing.strokes.reduce((m, s) => Math.max(m, s.width ?? 6), 0);
    const ws = theme.stroke?.width_scale ?? 1;
    const canvas = themeRender.renderDrawing(o.drawing, theme, { scale: bucket, pad: Math.ceil((maxW * ws * 0.75 + 14) * bucket) });
    const next = { drawing: o.drawing, theme, bucket, canvas };
    this.map.set(key, next);
    return next;
  }

  prune(ids: Set<string>): void {
    for (const k of this.map.keys()) if (!ids.has(k)) this.map.delete(k);
  }

  clear(): void {
    this.map.clear();
  }
}
