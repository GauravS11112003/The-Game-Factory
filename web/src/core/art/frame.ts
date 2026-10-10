/**
 * Framing helpers for thumbnails and share cards (PLAN_V2 §7.9), plus the sample level the theme picker previews
 * (§8.2: the four paper themes on the rules sheet). Pure and deterministic.
 */
import type { Entity, GameRules, LevelV2, RectCells, Theme } from '../types.gen.ts';
import { decodeGrid, floorPx, isFloor } from './terrain.ts';
import type { Grid } from './terrain.ts';

const VIEW_W = 48;
const VIEW_H = 27;

/** How much an entity type adds to a view's interest (a share card should show the level's best screen). */
const WEIGHT: Record<string, number> = {
  goal: 6, player_start: 3, enemy: 3, big_coin: 3, saw: 3, firebar: 3, moving_platform: 2, crumble: 1.5,
  falling_platform: 1.5, spring: 2, key: 2, door: 2, spikes: 2, checkpoint: 1, coin: 0.6, hint_arrow: 0,
};

function entityX(e: Entity): number {
  if (e.type === 'spikes') return (e.x0 + e.x1) / 2;
  return (e as { x: number }).x;
}

/** Column top heights (row of the first floor-like cell from the top, or h for a pit). */
function tops(g: Grid): number[] {
  const out: number[] = [];
  for (let c = 0; c < g.w; c++) {
    let r = 0;
    while (r < g.h && !isFloor(g.rows[r][c]) && g.rows[r][c] !== '~') r++;
    out.push(r);
  }
  return out;
}

export interface ViewOptions {
  /** 'start': the first screen; 'best': the most interesting screen (start or goal kept in view when close). */
  pick?: 'start' | 'best' | 'goal';
}

/**
 * A 48 × 27-cell view (one screen). 'best' scores every window (4-cell steps) by its entities, its terrain variety
 * (height changes and pits) and a small bonus for the first screen, so a share card shows the level at its liveliest.
 */
export function bestView(level: LevelV2, o: ViewOptions = {}): RectCells {
  const w = level.world.w;
  const maxX = Math.max(0, w - VIEW_W);
  const pick = o.pick ?? 'best';
  const ents = level.compiled?.entities ?? [];
  if (pick === 'start' || maxX === 0) return [0, 0, VIEW_W, VIEW_H];
  if (pick === 'goal') {
    const goal = ents.find((e) => e.type === 'goal');
    const gx = goal ? entityX(goal) : w;
    const x = Math.max(0, Math.min(maxX, Math.round(gx - VIEW_W * 0.72)));
    return [x, 0, x + VIEW_W, VIEW_H];
  }
  const g = decodeGrid(level);
  const t = tops(g);
  let best = 0;
  let bestScore = -Infinity;
  for (let x = 0; x <= maxX; x += 4) {
    let s = 0;
    for (const e of ents) {
      const ex = entityX(e);
      if (ex < x + 1 || ex > x + VIEW_W - 1) continue;
      s += WEIGHT[e.type] ?? 1;
    }
    let changes = 0;
    let pits = 0;
    for (let c = x + 1; c < Math.min(w, x + VIEW_W); c++) {
      if (t[c] !== t[c - 1]) changes++;
      if (t[c] >= g.h && t[c - 1] < g.h) pits++;
    }
    s += Math.min(8, changes) * 0.35 + pits * 1.2;
    if (x === 0) s += 2; // the screen a player sees first
    if (s > bestScore + 1e-9) {
      bestScore = s;
      best = x;
    }
  }
  return [best, 0, best + VIEW_W, VIEW_H];
}

/** The feet y (cells) of a standing spot in column x (the first floor from the top), or null over a pit. */
export function standY(level: LevelV2, x: number): number | null {
  const g = decodeGrid(level);
  const c = Math.max(0, Math.min(g.w - 1, Math.floor(x)));
  for (let r = 0; r < g.h; r++) {
    const ch = g.rows[r][c];
    if (ch === '~') return null;
    if (!isFloor(ch)) continue;
    const fy = floorPx(ch, x - c);
    return r + (fy ?? 0) / 16;
  }
  return null;
}

/**
 * Where to stand the character inside a view that does not show the start: left of the goal when it is in view,
 * else the first standable column from the view's left third. Null when nothing in view can be stood on.
 */
export function standPoint(level: LevelV2, view: RectCells): [number, number] | null {
  const ents = level.compiled?.entities ?? [];
  const goal = ents.find((e) => e.type === 'goal');
  const tries: number[] = [];
  if (goal && goal.x > view[0] + 4 && goal.x < view[2]) for (let d = 3; d <= 9; d++) tries.push(goal.x - d);
  const x0 = view[0] + (view[2] - view[0]) / 3;
  for (let d = 0; d < 20; d++) tries.push(x0 + d, x0 - d);
  const hazard = new Set<number>();
  for (const e of ents) {
    if (e.type === 'spikes' && e.facing === 'up') for (let c = Math.floor(e.x0); c < Math.ceil(e.x1); c++) hazard.add(c);
    if (e.type === 'enemy') hazard.add(Math.floor(e.x));
  }
  for (const x of tries) {
    if (x < view[0] + 1 || x > view[2] - 1 || hazard.has(Math.floor(x))) continue;
    const y = standY(level, x + 0.5);
    if (y !== null && y > 3) return [Math.floor(x) + 0.5, y];
  }
  return null;
}

/** True when the view contains the level's player start. */
export function viewHasStart(level: LevelV2, view: RectCells): boolean {
  const s = (level.compiled?.entities ?? []).find((e) => e.type === 'player_start');
  const x = s ? s.x : 2;
  return x >= view[0] && x <= view[2];
}

// ---- the theme picker's sample: a tiny real level, drawn by the real art pipeline ---------------------------------

function row(w: number, cells: [number, string][]): string {
  // cells: [count, char] runs → the RLE row format of compiled.tiles
  let n = 0;
  let out = '';
  for (const [k, ch] of cells) {
    out += `${k}${ch}`;
    n += k;
  }
  if (n < w) out += `${w - n}.`;
  return out;
}

/**
 * A one-screen sample level (ground with a pit, a floating jump-through ledge, spikes, coins, a big star and the goal
 * flag). The theme picker renders its left 16 × 9 cells with the real ArtDoc pipeline, so the swatch is exactly how
 * levels look with that theme.
 */
export function sampleLevel(theme: Theme, rules?: Partial<GameRules>): LevelV2 {
  const w = 48;
  const rows: string[] = [];
  for (let r = 0; r < 27; r++) {
    if (r === 23) rows.push(row(w, [[7, '#'], [2, '.'], [39, '#']]));
    else if (r > 23) rows.push(row(w, [[7, '#'], [2, '.'], [39, '#']]));
    else if (r === 19) rows.push(row(w, [[10, '.'], [3, '=']]));
    else rows.push(`${w}.`);
  }
  const entities: Entity[] = [
    { id: 'start', type: 'player_start', x: 2.5, y: 23 },
    { id: 'c1', type: 'coin', x: 7.5, y: 21.3 },
    { id: 'c2', type: 'coin', x: 8.5, y: 20.8 },
    { id: 'c3', type: 'coin', x: 10.6, y: 18.2 },
    { id: 'sp', type: 'spikes', host: null, face: 'top', x0: 4, x1: 5.5, y: 23, facing: 'up' },
    { id: 'big', type: 'big_coin', x: 12.3, y: 17.3 },
    { id: 'goal', type: 'goal', x: 14.2, y: 23, trigger: [14, 19, 15.4, 23] },
  ] as Entity[];
  return {
    format: 'dal-level', schema_version: 2, core_min: '2.0.0', id: `theme-sample-${theme}`, version: 1,
    title: theme, author: '', created_at: '1970-01-01T00:00:00Z',
    world: { cell: 16, screens: 1, w, h: 27 },
    rules: { version: 1, physics_profile: 'v2-standard', theme, music: true, ...rules } as GameRules,
    source: { kind: 'canvas' },
    ink: null,
    objects: [],
    compiled: { tiles: { legend: '.#=/\\abcd~X', rows }, entities, triggers: [] },
    meta: { level_hash: '', core_version: '' },
  } as LevelV2;
}

/** The part of the sample level a theme swatch shows (16:9, cells). */
export const SAMPLE_VIEW: RectCells = [0, 15, 16, 24];
