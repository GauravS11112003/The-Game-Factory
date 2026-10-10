/**
 * Stamps (§6.3): coin, big coin, spikes, flag, checkpoint, spring, saw, walker, hopper, flyer, key, door, start and
 * the game's library types. A stamp writes ordinary vector strokes that carry `stamp` (pinned, conf 1.0, §3.3), drawn
 * in the colour the paper grammar expects, so a stamped level reads the same as a hand-drawn one.
 * Every glyph is placed with its feet (bottom centre) on the tapped point, except pickups and saws (centred).
 */
import type { CellXY, InkColor, InkStroke, LibraryType, StampKind } from '../core/types.gen.ts';
import { q } from './geom.ts';

export const STAMP_KINDS: readonly Exclude<StampKind, 'library'>[] = [
  'coin', 'big_coin', 'spikes', 'flag', 'checkpoint', 'spring', 'saw', 'walker', 'hopper', 'flyer', 'key', 'door', 'start',
] as const;

/** Stamps that sit on a surface: their glyph's bottom is the tapped point. */
const GROUNDED = new Set<StampKind>(['spikes', 'flag', 'checkpoint', 'spring', 'walker', 'hopper', 'key', 'door', 'start']);

interface Glyph {
  color: InkColor;
  kind: 'line' | 'dot' | 'blob';
  pts: CellXY[];
  w: number;
  closed?: boolean;
}

const TAU = Math.PI * 2;

function ring(cx: number, cy: number, rx: number, ry: number, n = 18): CellXY[] {
  const out: CellXY[] = [];
  for (let i = 0; i < n; i++) out.push([cx + rx * Math.cos((i / n) * TAU), cy + ry * Math.sin((i / n) * TAU)]);
  return out;
}

function star(cx: number, cy: number, r1: number, r2: number, n: number, rot = -Math.PI / 2): CellXY[] {
  const out: CellXY[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = rot + (i / (n * 2)) * TAU;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function eyes(cx: number, cy: number, gap: number): Glyph[] {
  return [
    { color: 'black', kind: 'dot', pts: [[cx - gap, cy]], w: 0.22 },
    { color: 'black', kind: 'dot', pts: [[cx + gap, cy]], w: 0.22 },
  ];
}

/** Glyphs in local cells: origin = the anchor (feet line for grounded stamps, centre otherwise). */
function glyphs(kind: Exclude<StampKind, 'library'>): Glyph[] {
  switch (kind) {
    case 'coin':
      return [{ color: 'blue', kind: 'dot', pts: [[0, 0]], w: 0.875 }];
    case 'big_coin':
      return [{ color: 'blue', kind: 'line', pts: star(0, 0, 0.75, 0.33, 5), w: 0.22, closed: true }];
    case 'spikes': {
      const pts: CellXY[] = [];
      for (let i = 0; i <= 6; i++) pts.push([-1.5 + i * 0.5, i % 2 ? -0.7 : -0.05]);
      return [{ color: 'red', kind: 'line', pts, w: 0.28 }];
    }
    case 'flag':
      return [
        { color: 'black', kind: 'line', pts: [[0, 0], [0, -3.4]], w: 0.3 },
        { color: 'green', kind: 'blob', pts: [[0.1, -3.4], [1.6, -2.95], [0.1, -2.5]], w: 0.3, closed: true },
      ];
    case 'checkpoint':
      return [
        { color: 'black', kind: 'line', pts: [[0, 0], [0, -2.2]], w: 0.25 },
        { color: 'green', kind: 'blob', pts: [[0.1, -2.2], [1.0, -1.9], [0.1, -1.6]], w: 0.25, closed: true },
      ];
    case 'spring': {
      const coil: CellXY[] = [[-0.6, -0.05]];
      for (let i = 1; i <= 4; i++) coil.push([i % 2 ? 0.6 : -0.6, -0.05 - i * 0.22]);
      return [
        { color: 'black', kind: 'line', pts: coil, w: 0.2 },
        { color: 'black', kind: 'line', pts: [[-0.8, -1.0], [0.8, -1.0]], w: 0.3 },
      ];
    }
    case 'saw':
      return [
        { color: 'red', kind: 'line', pts: star(0, 0, 1.0, 0.72, 8, 0), w: 0.22, closed: true },
        { color: 'red', kind: 'dot', pts: [[0, 0]], w: 0.3 },
      ];
    case 'walker':
      return [
        { color: 'red', kind: 'line', pts: ring(0, -0.65, 0.8, 0.6), w: 0.25, closed: true },
        ...eyes(0, -0.8, 0.28),
        { color: 'red', kind: 'line', pts: [[-0.4, -0.12], [-0.45, 0]], w: 0.22 },
        { color: 'red', kind: 'line', pts: [[0.4, -0.12], [0.45, 0]], w: 0.22 },
      ];
    case 'hopper':
      return [
        { color: 'red', kind: 'line', pts: ring(0, -0.75, 0.7, 0.5), w: 0.25, closed: true },
        ...eyes(0, -0.95, 0.25),
        { color: 'red', kind: 'line', pts: [[-0.5, -0.4], [-0.85, -0.1], [-0.55, 0]], w: 0.22 },
        { color: 'red', kind: 'line', pts: [[0.5, -0.4], [0.85, -0.1], [0.55, 0]], w: 0.22 },
      ];
    case 'flyer':
      return [
        { color: 'red', kind: 'line', pts: ring(0, 0, 0.55, 0.45), w: 0.25, closed: true },
        ...eyes(0, -0.08, 0.2),
        { color: 'red', kind: 'line', pts: [[-0.5, -0.15], [-1.0, -0.6], [-1.2, -0.1], [-0.55, 0.05]], w: 0.2 },
        { color: 'red', kind: 'line', pts: [[0.5, -0.15], [1.0, -0.6], [1.2, -0.1], [0.55, 0.05]], w: 0.2 },
      ];
    case 'key':
      return [
        { color: 'blue', kind: 'line', pts: ring(-0.55, -0.45, 0.35, 0.35, 14), w: 0.22, closed: true },
        { color: 'blue', kind: 'line', pts: [[-0.2, -0.45], [0.85, -0.45]], w: 0.22 },
        { color: 'blue', kind: 'line', pts: [[0.55, -0.45], [0.55, -0.15]], w: 0.2 },
        { color: 'blue', kind: 'line', pts: [[0.8, -0.45], [0.8, -0.2]], w: 0.2 },
      ];
    case 'door':
      return [{ color: 'black', kind: 'blob', pts: [[-0.5, 0], [-0.5, -3], [0.5, -3], [0.5, 0]], w: 0.3, closed: true }];
    case 'start':
      return [
        { color: 'black', kind: 'line', pts: ring(0, -1.5, 0.25, 0.25, 12), w: 0.18, closed: true },
        { color: 'black', kind: 'line', pts: [[0, -1.25], [0, -0.5]], w: 0.18 },
        { color: 'black', kind: 'line', pts: [[-0.3, 0], [0, -0.5], [0.3, 0]], w: 0.18 },
        { color: 'black', kind: 'line', pts: [[-0.35, -1.0], [0.35, -1.0]], w: 0.18 },
      ];
  }
}

export interface StampContext {
  newId(): string;
  nextT(): number;
  sheetOf(x: number): number;
}

function place(gs: Glyph[], at: CellXY, kind: StampKind, ctx: StampContext, extra: Partial<InkStroke> = {}): InkStroke[] {
  let t = ctx.nextT();
  return gs.map((g) => {
    const pts = g.pts.map(([x, y]) => [q(at[0] + x), q(at[1] + y)] as CellXY);
    return {
      id: ctx.newId(), color: g.color, kind: g.kind, pts, w: g.kind === 'dot' ? [g.w] : pts.map(() => g.w),
      closed: g.kind !== 'line' ? true : !!g.closed, sheet: ctx.sheetOf(pts[0][0]), origin: 'kid', stamp: kind, t: t++,
      ...extra,
    } satisfies InkStroke;
  });
}

/** `at` is the feet line for grounded stamps (bottom centre) and the centre for pickups and saws. */
export function makeStamp(kind: Exclude<StampKind, 'library'>, at: CellXY, ctx: StampContext): InkStroke[] {
  return place(glyphs(kind), at, kind, ctx);
}

/** A library instance: the type's own art at its size, feet on the tapped point (§8.1 "Editor stamp"). */
export function makeLibraryStamp(type: LibraryType, at: CellXY, ctx: StampContext): InkStroke[] {
  const strokes = type.art.strokes;
  if (!strokes.length) return [];
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of strokes) for (const p of s.pts) {
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const [sw, sh] = type.art.size_cells;
  const k = Math.min(sw / Math.max(0.01, x1 - x0), sh / Math.max(0.01, y1 - y0));
  const cx = (x0 + x1) / 2;
  let t = ctx.nextT();
  return strokes.map((s) => {
    const pts = s.pts.map(([x, y]) => [q(at[0] + (x - cx) * k), q(at[1] + (y - y1) * k)] as CellXY);
    return {
      id: ctx.newId(), color: s.color, kind: s.kind, pts, w: s.w.map((w) => q(Math.max(0.15, w * k), 1 / 256)),
      closed: s.closed, sheet: ctx.sheetOf(pts[0][0]), origin: 'kid', stamp: 'library',
      lib: { type_id: type.id, version: type.version }, t: t++,
    } satisfies InkStroke;
  });
}

/** Preview strokes of a stamp around (0, 0), for toolbar icons. */
export function stampPreview(kind: Exclude<StampKind, 'library'>): InkStroke[] {
  let n = 0;
  return makeStamp(kind, GROUNDED.has(kind) ? [0, 1.5] : [0, 0], { newId: () => `p${n++}`, nextT: () => 0, sheetOf: () => 0 });
}

export function isGroundedStamp(kind: StampKind): boolean {
  return GROUNDED.has(kind);
}
