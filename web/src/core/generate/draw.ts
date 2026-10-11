/**
 * Layout primitives → blue-line strokes (§8.3 step 2): an InkDoc with `origin: 'draft'`, colour `draft`, a `label`
 * role on every stroke (conf 1.0, so perception of a draft is exact and PERCEIVE is skipped) and a `rule` where the
 * object behaves. Lines carry a seeded wobble so a draft looks hand-drawn; the wobble is small enough (≤ 0.06 cell)
 * that fitting snaps every surface back to its intended row, and vertical steps are drawn exactly so the lattice
 * keeps them as steps.
 *
 * Geometry conventions the fitter relies on (docs/spec/level-format-v2.md): a surface's ink top is centre − w/2, so
 * a ledge on row r is drawn at y = r + w/2; a ceiling's ink bottom is its underside; walls are drawn as vertical
 * lines at column centre x + 0.5 from y0 + w/2 to y1 − w/2; masses are filled boxes inset by half the pen.
 * Pure arithmetic only (the noise is hash-based value noise, no trig), so the same plan and seed give the same
 * strokes in the browser and in Node.
 */
import { PROMPT_LEVEL, WORLD } from '../params.ts';
import type { Behavior, InkDoc, InkStroke, Role } from '../types.gen.ts';
import { inkFromStrokes } from '../ink/index.ts';
import type { Layout, Prim, Pt } from './layout.ts';

const L = PROMPT_LEVEL.layout;

// ---- deterministic noise ----------------------------------------------------------------------------

function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in [−1, 1] for (seed, i). */
function hashUnit(seed: number, i: number): number {
  return (mix(seed, i) / 4294967295) * 2 - 1;
}

/** Smooth value noise in [−1, 1] along a coordinate. */
function noise(seed: number, x: number, knot: number): number {
  const u = x / knot;
  const i = Math.floor(u);
  const f = u - i;
  const s = f * f * (3 - 2 * f);
  const a = hashUnit(seed, i + 1000003);
  const b = hashUnit(seed, i + 1000004);
  return a + (b - a) * s;
}

function q64(x: number): number {
  return Math.round(x * 64) / 64;
}

// ---- unit shapes (precomputed cos/sin, no trig at runtime) -------------------------------------------

/** 12-gon: cos / sin of k·30°. */
const RING12: Pt[] = [
  [1, 0], [0.8660254, 0.5], [0.5, 0.8660254], [0, 1], [-0.5, 0.8660254], [-0.8660254, 0.5],
  [-1, 0], [-0.8660254, -0.5], [-0.5, -0.8660254], [0, -1], [0.5, -0.8660254], [0.8660254, -0.5],
];
/** 16-gon: cos / sin of k·22.5°. */
const RING16: Pt[] = [
  [1, 0], [0.9238795, 0.3826834], [0.7071068, 0.7071068], [0.3826834, 0.9238795], [0, 1], [-0.3826834, 0.9238795],
  [-0.7071068, 0.7071068], [-0.9238795, 0.3826834], [-1, 0], [-0.9238795, -0.3826834], [-0.7071068, -0.7071068],
  [-0.3826834, -0.9238795], [0, -1], [0.3826834, -0.9238795], [0.7071068, -0.7071068], [0.9238795, -0.3826834],
];
/** 10 star points (outer at k·72° − 90°, inner between), unit outer radius. */
const STAR_OUT: Pt[] = [[0, -1], [0.9510565, -0.3090170], [0.5877853, 0.8090170], [-0.5877853, 0.8090170], [-0.9510565, -0.3090170]];
const STAR_IN: Pt[] = [[0.5877853, -0.8090170], [0.9510565, 0.3090170], [0, 1], [-0.9510565, 0.3090170], [-0.5877853, -0.8090170]];

// ---- a tiny stroke font for signs (glyph box 0..0.6 × 0..1, y down, baseline 1) ----------------------

const FONT: Record<string, Pt[][]> = {
  a: [[[0.55, 0.45], [0.3, 0.4], [0.08, 0.6], [0.15, 0.95], [0.4, 0.92], [0.55, 0.7]], [[0.55, 0.4], [0.55, 1]]],
  b: [[[0.08, 0], [0.08, 1]], [[0.08, 0.6], [0.3, 0.42], [0.52, 0.6], [0.5, 0.88], [0.25, 1], [0.08, 0.9]]],
  c: [[[0.52, 0.48], [0.28, 0.42], [0.08, 0.65], [0.15, 0.95], [0.45, 0.98], [0.55, 0.88]]],
  d: [[[0.52, 0], [0.52, 1]], [[0.52, 0.6], [0.3, 0.42], [0.08, 0.6], [0.1, 0.9], [0.32, 1], [0.52, 0.88]]],
  e: [[[0.1, 0.7], [0.52, 0.68], [0.45, 0.45], [0.2, 0.45], [0.08, 0.7], [0.2, 0.97], [0.5, 0.95]]],
  g: [[[0.52, 0.45], [0.25, 0.42], [0.08, 0.62], [0.2, 0.85], [0.52, 0.8]], [[0.52, 0.42], [0.52, 1.15], [0.3, 1.3], [0.1, 1.2]]],
  h: [[[0.08, 0], [0.08, 1]], [[0.08, 0.6], [0.3, 0.42], [0.5, 0.55], [0.52, 1]]],
  i: [[[0.3, 0.42], [0.3, 1]], [[0.3, 0.18], [0.3, 0.2]]],
  j: [[[0.38, 0.42], [0.38, 1.15], [0.25, 1.3], [0.08, 1.22]], [[0.38, 0.18], [0.38, 0.2]]],
  k: [[[0.08, 0], [0.08, 1]], [[0.5, 0.42], [0.1, 0.72], [0.52, 1]]],
  l: [[[0.25, 0], [0.25, 0.9], [0.4, 1]]],
  m: [[[0.05, 0.42], [0.05, 1]], [[0.05, 0.55], [0.18, 0.42], [0.3, 0.55], [0.3, 1]], [[0.3, 0.55], [0.43, 0.42], [0.56, 0.55], [0.56, 1]]],
  n: [[[0.08, 0.42], [0.08, 1]], [[0.08, 0.58], [0.3, 0.42], [0.5, 0.55], [0.52, 1]]],
  o: [[[0.3, 0.42], [0.08, 0.6], [0.12, 0.92], [0.35, 1], [0.54, 0.8], [0.5, 0.5], [0.3, 0.42]]],
  p: [[[0.08, 0.42], [0.08, 1.3]], [[0.08, 0.55], [0.3, 0.42], [0.52, 0.6], [0.45, 0.92], [0.08, 0.9]]],
  r: [[[0.1, 0.42], [0.1, 1]], [[0.1, 0.62], [0.28, 0.44], [0.5, 0.46]]],
  s: [[[0.5, 0.48], [0.25, 0.42], [0.1, 0.55], [0.3, 0.7], [0.5, 0.82], [0.4, 0.98], [0.08, 0.94]]],
  t: [[[0.25, 0.1], [0.25, 0.9], [0.42, 1]], [[0.05, 0.42], [0.45, 0.42]]],
  u: [[[0.08, 0.42], [0.1, 0.9], [0.3, 1], [0.5, 0.88]], [[0.52, 0.42], [0.52, 1]]],
  v: [[[0.05, 0.42], [0.3, 1], [0.55, 0.42]]],
  w: [[[0.02, 0.42], [0.15, 1], [0.3, 0.6], [0.45, 1], [0.58, 0.42]]],
  y: [[[0.05, 0.42], [0.3, 0.92]], [[0.55, 0.42], [0.2, 1.3]]],
  '!': [[[0.3, 0.05], [0.3, 0.7]], [[0.3, 0.92], [0.3, 0.95]]],
  '?': [[[0.08, 0.2], [0.3, 0.05], [0.52, 0.2], [0.3, 0.5], [0.3, 0.7]], [[0.3, 0.92], [0.3, 0.95]]],
  '>': [[[0.1, 0.3], [0.5, 0.65], [0.1, 1]]],
  '-': [[[0.05, 0.65], [0.55, 0.65]]],
};
/** "→" is drawn as a shaft + head (4 units wide). */
const ARROW: Pt[][] = [[[0, 0.65], [1.2, 0.65]], [[0.85, 0.4], [1.2, 0.65], [0.85, 0.9]]];

// ---- stroke builders --------------------------------------------------------------------------------

interface Ctx {
  seed: number;
  out: InkStroke[];
  n: number;
}

function stroke(c: Ctx, p: Prim, s: Omit<InkStroke, 'id' | 'sheet' | 'origin' | 't'>): InkStroke {
  c.n++;
  const x0 = s.pts.reduce((m, q) => Math.min(m, q[0]), Infinity);
  const st: InkStroke & { x_beat?: string } = {
    id: `d${c.n}`, sheet: Math.max(0, Math.min(WORLD.max_screens - 1, Math.floor(Math.max(0, x0) / WORLD.screen_w))), origin: 'draft', t: c.n,
    ...s, pts: s.pts.map((q) => [q64(q[0]), q64(q[1])] as Pt),
  };
  st.x_beat = p.beat;
  c.out.push(st);
  return st;
}

/** A horizontal run from x0 to x1 at y (centreline), resampled with wobble; the ends stay exact. */
function wobblyRun(seed: number, x0: number, x1: number, y: number, amp: number): Pt[] {
  const pts: Pt[] = [[x0, y]];
  const step = L.resample_c;
  const n = Math.max(1, Math.round(Math.abs(x1 - x0) / step));
  for (let i = 1; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    // taper the wobble to 0 near both ends, so vertices (and steps) stay where the layout put them
    const edge = Math.min(Math.abs(x - x0), Math.abs(x1 - x)) / 1.0;
    const k = Math.min(1, edge);
    pts.push([x, y + amp * k * noise(seed, x, L.wobble_knot_c)]);
  }
  pts.push([x1, y]);
  return pts;
}

/** A vertical line from y0 to y1 at x, resampled every 0.5 (no wobble: a drawn step must stay ≥ 55°). */
function vertical(x: number, y0: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const n = Math.max(1, Math.round(Math.abs(y1 - y0) / L.resample_c));
  for (let i = 0; i <= n; i++) pts.push([x, y0 + ((y1 - y0) * i) / n]);
  return pts;
}

function widths(pts: readonly Pt[], w: number, seed: number): number[] {
  return pts.map((q, i) => Math.round((w * (1 + 0.04 * noise(seed ^ 0x55, i * 0.7, 3))) * 64) / 64);
}

function line(c: Ctx, p: Prim, pts: Pt[], w: number, label: Role, extra: Partial<InkStroke> = {}): InkStroke {
  return stroke(c, p, { color: 'draft', kind: 'line', pts, w: widths(pts, w, c.seed ^ c.n), closed: false, label, ...extra });
}

function blob(c: Ctx, p: Prim, pts: Pt[], label: Role | null, extra: Partial<InkStroke> = {}): InkStroke {
  return stroke(c, p, { color: 'draft', kind: 'blob', pts, w: [0.5], closed: true, ...(label ? { label } : {}), ...extra });
}

function dot(c: Ctx, p: Prim, x: number, y: number, w: number, label: Role | null): InkStroke {
  return stroke(c, p, { color: 'draft', kind: 'dot', pts: [[x, y]], w: [w], closed: true, ...(label ? { label } : {}) });
}

/** A rectangle outline resampled every 0.5 on all four edges (fitWall weighs points by segment length). */
function boxOutline(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const edge = (ax: number, ay: number, bx: number, by: number): void => {
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / L.resample_c));
    for (let i = 0; i < n; i++) pts.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
  };
  edge(x0, y0, x1, y0);
  edge(x1, y0, x1, y1);
  edge(x1, y1, x0, y1);
  edge(x0, y1, x0, y0);
  return pts;
}

function drawGround(c: Ctx, p: Extract<Prim, { k: 'ground' }>): void {
  const w = L.marker_w_c;
  const h = w / 2;
  const pts: Pt[] = [];
  const seed = mix(c.seed, c.n + 17);
  for (let i = 1; i < p.pts.length; i++) {
    const [ax, ay] = p.pts[i - 1];
    const [bx, by] = p.pts[i];
    const seg = ax === bx ? vertical(ax, ay + h, by + h) : wobblyRun(seed, ax, bx, ay + h, L.wobble_c);
    for (const q of seg) {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
    }
  }
  if (pts.length >= 2) line(c, p, pts, w, 'ground');
}

function behaviorOf(p: Extract<Prim, { k: 'platform' }>): Behavior | null {
  if (p.move) return { kind: 'move', dir: p.move.dir, cells: p.move.cells, speed: p.move.speed, mode: 'pingpong' };
  if (p.crumble) return { kind: 'crumble', delay_s: p.crumble.delay_s };
  if (p.falling) return { kind: 'falling' };
  return null;
}

function drawSpikes(c: Ctx, p: Extract<Prim, { k: 'spikes' }>): void {
  const sw = L.spike_w_c;
  const h = sw / 2;
  const pts: Pt[] = [];
  const n = Math.max(1, Math.round((p.a1 - p.a0) / 0.5));
  const tooth = (p.a1 - p.a0) / n;
  for (let i = 0; i <= 2 * n; i++) {
    const a = p.a0 + (tooth * i) / 2;
    const tip = i % 2 === 1;
    switch (p.face) {
      case 'top':
        pts.push([a, tip ? p.at - 0.85 : p.at - h]);
        break;
      case 'bottom':
        pts.push([a, tip ? p.at + 0.85 : p.at + h]);
        break;
      case 'left':
        pts.push([tip ? p.at - 0.85 : p.at - h, a]);
        break;
      case 'right':
        pts.push([tip ? p.at + 0.85 : p.at + h, a]);
        break;
    }
  }
  line(c, p, pts, sw, 'spikes');
}

function drawEnemy(c: Ctx, p: Extract<Prim, { k: 'enemy' }>): void {
  const rx = p.w / 2;
  const ry = p.h / 2;
  const cx = p.x;
  const cy = p.y - ry - 0.02;
  const pts: Pt[] = p.arch === 'crusher'
    ? boxOutline(cx - rx + 0.25, p.y - p.h + 0.25, cx + rx - 0.25, p.y - 0.27)
    : RING12.map(([u, v]) => [cx + u * (rx - 0.25), cy + v * (ry - 0.25)] as Pt);
  const rule: Behavior = p.arch === 'static' ? { kind: 'static' } : { kind: 'enemy', archetype: p.arch, spiky: p.spiky, params: { ...p.params } };
  blob(c, p, pts, 'enemy', { rule });
  // two eyes inside the body (grouped as parts: containment)
  const ey = p.y - p.h * 0.62;
  dot(c, p, cx - p.w * 0.17, ey, 0.18, null);
  dot(c, p, cx + p.w * 0.17, ey, 0.18, null);
}

/** Unit shapes for v4 art (precomputed, so the generator needs no trig): a 5-point star and an open spiral. */
const STAR10: Pt[] = [[0, -1], [0.265, -0.364], [0.951, -0.309], [0.428, 0.139], [0.588, 0.809], [0, 0.45], [-0.588, 0.809],
  [-0.428, 0.139], [-0.951, -0.309], [-0.265, -0.364]];
const SPIRAL: Pt[] = [[0.15, 0], [0.151, 0.108], [0.072, 0.209], [-0.073, 0.246], [-0.23, 0.179], [-0.327, 0.014], [-0.304, -0.198],
  [-0.145, -0.371], [0.106, -0.42], [0.358, -0.303], [0.502, -0.042], [0.464, 0.276], [0.231, 0.526], [-0.125, 0.598], [-0.475, 0.438],
  [-0.676, 0.085], [-0.631, -0.341], [-0.331, -0.675], [0.129, -0.777], [0.581, -0.582], [0.846, -0.142], [0.803, 0.392], [0.443, 0.817],
  [-0.118, 0.957], [-0.676, 0.737]];

/** v4 primitives (CONTRACTS_V4 §5): one stroke carrying the behaviour (compile makes the entity from it), drawn in a
 * shape that says what it is, since the kid's ink is the art: a star pickup, a spiral portal, a box zone, a figure. */
function drawV4(c: Ctx, p: Extract<Prim, { k: 'v4' }>): void {
  const cx = (p.x0 + p.x1) / 2;
  const cy = (p.y0 + p.y1) / 2;
  const rx = (p.x1 - p.x0) / 2;
  const ry = (p.y1 - p.y0) / 2;
  const fit = (shape: readonly Pt[]): Pt[] => shape.map(([u, v]) => [cx + u * rx, cy + v * ry] as Pt);
  switch (p.rule.kind) {
    case 'zone':
      line(c, p, boxOutline(p.x0, p.y0, p.x1, p.y1), 0.3, 'decoration', { color: 'blue', closed: true, rule: p.rule });
      break;
    case 'npc':
      line(c, p, fit(RING12), 0.3, 'decoration', { color: 'black', closed: true, rule: p.rule });
      break;
    case 'portal':
      line(c, p, fit(SPIRAL), 0.14, 'decoration', { color: 'blue', rule: p.rule });
      break;
    default: // pickup
      line(c, p, fit(STAR10), 0.26, 'decoration', { color: 'blue', closed: true, rule: p.rule });
  }
}

function drawText(c: Ctx, p: Extract<Prim, { k: 'sign' }>): void {
  const size = 0.9;
  let x = p.x;
  const baseline = p.y;
  for (const ch of p.text.toLowerCase()) {
    if (ch === ' ') {
      x += 0.45 * size;
      continue;
    }
    const glyph = ch === '→' ? ARROW : FONT[ch];
    if (!glyph) {
      x += 0.5 * size;
      continue;
    }
    let wmax = 0;
    for (const pl of glyph) {
      const pts = pl.map(([u, v]) => [x + u * size, baseline - size + v * size] as Pt);
      for (const [u] of pl) wmax = Math.max(wmax, u);
      if (pts.length === 2 && pts[0][0] === pts[1][0] && Math.abs(pts[0][1] - pts[1][1]) < 0.06) {
        stroke(c, p, { color: 'draft', kind: 'dot', pts: [pts[0]], w: [0.22], closed: true, label: 'text' });
        continue;
      }
      line(c, p, pts, 0.2, 'text');
    }
    x += (wmax + 0.25) * size;
  }
}

/** Every primitive → strokes, in a stable order; keys get `x_opens` (F-1) naming their door's stroke. */
export function primsToStrokes(prims: readonly Prim[], seed: number): InkStroke[] {
  const c: Ctx = { seed: seed >>> 0, out: [], n: 0 };
  const doorStroke = new Map<string, string>();
  const keyFix: { s: InkStroke; door: string }[] = [];
  for (const p of prims) {
    switch (p.k) {
      case 'ground':
        drawGround(c, p);
        break;
      case 'platform': {
        const w = p.solid ? L.solid_w_c : L.marker_w_c;
        const beh = behaviorOf(p);
        line(c, p, wobblyRun(mix(c.seed, c.n + 3), p.x0, p.x1, p.y + w / 2, L.wobble_c * 0.8), w, 'platform', beh ? { rule: beh } : {});
        break;
      }
      case 'mass':
        blob(c, p, boxOutline(p.x0 + 0.25, p.y0 + 0.25, p.x1 - 0.25, p.y1 - 0.25), 'wall');
        break;
      case 'wall': {
        const w = p.door ? 1.0 : L.marker_w_c;
        const s = line(c, p, vertical(p.x + 0.5, p.y0 + w / 2, p.y1 - w / 2), w, p.door ? 'door' : 'wall');
        if (p.door) doorStroke.set(p.door, s.id);
        break;
      }
      case 'spikes':
        drawSpikes(c, p);
        break;
      case 'lava':
        line(c, p, wobblyRun(mix(c.seed, c.n + 5), p.x0 + 0.3, p.x1 - 0.3, p.y + 0.3, 0.12), 0.6, 'lava');
        break;
      case 'coin':
        dot(c, p, p.x, p.y, 0.875, 'coin');
        break;
      case 'big_coin': {
        const pts: Pt[] = [];
        for (let i = 0; i < 5; i++) {
          pts.push([p.x + STAR_OUT[i][0] * 0.75, p.y + STAR_OUT[i][1] * 0.75]);
          pts.push([p.x + STAR_IN[i][0] * 0.32, p.y + STAR_IN[i][1] * 0.32]);
        }
        blob(c, p, pts, 'big_coin');
        break;
      }
      case 'enemy':
        drawEnemy(c, p);
        break;
      case 'saw': {
        const pts = RING16.map(([u, v], i) => [p.x + u * p.r * (i % 2 ? 0.8 : 1), p.y + v * p.r * (i % 2 ? 0.8 : 1)] as Pt);
        blob(c, p, pts, 'saw', { rule: { kind: 'saw', radius: p.r, dir: p.dir, cells: p.cells, speed: p.speed } });
        break;
      }
      case 'firebar': {
        const pts = RING12.map(([u, v]) => [p.x + u * 0.35, p.y + v * 0.35] as Pt);
        blob(c, p, pts, 'saw', { rule: { kind: 'firebar', balls: p.balls, speed_deg_s: p.speed, phase: p.phase } });
        break;
      }
      case 'spring': {
        const pts: Pt[] = [];
        for (let i = 0; i <= 6; i++) pts.push([p.x + (i % 2 ? 0.4 : -0.4), p.y - 0.12 - i * 0.1]);
        line(c, p, pts, 0.3, 'spring', { rule: { kind: 'spring', dir: 'up', strength: p.strength } });
        break;
      }
      case 'key': {
        const pts: Pt[] = RING12.map(([u, v]) => [p.x - 0.3 + u * 0.3, p.y + v * 0.3] as Pt);
        pts.push([p.x - 0.3 + 0.3, p.y], [p.x + 0.55, p.y], [p.x + 0.55, p.y + 0.28], [p.x + 0.42, p.y], [p.x + 0.35, p.y + 0.22]);
        const s = line(c, p, pts, 0.3, 'key');
        if (p.door) keyFix.push({ s, door: p.door });
        break;
      }
      case 'flag': {
        const goal = p.role === 'goal';
        const ph = goal ? 4 : 2.6;
        const fw = goal ? 1.6 : 1.1;
        const fh = goal ? 1.1 : 0.8;
        line(c, p, vertical(p.x, p.y - L.pole_w_c / 2, p.y - ph), L.pole_w_c, 'pole');
        const top = p.y - ph;
        blob(c, p, [[p.x + 0.15, top + 0.05], [p.x + 0.15 + fw * 0.5, top + fh * 0.3], [p.x + 0.15 + fw, top + fh * 0.45], [p.x + 0.15 + fw * 0.5, top + fh * 0.7], [p.x + 0.15, top + fh]], goal ? 'goal' : 'checkpoint');
        break;
      }
      case 'sign':
        drawText(c, p);
        break;
      case 'v4':
        drawV4(c, p);
        break;
    }
  }
  for (const k of keyFix) {
    const d = doorStroke.get(k.door);
    if (d) (k.s as InkStroke & { x_opens?: string }).x_opens = d;
  }
  return c.out;
}

/** Beat extents in world cells, plan order (`InkDoc.x_beats`, D-2 §3): a gap has an extent even with no strokes. */
export function beatExtents(lay: Layout): { section: number; beat: number; kind: string; x0: number; x1: number }[] {
  return lay.spans.filter((s) => s.s >= 0 && s.b >= 0 && /^\d+\.\d+$/.test(s.addr)).map((s) => ({ section: s.s, beat: s.b, kind: s.kind, x0: s.x0, x1: s.x1 }));
}

/** A layout as an InkDoc (`source: 'prompt'`): components and features computed by the core. */
export function layoutToInk(lay: Layout, seed: number): InkDoc {
  const strokes = primsToStrokes(lay.prims, seed);
  const ink = inkFromStrokes(strokes, { cell: 16, screens: lay.world.screens, w: lay.world.w, h: 27 });
  const out: InkDoc & { x_beats?: ReturnType<typeof beatExtents> } = { ...ink, source: 'prompt' };
  out.x_beats = beatExtents(lay);
  return out;
}
