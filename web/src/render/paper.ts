/**
 * Paper themes (PLAN_V2 §7.5): a procedural 512 × 512 fBm grain tile (4 octaves, ±4% luminance) made once per theme
 * and render scale, plus the theme pattern (sketchbook dot grid, notebook rules + red margin, graph grid, kraft
 * fibres) and a 12% vignette.
 */
import type { Theme } from '../core/types.gen.ts';
import { ART } from '../core/params.ts';
import { PAPER_THEMES } from '../core/art/outline.ts';
import { hash32, rng } from '../core/art/geom.ts';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const TILE = ART.paper_grain.tile_px;
const tiles = new Map<string, HTMLCanvasElement>();
let grain: HTMLCanvasElement | null = null;

export function paperBase(theme: Theme): string {
  return (PAPER_THEMES[theme] ?? PAPER_THEMES.sketchbook).base;
}

/** Tileable fBm value noise, 4 octaves, as a darkening alpha mask (mean ≈ 4%). */
function grainCanvas(): HTMLCanvasElement {
  if (grain) return grain;
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  const ctx = c.getContext('2d');
  grain = c;
  if (!ctx) return c;
  const r = rng(hash32('paper-grain'));
  const octaves = ART.paper_grain.octaves;
  const lattices: { f: number; v: Float32Array; amp: number }[] = [];
  let amp = 0.5;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = 16 << o; // 16, 32, 64, 128 lattice cells per tile: periodic, so the tile repeats seamlessly
    const v = new Float32Array(f * f);
    for (let i = 0; i < v.length; i++) v[i] = r();
    lattices.push({ f, v, amp });
    total += amp;
    amp *= 0.5;
  }
  const img = ctx.createImageData(TILE, TILE);
  const lum = ART.paper_grain.lum * 2;
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      let n = 0;
      for (const L of lattices) {
        const fx = (x / TILE) * L.f;
        const fy = (y / TILE) * L.f;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        let tx = fx - ix;
        let ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx);
        ty = ty * ty * (3 - 2 * ty);
        const x0 = ix % L.f;
        const y0 = iy % L.f;
        const x1 = (ix + 1) % L.f;
        const y1 = (iy + 1) % L.f;
        const a = L.v[y0 * L.f + x0];
        const b = L.v[y0 * L.f + x1];
        const cc = L.v[y1 * L.f + x0];
        const d = L.v[y1 * L.f + x1];
        n += (a + (b - a) * tx + (cc - a + (a - b - cc + d) * tx) * ty) * L.amp;
      }
      const k = (y * TILE + x) * 4;
      img.data[k] = 40;
      img.data[k + 1] = 28;
      img.data[k + 2] = 16;
      img.data[k + 3] = Math.round((n / total) * lum * 255);
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

function drawPattern(ctx: Ctx2D, theme: Theme, size: number, r: number): void {
  ctx.save();
  ctx.scale(r, r);
  if (theme === 'sketchbook') {
    const g = ART.themes.sketchbook.grid_px;
    ctx.fillStyle = PAPER_THEMES.sketchbook.dot;
    for (let y = 0; y <= size; y += g)
      for (let x = 0; x <= size; x += g) {
        ctx.beginPath();
        ctx.arc(x, y, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
  } else if (theme === 'notebook') {
    const rp = ART.themes.notebook.rule_px;
    ctx.strokeStyle = PAPER_THEMES.notebook.rule;
    ctx.lineWidth = 1;
    for (let y = rp - 0.5; y < size; y += rp) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  } else if (theme === 'graph') {
    const g = ART.themes.graph.grid_px;
    ctx.strokeStyle = PAPER_THEMES.graph.grid;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let v = 0; v <= size; v += g) {
      ctx.moveTo(v, 0);
      ctx.lineTo(v, size);
      ctx.moveTo(0, v);
      ctx.lineTo(size, v);
    }
    ctx.stroke();
  } else {
    // kraft fibres, kept away from the tile edges so the tile repeats seamlessly
    const rr = rng(hash32('kraft-fibres'));
    for (let i = 0; i < 160; i++) {
      const x = 8 + rr() * (size - 16);
      const y = 8 + rr() * (size - 16);
      const a = rr() * Math.PI;
      const L = 3 + rr() * 6;
      ctx.strokeStyle = i % 3 ? PAPER_THEMES.kraft.fibre : 'rgba(255,240,220,0.14)';
      ctx.lineWidth = 0.6 + rr() * 0.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + Math.cos(a) * L * 0.5 + 1, y + Math.sin(a) * L * 0.5 - 1, x + Math.cos(a) * L, y + Math.sin(a) * L);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The paper tile for a theme at render scale r: 512·r canvas px for 512 logical px. */
export function paperTile(theme: Theme, r: number): HTMLCanvasElement {
  const key = `${theme}@${r}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  const N = Math.round(TILE * r);
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = paperBase(theme);
    ctx.fillRect(0, 0, N, N);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(grainCanvas(), 0, 0, N, N);
    drawPattern(ctx, theme, TILE, r);
  }
  tiles.set(key, c);
  return c;
}

/** Fill a logical-px rect with the theme paper (the context transform maps logical px to canvas px). */
export function paintPaper(ctx: Ctx2D, theme: Theme, x0: number, y0: number, w: number, h: number, scale: number): void {
  ctx.save();
  ctx.fillStyle = paperBase(theme);
  ctx.fillRect(x0, y0, w, h);
  const r = scale >= 1.25 ? 2 : 1;
  const tile = paperTile(theme, r);
  const pat = ctx.createPattern(tile as CanvasImageSource, 'repeat');
  if (pat) {
    if (r !== 1 && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix().scale(1 / r, 1 / r));
    ctx.fillStyle = pat;
    ctx.fillRect(x0, y0, w, h);
  }
  if (theme === 'notebook') {
    ctx.strokeStyle = PAPER_THEMES.notebook.margin;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(40, y0);
    ctx.lineTo(40, y0 + h);
    ctx.stroke();
  }
  ctx.restore();
}

export function paintVignette(ctx: Ctx2D, x0: number, y0: number, w: number, h: number, strength: number = ART.paper_grain.vignette): void {
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const R = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
  g.addColorStop(0, 'rgba(60,40,20,0)');
  g.addColorStop(1, `rgba(60,40,20,${strength})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);
  ctx.restore();
}

/** A small vignette texture (stretched over the view in the engine). */
export function vignetteCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 144;
  const ctx = c.getContext('2d');
  if (ctx) paintVignette(ctx, 0, 0, 256, 144);
  return c;
}
