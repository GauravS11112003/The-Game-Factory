/**
 * House art for the v4 entities (docs/v4/CONTRACTS_V4.md §5), in the same living-ink-on-paper hand as the v2 doodles:
 * marker lines with a paper or colour fill, pencil for designer additions.
 * - portal: a swirl in its pair's colour (both ends of a pair share one colour; a lone portal is graphite);
 * - zone: a translucent wash with a dashed edge and its effect's glyph (wind / conveyor arrows toward `dir`, water
 *   waves, an ice sparkle, low-gravity floating dots, a slow snail spiral);
 * - pickup: a little doodle chosen by its item name (star, heart, gem, mushroom, apple, potion, bolt, feather,
 *   flower, snowflake; a gift for anything else);
 * - npc: a friendly bean with a sprout and a "…" speech bubble.
 * Paths the engine animates itself (a zone's glyph, an npc's bubble) are tagged `part: 'shine'`.
 */
import type { Dir4, Entity, ZoneEffect } from '../types.gen.ts';
import type { ArtPath } from './types.ts';
import { clamp, hash32, starPts } from './geom.ts';
import type { V } from './geom.ts';
import { ellipse, emitFill, emitMarker, emitPencil, inkHex, poly, StyleBook } from './styles.ts';
import type { EmitExtra, InkFor } from './styles.ts';

/** A pair's colour, shared by both of its portals. */
export const PORTAL_COLORS = ['#2C7BE5', '#6A5ACD', '#3E9E4F', '#F08A24', '#D9468F', '#14A3A3'] as const;
export const PORTAL_LONE = '#8A817A';

/** Portal id → colour: each pair in level order takes the next colour, so pairs differ (up to six of them). */
export function portalColors(entities: readonly Entity[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = new Set(entities.filter((e) => e.type === 'portal').map((e) => e.id));
  let n = 0;
  for (const e of entities) {
    if (e.type !== 'portal' || out.has(e.id)) continue;
    const pair = e.pair && ids.has(e.pair) && e.pair !== e.id ? e.pair : null;
    if (!pair) {
      out.set(e.id, PORTAL_LONE);
      continue;
    }
    const c = PORTAL_COLORS[n++ % PORTAL_COLORS.length];
    out.set(e.id, c);
    if (!out.has(pair)) out.set(pair, c);
  }
  return out;
}

export const ZONE_LOOK: Record<ZoneEffect, { fill: string; alpha: number; line: string }> = {
  wind: { fill: '#8FB8DE', alpha: 0.12, line: '#5E8FBF' },
  water: { fill: '#2C7BE5', alpha: 0.22, line: '#2C7BE5' },
  ice: { fill: '#9AD8F2', alpha: 0.28, line: '#3E9ACB' },
  low_gravity: { fill: '#6A5ACD', alpha: 0.12, line: '#6A5ACD' },
  conveyor: { fill: '#3B3632', alpha: 0.1, line: '#3B3632' },
  slow: { fill: '#8B6B3E', alpha: 0.22, line: '#7A5A30' },
};

export type PickupShape = 'star' | 'heart' | 'gem' | 'mushroom' | 'apple' | 'potion' | 'bolt' | 'feather' | 'flower' | 'snowflake' | 'gift';

/** The doodle for a pickup's item name ("star" by default). */
export function pickupShape(item: string | null | undefined): PickupShape {
  const s = (item ?? 'star').toLowerCase();
  const has = (...w: string[]): boolean => w.some((x) => s.includes(x));
  if (has('star')) return 'star';
  if (has('heart', 'life', 'love')) return 'heart';
  if (has('gem', 'diamond', 'crystal', 'jewel', 'ruby')) return 'gem';
  if (has('mushroom', 'shroom')) return 'mushroom';
  if (has('apple', 'fruit', 'cherry', 'berry', 'banana', 'food', 'cake', 'cookie')) return 'apple';
  if (has('potion', 'bottle', 'drink', 'juice', 'elixir')) return 'potion';
  if (has('bolt', 'lightning', 'zap', 'energy', 'battery', 'power', 'speed', 'fast')) return 'bolt';
  if (has('feather', 'wing', 'jump', 'float')) return 'feather';
  if (has('flower', 'rose', 'daisy', 'petal')) return 'flower';
  if (has('snow', 'ice', 'freeze', 'frost', 'cold')) return 'snowflake';
  return 'gift';
}

// ---- emitting ---------------------------------------------------------------------------------------------------

interface Line {
  v: V[];
  closed: boolean;
  color: string; // ink name or '#rrggbb'
  fill?: 'sticker' | 'blob' | 'soft' | 'none';
  part?: ArtPath['part'];
}

/** Lines in the right ink: marker with a paper / colour fill, or pencil (grain, hatch) for designer additions. */
function emitLines(out: ArtPath[], b: StyleBook, lines: Line[], ink: InkFor, seed: number, x: EmitExtra = {}): void {
  lines.forEach((l, i) => {
    const extra = { ...x, ...(l.part ? { part: l.part } : {}) };
    const isDot = l.v.length === 1;
    const name = l.color === 'black' && ink === 'pencil' ? 'pencil' : l.color;
    const hex = inkHex(name, b.theme);
    if (l.closed && !isDot && l.fill === 'soft') emitFill(out, l.v, b.line(`soft:${hex}`, { fill: hex, fill_opacity: 0.2, ink: 'marker' }), extra);
    if (ink === 'pencil') {
      if (isDot) emitMarker(out, l.v, true, b.pencil(hex), extra);
      else {
        if (l.closed && (l.fill === 'sticker' || l.fill === 'blob')) emitFill(out, l.v, l.fill === 'blob' ? b.pencilFill(hex) : b.sticker(), extra);
        emitPencil(out, b, l.v, l.closed, hex, seed + i * 7, extra, false);
      }
      return;
    }
    // marker() and blob() take the colour name (or '#hex') and apply the theme themselves
    if (l.closed && !isDot && l.fill === 'blob') emitFill(out, l.v, b.blob(name), extra);
    if (l.closed && !isDot && l.fill === 'sticker') emitFill(out, l.v, b.sticker(), extra);
    emitMarker(out, l.v, l.closed, b.marker(name), extra);
  });
}

const flatToV = (pts: number[], w: number): V[] => {
  const v: V[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) v.push([pts[i], pts[i + 1], w]);
  return v;
};

/** Rotate local points (about c) so "right" points along dir (y down). */
function toward(dir: Dir4 | undefined, c: [number, number]): (p: [number, number]) => [number, number] {
  return ([x, y]) => {
    const dx = x - c[0];
    const dy = y - c[1];
    switch (dir) {
      case 'left':
        return [c[0] - dx, c[1] + dy];
      case 'up':
        return [c[0] + dy, c[1] - dx];
      case 'down':
        return [c[0] - dy, c[1] + dx];
      default:
        return [x, y];
    }
  };
}

function wavy(x0: number, x1: number, y: number, amp: number, periods: number, n = 14): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([x0 + (x1 - x0) * t, y + Math.sin(t * Math.PI * 2 * periods) * amp]);
  }
  return out;
}

function spiral(cx: number, cy: number, r0: number, r1: number, turns: number, n = 28): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * turns * Math.PI * 2;
    const r = r0 + (r1 - r0) * t;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

// ---- portal -----------------------------------------------------------------------------------------------------

/** A swirl portal (centre anchor, radius 0.75 cells). With the kid's own drawing only the coloured ring is added. */
export function portalArt(out: ArtPath[], b: StyleBook, color: string, ink: InkFor, seed: number, ringOnly = false): void {
  const lines: Line[] = [{ v: ellipse(0, 0, 0.74, 0.74, 26, 2.6, 0.03), closed: true, color, fill: 'soft' }];
  if (!ringOnly) {
    // two interleaved spiral arms (the engine spins the whole swirl)
    for (const ph of [0, Math.PI]) {
      const arm = spiral(0, 0, 0.06, 0.58, 1.15).map(([x, y]) => [x * Math.cos(ph) - y * Math.sin(ph), x * Math.sin(ph) + y * Math.cos(ph)] as [number, number]);
      lines.push({ v: arm.map((p, i) => [p[0], p[1], 1.4 + (2.4 * i) / arm.length] as V), closed: false, color });
    }
    lines.push({ v: [[0, 0, 3.6]], closed: true, color: 'black' });
  }
  emitLines(out, b, lines, ink, seed);
}

// ---- zone -------------------------------------------------------------------------------------------------------

/** A zone: wash + dashed edge over its box (local 0..w × 0..h), the effect's glyph in the middle (`part: 'shine'`). */
export function zoneArt(out: ArtPath[], b: StyleBook, e: { w: number; h: number; effect: ZoneEffect; dir?: Dir4 }, ink: InkFor, seed: number, glyph = true): void {
  const look = ZONE_LOOK[e.effect] ?? ZONE_LOOK.wind;
  const w = Math.max(0.5, e.w);
  const h = Math.max(0.5, e.h);
  const fill = inkHex(look.fill, b.theme);
  const line = inkHex(look.line, b.theme);
  out.push({ pts: [0, 0, w, 0, w, h, 0, h], closed: true, style: b.line(`zone_fill:${e.effect}:${fill}`, { fill, fill_opacity: look.alpha, ink: ink === 'pencil' ? 'pencil' : 'marker' }) });
  // a rounded, dashed edge (constant width, so the dash applies)
  const r = Math.min(0.3, w / 4, h / 4);
  const edge: number[] = [];
  const corner = (cx: number, cy: number, a0: number): void => {
    for (let i = 0; i <= 4; i++) {
      const a = a0 + (i / 4) * (Math.PI / 2);
      edge.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  corner(w - r, r, -Math.PI / 2);
  corner(w - r, h - r, 0);
  corner(r, h - r, Math.PI / 2);
  corner(r, r, Math.PI);
  out.push({ pts: edge, closed: true, style: b.line(`zone_edge:${line}`, { stroke: line, width: 1.5, opacity: 0.7, dash: [5, 4], cap: 'round' }) });
  if (glyph) emitLines(out, b, zoneGlyph(e.effect, e.dir, w, h, line), ink, seed, { part: 'shine' });
}

function zoneGlyph(effect: ZoneEffect, dir: Dir4 | undefined, w: number, h: number, color: string): Line[] {
  const c: [number, number] = [w / 2, h / 2];
  const s = clamp(Math.min(w, h) * 0.42, 0.35, 1.1);
  const rot = toward(dir ?? 'right', c);
  const L = (pts: [number, number][], width = 2.2, closed = false, turn = false): Line => ({ v: poly(turn ? pts.map(rot) : pts, width), closed, color });
  switch (effect) {
    case 'wind':
      return [
        L(wavy(c[0] - s, c[0] + s * 0.6, c[1] - s * 0.38, s * 0.07, 1.5), 2, false, true),
        L(wavy(c[0] - s * 0.8, c[0] + s * 0.85, c[1], s * 0.07, 1.5), 2, false, true),
        L(wavy(c[0] - s, c[0] + s * 0.5, c[1] + s * 0.38, s * 0.07, 1.5), 2, false, true),
        L([[c[0] + s * 0.6, c[1] - s * 0.22], [c[0] + s * 0.88, c[1]], [c[0] + s * 0.6, c[1] + s * 0.22]], 2.2, false, true),
      ];
    case 'conveyor':
      return [-0.6, 0, 0.6].map((k) => L([[c[0] + s * (k - 0.18), c[1] - s * 0.28], [c[0] + s * (k + 0.12), c[1]], [c[0] + s * (k - 0.18), c[1] + s * 0.28]], 2.6, false, true));
    case 'water':
      return [
        L(wavy(c[0] - s, c[0] + s, c[1] - s * 0.22, s * 0.12, 2), 2.2),
        L(wavy(c[0] - s * 0.8, c[0] + s * 0.8, c[1] + s * 0.26, s * 0.12, 1.6), 2.2),
      ];
    case 'ice': {
      const out: Line[] = [];
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3 + Math.PI / 2;
        const dx = Math.cos(a) * s * 0.6;
        const dy = Math.sin(a) * s * 0.6;
        out.push(L([[c[0] - dx, c[1] - dy], [c[0] + dx, c[1] + dy]], 2));
      }
      out.push({ v: [[c[0], c[1], 4]], closed: true, color });
      return out;
    }
    case 'low_gravity':
      return [
        L([[c[0] - s * 0.35, c[1] - s * 0.3], [c[0], c[1] - s * 0.62], [c[0] + s * 0.35, c[1] - s * 0.3]], 2.2),
        { v: [[c[0] - s * 0.4, c[1] + s * 0.05, 4.2]], closed: true, color },
        { v: [[c[0] + s * 0.25, c[1] + s * 0.2, 3.2]], closed: true, color },
        { v: [[c[0] - s * 0.05, c[1] + s * 0.5, 5]], closed: true, color },
      ];
    case 'slow':
      return [
        L(spiral(c[0], c[1] - s * 0.1, 0.02, s * 0.42, 1.6), 2.2),
        L([[c[0] - s * 0.7, c[1] + s * 0.38], [c[0] + s * 0.75, c[1] + s * 0.38]], 2.4),
      ];
    default:
      return [];
  }
}

// ---- pickup -----------------------------------------------------------------------------------------------------

/** A pickup's doodle by item (centre anchor, about one cell across). */
export function pickupArt(out: ArtPath[], b: StyleBook, item: string | null | undefined, ink: InkFor, seed: number): void {
  const gold = '#E39B1B';
  const lines: Line[] = [];
  switch (pickupShape(item)) {
    case 'star': {
      const s = starPts(0, 0, 0.5, 0.46);
      out.push({ pts: s, closed: true, style: 'star_fill' });
      lines.push({ v: flatToV(s, 2.4), closed: true, color: gold });
      lines.push({ v: poly([[-0.16, -0.12], [-0.06, -0.2]], 1.4), closed: false, color: '#FFFDF6' });
      break;
    }
    case 'heart': {
      const v: V[] = [];
      for (let i = 0; i < 24; i++) {
        const t = (i / 24) * Math.PI * 2;
        const x = 16 * Math.sin(t) ** 3;
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        v.push([(x / 16) * 0.46, (y / 16) * 0.46 - 0.04, 2.4]);
      }
      lines.push({ v, closed: true, color: 'red', fill: 'blob' });
      break;
    }
    case 'gem':
      lines.push({ v: poly([[-0.44, -0.12], [-0.22, -0.4], [0.22, -0.4], [0.44, -0.12], [0, 0.44]], 2.4), closed: true, color: 'blue', fill: 'soft' });
      lines.push({ v: poly([[-0.44, -0.12], [0.44, -0.12]], 1.6), closed: false, color: 'blue' });
      lines.push({ v: poly([[-0.14, -0.12], [0, 0.44], [0.14, -0.12]], 1.4), closed: false, color: 'blue' });
      break;
    case 'mushroom':
      lines.push({ v: poly([[-0.16, 0], [-0.18, 0.42], [0.18, 0.42], [0.16, 0]], 2.2), closed: true, color: 'black', fill: 'sticker' });
      lines.push({ v: [...ellipse(0, 0.02, 0.48, 0.42, 20, 2.4).filter((p) => p[1] <= 0.03)], closed: true, color: 'red', fill: 'blob' });
      lines.push({ v: [[-0.2, -0.18, 4.4]], closed: true, color: '#FFFDF6' });
      lines.push({ v: [[0.18, -0.24, 3.6]], closed: true, color: '#FFFDF6' });
      break;
    case 'apple':
      lines.push({ v: ellipse(0, 0.06, 0.4, 0.38, 20, 2.4, 0.04), closed: true, color: 'red', fill: 'blob' });
      lines.push({ v: poly([[0, -0.3], [0.04, -0.48]], 2), closed: false, color: 'black' });
      lines.push({ v: ellipse(0.17, -0.42, 0.13, 0.06, 10, 1.8), closed: true, color: 'green', fill: 'blob' });
      break;
    case 'potion':
      lines.push({ v: ellipse(0, 0.14, 0.34, 0.32, 18, 2.4), closed: true, color: 'black', fill: 'sticker' });
      lines.push({ v: ellipse(0, 0.22, 0.27, 0.2, 14, 1), closed: true, color: 'pencil', fill: 'soft' });
      lines.push({ v: poly([[-0.1, -0.16], [-0.1, -0.36], [0.1, -0.36], [0.1, -0.16]], 2.2), closed: false, color: 'black' });
      lines.push({ v: poly([[-0.13, -0.42], [0.13, -0.42]], 3.2), closed: false, color: '#8B6B3E' });
      break;
    case 'bolt': {
      const v = poly([[0.1, -0.5], [-0.3, 0.06], [-0.02, 0.06], [-0.12, 0.5], [0.3, -0.08], [0.02, -0.08]], 2.4);
      emitFill(out, v, b.line('bolt_fill', { fill: '#FFD86B', fill_opacity: 0.95, ink: 'marker' }));
      lines.push({ v, closed: true, color: gold });
      break;
    }
    case 'feather':
      lines.push({ v: poly([[0.36, -0.42], [0.1, -0.3], [-0.2, 0.02], [-0.32, 0.3], [-0.1, 0.16], [0.18, -0.08]], 2.2), closed: true, color: 'blue', fill: 'soft' });
      lines.push({ v: poly([[0.36, -0.42], [-0.4, 0.42]], 1.6), closed: false, color: 'blue' });
      break;
    case 'flower':
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k / 5) * Math.PI * 2;
        lines.push({ v: ellipse(Math.cos(a) * 0.24, Math.sin(a) * 0.24, 0.16, 0.16, 10, 1.8), closed: true, color: '#D9468F', fill: 'soft' });
      }
      lines.push({ v: ellipse(0, 0, 0.13, 0.13, 10, 2), closed: true, color: gold, fill: 'blob' });
      break;
    case 'snowflake':
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3 + Math.PI / 2;
        const dx = Math.cos(a) * 0.46;
        const dy = Math.sin(a) * 0.46;
        lines.push({ v: poly([[-dx, -dy], [dx, dy]], 2.2), closed: false, color: 'blue' });
        for (const sgn of [1, -1]) {
          const tx = dx * 0.62 * sgn;
          const ty = dy * 0.62 * sgn;
          lines.push({ v: poly([[tx - dy * 0.3, ty + dx * 0.3], [tx, ty], [tx + dy * 0.3, ty - dx * 0.3]], 1.6), closed: false, color: 'blue' });
        }
      }
      break;
    default:
      // gift: a box with a ribbon and a bow
      lines.push({ v: poly([[-0.4, -0.18], [0.4, -0.18], [0.4, 0.42], [-0.4, 0.42]], 2.4), closed: true, color: 'red', fill: 'soft' });
      lines.push({ v: poly([[0, -0.18], [0, 0.42]], 2.4), closed: false, color: gold });
      lines.push({ v: ellipse(-0.14, -0.3, 0.13, 0.09, 10, 2), closed: true, color: gold });
      lines.push({ v: ellipse(0.14, -0.3, 0.13, 0.09, 10, 2), closed: true, color: gold });
  }
  emitLines(out, b, lines, ink, seed);
}

// ---- npc --------------------------------------------------------------------------------------------------------

const NPC_COLORS = ['#2C7BE5', '#3E9E4F', '#6A5ACD', '#F08A24'] as const;

/** A friendly bean (x centre, feet at 0) with a sprout, and a "…" bubble above it (`part: 'shine'`). */
export function npcArt(out: ArtPath[], b: StyleBook, e: { id: string; name?: string | null; w?: number; h?: number }, ink: InkFor, seed: number, body = true): void {
  const w = clamp(e.w ?? 1.2, 0.8, 3);
  const h = clamp(e.h ?? 1.8, 1, 4);
  const lines: Line[] = [];
  if (body) {
    const color = NPC_COLORS[hash32(e.name || e.id) % NPC_COLORS.length];
    const cy = -h * 0.46;
    lines.push({ v: ellipse(0, cy, w * 0.42, h * 0.43, 24, 2.6, 0.03), closed: true, color, fill: 'sticker' });
    lines.push({ v: [[-w * 0.15, -h * 0.6, 3.8]], closed: true, color: 'black', part: 'eye' });
    lines.push({ v: [[w * 0.15, -h * 0.6, 3.8]], closed: true, color: 'black', part: 'eye' });
    lines.push({ v: poly([[-w * 0.13, -h * 0.47], [0, -h * 0.41], [w * 0.13, -h * 0.47]], 2), closed: false, color: 'black' });
    lines.push({ v: poly([[-w * 0.16, -h * 0.05], [-w * 0.2, 0], [-w * 0.05, 0]], 2.2), closed: false, color });
    lines.push({ v: poly([[w * 0.16, -h * 0.05], [w * 0.2, 0], [w * 0.05, 0]], 2.2), closed: false, color });
    lines.push({ v: poly([[0, -h * 0.89], [0.04, -h * 0.89 - 0.22]], 2), closed: false, color: 'green' });
    lines.push({ v: ellipse(0.16, -h * 0.89 - 0.26, 0.13, 0.07, 10, 1.8), closed: true, color: 'green', fill: 'blob' });
  }
  // the speech-bubble hint
  const bx = w * 0.2;
  const by = -h - 0.85;
  lines.push({ v: poly([[bx, by], [bx + 1, by], [bx + 1, by + 0.55], [bx + 0.32, by + 0.55], [bx + 0.12, by + 0.78], [bx + 0.16, by + 0.55], [bx, by + 0.55]], 2), closed: true, color: 'black', fill: 'sticker', part: 'shine' });
  for (let k = 0; k < 3; k++) lines.push({ v: [[bx + 0.28 + k * 0.22, by + 0.28, 3.2]], closed: true, color: 'black', part: 'shine' });
  emitLines(out, b, lines, ink, seed);
}
