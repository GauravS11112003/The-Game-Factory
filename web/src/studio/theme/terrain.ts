/**
 * Terrain geometry for ground lines (physics shape `line`, docs/v7/CONTRACTS_V7.md §4.1), pure (no DOM, tested in node).
 * art.ts paints it; the runtime and the Studio canvas share it so the ground looks the same everywhere.
 *
 * Every stroke of a line object becomes a piece of solid land, in world px:
 *   ground  an open, mostly horizontal stroke with nothing under it: land from the line down past the world's bottom
 *           (and on past the world's side when the line reaches it), the surface band along the top.
 *   slab    an open stroke with other ground below most of it (a floating platform): a thick island under the line.
 *   wall    a mostly vertical open stroke: a solid rounded rock band along the pen.
 *   closed  a closed stroke: the outline filled, the surface band on its upward-facing edges.
 * The visible top sits on the physics surface (the pen line raised by the physics half-thickness r), so wheels and feet
 * touch the land they stand on. Decorations are placed deterministically (seeded by the object id).
 */
import type { ArtVariant, TerrainSkin } from '../../core/types.gen.ts';
import { hexOr, isAchromatic, isDark, luminance, mix, toHsl, type FullTheme } from './color.ts';
import { roundCorners, simplify, type Pt } from './polish.ts';
import { hashNums, rng } from './rng.ts';

export type { Pt } from './polish.ts';

export interface TerrainObj {
  id: string;
  drawing?: { strokes?: { points?: unknown; width?: number; closed?: boolean; color?: string }[] } | null;
  x?: number;
  y?: number;
  rotation?: number;
  scale?: number;
}

export interface WorldStroke {
  pts: Pt[];
  /** Physics half thickness (world px): max(4, width / 2) × scale, as the runtime's chain segments. */
  r: number;
  closed: boolean;
  color: string;
}

export type TerrainKind = 'ground' | 'slab' | 'wall' | 'closed';

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TerrainPiece {
  kind: TerrainKind;
  /** Smoothed pen line (world px); for walls the band is drawn along it. */
  line: Pt[];
  /** The land outline (closed polygon); empty for walls. */
  poly: Pt[];
  /** Polylines the surface band follows (top-facing edges). */
  runs: Pt[][];
  r: number;
  color: string;
  box: Box;
}

/** Ground lines extend this far past the world's sides and bottom so the land never ends on screen. */
export const DEEP = 4000;
const EDGE_SNAP = 60;

// ---- small geometry ---------------------------------------------------------------------------------

export function boxOf(pts: Pt[], pad = 0): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Offset a polyline by `d` along its normals. Open lines: the normal is (dy, −dx) of the direction of travel (for a
 * left-to-right line that points up, −y). Closed outlines: outward. Miters are capped so sharp bends stay sane.
 */
export function offsetLine(pts: Pt[], d: number, closed: boolean): Pt[] {
  const n = pts.length;
  if (n < 2 || !d) return pts.slice();
  const flip = closed && signedArea(pts) < 0 ? -1 : 1;
  const segN: Pt[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    segN.push([(dy / l) * flip, (-dx / l) * flip]);
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let na: Pt | undefined;
    let nb: Pt | undefined;
    if (closed) {
      na = segN[(i - 1 + segs) % segs];
      nb = segN[i % segs];
    } else {
      na = segN[i - 1] ?? segN[i];
      nb = segN[i] ?? segN[i - 1];
    }
    let mx = na[0] + nb[0];
    let my = na[1] + nb[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = nb[0];
      my = nb[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = Math.max(0.5, mx * nb[0] + my * nb[1]);
    out.push([pts[i][0] + (mx * d) / cos, pts[i][1] + (my * d) / cos]);
  }
  return out;
}

/** Every y where the polyline crosses the vertical line at x. */
export function crossingsAt(pts: Pt[], x: number, closed: boolean): number[] {
  const ys: number[] = [];
  const n = pts.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const lo = Math.min(a[0], b[0]);
    const hi = Math.max(a[0], b[0]);
    if (x < lo || x > hi) continue;
    if (hi - lo < 1e-9) ys.push(Math.max(a[1], b[1]));
    else ys.push(a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]));
  }
  return ys;
}

export function polylineLength(pts: Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// ---- strokes → world ----------------------------------------------------------------------------------

/** A line object's strokes in world px (scale, rotation, position applied; simplified like the physics chain). */
export function worldStrokes(o: TerrainObj): WorldStroke[] {
  const s = Number.isFinite(o.scale) && (o.scale as number) > 0 ? (o.scale as number) : 1;
  const a = ((Number(o.rotation) || 0) * Math.PI) / 180;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const ox = Number(o.x) || 0;
  const oy = Number(o.y) || 0;
  const out: WorldStroke[] = [];
  for (const st of o.drawing?.strokes ?? []) {
    if (!st || !Array.isArray(st.points)) continue;
    const local: Pt[] = [];
    for (const p of st.points as unknown[]) {
      if (!Array.isArray(p)) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) local.push([x, y]);
    }
    if (!local.length) continue;
    const width = Math.max(1, Math.min(80, Number(st.width) || 6));
    const closed = st.closed === true && local.length > 2;
    const simple = simplify(closed ? [...local, local[0]] : local, 1.5);
    if (closed && simple.length > 3) simple.pop();
    const pts = simple.map(([x, y]) => [ox + (x * c - y * sn) * s, oy + (x * sn + y * c) * s] as Pt);
    out.push({ pts, r: Math.max(4, width / 2) * s, closed, color: typeof st.color === 'string' ? st.color : '#1f1b18' });
  }
  return out;
}

// ---- classification -------------------------------------------------------------------------------

function isWallish(s: WorldStroke): boolean {
  if (s.closed) return false;
  const b = boxOf(s.pts);
  const sx = b.maxX - b.minX;
  const sy = b.maxY - b.minY;
  return sx < Math.max(30, sy * 0.6);
}

/** What a stroke is, given every terrain stroke in the scene (`all` includes `s`). */
export function classifyStroke(s: WorldStroke, all: WorldStroke[]): TerrainKind {
  if (s.closed) return 'closed';
  if (isWallish(s)) return 'wall';
  const b = boxOf(s.pts);
  const sx = b.maxX - b.minX;
  let samples = 0;
  let below = 0;
  for (let k = 0; k < 7; k++) {
    const x = b.minX + (sx * (k + 0.5)) / 7;
    const ys = crossingsAt(s.pts, x, false);
    if (!ys.length) continue;
    const y = Math.max(...ys);
    samples++;
    for (const o of all) {
      if (o === s || isWallish(o)) continue;
      if (crossingsAt(o.pts, x, o.closed).some((yo) => yo > y + 90)) {
        below++;
        break;
      }
    }
  }
  return samples && below / samples >= 0.6 ? 'slab' : 'ground';
}

// ---- pieces ------------------------------------------------------------------------------------------

function smoothOpen(pts: Pt[]): Pt[] {
  return pts.length > 2 ? roundCorners(pts, false, 6) : pts.slice();
}

function upwardRuns(poly: Pt[]): Pt[][] {
  const n = poly.length;
  if (n < 3) return [];
  const flip = signedArea(poly) < 0 ? -1 : 1;
  const up: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    up.push((-dx / l) * flip < -0.45); // outward normal's y
  }
  if (up.every(Boolean)) return [[...poly, poly[0]]];
  const runs: Pt[][] = [];
  const start = up.findIndex((u) => !u);
  let cur: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (up[i]) {
      if (!cur.length) cur.push(poly[i]);
      cur.push(poly[(i + 1) % n]);
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2 && polylineLength(r) > 6);
}

/** Build one stroke's piece of land (see the header). */
export function buildPiece(s: WorldStroke, kind: TerrainKind, world: { width: number; height: number }): TerrainPiece {
  const r = s.r;
  if (kind === 'closed') {
    const outline = s.pts.length > 2 ? roundCorners(s.pts, true, 6) : s.pts.slice();
    const poly = offsetLine(outline, r, true);
    return { kind, line: outline, poly, runs: upwardRuns(poly), r, color: s.color, box: boxOf(poly) };
  }
  let line = smoothOpen(s.pts);
  if (kind === 'wall') return { kind, line, poly: [], runs: [], r, color: s.color, box: boxOf(line, r + 6) };
  if (line.length >= 2 && line[0][0] > line[line.length - 1][0]) line = line.slice().reverse();
  const top = offsetLine(line, r, false);
  if (kind === 'slab') {
    const b = boxOf(line);
    const T = Math.max(22, Math.min(64, (b.maxX - b.minX) * 0.1));
    const L = polylineLength(line) || 1;
    let run = 0;
    const depths = line.map((p, i) => {
      if (i) run += Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]);
      const t = run / L;
      return -(r + T * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * t), 0.6)));
    });
    // the underside: the line pushed down by a depth that thins toward the ends (a floating island)
    const unit = offsetLine(line, 1, false);
    const under = line.map((p, i) => {
      const nx = unit[i][0] - p[0];
      const ny = unit[i][1] - p[1];
      return [p[0] + nx * depths[i], Math.max(p[1] + ny * depths[i], p[1] + r)] as Pt;
    });
    const poly = [...top, ...under.reverse()];
    return { kind, line, poly, runs: [top], r, color: s.color, box: boxOf(poly) };
  }
  // ground: down past the world's bottom; past the world's sides when the line reaches them
  const tp = top.slice();
  if (tp.length && tp[0][0] <= EDGE_SNAP) tp.unshift([-DEEP, tp[0][1]]);
  if (tp.length && tp[tp.length - 1][0] >= world.width - EDGE_SNAP) tp.push([world.width + DEEP, tp[tp.length - 1][1]]);
  const deep = world.height + DEEP;
  const poly = [...tp, [tp[tp.length - 1][0], deep] as Pt, [tp[0][0], deep] as Pt];
  return { kind, line, poly, runs: [tp], r, color: s.color, box: boxOf(poly) };
}

/** All pieces of one line object; `others` are the scene's other line objects (for the slab test). */
export function buildTerrain(o: TerrainObj, world: { width: number; height: number }, others: TerrainObj[] = []): TerrainPiece[] {
  const mine = worldStrokes(o);
  const all = [...mine, ...others.filter((x) => x && x.id !== o.id).flatMap(worldStrokes)];
  return mine.map((s) => buildPiece(s, classifyStroke(s, all), world));
}

// ---- decorations ---------------------------------------------------------------------------------

export interface DecorSpot {
  x: number;
  y: number;
  /** Surface slope at the spot (deg, clockwise). */
  angle: number;
  variant: number;
  scale: number;
  flip: boolean;
}

/**
 * Spots for decorations along the surface runs, about every `every` px (±40%), skipping slopes steeper than `maxSlope`
 * and anything outside [minX, maxX]. Deterministic for the same pieces and seed.
 */
export function decorSpots(pieces: TerrainPiece[], every: number, seed: number, variants: number,
  o: { maxSlope?: number; minX?: number; maxX?: number } = {}): DecorSpot[] {
  const out: DecorSpot[] = [];
  if (variants <= 0 || !(every > 0)) return out;
  const maxSlope = o.maxSlope ?? 30;
  const minX = o.minX ?? -Infinity;
  const maxX = o.maxX ?? Infinity;
  const step = Math.max(24, every);
  pieces.forEach((pc, pi) => {
    pc.runs.forEach((run, ri) => {
      const r = rng(hashNums(seed, pi, ri));
      let next = step * (0.25 + r() * 0.75);
      let s0 = 0;
      for (let i = 1; i < run.length; i++) {
        const a = run[i - 1];
        const b = run[i];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-9) continue;
        while (next <= s0 + len) {
          const t = (next - s0) / len;
          const x = a[0] + (b[0] - a[0]) * t;
          const y = a[1] + (b[1] - a[1]) * t;
          let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
          if (ang > 90) ang -= 180;
          else if (ang <= -90) ang += 180;
          const variant = Math.floor(r() * variants) % variants;
          const scale = 0.75 + r() * 0.5;
          const flip = r() < 0.5;
          const gap = step * (0.6 + r() * 0.8);
          if (Math.abs(ang) <= maxSlope && x >= minX && x <= maxX) out.push({ x, y, angle: ang, variant, scale, flip });
          next += gap;
        }
        s0 += len;
      }
    });
  });
  return out;
}

export interface Pebble {
  x: number;
  y: number;
  r: number;
  /** 0..1: lighter or darker than the land. */
  t: number;
}

/** Pebbles in a window, from a fixed world grid so neighbouring tiles agree. */
export function pebbleSpots(box: Box, seed: number, cell = 90): Pebble[] {
  const out: Pebble[] = [];
  const pad = 8;
  const cx0 = Math.floor((box.minX - pad) / cell);
  const cx1 = Math.floor((box.maxX + pad) / cell);
  const cy0 = Math.floor((box.minY - pad) / cell);
  const cy1 = Math.floor((box.maxY + pad) / cell);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 40000) return out;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const r = rng(hashNums(seed, cx, cy));
      const n = r() < 0.5 ? 1 : r() < 0.35 ? 2 : 0;
      for (let k = 0; k < n; k++) out.push({ x: (cx + r()) * cell, y: (cy + r()) * cell, r: 2 + r() * 5, t: r() });
    }
  }
  return out;
}

// ---- skins ---------------------------------------------------------------------------------------

export type ProcDecor = 'tuft' | 'flower' | 'rock' | 'crater' | 'shell' | 'crystal' | 'drytuft';

/** A terrain look with every field decided (from an AI TerrainSkin or made from the theme). */
export interface ResolvedSkin {
  /** Land colours, top to bottom (1..4). */
  fill: string[];
  surface: string;
  surfaceWidth: number;
  surfaceSvg: string | null;
  textureSvg: string | null;
  decor: ArtVariant[];
  decorEvery: number;
  /** Procedural extras (used when there is no AI skin). */
  blades: boolean;
  glow: boolean;
  strata: boolean;
  pebbles: boolean;
  procDecor: ProcDecor[];
  /** Colour flowers / crystals use. */
  accent: string;
  /** Dark rim colour under the surface band. */
  edge: string;
}

export type TerrainMood = 'grass' | 'dark' | 'sand' | 'moon' | 'neon' | 'snow' | 'city' | 'beach';

export function terrainMood(ft: FullTheme): TerrainMood {
  if (ft.particles === 'snow') return 'snow';
  switch (ft.background.style) {
    case 'space':
    case 'stars': return 'moon';
    case 'neon_grid': return 'neon';
    case 'dunes': return 'sand';
    case 'waves': return 'beach';
    case 'city': return 'city';
    default: return isDark(ft.palette.bg) ? 'dark' : 'grass';
  }
}

function greenish(hex: string): boolean {
  const [h, s, l] = toHsl(hex);
  return h >= 70 && h <= 170 && s > 0.2 && l > 0.15 && l < 0.8;
}

function shades(base: string, light = 0.1, dark = 0.42): string[] {
  return [mix(base, '#ffffff', light), mix(base, '#000000', dark * 0.45), mix(base, '#000000', dark)];
}

/** The look of a line object in the `game` view without an AI skin: solid land from the theme and the pen colour. */
export function defaultSkin(ft: FullTheme, strokeColor: string, r = 7): ResolvedSkin {
  const pen = hexOr(strokeColor, '#1f1b18');
  const chroma = !isAchromatic(pen) && luminance(pen) > 0.02;
  const P = ft.palette;
  const sw = Math.max(10, Math.min(24, r * 2.2 + 2));
  const base: ResolvedSkin = {
    fill: [], surface: P.good, surfaceWidth: sw, surfaceSvg: null, textureSvg: null, decor: [], decorEvery: 150,
    blades: false, glow: false, strata: true, pebbles: true, procDecor: [], accent: P.accent, edge: '#000000',
  };
  const tint = (cols: string[], t = 0.22): string[] => (chroma ? cols.map((c) => mix(c, pen, t)) : cols);
  switch (terrainMood(ft)) {
    case 'grass': {
      const soil = chroma && !greenish(pen) ? pen : '#9a6a3f';
      const grass = chroma && greenish(pen) ? pen : mix(P.good, '#3f8f3a', 0.45);
      return { ...base, fill: shades(soil, 0.08, 0.45), surface: grass, blades: true, edge: mix(grass, '#000000', 0.45),
        procDecor: ['tuft', 'tuft', 'flower', 'rock', 'tuft'], accent: P.accent };
    }
    case 'dark': {
      const soil = mix(chroma && !greenish(pen) ? pen : '#5b4636', P.bg, 0.35);
      const grass = mix(chroma && greenish(pen) ? pen : P.good, P.bg, 0.3);
      return { ...base, fill: shades(soil, 0.06, 0.5), surface: grass, blades: true, edge: mix(grass, '#000000', 0.5),
        procDecor: ['tuft', 'rock', 'tuft'], accent: P.accent };
    }
    case 'sand':
      return { ...base, fill: tint(['#e8c07a', '#d29a55', '#a86f35'].map((c) => mix(c, P.accent, 0.08))), surface: '#f6dda3',
        surfaceWidth: sw * 0.8, edge: '#b07a3c', pebbles: true, procDecor: ['rock', 'drytuft', 'rock'], accent: P.accent };
    case 'beach':
      return { ...base, fill: tint(['#f2d49b', '#e0b66e', '#c08f4a']), surface: '#fbe9c2', surfaceWidth: sw * 0.8, edge: '#c69a58',
        procDecor: ['shell', 'rock', 'shell'], accent: P.accent };
    case 'moon': {
      const rock = mix('#8e94ad', P.accent2, 0.12);
      return { ...base, fill: tint(shades(rock, 0.12, 0.5), 0.15), surface: mix(rock, '#ffffff', 0.45), surfaceWidth: sw * 0.75,
        edge: mix(rock, '#000000', 0.5), procDecor: ['crater', 'rock', 'crater', 'crystal'], accent: P.accent };
    }
    case 'neon':
      return { ...base, fill: [mix(P.bg, '#000000', 0.1), mix(P.bg, '#000000', 0.35), mix(P.bg, '#000000', 0.6)],
        surface: chroma ? pen : P.accent, surfaceWidth: Math.max(6, sw * 0.5), glow: true, pebbles: false, edge: P.accent2,
        procDecor: [], accent: P.accent2 };
    case 'snow': {
      const rock = chroma ? mix(pen, '#7d8aa6', 0.5) : '#7d8aa6';
      return { ...base, fill: shades(rock, 0.15, 0.45), surface: '#f7fbff', surfaceWidth: sw * 1.1, edge: '#9fb3cf',
        procDecor: ['rock'], accent: P.accent };
    }
    case 'city':
      return { ...base, fill: tint(['#a3a7ad', '#83878d', '#5f6368'], 0.12), surface: '#4b4f56', surfaceWidth: sw * 0.9,
        edge: '#2e3136', pebbles: false, procDecor: [], accent: '#f2c94c' };
  }
}

/** A TerrainSkin from the art backend made complete (bad colours fall back to the theme's land). */
export function resolveSkin(skin: TerrainSkin | null | undefined, ft: FullTheme, strokeColor: string, r = 7): ResolvedSkin {
  const d = defaultSkin(ft, strokeColor, r);
  if (!skin || typeof skin !== 'object') return d;
  const fill = (Array.isArray(skin.fill) ? skin.fill : []).map((c) => hexOr(c, '')).filter(Boolean).slice(0, 4);
  const surface = hexOr(skin.surface, d.surface);
  const sw = Number.isFinite(skin.surface_width) ? Math.max(0, Math.min(80, Number(skin.surface_width))) : d.surfaceWidth;
  const svgOk = (v: unknown): string | null => (typeof v === 'string' && v.includes('<svg') ? v : null);
  const decor = (Array.isArray(skin.decor) ? skin.decor : []).filter((v) => v && typeof v.svg === 'string' && v.w > 0 && v.h > 0);
  return {
    ...d,
    fill: fill.length ? fill : d.fill,
    surface,
    surfaceWidth: sw,
    surfaceSvg: svgOk(skin.surface_svg),
    textureSvg: svgOk(skin.texture_svg),
    decor,
    decorEvery: Number.isFinite(skin.decor_every) ? Math.max(40, Math.min(4000, Number(skin.decor_every))) : 220,
    blades: !svgOk(skin.surface_svg) && greenish(surface),
    glow: false,
    strata: !svgOk(skin.texture_svg),
    pebbles: false,
    procDecor: [],
    edge: mix(surface, '#000000', 0.45),
  };
}
