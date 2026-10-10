/**
 * Entity showcase levels for #/dev (§11.7 item 10: a playable fixture for each gameplay system):
 * stomp chains; all six archetypes with gravity; oriented spikes, one-way platforms and slopes; crumble, falling and
 * springs (held vs not held); moving platforms, saws, the firebar and key/door; checkpoints, big-coin banking, hearts
 * and lives. They are authored directly as compiled levels (tiles + typed entities, the §2.4 alphabet and the
 * normative entity geometry of docs/spec/level-format-v2.md), so they exercise the Sim and the renderer without going
 * through perception or the designer. Each gets its real `level_hash` from the core.
 */
import type { Entity, GameRules, LevelV2 } from '../core/types.gen.ts';
import { CORE_VERSION, levelHash } from '../core/index.ts';
import { DEFAULT_RULES } from './rules.ts';

const H = 27;
const FLOOR = 22;

/** A tile grid for one level: fill helpers in cells, then RLE rows (§2.4). */
class Grid {
  readonly w: number;
  private cells: string[][];
  constructor(screens: number) {
    this.w = 48 * screens;
    this.cells = Array.from({ length: H }, () => Array.from({ length: this.w }, () => '.'));
  }

  set(x: number, y: number, ch: string): this {
    if (x >= 0 && x < this.w && y >= 0 && y < H) this.cells[y][x] = ch;
    return this;
  }

  /** Fill [x0, x1) × [y0, y1). */
  fill(x0: number, x1: number, y0: number, y1: number, ch = '#'): this {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, ch);
    return this;
  }

  /** Ground with its top on row `top`, filled to the world bottom. */
  ground(x0: number, x1: number, top = FLOOR): this {
    return this.fill(x0, x1, top, H);
  }

  /** A one-row platform ('=' one-way, '#' solid). */
  ledge(x0: number, x1: number, row: number, ch = '='): this {
    return this.fill(x0, x1, row, row + 1, ch);
  }

  /** A 1:1 slope rising right from `top` over n columns starting at x (each column one row higher), mass below. */
  rampUp(x: number, top: number, n: number): this {
    for (let i = 0; i < n; i++) {
      const row = top - 1 - i;
      this.set(x + i, row, '/');
      this.fill(x + i, x + i + 1, row + 1, H);
    }
    return this;
  }

  /** A 1:2 slope falling right from `top` over 2·rows columns ('c' high half, 'd' low half), mass below. */
  gentleDown(x: number, top: number, rows: number): this {
    for (let i = 0; i < rows; i++) {
      const row = top + i;
      this.set(x + 2 * i, row, 'c');
      this.set(x + 2 * i + 1, row, 'd');
      this.fill(x + 2 * i, x + 2 * i + 2, row + 1, H);
    }
    return this;
  }

  rows(): string[] {
    return this.cells.map((r) => {
      let out = '';
      let i = 0;
      while (i < r.length) {
        let j = i;
        while (j < r.length && r[j] === r[i]) j++;
        out += (j - i > 1 ? String(j - i) : '') + r[i];
        i = j;
      }
      return out;
    });
  }
}

function goal(x: number, y = FLOOR): Entity {
  return { id: 'goal', type: 'goal', x, y, trigger: [x - 0.25, y - 3, x + 1.5, y] };
}

function start(x = 2, y = FLOOR): Entity {
  return { id: 'start', type: 'player_start', x, y };
}

function level(id: string, title: string, grid: Grid, entities: Entity[], rules: Partial<GameRules> = {}): LevelV2 {
  const screens = grid.w / 48;
  const lv: LevelV2 = {
    format: 'dal-level', schema_version: 2, core_min: '2.0.0', id, version: 1, game_id: null, parent_id: null, order_index: 0,
    title, author: 'showcase', created_at: '2026-10-10T00:00:00Z', license: 'CC0-1.0',
    world: { cell: 16, screens, w: grid.w, h: 27 },
    rules: { ...DEFAULT_RULES, ...rules, abilities: { ...DEFAULT_RULES.abilities, ...(rules.abilities ?? {}) } },
    source: { kind: 'canvas', prompt: null, pack_id: null, sheets: Array.from({ length: screens }, (_, i) => ({ index: i, photo_url: null, qr: null })) },
    setpieces: [], design: null, embedded_library: [],
    compiled: { tiles: { legend: '.#=/\\abcd~X', rows: grid.rows() }, entities, triggers: [], sprites: { player: null, objects: {} } },
    meta: { transcript: '', intent: null, safety: 'unchecked', level_hash: '', core_version: CORE_VERSION, warnings: [], build: null },
  };
  try {
    lv.meta.level_hash = levelHash(lv);
  } catch {
    /* the hash is informative on the dev page */
  }
  return lv;
}

export interface Showcase {
  key: string;
  title: string;
  what: string; // one line for the dev page
  level: LevelV2;
}

function stompChains(): Showcase {
  const g = new Grid(1).ground(0, 24).ground(36, 48);
  g.ground(24, 36, 25); // a low pit floor carrying spikes
  const e: Entity[] = [
    start(),
    { id: 'w1', type: 'enemy', archetype: 'walker', x: 10, y: FLOOR, w: 1.5, h: 1.25, spiky: false, params: { speed: 1.5, ledge_aware: true }, bounds: [6, 14] },
    { id: 'w2', type: 'enemy', archetype: 'walker', x: 14, y: FLOOR, w: 1.5, h: 1.25, spiky: false, params: { speed: 1.5, ledge_aware: true }, bounds: [11, 18] },
    { id: 'w3', type: 'enemy', archetype: 'walker', x: 18, y: FLOOR, w: 1.5, h: 1.25, spiky: false, params: { speed: 1.5, ledge_aware: true }, bounds: [15, 22] },
    { id: 'pit_spikes', type: 'spikes', host: null, face: 'top', x0: 24, x1: 36, y: 25, facing: 'up' },
    { id: 'f1', type: 'enemy', archetype: 'flyer', x: 26.5, y: 19.5, w: 1, h: 1, spiky: false, params: { pattern: 'hover' }, bounds: null },
    { id: 'f2', type: 'enemy', archetype: 'flyer', x: 30, y: 18.5, w: 1, h: 1, spiky: false, params: { pattern: 'hover' }, bounds: null },
    { id: 'f3', type: 'enemy', archetype: 'flyer', x: 33.5, y: 19.5, w: 1, h: 1, spiky: false, params: { pattern: 'hover' }, bounds: null },
    { id: 'chain_coin', type: 'big_coin', x: 30, y: 13.5 },
    goal(45),
  ];
  return { key: 'stomp', title: 'Stomp chains', what: 'three walkers in a row, then a spike pit crossed only by bouncing off three flyers; a big coin rewards a held chain', level: level('lvl_show_stomp', 'Stomp chains', g, e) };
}

function archetypes(): Showcase {
  const g = new Grid(2).ground(0, 96);
  g.ledge(57, 64, 18, '='); // the shooter's perch
  g.fill(76, 84, 14, 15, '#'); // the crusher's ceiling
  g.fill(46, 47, 19, 22, '#'); // a low wall the chaser must hop
  const e: Entity[] = [
    start(),
    { id: 'walker', type: 'enemy', archetype: 'walker', x: 14, y: FLOOR, w: 1.5, h: 1.25, spiky: false, params: { speed: 2, ledge_aware: true }, bounds: [10, 20] },
    { id: 'hopper', type: 'enemy', archetype: 'hopper', x: 27, y: FLOOR, w: 1.25, h: 1.25, spiky: false, params: { interval: 1.6, forward: true }, bounds: [23, 31] },
    { id: 'flyer', type: 'enemy', archetype: 'flyer', x: 38, y: 18, w: 1, h: 1, spiky: false, params: { pattern: 'horizontal', range: 4, speed: 2 }, bounds: null },
    { id: 'shooter', type: 'enemy', archetype: 'shooter', x: 61, y: 18, w: 1.25, h: 1.25, spiky: false, params: { interval: 2.5, facing: 'toward_player', blob_speed: 5 }, bounds: null },
    { id: 'chaser', type: 'enemy', archetype: 'chaser', x: 70, y: FLOOR, w: 1.5, h: 1.5, spiky: false, params: { speed: 4, sight: 8 }, bounds: [66, 75] },
    { id: 'crusher', type: 'enemy', archetype: 'crusher', x: 80, y: 17, w: 2, h: 2, spiky: false, params: { warn: 0.5, rise_speed: 2 }, bounds: null },
    { id: 'spiky_walker', type: 'enemy', archetype: 'walker', x: 88, y: FLOOR, w: 1.5, h: 1.25, spiky: true, params: { speed: 1.5, ledge_aware: true }, bounds: [86, 91] },
    goal(93),
  ];
  return { key: 'archetypes', title: 'Six archetypes', what: 'walker, hopper, flyer, shooter (perched), chaser (behind a low wall), crusher (under a ceiling) and a spiky walker you must not stomp', level: level('lvl_show_arch', 'Six archetypes', g, e) };
}

function spikesSlopes(): Showcase {
  const g = new Grid(2).ground(0, 52);
  g.fill(15, 25, 16, 18, '#'); // a ceiling block with spikes underneath: walk under, don't jump
  g.fill(28, 30, 19, 22, '#'); // a 3-row wall with spikes on its left face
  g.fill(32, 34, 19, 22, '#'); // and one with spikes on its right face (hop from top to top)
  g.ledge(36, 41, 18).ledge(42, 47, 15); // one-way ledges (jump up through them)
  g.rampUp(52, FLOOR, 4); // 45° up to row 18
  g.ground(56, 64, 18);
  g.gentleDown(64, 18, 4); // 1:2 back down to row 22
  g.ground(72, 96);
  const e: Entity[] = [
    start(),
    { id: 'sp_up', type: 'spikes', host: null, face: 'top', x0: 8, x1: 11, y: FLOOR, facing: 'up' },
    { id: 'sp_down', type: 'spikes', host: null, face: 'bottom', x0: 16, x1: 24, y: 18, facing: 'down' },
    { id: 'sp_left', type: 'spikes', host: null, face: 'left', x0: 19, x1: 22, y: 28, facing: 'left' },
    { id: 'sp_right', type: 'spikes', host: null, face: 'right', x0: 19, x1: 22, y: 34, facing: 'right' },
    { id: 'sp_ledge', type: 'spikes', host: null, face: 'top', x0: 59, x1: 61, y: 18, facing: 'up' },
    { id: 'c1', type: 'coin', x: 44.5, y: 13.5 },
    { id: 'c2', type: 'coin', x: 54, y: 17.5 },
    { id: 'c3', type: 'coin', x: 67, y: 18 },
    goal(93),
  ];
  return { key: 'spikes', title: 'Spikes, one-ways, slopes', what: 'spikes facing up, down, left and right (6 px bands), two one-way ledges, a 45° ramp up and a 1:2 slope down', level: level('lvl_show_spikes', 'Spikes, one-ways, slopes', g, e) };
}

function crumbleSprings(): Showcase {
  const g = new Grid(2).ground(0, 10).ground(21, 44).ground(56, 96);
  g.ledge(26, 31, 19, '='); // a spring bounce without holding Jump (≈ 3.7 rows) reaches this
  g.ledge(35, 41, 16, '='); // only a held bounce (≈ 7 rows) reaches this: a normal jump tops out near 4.5
  const e: Entity[] = [
    start(),
    { id: 'cr1', type: 'crumble', x: 11, y: 21, w: 2, delay_s: 0.5, respawn_s: 3, one_way: true },
    { id: 'cr2', type: 'crumble', x: 14.5, y: 21, w: 2, delay_s: 0.5, respawn_s: 3, one_way: true },
    { id: 'cr3', type: 'crumble', x: 18, y: 21, w: 2, delay_s: 0.5, respawn_s: 3, one_way: true },
    { id: 'spring_low', type: 'spring', x: 25, y: FLOOR, dir: 'up', strength: 1.0, w: 1 },
    { id: 'spring_high', type: 'spring', x: 34, y: FLOOR, dir: 'up', strength: 1.0, w: 1 },
    { id: 'high_coin', type: 'big_coin', x: 38, y: 14.5 },
    { id: 'spring_side', type: 'spring', x: 43, y: FLOOR, dir: 'right', strength: 1.0, w: 1 },
    { id: 'fall1', type: 'falling_platform', x: 46, y: 21, w: 2, delay_s: 0.4, one_way: true },
    { id: 'fall2', type: 'falling_platform', x: 50, y: 20, w: 2, delay_s: 0.4, one_way: true },
    { id: 'fall3', type: 'falling_platform', x: 53.5, y: 21, w: 2, delay_s: 0.4, one_way: true },
    goal(93),
  ];
  return { key: 'crumble', title: 'Crumble, fall, springs', what: 'a crumble bridge over a pit, springs held vs not held (two ledge heights), a side spring and falling platforms', level: level('lvl_show_crumble', 'Crumble, fall, springs', g, e) };
}

function moversHazards(): Showcase {
  const g = new Grid(2).ground(0, 12).ground(24, 52).ground(56, 96);
  g.ledge(44, 50, 12, '#'); // the lift's top ledge with the key
  g.fill(64, 66, 18, 22, '#'); // the firebar's block
  const e: Entity[] = [
    start(),
    { id: 'ferry', type: 'moving_platform', x: 12, y: 21, w: 3, path: [[12, 21], [21, 21]], speed: 2.5, mode: 'pingpong', wait_s: 0.3, one_way: true },
    { id: 'saw_path', type: 'saw', x: 30, y: 20.5, r: 1, path: [[28, 20.5], [36, 20.5]], speed: 3, mode: 'pingpong' },
    { id: 'saw_static', type: 'saw', x: 40, y: 17, r: 0.75 },
    { id: 'lift', type: 'moving_platform', x: 41, y: 21, w: 2, path: [[41, 21], [41, 12]], speed: 2, mode: 'pingpong', wait_s: 0.5, one_way: true },
    { id: 'key', type: 'key', x: 47, y: 11, door: 'door' },
    { id: 'gap_ferry', type: 'moving_platform', x: 52, y: 21, w: 2, path: [[52, 21], [54, 21]], speed: 1.5, mode: 'pingpong', wait_s: 0.3, one_way: true },
    { id: 'firebar', type: 'firebar', x: 65, y: 17.5, balls: 5, speed_deg_s: 90, phase: 0 },
    { id: 'door', type: 'door', x: 80, y: 17, w: 1, h: 5, key: 'key' },
    goal(93),
  ];
  return { key: 'movers', title: 'Movers, saws, firebar, key/door', what: 'a ferry, a path saw and a static saw, a lift up to the key, a firebar, then the locked door before the goal', level: level('lvl_show_movers', 'Movers, saws, firebar, key/door', g, e) };
}

function stakes(): Showcase {
  const g = new Grid(2).ground(0, 96);
  g.ledge(20, 26, 17, '=');
  g.ledge(66, 72, 16, '=');
  const e: Entity[] = [
    start(),
    { id: 'sp1', type: 'spikes', host: null, face: 'top', x0: 12, x1: 15, y: FLOOR, facing: 'up' },
    { id: 'bc1', type: 'big_coin', x: 23, y: 15.5 },
    { id: 'cp1', type: 'checkpoint', x: 32, y: FLOOR },
    { id: 'sp2', type: 'spikes', host: null, face: 'top', x0: 38, x1: 46, y: FLOOR, facing: 'up' },
    { id: 'bc2', type: 'big_coin', x: 42, y: 18 },
    { id: 'w1', type: 'enemy', archetype: 'walker', x: 52, y: FLOOR, w: 1.5, h: 1.25, spiky: false, params: { speed: 2, ledge_aware: true }, bounds: [48, 58] },
    { id: 'cp2', type: 'checkpoint', x: 62, y: FLOOR },
    { id: 'bc3', type: 'big_coin', x: 69, y: 14.5 },
    { id: 'sp3', type: 'spikes', host: null, face: 'top', x0: 76, x1: 80, y: FLOOR, facing: 'up' },
    ...Array.from({ length: 6 }, (_, i): Entity => ({ id: `coin${i}`, type: 'coin', x: 83 + i, y: 19.5 - Math.sin((i / 5) * Math.PI) * 2 })),
    goal(93),
  ];
  return {
    key: 'stakes', title: 'Checkpoints, big coins, hearts, lives',
    what: '3 lives and 3 hearts; big coins bank at the next checkpoint (die before it and they return); spikes to take a hit on',
    level: level('lvl_show_stakes', 'Checkpoints, big coins, hearts, lives', g, e, { lives: 3, hearts: 3 }),
  };
}

let cache: Showcase[] | null = null;

export function showcaseLevels(): Showcase[] {
  cache ??= [stompChains(), archetypes(), spikesSlopes(), crumbleSprings(), moversHazards(), stakes()];
  return cache;
}
