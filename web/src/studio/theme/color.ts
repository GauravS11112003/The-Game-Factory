/**
 * Colour helpers and the theme's palette logic (docs/v6/CONTRACTS_V6.md §4.3): parsing, mixing, contrast, the full
 * theme with defaults (`fullTheme`), the recolour map (distinct stroke colours → palette, in order of first use) and the
 * fill colour a closed stroke gets (`fillFor`). Pure: no DOM, testable in node.
 */
import type { Drawing, GameDoc, StudioTheme } from '../../core/types.gen.ts';
import { hashNums } from './rng.ts';

export type RGB = [number, number, number];

export function parseHex(hex: unknown): RGB | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: RGB): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** A valid #rrggbb (lower case) or the fallback. */
export function hexOr(hex: unknown, fallback: string): string {
  const c = parseHex(hex);
  return c ? toHex(c) : fallback;
}

export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a) ?? [0, 0, 0];
  const y = parseHex(b) ?? [0, 0, 0];
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

/** 0xRRGGBB for Phaser. */
export function hexNum(hex: string): number {
  const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
  return (r << 16) | (g << 8) | b;
}

/** WCAG relative luminance 0..1. */
export function luminance(hex: string): number {
  const c = parseHex(hex) ?? [0, 0, 0];
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.18;
}

/** [h 0..360, s 0..1, l 0..1] */
export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((v) => v / 255) as RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): string {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** Brighter, more saturated version (neon cores). */
export function brighten(hex: string, t = 0.3): string {
  const [h, s, l] = toHsl(hex);
  return fromHsl(h, Math.min(1, s + t * 0.5), Math.min(0.92, l + t * 0.5));
}

// ---- the theme with every field filled -----------------------------------------------------------

export interface FullPalette {
  bg: string;
  ink: string;
  accent: string;
  accent2: string;
  text: string;
  danger: string;
  good: string;
  [k: string]: string;
}

export interface FullTheme {
  id: string;
  name: string;
  palette: FullPalette;
  background: { style: NonNullable<NonNullable<StudioTheme['background']>['style']>; colors: string[]; parallax: boolean };
  stroke: {
    style: NonNullable<NonNullable<StudioTheme['stroke']>['style']>;
    outline: string | null;
    width_scale: number;
    glow: boolean;
    fill_closed: boolean;
    halftone: boolean;
    wobble: number;
  };
  recolor: boolean;
  particles: NonNullable<StudioTheme['particles']>;
  font: NonNullable<StudioTheme['font']>;
  music: NonNullable<StudioTheme['music']>;
}

export const SKETCHBOOK_PALETTE: FullPalette = {
  bg: '#f6f1e7', ink: '#1f1b18', accent: '#e4572e', accent2: '#2e86ab', text: '#1f1b18', danger: '#d7263d', good: '#3bb273',
};

const STROKE_STYLES = ['ink', 'marker', 'neon', 'pixel', 'chalk', 'comic', 'crayon', 'watercolor'] as const;
const BG_STYLES = ['paper', 'solid', 'gradient', 'stars', 'grid', 'city', 'hills', 'clouds', 'neon_grid', 'halftone', 'waves',
  'dunes', 'forest', 'space'] as const;
const PARTICLES = ['none', 'dust', 'sparks', 'stars', 'bubbles', 'confetti', 'embers', 'snow'] as const;
const FONTS = ['hand', 'comic', 'pixel', 'clean', 'serif'] as const;
const MUSIC = ['none', 'calm', 'upbeat', 'spooky', 'heroic', 'chiptune', 'racing'] as const;

function pick<T extends string>(v: unknown, list: readonly T[], d: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d;
}

function num(v: unknown, d: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.max(lo, Math.min(hi, n));
}

const fullCache = new WeakMap<object, FullTheme>();

/** Any (partial, null, broken) theme → a complete one with Sketchbook defaults. Cached per theme object. */
export function fullTheme(t: StudioTheme | null | undefined): FullTheme {
  if (t && typeof t === 'object') {
    const hit = fullCache.get(t);
    if (hit) return hit;
  }
  const src = (t && typeof t === 'object' ? t : {}) as StudioTheme;
  const p = (src.palette && typeof src.palette === 'object' ? src.palette : {}) as Record<string, unknown>;
  const palette: FullPalette = { ...SKETCHBOOK_PALETTE };
  for (const [k, v] of Object.entries(p)) {
    const c = parseHex(v);
    if (c) palette[k] = toHex(c);
  }
  if (!parseHex(p.text)) palette.text = palette.ink;
  const bg = (src.background ?? {}) as Record<string, unknown>;
  const st = (src.stroke ?? {}) as Record<string, unknown>;
  const out: FullTheme = {
    id: typeof src.id === 'string' ? src.id : 'custom',
    name: typeof src.name === 'string' ? src.name : 'Sketchbook',
    palette,
    background: {
      style: pick(bg.style, BG_STYLES, 'paper'),
      colors: Array.isArray(bg.colors) ? (bg.colors as unknown[]).map((c) => parseHex(c)).filter((c): c is RGB => !!c).map(toHex) : [],
      parallax: bg.parallax !== false,
    },
    stroke: {
      style: pick(st.style, STROKE_STYLES, 'marker'),
      outline: parseHex(st.outline) ? toHex(parseHex(st.outline)!) : null,
      width_scale: num(st.width_scale, 1, 0.2, 4),
      glow: st.glow === true,
      fill_closed: st.fill_closed !== false,
      halftone: st.halftone === true,
      wobble: num(st.wobble, 0, 0, 1),
    },
    recolor: src.recolor === true,
    particles: pick(src.particles, PARTICLES, 'dust'),
    font: pick(src.font, FONTS, 'hand'),
    music: pick(src.music, MUSIC, 'upbeat'),
  };
  if (t && typeof t === 'object') fullCache.set(t, out);
  return out;
}

/** CSS font stack for a theme font. */
export function fontStack(font: FullTheme['font']): string {
  switch (font) {
    case 'comic': return "'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', 'Patrick Hand', cursive";
    case 'pixel': return "'Press Start 2P', 'VT323', ui-monospace, 'Courier New', monospace";
    case 'clean': return "'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    case 'serif': return "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
    default: return "'Patrick Hand', 'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', system-ui, sans-serif";
  }
}

// ---- recolour and fills --------------------------------------------------------------------------

/** The palette colours strokes can be mapped to, in order: ink, accent, accent2, good, danger, then any extra keys. */
export function strokePalette(theme: FullTheme): string[] {
  const p = theme.palette;
  const order = [p.ink, p.accent, p.accent2, p.good, p.danger];
  for (const [k, v] of Object.entries(p)) if (!['bg', 'ink', 'accent', 'accent2', 'good', 'danger', 'text'].includes(k)) order.push(v);
  const seen = new Set<string>();
  return order.filter((c) => (seen.has(c) ? false : (seen.add(c), true)));
}

/** Colourful palette entries for fills of dark-pen shapes (everything except ink, bg and text). */
export function fillPalette(theme: FullTheme): string[] {
  const p = theme.palette;
  const out = [p.accent, p.accent2, p.good, p.danger];
  for (const [k, v] of Object.entries(p)) if (!['bg', 'ink', 'accent', 'accent2', 'good', 'danger', 'text'].includes(k)) out.push(v);
  return out;
}

function normHex(c: unknown): string | null {
  const v = parseHex(c);
  return v ? toHex(v) : null;
}

/**
 * The recolour map: every distinct stroke colour (in order of first use across the drawings, strokes then fills) →
 * the palette colour at the same position (cycling). Pass every drawing of a game so the mapping is game-wide.
 */
export function buildRecolorMap(drawings: Iterable<Drawing | null | undefined>, theme: FullTheme): Map<string, string> {
  const pal = strokePalette(theme);
  const map = new Map<string, string>();
  const list = [...drawings];
  for (const d of list) {
    for (const s of d?.strokes ?? []) {
      const c = normHex(s?.color ?? '#1f1b18');
      if (c && !map.has(c)) map.set(c, pal[map.size % pal.length]);
    }
  }
  // fills that are not also stroke colours follow (very light ones keep their lightness, see fillFor)
  for (const d of list) {
    for (const s of d?.strokes ?? []) {
      const c = normHex(s?.fill);
      if (c && !map.has(c) && !(isAchromatic(c) && luminance(c) > 0.6)) map.set(c, pal[map.size % pal.length]);
    }
  }
  return map;
}

/** Every drawing in a doc (all scenes, templates included), in document order. */
export function docDrawings(doc: GameDoc | null | undefined): Drawing[] {
  const out: Drawing[] = [];
  for (const sc of doc?.scenes ?? []) for (const o of sc?.objects ?? []) if (o?.drawing) out.push(o.drawing);
  return out;
}

/** Is this colour close to grey (a pencil or black pen)? */
export function isAchromatic(hex: string): boolean {
  const [, s, l] = toHsl(hex);
  return s < 0.18 || l < 0.12 || l > 0.94;
}

/**
 * The fill a closed stroke without its own fill gets: a tint of its (mapped) stroke colour toward the background; dark
 * or grey pens get a colourful palette entry picked stably by `seed`, so a black-pen sketch still becomes colourful.
 */
export function fillFor(strokeColor: string, theme: FullTheme, seed: number): string {
  const bg = theme.palette.bg;
  const darkBg = isDark(bg);
  if (isAchromatic(strokeColor)) {
    const pal = fillPalette(theme);
    const c = pal[hashNums(seed) % pal.length];
    return darkBg ? mix(c, bg, 0.35) : mix(c, '#ffffff', 0.12);
  }
  return darkBg ? mix(strokeColor, bg, 0.55) : mix(strokeColor, bg, 0.42);
}

/** An explicit fill under recolour: its mapped colour as a soft tint; whites and pale greys stay pale. */
export function recolorFill(fill: string, map: Map<string, string>, theme: FullTheme, strokeColor: string, seed: number): string {
  const f = normHex(fill) ?? '#ffffff';
  if (isAchromatic(f) && luminance(f) > 0.6) return isDark(theme.palette.bg) ? mix(theme.palette.bg, '#ffffff', 0.25) : mix(f, theme.palette.bg, 0.2);
  const m = map.get(f);
  if (!m) return fillFor(strokeColor, theme, seed);
  return isDark(theme.palette.bg) ? mix(m, theme.palette.bg, 0.45) : mix(m, '#ffffff', 0.25);
}

/** Mapped stroke colour under the theme (recolour on), else the stroke's own colour. */
export function mapColor(c: unknown, map: Map<string, string> | null): string {
  const h = normHex(c) ?? '#1f1b18';
  return map?.get(h) ?? h;
}
