/**
 * The three inks and every style id (PLAN_V2 §7.1, §7.3): kid marker (solid, canonical palette), designer pencil
 * (grain + 45° hatch at 85%, graphite-violet for neutral additions, red pencil with a dark outline for hazards) and
 * graphite / blue-line (≤ 30% contrast world, non-photo blue drafts).
 */
import type { InkColor, Origin, Theme } from '../types.gen.ts';
import { ART } from '../params.ts';
import type { ArtPath, ArtStyle } from './types.ts';
import { CELL, flat, rng, wobble, widths } from './geom.ts';
import type { V } from './geom.ts';

const P = ART.palette;
export const INK: Record<InkColor, string> = {
  black: P.ink, red: P.red, green: P.green, blue: P.blue, pencil: P.pencil_violet, draft: P.blue_line,
};
export const GRAPHITE = '#3B3632';
export const PAPER_WHITE = '#FFFDF6';
export const DARK_OUTLINE = '#2A2320';

function lighten(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number): number => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * f);
  return '#' + [ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Ink colour for a stroke colour class (or a '#rrggbb' house colour) and theme (kraft lightens ink 8%). */
export function inkHex(c: InkColor | string, theme: Theme): string {
  const base = /^#[0-9a-fA-F]{6}$/.test(c) ? c : (INK as Record<string, string>)[c] ?? P.ink;
  return theme === 'kraft' ? lighten(base, ART.themes.kraft.ink_lighten) : base;
}

export type InkFor = 'marker' | 'pencil' | 'blue_line';

/** Which ink draws an object of this origin (I5: every designer addition is pencil). */
export function inkForOrigin(o: Origin | null | undefined): InkFor {
  if (o === 'designer') return 'pencil';
  if (o === 'draft') return 'blue_line';
  return 'marker';
}

export class StyleBook {
  readonly styles: Record<string, ArtStyle> = {};
  readonly theme: Theme;
  constructor(theme: Theme) {
    this.theme = theme;
  }

  private put(key: string, s: ArtStyle): string {
    this.styles[key] ??= s;
    return key;
  }

  marker(c: InkColor | string): string {
    const hex = inkHex(c, this.theme);
    return this.put(`marker:${hex}`, { stroke: hex, ink: 'marker' });
  }
  /** A filled marker blob (kind "blob"): solid colour inside its outline. */
  blob(c: InkColor | string): string {
    const hex = inkHex(c, this.theme);
    return this.put(`blob:${hex}`, { fill: hex, fill_opacity: 0.92, ink: 'marker' });
  }
  /** Paper fill inside a closed creature outline so the sprite reads as one solid character. */
  sticker(): string {
    return this.put('sticker', { fill: PAPER_WHITE, fill_opacity: 0.9, ink: 'marker' });
  }
  wash(c: InkColor | string): string {
    const hex = inkHex(c, this.theme);
    // decoration layer is composited at 55%: 0.364 × 0.55 = the 20% watercolour wash of §7.1 rule 3
    return this.put(`wash:${hex}`, { fill: hex, fill_opacity: ART.decoration_wash / ART.decoration_opacity, ink: 'marker' });
  }
  sign(): string {
    return this.put('sign', { stroke: GRAPHITE, ink: 'graphite' });
  }
  pencil(hex: string): string {
    return this.put(`pencil:${hex}`, { stroke: hex, opacity: ART.pencil.opacity, ink: 'pencil' });
  }
  pencilGrain(hex: string): string {
    return this.put(`pgrain:${hex}`, { stroke: hex, width: 0.9, opacity: 0.45, ink: 'pencil', cap: 'round' });
  }
  pencilFill(hex: string): string {
    return this.put(`pfill:${hex}`, {
      fill: hex, fill_opacity: 0.1, opacity: ART.pencil.opacity, ink: 'pencil',
      hatch: { angle_deg: ART.pencil.hatch_deg, spacing_px: 3, width_px: 0.9, alpha: 0.55, color: hex },
    });
  }
  darkOutline(): string {
    return this.put('dark_outline', { stroke: DARK_OUTLINE, opacity: 0.9, ink: 'pencil' });
  }
  blueLine(): string {
    return this.put('blue_line', { stroke: P.blue_line, width: 2, ink: 'blue_line', cap: 'round' });
  }
  line(key: string, s: Omit<ArtStyle, 'ink'> & { ink?: ArtStyle['ink'] }): string {
    return this.put(key, { ink: 'graphite', ...s });
  }
}

/** Shared fixed styles used by terrain, entities and parallax. */
export function baseStyles(b: StyleBook): void {
  const red = inkHex('red', b.theme);
  const blue = inkHex('blue', b.theme);
  b.line('ground_tint', { fill: P.paper_tint, fill_opacity: ART.ground_hatch.tint_alpha });
  b.line('ground_hatch', {
    hatch: { angle_deg: 45, spacing_px: ART.ground_hatch.spacing_px, width_px: ART.ground_hatch.width_px, alpha: ART.ground_hatch.alpha, color: P.ink },
  });
  b.line('hatch_light', { hatch: { angle_deg: 45, spacing_px: ART.ground_hatch.spacing_px, width_px: 1, alpha: 0.18, color: P.ink } });
  b.line('edge_faint', { stroke: GRAPHITE, width: 1.2, opacity: 0.35, cap: 'round' });
  b.line('oneway_dot', { fill: GRAPHITE, fill_opacity: 0.5 });
  b.line('lava_fill', { fill: red, fill_opacity: 0.88, hatch: { angle_deg: -30, spacing_px: 5, width_px: 1.2, alpha: 0.3, color: '#8E1F18' }, ink: 'marker' });
  b.line('legacy_hazard', { fill: P.spike_fill, fill_opacity: 1, hatch: { angle_deg: 45, spacing_px: 4, width_px: 1.2, alpha: 0.6, color: red }, ink: 'marker' });
  b.line('legacy_outline', { stroke: red, width: 1.8, ink: 'marker' });
  b.line('abyss', { stroke: GRAPHITE, width: 1.4, opacity: 0.55, cap: 'round' });
  b.line('spike_fill', { fill: P.spike_fill, fill_opacity: 1, ink: 'marker' });
  b.line('spike_outline', { stroke: red, width: 1.8, ink: 'marker', cap: 'round' });
  b.line('spike_pencil_fill', { fill: P.spike_fill, fill_opacity: 0.85, hatch: { angle_deg: 45, spacing_px: 3, width_px: 0.9, alpha: 0.6, color: red }, ink: 'pencil' });
  b.line('coin_ring', { stroke: blue, width: 2.2, ink: 'marker', cap: 'round' });
  b.line('coin_fill', { fill: blue, fill_opacity: 0.16, ink: 'marker' });
  b.line('coin_shine', { stroke: PAPER_WHITE, width: 1.4, opacity: 0.95, ink: 'marker', cap: 'round' });
  b.line('star_fill', { fill: '#FFD86B', fill_opacity: 0.9, ink: 'marker' });
  b.line('far0', { stroke: GRAPHITE, width: 1.8, opacity: 0.2, cap: 'round' });
  b.line('far1', { stroke: GRAPHITE, width: 1.6, opacity: 0.15, cap: 'round' });
  b.line('far2', { stroke: GRAPHITE, width: 1.4, opacity: 0.11, cap: 'round' });
  b.line('far_wash', { fill: GRAPHITE, fill_opacity: 0.035 });
  b.line('cloud', { stroke: GRAPHITE, width: 1.4, opacity: 0.22, fill: PAPER_WHITE, fill_opacity: 0.55, cap: 'round' });
  b.line('mid', { stroke: GRAPHITE, width: 1.5, opacity: 0.24, cap: 'round' });
  b.line('mid_wash', { fill: P.green, fill_opacity: 0.07 });
  b.line('tuft', { stroke: GRAPHITE, width: 1.3, opacity: 0.3, cap: 'round' });
  b.line('fire_core', { fill: '#FFB347', fill_opacity: 1, stroke: red, width: 1.6, ink: 'marker' });
}

// ---- emitting strokes as ArtPaths ------------------------------------------------------------------

export interface EmitExtra {
  object_id?: string;
  part?: ArtPath['part'];
  pivot?: [number, number];
}

export function emitMarker(out: ArtPath[], v: V[], closed: boolean, style: string, x: EmitExtra = {}): void {
  if (!v.length) return;
  out.push({ pts: flat(v), w: widths(v), closed, style, ...x });
}

export function emitFill(out: ArtPath[], v: V[], style: string, x: EmitExtra = {}): void {
  if (v.length < 3) return;
  out.push({ pts: flat(v), closed: true, style, ...x });
}

/** A pencil line: a thinner main pass plus a jittered grain pass (and a hatched fill for closed shapes). */
export function emitPencil(out: ArtPath[], b: StyleBook, v: V[], closed: boolean, hex: string, seed: number, x: EmitExtra = {}, fill = true): void {
  if (!v.length) return;
  const r = rng(seed);
  if (closed && fill && v.length >= 3) emitFill(out, v, b.pencilFill(hex), x);
  const main: V[] = v.map((p) => [p[0], p[1], Math.max(1.6, p[2] * 0.55)]);
  emitMarker(out, main, closed, b.pencil(hex), x);
  if (v.length >= 2) {
    const grain = wobble(v.map((p) => [p[0], p[1], 0.9] as V), 0.55, r, 0.6);
    out.push({ pts: flat(grain), closed, style: b.pencilGrain(hex), ...x });
  }
}

/** A blue-line draft stroke with a seeded wobble. */
export function emitBlueLine(out: ArtPath[], b: StyleBook, v: V[], closed: boolean, seed: number, x: EmitExtra = {}): void {
  if (!v.length) return;
  const w = wobble(v, 0.6, rng(seed), 1.2);
  out.push({ pts: flat(w), closed, style: b.blueLine(), ...x });
}

/** Constant-width polyline helper for house doodles (widths in px). */
export function poly(pts: [number, number][], wPx: number): V[] {
  return pts.map((p) => [p[0], p[1], wPx] as V);
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, n: number, wPx: number, bump = 0, phase = 0): V[] {
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    const k = 1 + bump * Math.sin(a * 5 + 1.3);
    out.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k, wPx]);
  }
  return out;
}

export const PX = 1 / CELL;
