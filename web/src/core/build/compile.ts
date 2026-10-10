/**
 * Compile (§2.4): the fitted scene → `compiled.tiles` (one char per cell, RLE rows) and typed entities.
 * Hazards, enemies, doors, keys, springs, saws, movers, crumble and falling platforms are entities, never tiles,
 * so a spike strip can never turn its wall into a hazard [B F6]. Exactly one row per platform [B F4].
 *
 * Entity conventions (docs/v2/CONTRACTS.md §3.10): standing things use the feet line as `y` and the centre as `x`;
 * coins, keys and saws use their centre; doors and platforms use the top-left corner plus w (and h); spike strips
 * use x0..x1 along the face and y = the face line's perpendicular coordinate (for left/right faces x0..x1 runs
 * along y and y is the face's x).
 */
import { HAZARDS, PERCEPTION, RASTER, WORLD } from '../params.ts';
import type {
  Behavior, CellXY, Dir4, EEnemy, EGoal, EnemyParams, Entity, Face, SceneObject, SurfaceSeg, Tiles, Trigger,
} from '../types.gen.ts';
import type { Work } from '../edits/work.ts';
import { floorBelow, isDynamic, isFloor, objBBox, topAt } from '../edits/work.ts';
import { clamp, q16, roundHalfUp } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';
import { fitCreatureBox, segsBBox, surfaceYAt } from './fit.ts';
import { encodeRow } from './tiles.ts';

const TERRAIN = new Set(['ground', 'platform', 'wall', 'ceiling']);

const PRIORITY: Record<string, number> = { '.': 0, '~': 1, '=': 2, '/': 3, '\\': 3, a: 3, b: 3, c: 3, d: 3, '#': 4, X: 5 };

export class Grid {
  readonly w: number;
  readonly h: number;
  readonly cells: string[][];
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cells = Array.from({ length: h }, () => new Array<string>(w).fill('.'));
  }
  get(c: number, r: number): string {
    if (c < 0 || c >= this.w) return '#'; // world sides are walls
    if (r < 0) return '.';
    if (r >= this.h) return '.';
    return this.cells[r][c];
  }
  put(c: number, r: number, ch: string): void {
    if (c < 0 || c >= this.w || r < 0 || r >= this.h) return;
    const cur = this.cells[r][c];
    if ((PRIORITY[ch] ?? 0) >= (PRIORITY[cur] ?? 0)) this.cells[r][c] = ch;
  }
  /** Solid for standing (any floor tile). */
  floor(c: number, r: number): boolean {
    const ch = this.get(c, r);
    return ch !== '.' && ch !== '~';
  }
  /** Blocks the body (solid tiles only; one-way and slopes count as passable from the side for headroom tests). */
  blocks(c: number, r: number): boolean {
    const ch = this.get(c, r);
    return ch === '#' || ch === 'X';
  }
  rows(): string[] {
    return this.cells.map((r) => encodeRow(r.join('')));
  }
  /** A 12×28 px body fits standing on (c, r): floor at row r, two free rows above. */
  standable(c: number, r: number): boolean {
    if (r < 2 || r >= this.h) return false;
    const ch = this.get(c, r);
    if (ch !== '#' && ch !== '=' && ch !== 'X') return false;
    return !this.floor(c, r - 1) && !this.floor(c, r - 2) && this.get(c, r - 1) !== '~';
  }
}

/** The tile for one lattice column with heights yl (left) and yr (right). */
export function slopeTile(yl: number, yr: number, oneWay: boolean): { ch: string; row: number } {
  const d = yr - yl;
  const isInt = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
  let ch: string;
  if (Math.abs(d) < 1e-6) ch = oneWay ? '=' : '#';
  else if (Math.abs(d + 1) < 1e-6) ch = '/';
  else if (Math.abs(d - 1) < 1e-6) ch = '\\';
  else if (Math.abs(d + 0.5) < 1e-6) ch = isInt(yl) ? 'a' : 'b';
  else if (Math.abs(d - 0.5) < 1e-6) ch = isInt(yl) ? 'c' : 'd';
  else ch = '#';
  return { ch, row: Math.floor(Math.min(yl, yr) + 1e-6) };
}

function segColumns(s: SurfaceSeg, cb: (c: number, yl: number, yr: number) => void): void {
  const x0 = Math.round(Math.min(s.a[0], s.b[0]));
  const x1 = Math.round(Math.max(s.a[0], s.b[0]));
  for (let c = x0; c < x1; c++) {
    const yl = s.a[1] + s.slope * (c - s.a[0]);
    cb(c, yl, yl + s.slope);
  }
}

export interface Compiled {
  tiles: Tiles;
  entities: Entity[];
  triggers: Trigger[];
  grid: Grid;
}

/** Rasterize the static terrain (no entities). */
export function rasterize(w: Work): Grid {
  const g = new Grid(w.world.w, w.world.h);
  const statics = w.objs.filter((o) => !o.rel.part_of && !isDynamic(o) && TERRAIN.has(o.role) && (o.collision === 'solid' || o.collision === 'one_way'));
  const surfaces = statics.filter((o) => o.shape.k === 'surface');
  const floors = surfaces.filter((o) => o.shape.k === 'surface' && o.shape.fill !== 'to_top');
  // surface tops per column, for the ground fill stop rule
  const topsAt = (c: number, except: SceneObject): number[] => {
    const out: number[] = [];
    for (const f of floors) {
      if (f === except || f.shape.k !== 'surface') continue;
      const y = surfaceYAt(f.shape.segs, c + 0.5);
      if (y !== null) out.push(Math.floor(y + 1e-6));
    }
    for (const o of statics) {
      if (o.shape.k === 'wall' && c >= o.shape.x && c < o.shape.x + (o.shape.w ?? 1)) out.push(o.shape.y0);
    }
    return out;
  };
  // grounds and platforms
  for (const o of floors) {
    if (o.shape.k !== 'surface') continue;
    const oneWay = o.collision === 'one_way';
    const toBottom = o.shape.fill === 'to_bottom';
    for (const s of o.shape.segs) {
      segColumns(s, (c, yl, yr) => {
        const t = slopeTile(yl, yr, oneWay && !toBottom);
        g.put(c, t.row, t.ch);
        if (!toBottom) return;
        const below = topsAt(c, o).filter((r) => r > t.row + 1);
        const stop = below.length ? Math.min(...below) - 1 : g.h;
        for (let r = t.row + 1; r < stop; r++) g.put(c, r, '#');
      });
    }
  }
  // walls (doors are entities)
  for (const o of statics) {
    if (o.shape.k !== 'wall' || o.role === 'door' || o.role === 'pole') continue;
    const s = o.shape;
    for (let c = s.x; c < s.x + (s.w ?? 1); c++) for (let r = s.y0; r < s.y1; r++) g.put(c, r, '#');
  }
  // ceilings: one row; a mass to row 0 when in the top 4 rows and ≥ 4 cells long
  for (const o of surfaces) {
    if (o.shape.k !== 'surface' || o.shape.fill !== 'to_top') continue;
    const b = segsBBox(o.shape.segs, 0);
    const long = b[2] - b[0] >= RASTER.ceiling_mass_min_len_c;
    for (const s of o.shape.segs) {
      segColumns(s, (c, yl, yr) => {
        const row = Math.round(Math.min(yl, yr)) - 1;
        g.put(c, row, '#');
        if (row <= RASTER.ceiling_mass_top_rows - 1 && long) for (let r = 0; r < row; r++) g.put(c, r, '#');
      });
    }
  }
  // lava fills its pit: from the drawn top down to solid ground or the world bottom
  for (const o of w.objs) {
    if (o.role !== 'lava' || o.rel.part_of) continue;
    const b = objBBox(o);
    const top = clamp(roundHalfUp(b[1]), 0, g.h - 1);
    for (let c = Math.max(0, Math.floor(b[0])); c < Math.min(g.w, Math.ceil(b[2])); c++) {
      for (let r = top; r < g.h; r++) {
        if (g.floor(c, r)) break;
        g.put(c, r, '~');
      }
    }
  }
  return g;
}

function centre(o: SceneObject): CellXY {
  const b = objBBox(o);
  if (o.shape.k === 'point') return [q16(o.shape.p[0]), q16(o.shape.p[1])];
  return [q16((b[0] + b[2]) / 2), q16((b[1] + b[3]) / 2)];
}

function feetOf(o: SceneObject, w: Work): number {
  const b = objBBox(o);
  const host = o.rel.rests_on ? w.objs.find((q) => q.id === o.rel.rests_on) : undefined;
  if (host) {
    const t = topAt(host, (b[0] + b[2]) / 2);
    if (t !== null) return q16(t);
  }
  return q16(b[3]);
}

function faceFacing(face: Face): Dir4 {
  return face === 'top' ? 'up' : face === 'bottom' ? 'down' : face;
}

function spikesEntity(o: SceneObject): Entity | null {
  if (o.shape.k !== 'strip') return null;
  const { a, b } = o.shape;
  const att = o.rel.attached ?? null;
  const vertical = Math.abs(a[0] - b[0]) < Math.abs(a[1] - b[1]);
  const face: Face = att?.face ?? (vertical ? (o.rel.points === 'right' ? 'right' : 'left') : o.rel.points === 'down' ? 'bottom' : 'top');
  const facing: Dir4 = o.rel.points && o.rel.points !== 'none' ? o.rel.points : faceFacing(face);
  const along0 = vertical ? Math.min(a[1], b[1]) : Math.min(a[0], b[0]);
  const along1 = vertical ? Math.max(a[1], b[1]) : Math.max(a[0], b[0]);
  return {
    id: o.id, type: 'spikes', host: att?.host ?? null, face, x0: q16(along0), x1: q16(Math.max(along1, along0 + 0.5)),
    y: q16(vertical ? a[0] : a[1]), facing, ...(o.origin === 'designer' ? { origin: 'designer' as const } : {}),
  };
}

/** Patrol bounds for a walking enemy: the flat run of its host under it, inset by half its width. */
function patrolBounds(o: SceneObject, w: Work, x: number, y: number, half: number, grid: Grid): [number, number] {
  void o;
  const c0 = Math.floor(x);
  const r = Math.round(y);
  let lo = c0;
  let hi = c0;
  const ok = (c: number): boolean => grid.floor(c, r) && !grid.blocks(c, r - 1);
  while (lo - 1 >= 0 && ok(lo - 1)) lo--;
  while (hi + 1 < w.world.w && ok(hi + 1)) hi++;
  let a = lo + half;
  let b = hi + 1 - half;
  if (w.st.trimmed.includes(o.id) && w.st.start) {
    const sx = w.st.start[0];
    const keep = 4;
    if (sx < x) a = Math.max(a, sx + keep + half);
    else b = Math.min(b, sx - keep - half);
  }
  if (b < a) b = a;
  return [q16(a), q16(b)];
}

function enemyEntity(o: SceneObject, w: Work, grid: Grid): Entity {
  const b = objBBox(o);
  const fitted = w.st.fitted.includes(o.id);
  const box = fitted ? fitCreatureBox(b) : { w: q16(clamp(b[2] - b[0], 0.75, 3)), h: q16(clamp(b[3] - b[1], 0.75, 3)) };
  const beh: Behavior | null = o.behavior ?? null;
  let archetype: EEnemy['archetype'] = beh && beh.kind === 'enemy' ? beh.archetype : 'static';
  const params: EnemyParams = beh && beh.kind === 'enemy' ? { ...(beh.params ?? {}) } : {};
  // a drawn creature with no host hovers (§3.3 enemy host)
  if (archetype === 'static' && !o.rel.rests_on && !floorBelow(w, (b[0] + b[2]) / 2, b[3] - 0.25, 0.6)) {
    archetype = 'flyer';
    params.pattern = 'hover';
  }
  const x = q16((b[0] + b[2]) / 2);
  const flying = archetype === 'flyer';
  const y = flying ? q16(b[3]) : feetOf(o, w);
  let bounds: [number, number] | null = null;
  if (archetype === 'walker' || archetype === 'chaser') {
    if (params.speed == null) params.speed = archetype === 'walker' ? 2 : 4;
    if (archetype === 'walker' && params.ledge_aware == null) params.ledge_aware = true;
    bounds = patrolBounds(o, w, x, y, box.w / 2, grid);
  } else if (archetype === 'flyer' && !params.pattern) params.pattern = 'hover';
  const spiky = beh && beh.kind === 'enemy' ? !!beh.spiky : false;
  return {
    id: o.id, type: 'enemy', archetype, x, y, w: box.w, h: box.h, spiky, params, bounds,
    ...(o.origin === 'designer' ? { origin: 'designer' as const } : {}),
  };
}

function sawRadius(d: number): number {
  const opts: readonly number[] = HAZARDS.saw.radius_c;
  let best: number = opts[0];
  for (const r of opts) if (Math.abs(2 * r - d) < Math.abs(2 * best - d)) best = r;
  return best;
}

function dirVec(d: string | undefined | null): [number, number] {
  return d === 'left' ? [-1, 0] : d === 'right' ? [1, 0] : d === 'up' ? [0, -1] : d === 'down' ? [0, 1] : [0, 0];
}

function goalEntity(o: SceneObject, w: Work): EGoal {
  const b = objBBox(o);
  const parts = (o.rel.parts ?? []).map((id) => w.objs.find((q) => q.id === id)).filter((q): q is SceneObject => !!q);
  const pole = parts.find((p) => p.role === 'pole');
  let trig: Rect = [b[0], b[1], b[2], b[3]];
  let x = (b[0] + b[2]) / 2;
  let feet = feetOf(o, w);
  if (pole && pole.shape.k === 'wall') {
    const ps = pole.shape;
    const px0 = ps.x + (ps.w ?? 1) / 2 - 0.25;
    const px1 = ps.x + (ps.w ?? 1) / 2 + 0.25;
    x = ps.x + (ps.w ?? 1) / 2;
    const host = pole.rel.rests_on ? w.objs.find((q) => q.id === pole.rel.rests_on) : undefined;
    const ht = host ? topAt(host, x) : null;
    feet = q16(ht ?? ps.y1);
    trig = [Math.min(trig[0], px0), Math.min(trig[1], ps.y0), Math.max(trig[2], px1), Math.max(trig[3], feet)];
  } else {
    trig = [trig[0], trig[1], trig[2], Math.max(trig[3], feet)];
  }
  return { id: o.id, type: 'goal', x: q16(x), y: q16(feet), trigger: [q16(trig[0]), q16(trig[1]), q16(trig[2]), q16(trig[3])], ...(o.origin === 'designer' ? { origin: 'designer' as const } : {}) };
}

function platformEntity(o: SceneObject): Entity | null {
  const b = objBBox(o);
  const beh = o.behavior;
  if (!beh || o.shape.k !== 'surface') return null;
  const x = Math.round(b[0]);
  const y = Math.round(b[1]);
  const width = Math.max(1, Math.round(b[2] - b[0]));
  const oneWay = o.collision === 'one_way';
  const designer = o.origin === 'designer' ? { origin: 'designer' as const } : {};
  if (beh.kind === 'move') {
    const [dx, dy] = dirVec(beh.dir);
    const cells = Math.max(0, beh.cells);
    return { id: o.id, type: 'moving_platform', x, y, w: width, path: [[x, y], [x + dx * cells, y + dy * cells]], speed: beh.speed, mode: beh.mode ?? 'pingpong', wait_s: beh.wait_s ?? HAZARDS.moving_platform.end_wait_s, one_way: oneWay, ...designer };
  }
  if (beh.kind === 'crumble') return { id: o.id, type: 'crumble', x, y, w: width, delay_s: beh.delay_s ?? 0.5, respawn_s: beh.respawn_s ?? HAZARDS.crumble.respawn_s, one_way: oneWay, ...designer };
  if (beh.kind === 'falling') return { id: o.id, type: 'falling_platform', x, y, w: width, delay_s: beh.delay_s ?? HAZARDS.falling.delay_s, one_way: oneWay, ...designer };
  return null;
}

/** The §3.3 start rule, used when N7 has not placed one (never fails: falls back to the leftmost column). */
export function defaultStart(grid: Grid): CellXY {
  const s = PERCEPTION.start;
  for (let c = 0; c < Math.min(grid.w, s.leftmost_cols); c++) {
    for (let r = grid.h - 1; r >= 2; r--) {
      if (!grid.standable(c, r)) continue;
      let free = 0;
      for (let k = 1; k <= 6 && r - k >= 0 && !grid.floor(c, r - k); k++) free++;
      if (free >= s.min_free_rows) return [Math.max(c + 0.5, s.edge_margin_c + 0.25), r];
    }
  }
  return [2, WORLD.ground_top_row_default];
}

export function compileWork(w: Work): Compiled {
  const grid = rasterize(w);
  const ents: Entity[] = [];
  const start = w.st.start ?? defaultStart(grid);
  ents.push({ id: 'start', type: 'player_start', x: q16(start[0]), y: q16(start[1]) });
  let goal: EGoal | null = null;
  for (const o of w.objs) {
    if (o.rel.part_of) continue;
    const designer = o.origin === 'designer' ? { origin: 'designer' as const } : {};
    switch (o.role) {
      case 'spikes': {
        const e = spikesEntity(o);
        if (e) ents.push(e);
        break;
      }
      case 'enemy':
        ents.push(enemyEntity(o, w, grid));
        break;
      case 'coin': {
        const [x, y] = centre(o);
        ents.push({ id: o.id, type: 'coin', x, y, ...designer });
        break;
      }
      case 'big_coin': {
        const [x, y] = centre(o);
        ents.push({ id: o.id, type: 'big_coin', x, y, ...designer });
        break;
      }
      case 'key': {
        const [x, y] = centre(o);
        const door = o.rel.refers_to && w.objs.some((q) => q.id === o.rel.refers_to && q.role === 'door') ? o.rel.refers_to : null;
        ents.push({ id: o.id, type: 'key', x, y, door, ...designer });
        break;
      }
      case 'door': {
        const b = objBBox(o);
        const key = o.rel.refers_to && w.objs.some((q) => q.id === o.rel.refers_to && q.role === 'key') ? o.rel.refers_to : null;
        ents.push({ id: o.id, type: 'door', x: q16(b[0]), y: q16(b[1]), w: q16(Math.max(1, b[2] - b[0])), h: q16(Math.max(1, b[3] - b[1])), key, ...designer });
        break;
      }
      case 'spring': {
        const b = objBBox(o);
        const beh = o.behavior && o.behavior.kind === 'spring' ? o.behavior : null;
        const dir = beh?.dir ?? (o.rel.points === 'left' || o.rel.points === 'right' ? o.rel.points : 'up');
        ents.push({ id: o.id, type: 'spring', x: q16((b[0] + b[2]) / 2), y: feetOf(o, w), dir, strength: beh?.strength ?? 1.0, w: q16(Math.max(1, Math.round(b[2] - b[0]))), ...designer });
        break;
      }
      case 'saw': {
        const b = objBBox(o);
        const [x, y] = centre(o);
        // a fire bar is a saw-family hazard with a rotating chain of balls (C6 Hard, a "fire bar" chip or text)
        if (o.behavior && o.behavior.kind === 'firebar') {
          const fb = o.behavior;
          const balls = clamp(Math.round(fb.balls ?? 4), HAZARDS.firebar.balls[0], HAZARDS.firebar.balls[1]);
          const speed = clamp(fb.speed_deg_s ?? HAZARDS.firebar.speed, HAZARDS.firebar.speed_range[0], HAZARDS.firebar.speed_range[1]);
          ents.push({ id: o.id, type: 'firebar', x, y, balls, speed_deg_s: speed, phase: q16(fb.phase ?? 0), ...designer });
          break;
        }
        const beh = o.behavior && o.behavior.kind === 'saw' ? o.behavior : null;
        const r = beh?.radius ?? sawRadius(Math.max(b[2] - b[0], b[3] - b[1]));
        const [dx, dy] = dirVec(beh?.dir);
        const cells = beh?.cells ?? 0;
        const path: CellXY[] = cells > 0 && (dx || dy) ? [[x, y], [q16(x + dx * cells), q16(y + dy * cells)]] : [];
        ents.push({ id: o.id, type: 'saw', x, y, r, path, speed: beh?.speed ?? HAZARDS.saw.speed, mode: 'pingpong', ...designer });
        break;
      }
      case 'checkpoint': {
        const b = objBBox(o);
        const pole = (o.rel.parts ?? []).map((id) => w.objs.find((q) => q.id === id)).find((q) => q && q.role === 'pole' && q.shape.k === 'wall');
        const px = pole && pole.shape.k === 'wall' ? pole.shape.x + (pole.shape.w ?? 1) / 2 : (b[0] + b[2]) / 2;
        const py = pole && pole.shape.k === 'wall' ? q16(pole.shape.y1) : feetOf(o, w);
        ents.push({ id: o.id, type: 'checkpoint', x: q16(px), y: py, ...designer });
        break;
      }
      case 'goal': {
        const e = goalEntity(o, w);
        if (!goal || e.x > goal.x) goal = e;
        break;
      }
      case 'arrow':
        if (o.origin === 'designer') {
          const [x, y] = centre(o);
          const dir: Dir4 = o.rel.points && o.rel.points !== 'none' ? o.rel.points : 'right';
          ents.push({ id: o.id, type: 'hint_arrow', x, y, dir, origin: 'designer' });
        }
        break;
      case 'ground':
      case 'platform': {
        if (isDynamic(o)) {
          const e = platformEntity(o);
          if (e) ents.push(e);
        }
        break;
      }
      default:
        break;
    }
  }
  if (goal) ents.push(goal);
  const triggers: Trigger[] = [];
  if (w.st.timer_s) triggers.push({ when: `timer:${Math.round(w.st.timer_s)}`, then: 'lose' });
  return { tiles: { legend: '.#=/\\abcd~X', rows: grid.rows() }, entities: ents, triggers, grid };
}

/** The standable feet line under (x, y) on the compiled grid, searching down. */
export function groundUnder(grid: Grid, x: number, y: number, maxDy = 27): number | null {
  const c = Math.floor(x);
  for (let r = Math.max(2, Math.ceil(y - 0.5)); r < Math.min(grid.h, y + maxDy + 1); r++) if (grid.standable(c, r)) return r;
  return null;
}

export { floorBelow, isFloor };
