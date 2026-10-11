/**
 * Drawings → pixels under a theme (docs/v6/CONTRACTS_V6.md §4.3). The one stroke renderer: the Studio canvas, the
 * runtime (textures) and thumbnails all call it, so what the maker sees while drawing is what plays.
 *
 * Exported API (lane E):
 *   renderDrawing(drawing, theme, { scale?, pad?, recolorMap?, region? }) → HTMLCanvasElement
 *       The drawing on a transparent canvas. Without `region` the canvas is centred on the drawing's (0, 0) (its size
 *       is 2 × the largest extent from the origin × scale + 2 × pad, plus room for glow and outlines), so draw it with
 *       its centre at the object's position: `ctx.drawImage(c, x - c.width / 2 / scale, y - c.height / 2 / scale, ...)`.
 *       With `region` ({x, y, w, h} in drawing-local px) only that window is drawn onto a w×h (× scale) canvas whose
 *       top left is (region.x, region.y): use it to tile huge drawings (terrain) below texture size limits.
 *       Results are cached by drawing object identity + theme + options; treat drawings and recolour maps as immutable.
 *   drawingCanvasOrigin(c) → {x, y}: the canvas pixel where the drawing's (0, 0) sits.
 *   drawingExtent(drawing, theme) → {x, y}: largest |x| / |y| reach of the drawing's ink incl. stroke widths & effects.
 *   clearRenderCache(): drop cached canvases (theme gallery switches, memory pressure).
 *   Re-exported for convenience: fullTheme, buildRecolorMap, docDrawings (see color.ts), renderBackground (background.ts).
 *
 * Stroke styles: ink (thin, dark, tapered), marker (round, flat), neon (bright core + glow), pixel (grid-snapped, no AA),
 * chalk (grainy, broken), comic (thick outline + optional halftone fills), crayon (waxy grain + hatched fills),
 * watercolor (soft translucent edges + bleed). Plus outline, glow, wobble (seeded per stroke), fill_closed, recolor.
 */
import type { Drawing, Stroke, StudioTheme } from '../../core/types.gen.ts';
import { brighten, buildRecolorMap, fillFor, fullTheme, mapColor, mix, parseHex, recolorFill, rgba, type FullTheme } from './color.ts';
import { hashNums, rng } from './rng.ts';

export { buildRecolorMap, docDrawings, fullTheme } from './color.ts';
export { renderBackground } from './background.ts';

export interface RenderOpts {
  scale?: number; // pixels per drawing unit (default 1)
  pad?: number; // extra pixels around the drawing (default 8)
  /** Game-wide colour map from buildRecolorMap (used when the theme's recolor is on); default: per drawing. */
  recolorMap?: Map<string, string> | null;
  /** Only this window of the drawing (drawing-local px); the canvas top left is (x, y). */
  region?: { x: number; y: number; w: number; h: number };
}

type Pt = [number, number];

interface Geo {
  pts: Pt[];
  width: number;
  closed: boolean;
  color: string;
  fill: string | null;
  seed: number;
  index: number;
}

const MAX_CANVAS = 8192;

// ---- caches ---------------------------------------------------------------------------------------

const cache = new WeakMap<object, Map<string, HTMLCanvasElement>>();
const themeKeys = new WeakMap<object, string>();
const mapKeys = new WeakMap<object, string>();
let generation = 0;

function themeKey(ft: FullTheme): string {
  let k = themeKeys.get(ft);
  if (!k) {
    k = JSON.stringify([ft.palette, ft.stroke, ft.recolor]);
    themeKeys.set(ft, k);
  }
  return k;
}

function mapKey(m: Map<string, string> | null | undefined): string {
  if (!m) return '';
  let k = mapKeys.get(m);
  if (!k) {
    k = [...m.entries()].map(([a, b]) => a + b).join('');
    mapKeys.set(m, k);
  }
  return k;
}

export function clearRenderCache(): void {
  generation++;
}

/** The canvas pixel where the drawing's (0, 0) sits (centre for full renders, from the region otherwise). */
export function drawingCanvasOrigin(c: HTMLCanvasElement): { x: number; y: number } {
  const o = (c as HTMLCanvasElement & { __origin?: { x: number; y: number } }).__origin;
  return o ?? { x: c.width / 2, y: c.height / 2 };
}

// ---- geometry -------------------------------------------------------------------------------------

function cleanPoints(s: Stroke): Pt[] {
  const out: Pt[] = [];
  for (const p of s?.points ?? []) {
    if (!Array.isArray(p)) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** Split long segments so wobble has points to bend. */
function resample(pts: Pt[], closed: boolean, maxLen: number): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.floor(d / maxLen);
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

/** Stable hand jitter: smooth noise along the normal, seeded per stroke (never per frame). */
export function wobblePoints(pts: Pt[], closed: boolean, amount: number, width: number, seed: number): Pt[] {
  if (amount <= 0 || pts.length < 2) return pts;
  const amp = Math.min(9, amount * (1.6 + width * 0.32));
  const rp = resample(pts, closed, 9);
  const r = rng(seed);
  const n = rp.length;
  // value noise: random knots every ~4 points, cosine-interpolated, plus a finer octave
  const knots = Array.from({ length: Math.ceil(n / 4) + 2 }, () => r() * 2 - 1);
  const fine = Array.from({ length: n }, () => r() * 2 - 1);
  const noise = (i: number): number => {
    const f = i / 4;
    const k = Math.floor(f);
    const t = (1 - Math.cos((f - k) * Math.PI)) / 2;
    return knots[k] * (1 - t) + knots[k + 1] * t + fine[i] * 0.18;
  };
  const off = rp.map((_, i) => noise(i));
  if (closed && n > 8) {
    const blend = Math.max(2, Math.floor(n * 0.15));
    for (let j = 0; j < blend; j++) {
      const i = n - blend + j;
      const t = (j + 1) / (blend + 1);
      off[i] = off[i] * (1 - t) + off[0] * t;
    }
  }
  return rp.map((p, i) => {
    const a = rp[Math.max(0, i - 1)];
    const b = rp[Math.min(n - 1, i + 1)];
    let nx = -(b[1] - a[1]);
    let ny = b[0] - a[0];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    return [p[0] + nx * off[i] * amp, p[1] + ny * off[i] * amp] as Pt;
  });
}

function styleWidth(ft: FullTheme): number {
  switch (ft.stroke.style) {
    case 'ink': return 0.6;
    case 'comic': return 1.15;
    case 'neon': return 0.9;
    case 'crayon': return 1.1;
    default: return 1;
  }
}

function intrinsicWobble(ft: FullTheme): number {
  switch (ft.stroke.style) {
    case 'chalk': return 0.25;
    case 'crayon': return 0.2;
    case 'watercolor': return 0.15;
    case 'ink': return 0.08;
    default: return 0;
  }
}

function buildGeo(d: Drawing, ft: FullTheme, map: Map<string, string> | null): Geo[] {
  const ws = ft.stroke.width_scale * styleWidth(ft);
  const wob = Math.min(1, ft.stroke.wobble + intrinsicWobble(ft));
  const out: Geo[] = [];
  (d?.strokes ?? []).forEach((s, index) => {
    if (!s || typeof s !== 'object') return;
    const raw = cleanPoints(s);
    if (!raw.length) return;
    const width = Math.max(0.5, Math.min(80, Number(s.width) || 6)) * ws;
    const closed = s.closed === true && raw.length > 2;
    const seed = hashNums(index, raw[0][0], raw[0][1], raw.length);
    const pts = ft.stroke.style === 'pixel' ? raw : wobblePoints(raw, closed, wob, width, seed);
    const color = mapColor(s.color, map);
    let fill: string | null = null;
    if (closed) {
      if (s.fill && parseHex(s.fill)) fill = map && ft.recolor ? recolorFill(s.fill, map, ft, color, seed) : mapColor(s.fill, null);
      else if (ft.stroke.fill_closed) fill = fillFor(color, ft, seed);
    }
    out.push({ pts, width, closed, color, fill, seed, index });
  });
  return out;
}

function effectMargin(ft: FullTheme, maxW: number): number {
  let m = 2;
  if (ft.stroke.outline || ft.stroke.style === 'comic') m += Math.max(4, maxW * 0.6);
  if (ft.stroke.glow || ft.stroke.style === 'neon') m += maxW * 1.6 + 10;
  if (ft.stroke.style === 'watercolor') m += 6;
  return m;
}

/** Largest |x| / |y| reach of the drawing's ink (incl. widths and effects) under the theme. */
export function drawingExtent(d: Drawing, theme: StudioTheme | null): { x: number; y: number } {
  const ft = fullTheme(theme);
  const geo = buildGeo(d, ft, null);
  return extentOf(geo, ft);
}

function extentOf(geo: Geo[], ft: FullTheme): { x: number; y: number } {
  let ex = 1;
  let ey = 1;
  let maxW = 0;
  for (const g of geo) {
    maxW = Math.max(maxW, g.width);
    for (const [x, y] of g.pts) {
      ex = Math.max(ex, Math.abs(x) + g.width / 2);
      ey = Math.max(ey, Math.abs(y) + g.width / 2);
    }
  }
  const m = effectMargin(ft, maxW);
  return { x: ex + m, y: ey + m };
}

// ---- paths ----------------------------------------------------------------------------------------

/** Add points 6 px from both ends of long segments, so midpoint smoothing keeps corners crisp (a drawn box stays a box). */
function keepCorners(pts: Pt[], closed: boolean): Pt[] {
  if (pts.length < 3) return pts;
  const out: Pt[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a);
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d > 24) {
      const t = 6 / d;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], [b[0] - (b[0] - a[0]) * t, b[1] - (b[1] - a[1]) * t]);
    }
  }
  if (!closed) out.push(pts[pts.length - 1]);
  return out;
}

function trace(ctx: CanvasRenderingContext2D, pts0: Pt[], closed: boolean): void {
  const pts = keepCorners(pts0, closed);
  ctx.beginPath();
  if (pts.length < 3) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (closed) ctx.closePath();
    return;
  }
  if (closed) {
    const n = pts.length;
    const m0: Pt = [(pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2];
    ctx.moveTo(m0[0], m0[1]);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
    return;
  }
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function dot(ctx: CanvasRenderingContext2D, p: Pt, r: number, color: string | CanvasPattern): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fill();
}

function jitterPts(pts: Pt[], r: () => number, amt: number): Pt[] {
  return pts.map(([x, y]) => [x + (r() * 2 - 1) * amt, y + (r() * 2 - 1) * amt] as Pt);
}

function shrinkToward(pts: Pt[], k: number): Pt[] {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  cx /= pts.length;
  cy /= pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k] as Pt);
}

// ---- grain patterns (chalk, crayon) ---------------------------------------------------------------

const patterns = new Map<string, CanvasPattern | null>();

function grainPattern(ctx: CanvasRenderingContext2D, color: string, kind: 'chalk' | 'crayon'): CanvasPattern | string {
  const key = `${kind}${color}`;
  if (patterns.has(key)) return patterns.get(key) ?? color;
  let pat: CanvasPattern | null = null;
  try {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (g) {
      const img = g.createImageData(size, size);
      const [r0, g0, b0] = parseHex(color) ?? [0, 0, 0];
      const rand = rng(kind === 'chalk' ? 7 : 11);
      for (let y = 0; y < size; y++) {
        // crayon: horizontal streaks (wax drags), chalk: speckle with holes
        const row = kind === 'crayon' ? 0.75 + 0.25 * Math.sin(y * 1.7 + rand() * 0.5) : 1;
        for (let x = 0; x < size; x++) {
          const v = rand();
          let a: number;
          if (kind === 'chalk') a = v < 0.22 ? 0 : 0.55 + v * 0.45;
          else a = (v < 0.1 ? 0.25 : 0.8 + v * 0.2) * row;
          const i = (y * size + x) * 4;
          img.data[i] = r0;
          img.data[i + 1] = g0;
          img.data[i + 2] = b0;
          img.data[i + 3] = Math.round(a * 255);
        }
      }
      g.putImageData(img, 0, 0);
      pat = ctx.createPattern(c, 'repeat');
    }
  } catch {
    pat = null;
  }
  patterns.set(key, pat);
  return pat ?? color;
}

// ---- fills ----------------------------------------------------------------------------------------

function halftone(ctx: CanvasRenderingContext2D, g: Geo, color: string): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of g.pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  ctx.save();
  trace(ctx, g.pts, true);
  ctx.clip();
  ctx.fillStyle = color;
  const step = 7;
  const h = Math.max(1, maxY - minY);
  for (let y = minY; y <= maxY; y += step) {
    const rr = 0.6 + 2.2 * ((y - minY) / h);
    const off = (Math.round((y - minY) / step) % 2) * step * 0.5;
    for (let x = minX - step + off; x <= maxX + step; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function hatch(ctx: CanvasRenderingContext2D, g: Geo, color: string, r: () => number): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of g.pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  ctx.save();
  trace(ctx, g.pts, true);
  ctx.clip();
  ctx.strokeStyle = grainPattern(ctx, color, 'crayon');
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.globalAlpha *= 0.75;
  const span = maxX - minX + maxY - minY;
  for (let t = -4; t < span + 8; t += 4.2) {
    ctx.beginPath();
    ctx.moveTo(minX + t + (r() - 0.5) * 3, minY - 4);
    ctx.lineTo(minX + t - (maxY - minY) - 8 + (r() - 0.5) * 3, maxY + 4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFill(ctx: CanvasRenderingContext2D, g: Geo, ft: FullTheme): void {
  if (!g.fill) return;
  const style = ft.stroke.style;
  const r = rng(g.seed ^ 0x55);
  ctx.save();
  if (style === 'neon') {
    ctx.fillStyle = rgba(g.color, 0.2);
    trace(ctx, g.pts, true);
    ctx.fill();
  } else if (style === 'watercolor') {
    for (let k = 0; k < 3; k++) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = g.fill;
      trace(ctx, shrinkToward(jitterPts(g.pts, r, 2.5), 0.97 + k * 0.025), true);
      ctx.fill();
    }
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = mix(g.fill, g.color, 0.4);
    ctx.lineWidth = 2.5;
    trace(ctx, g.pts, true);
    ctx.stroke();
  } else if (style === 'chalk') {
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = grainPattern(ctx, g.fill, 'chalk');
    trace(ctx, g.pts, true);
    ctx.fill();
  } else if (style === 'crayon') {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = g.fill;
    trace(ctx, g.pts, true);
    ctx.fill();
    ctx.globalAlpha = 1;
    hatch(ctx, g, g.fill, r);
  } else {
    ctx.fillStyle = g.fill;
    trace(ctx, g.pts, true);
    ctx.fill();
  }
  if (ft.stroke.halftone || (style === 'comic' && ft.stroke.halftone)) halftone(ctx, g, rgba(mix(g.fill, ft.palette.ink, 0.45), 0.35));
  ctx.restore();
}

// ---- strokes --------------------------------------------------------------------------------------

function strokeLine(ctx: CanvasRenderingContext2D, g: Geo, color: string | CanvasPattern, width: number): void {
  if (g.pts.length === 1) {
    dot(ctx, g.pts[0], width / 2, color);
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  trace(ctx, g.pts, g.closed);
  ctx.stroke();
}

function drawStroke(ctx: CanvasRenderingContext2D, g: Geo, ft: FullTheme, scale: number): void {
  const style = ft.stroke.style;
  const r = rng(g.seed ^ 0xa1);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (ft.stroke.glow && style !== 'neon') {
    ctx.shadowColor = g.color;
    ctx.shadowBlur = (g.width * 1.2 + 6) * scale;
  }
  switch (style) {
    case 'ink': {
      const c = mix(g.color, ft.palette.ink, 0.35);
      if (g.pts.length === 1 || g.closed) {
        strokeLine(ctx, g, c, g.width);
        break;
      }
      // taper: thin at both ends
      let total = 0;
      for (let i = 1; i < g.pts.length; i++) total += Math.hypot(g.pts[i][0] - g.pts[i - 1][0], g.pts[i][1] - g.pts[i - 1][1]);
      let run = 0;
      ctx.strokeStyle = c;
      for (let i = 1; i < g.pts.length; i++) {
        const a = g.pts[i - 1];
        const b = g.pts[i];
        const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const t = total > 0 ? (run + seg / 2) / total : 0.5;
        run += seg;
        ctx.lineWidth = g.width * (0.35 + 0.65 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.5));
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      break;
    }
    case 'neon': {
      ctx.shadowColor = g.color;
      ctx.shadowBlur = (g.width * 2 + 8) * scale;
      strokeLine(ctx, g, brighten(g.color, 0.2), g.width);
      ctx.shadowBlur = (g.width * 0.8 + 3) * scale;
      strokeLine(ctx, g, brighten(g.color, 0.2), g.width);
      ctx.shadowBlur = 0;
      strokeLine(ctx, g, mix(g.color, '#ffffff', 0.7), Math.max(1, g.width * 0.38));
      break;
    }
    case 'chalk': {
      const pat = grainPattern(ctx, g.color, 'chalk');
      for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([g.width * (2.5 + r() * 3), g.width * (0.3 + r() * 0.6)]);
        ctx.lineDashOffset = r() * 20;
        strokeLine(ctx, { ...g, pts: jitterPts(g.pts, r, g.width * 0.12) }, pat, g.width * (0.75 + k * 0.12));
      }
      ctx.setLineDash([]);
      break;
    }
    case 'crayon': {
      const pat = grainPattern(ctx, g.color, 'crayon');
      for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = 0.75;
        strokeLine(ctx, { ...g, pts: jitterPts(g.pts, r, g.width * 0.15) }, pat, g.width * (0.55 + k * 0.15));
      }
      break;
    }
    case 'watercolor': {
      ctx.globalAlpha = 0.5;
      strokeLine(ctx, g, g.color, g.width * 1.15);
      ctx.globalAlpha = 0.45;
      strokeLine(ctx, { ...g, pts: jitterPts(g.pts, r, 1.2) }, g.color, g.width * 0.7);
      break;
    }
    case 'comic':
    case 'marker':
    default:
      strokeLine(ctx, g, g.color, g.width);
      if (style === 'marker' && g.width >= 5 && g.pts.length > 1) {
        // a faint highlight down the middle of fat marker lines
        ctx.globalAlpha = 0.18;
        strokeLine(ctx, g, '#ffffff', g.width * 0.28);
      }
  }
  ctx.restore();
}

function outlinePass(ctx: CanvasRenderingContext2D, geo: Geo[], color: string, extra: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const g of geo) {
    if (g.closed && g.fill) {
      ctx.fillStyle = color;
      trace(ctx, g.pts, true);
      ctx.fill();
    }
    strokeLine(ctx, g, color, g.width + extra);
  }
  ctx.restore();
}

// ---- pixel style ----------------------------------------------------------------------------------

function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function renderPixel(ctx: CanvasRenderingContext2D, geo: Geo[], ft: FullTheme, scale: number): void {
  const widths = geo.map((g) => g.width).sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)] ?? 6;
  const cell = Math.max(4, Math.min(12, Math.round(median * 0.7)));
  const colors = new Map<string, string>(); // "i,j" → colour (later strokes on top)
  const order: string[] = [];
  const put = (i: number, j: number, c: string): void => {
    const k = `${i},${j}`;
    if (!colors.has(k)) order.push(k);
    colors.set(k, c);
  };
  for (const g of geo) {
    if (g.fill) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of g.pts) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      const shade = mix(g.fill, ft.palette.ink, 0.22);
      for (let j = Math.floor(minY / cell); j <= Math.floor(maxY / cell); j++) {
        for (let i = Math.floor(minX / cell); i <= Math.floor(maxX / cell); i++) {
          if (!pointInPoly((i + 0.5) * cell, (j + 0.5) * cell, g.pts)) continue;
          const below = pointInPoly((i + 0.5) * cell, (j + 1.5) * cell, g.pts);
          put(i, j, below ? g.fill : shade);
        }
      }
    }
    const rad = Math.max(cell * 0.5, g.width / 2);
    const stamp = (x: number, y: number): void => {
      for (let j = Math.floor((y - rad) / cell); j <= Math.floor((y + rad) / cell); j++) {
        for (let i = Math.floor((x - rad) / cell); i <= Math.floor((x + rad) / cell); i++) {
          if (Math.hypot((i + 0.5) * cell - x, (j + 0.5) * cell - y) <= rad + cell * 0.2) put(i, j, g.color);
        }
      }
    };
    const pts = g.closed ? [...g.pts, g.pts[0]] : g.pts;
    stamp(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(d / (cell * 0.5)));
      for (let s = 1; s <= n; s++) stamp(a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n);
    }
  }
  const outline = ft.stroke.outline;
  if (outline) {
    const ring = new Set<string>();
    for (const k of order) {
      const [i, j] = k.split(',').map(Number);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${i + di},${j + dj}`;
        if (!colors.has(nk)) ring.add(nk);
      }
    }
    ctx.fillStyle = outline;
    for (const k of ring) {
      const [i, j] = k.split(',').map(Number);
      ctx.fillRect(i * cell, j * cell, cell + 1 / scale, cell + 1 / scale);
    }
  }
  for (const k of order) {
    const [i, j] = k.split(',').map(Number);
    ctx.fillStyle = colors.get(k)!;
    ctx.fillRect(i * cell, j * cell, cell + 1 / scale, cell + 1 / scale);
  }
}

// ---- the renderer ---------------------------------------------------------------------------------

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.min(MAX_CANVAS, Math.ceil(w)));
  c.height = Math.max(2, Math.min(MAX_CANVAS, Math.ceil(h)));
  return c;
}

/** The drawing on a transparent canvas (see the header for sizing and the region option). Never throws. */
export function renderDrawing(d: Drawing, theme: StudioTheme | null, o: RenderOpts = {}): HTMLCanvasElement {
  const ft = fullTheme(theme);
  const scale = Number.isFinite(o.scale) && (o.scale as number) > 0 ? (o.scale as number) : 1;
  const pad = Number.isFinite(o.pad) ? Math.max(0, o.pad as number) : 8;
  const map = ft.recolor ? (o.recolorMap ?? null) : null;
  const reg = o.region;
  const key = `${generation}|${themeKey(ft)}|${scale}|${pad}|${ft.recolor ? mapKey(o.recolorMap) : ''}|${reg ? `${reg.x},${reg.y},${reg.w},${reg.h}` : ''}`;
  const holder = d && typeof d === 'object' ? d : null;
  if (holder) {
    const hit = cache.get(holder)?.get(key);
    if (hit) return hit;
  }
  let c: HTMLCanvasElement;
  try {
    c = paint(d, ft, scale, pad, map, reg);
  } catch {
    c = newCanvas(2, 2);
  }
  if (holder) {
    let m = cache.get(holder);
    if (!m) {
      m = new Map();
      cache.set(holder, m);
    }
    if (m.size >= 8) m.delete(m.keys().next().value as string);
    m.set(key, c);
  }
  return c;
}

function paint(d: Drawing, ft: FullTheme, scale: number, pad: number, map0: Map<string, string> | null,
  reg: RenderOpts['region']): HTMLCanvasElement {
  let map = map0;
  if (ft.recolor && !map) {
    // per-drawing mapping (callers with a whole game pass a game-wide one)
    map = buildRecolorMap([d], ft);
  }
  const geo = buildGeo(d, ft, map);
  let c: HTMLCanvasElement;
  let ox: number;
  let oy: number;
  if (reg) {
    c = newCanvas(reg.w * scale, reg.h * scale);
    ox = -reg.x * scale;
    oy = -reg.y * scale;
  } else {
    const ext = extentOf(geo, ft);
    const maxHalf = (MAX_CANVAS / 2 - pad) / scale;
    const ex = Math.min(ext.x, maxHalf);
    const ey = Math.min(ext.y, maxHalf);
    c = newCanvas(Math.ceil(ex * scale + pad) * 2, Math.ceil(ey * scale + pad) * 2);
    ox = c.width / 2;
    oy = c.height / 2;
  }
  (c as HTMLCanvasElement & { __origin?: { x: number; y: number } }).__origin = { x: ox, y: oy };
  if (!geo.length) return c;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  if (ft.stroke.style === 'pixel') {
    ctx.imageSmoothingEnabled = false;
    renderPixel(ctx, geo, ft, scale);
    return c;
  }
  const outline = ft.stroke.outline ?? (ft.stroke.style === 'comic' ? mix(ft.palette.ink, '#000000', 0.5) : null);
  const maxW = Math.max(...geo.map((g) => g.width));
  if (outline) outlinePass(ctx, geo, outline, Math.max(4, maxW * 0.5));
  for (const g of geo) {
    if (g.closed) drawFill(ctx, g, ft);
    drawStroke(ctx, g, ft, scale);
  }
  return c;
}
