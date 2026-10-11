/**
 * Beat layout (§8.3 step 2, `core/generate/layout.ts`): a clamped LevelPlan → geometry primitives, laid left to right
 * along a ground spine (top row 22 by default) that tracks rises and falls.
 *
 * - The plan picks pacing and content; this code picks every coordinate, from the physics envelope (beats.ts
 *   clamps) and the beat recipes below, so a draft is playable by construction and proved by the bot afterwards.
 * - `flat` and `rest` beats stretch or trim so the level fills 48·screens; beats that still do not fit are dropped
 *   from the end (never the goal). The ground runs on to the world's right edge after the goal.
 * - Checkpoints follow P1: inserted at section starts (test / twist / finale) once ≥ 24 cells in, ≤ 1 per screen,
 *   every ~56 cells at most, on a 5-cell flat; explicit `checkpoint` beats count.
 * - The latest key is linked to the next door (a door with no key first gets a guarded key).
 * - Starter World overrides (`LayoutOverrides`) add per-beat recipe parameters (`patches`) and extra drawn things
 *   (`draw`: big coins, signs, ledges, coins, springs …) positioned absolutely or relative to a beat.
 *
 * Coordinates are cells; a ground or ledge `y` is its top row (the feet line), a ceiling's is its underside.
 */
import { GRIDS, PROMPT_LEVEL, WORLD } from '../params.ts';
import type { PhysicsProfile } from '../sim/types.ts';
import type { Beat, Behavior, BNpc, EnemyParams, Face, LevelPlan, PickupEffect, ZoneEffect } from '../types.gen.ts';
import { gMax } from '../edits/envelope.ts';
import { bandOf } from './beats.ts';
import type { PlanBand } from './beats.ts';

const L = PROMPT_LEVEL.layout;
const C = PROMPT_LEVEL.clamps;

export type Pt = [number, number];

export type Prim =
  | { k: 'ground'; pts: Pt[]; beat: string }
  | { k: 'platform'; x0: number; x1: number; y: number; solid: boolean; beat: string; move?: { dir: 'left' | 'right' | 'up' | 'down'; cells: number; speed: number }; crumble?: { delay_s: number }; falling?: boolean }
  | { k: 'mass'; x0: number; x1: number; y0: number; y1: number; beat: string } // a solid rock block (ceilings, cave roofs)
  | { k: 'wall'; x: number; y0: number; y1: number; beat: string; door?: string }
  | { k: 'spikes'; a0: number; a1: number; at: number; face: Face; beat: string } // along the face; `at` = face line
  | { k: 'lava'; x0: number; x1: number; y: number; beat: string }
  | { k: 'coin'; x: number; y: number; beat: string }
  | { k: 'big_coin'; x: number; y: number; beat: string }
  | { k: 'enemy'; x: number; y: number; arch: 'walker' | 'hopper' | 'flyer' | 'shooter' | 'chaser' | 'crusher' | 'static'; params: EnemyParams; w: number; h: number; spiky: boolean; beat: string }
  | { k: 'saw'; x: number; y: number; r: number; dir: 'left' | 'right' | 'up' | 'down' | 'none'; cells: number; speed: number; beat: string }
  | { k: 'firebar'; x: number; y: number; balls: number; speed: number; phase: number; beat: string }
  | { k: 'spring'; x: number; y: number; strength: number; beat: string }
  | { k: 'key'; x: number; y: number; tag: string; door: string | null; beat: string }
  | { k: 'flag'; x: number; y: number; role: 'goal' | 'checkpoint'; beat: string }
  | { k: 'sign'; text: string; x: number; y: number; beat: string }
  // v4 (CONTRACTS_V4 §5): a portal, zone, pickup or npc drawn as ink that carries its behaviour; box in cells
  | { k: 'v4'; x0: number; y0: number; x1: number; y1: number; rule: Behavior; beat: string };

export interface Span {
  addr: string; // "<section>.<beat>" (0-based), "start", "cp<n>" (auto checkpoint), "rest" (auto filler)
  s: number;
  b: number;
  kind: Beat['kind'] | 'start';
  x0: number;
  x1: number;
  y0: number; // ground top at the start
  y1: number; // ground top at the end
}

/** A Starter World author's extras (shared/starter/L*.overrides.json, README there). */
export interface DrawSpec {
  kind: 'big_coin' | 'coin' | 'coins' | 'platform' | 'sign' | 'spikes' | 'enemy' | 'spring' | 'saw' | 'firebar' | 'mass' | 'wall' | 'lava'
    | 'portal' | 'zone' | 'pickup' | 'npc'; // v4
  beat?: string; // anchor: that beat's start x and ground row; else absolute
  x?: number;
  y?: number;
  dx?: number;
  dy?: number; // rows, negative = up
  x1?: number;
  w?: number;
  h?: number;
  n?: number;
  apex?: number;
  text?: string;
  solid?: boolean;
  face?: Face;
  arch?: 'walker' | 'hopper' | 'flyer' | 'shooter' | 'chaser' | 'crusher' | 'static';
  params?: EnemyParams;
  spiky?: boolean;
  dir?: 'left' | 'right' | 'up' | 'down' | 'none';
  cells?: number;
  speed?: number;
  r?: number;
  balls?: number;
  phase?: number;
  strength?: number;
  move?: { dir: 'left' | 'right' | 'up' | 'down'; cells: number; speed: number };
  crumble?: { delay_s: number };
  // v4 primitives: portal `pair`; zone `effect` (+ dir, strength); pickup `item`, `effect`, `seconds`; npc `lines`, `name`
  pair?: string;
  effect?: ZoneEffect | PickupEffect;
  item?: string;
  seconds?: number;
  lines?: string[];
  name?: string;
}

export interface LayoutOverrides {
  patches?: ({ beat: string } & Record<string, unknown>)[];
  draw?: DrawSpec[];
  drop?: string[]; // generated primitive tags to leave out (rarely needed)
}

export interface Layout {
  plan: LevelPlan;
  prims: Prim[];
  spans: Span[];
  world: { screens: number; w: number };
  goalX: number;
  dropped: string[]; // beat addresses that did not fit
}

type Bridge = Extract<Beat, { kind: 'moving_bridge' }>;

function q(x: number): number {
  return Math.round(x * 16) / 16;
}

/** One layout pass (the spine walker). */
class Spine {
  x = 0;
  y: number = L.ground_row;
  run: Pt[] | null = null;
  readonly prims: Prim[] = [];
  readonly spans: Span[] = [];
  flatLen = 0; // the flat stretch behind the cursor at the current height (runway)
  keys: { tag: string; prim: Extract<Prim, { k: 'key' }> }[] = [];
  tagN = 0;
  lastCp = 0;
  cpScreens = new Set<number>();
  beat = 'start';
  skipped: string[] = [];
  readonly band: PlanBand;
  readonly p: PhysicsProfile;
  readonly canRun: boolean;
  readonly W: number;
  readonly patch: Map<string, Record<string, unknown>>;

  constructor(band: PlanBand, p: PhysicsProfile, canRun: boolean, W: number, patch: Map<string, Record<string, unknown>>) {
    this.band = band;
    this.p = p;
    this.canRun = canRun;
    this.W = W;
    this.patch = patch;
    this.run = [[0, this.y]];
  }

  P(key: string): unknown {
    return this.patch.get(this.beat)?.[key];
  }

  num(key: string, def: number): number {
    const v = this.P(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  }

  str<T extends string>(key: string, allowed: readonly T[], def: T): T {
    const v = this.P(key);
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
  }

  push(p: Prim): void {
    this.prims.push(p);
  }

  // ---- the ground spine ----
  point(x: number, y: number): void {
    if (!this.run) this.run = [[x, y]];
    const r = this.run;
    const last = r[r.length - 1];
    if (last[0] === x && last[1] === y) return;
    const prev = r.length >= 2 ? r[r.length - 2] : null;
    if (prev && last[1] === y && prev[1] === y && x > last[0]) last[0] = x;
    else r.push([x, y]);
  }

  flat(len: number): void {
    if (len <= 0) return;
    const l = Math.min(len, Math.max(0, this.W - this.x));
    if (l <= 0) return;
    if (!this.run) this.run = [[this.x, this.y]];
    this.x += l;
    this.point(this.x, this.y);
    this.flatLen += l;
  }

  /** A vertical step at the cursor: dy rows (negative = up). Clamped to the spine's row bounds. */
  step(dy: number): number {
    const to = Math.max(L.min_row, Math.min(L.max_row, this.y + dy));
    if (to === this.y) return 0;
    if (!this.run) this.run = [[this.x, this.y]];
    this.point(this.x, this.y);
    this.point(this.x, to);
    const d = to - this.y;
    this.y = to;
    this.flatLen = 0;
    return d;
  }

  endRun(): void {
    const r = this.run;
    if (r && r.length >= 2 && r[r.length - 1][0] - r[0][0] >= 1) this.push({ k: 'ground', pts: r.map((p) => [p[0], p[1]] as Pt), beat: this.beat });
    this.run = null;
  }

  gap(w: number): void {
    this.endRun();
    this.x += w;
    this.run = [[this.x, this.y]];
    this.flatLen = 0;
  }

  /** A void gap whose far side starts at row `y2`. */
  gapTo(w: number, y2: number): void {
    this.endRun();
    this.x += w;
    this.y = Math.max(L.min_row, Math.min(L.max_row, y2));
    this.run = [[this.x, this.y]];
    this.flatLen = 0;
  }

  ensureFlat(n: number): void {
    if (this.flatLen < n) this.flat(n - this.flatLen);
  }

  // ---- things ----
  coinRow(x0: number, x1: number, y: number, n: number): void {
    if (n <= 0) return;
    const step = n > 1 ? Math.min(1.5, (x1 - x0) / (n - 1)) : 0;
    const mid = (x0 + x1) / 2;
    for (let i = 0; i < n; i++) this.push({ k: 'coin', x: q(mid + (i - (n - 1) / 2) * step), y: q(y), beat: this.beat });
  }

  /** Coins along a jump arc from (x0, y0) to (x1, y1) (feet lines) peaking `apex` rows above the higher end. */
  coinArc(x0: number, y0: number, x1: number, y1: number, apex: number, n: number): void {
    if (n <= 0) return;
    const top = Math.min(y0, y1) - apex;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : (i + 0.5) / n;
      const x = x0 + (x1 - x0) * t;
      // a parabola through (0, y0), (1, y1) with its vertex near `top`
      const base = y0 + (y1 - y0) * t;
      const lift = 4 * t * (1 - t) * (Math.min(y0, y1) - top + Math.abs(y1 - y0) / 2);
      this.push({ k: 'coin', x: q(x), y: q(base - lift - 0.9), beat: this.beat });
    }
  }

  spikesTop(x0: number, x1: number, y: number): void {
    if (x1 - x0 < 0.5) return;
    this.push({ k: 'spikes', a0: q(x0), a1: q(x1), at: y, face: 'top', beat: this.beat });
  }

  enemy(x: number, feet: number, arch: Extract<Prim, { k: 'enemy' }>['arch'], params: EnemyParams = {}, size: [number, number] = [1.5, 1.25], spiky = false): void {
    this.push({ k: 'enemy', x: q(x), y: q(feet), arch, params, w: size[0], h: size[1], spiky, beat: this.beat });
  }

  flag(x: number, role: 'goal' | 'checkpoint'): void {
    this.push({ k: 'flag', x: q(x), y: this.y, role, beat: this.beat });
    if (role === 'checkpoint') {
      this.lastCp = x;
      this.cpScreens.add(Math.floor(x / WORLD.screen_w));
    }
  }

  speedOf(kind: 'walker' | 'flyer' | 'chaser' | 'platform' | 'saw'): number {
    const e = C.enemy_speed[this.band] as 'slow' | 'normal' | 'fast';
    const grid = kind === 'walker' ? GRIDS.walker_speed : kind === 'flyer' ? GRIDS.flyer_speed : kind === 'chaser' ? GRIDS.chaser_speed : kind === 'platform' ? GRIDS.platform_speed : GRIDS.saw_speed;
    return grid.enum[e];
  }

  newTag(prefix: string): string {
    this.tagN++;
    return `${prefix}${this.tagN}`;
  }

  // ---- beats ----
  layBeat(b: Beat): void {
    switch (b.kind) {
      case 'flat':
        return this.flatBeat(b.length, b.enemy, b.coins, b.spikes);
      case 'rest': {
        const len = b.length;
        this.flat(len);
        if (len >= 6 && this.num('coins', 3) > 0) this.coinRow(this.x - len + 1.5, this.x - 1.5, this.y - 1.5, Math.min(this.num('coins', 3), Math.floor(len / 2)));
        return;
      }
      case 'gap':
        return this.gapBeat(b.width, b.floor);
      case 'step':
        return this.stepBeat(b.rise, b.length);
      case 'stairs': {
        for (let i = 0; i < b.n; i++) {
          if (b.rise > 0) this.ensureFlat(1);
          if (b.rise > 0 && this.y - b.rise < L.min_row) this.step(Math.abs(b.rise));
          else this.step(-b.rise);
          this.flat(b.run);
        }
        const coins = this.num('coins', 0);
        if (coins > 0) this.coinRow(this.x - b.run + 0.5, this.x - 0.5, this.y - 1.5, coins);
        return;
      }
      case 'pillars':
        return this.pillarsBeat(b.n, b.spacing, b.hazard);
      case 'floaters':
        return this.floatersBeat(b.n, b.dy, b.spacing, b.oneway);
      case 'ceiling':
        return this.ceilingBeat(b.length, b.spikes, b.headroom);
      case 'wall': {
        this.ensureFlat(2);
        const h = Math.max(1, Math.min(b.height, this.y - L.min_row));
        const x = this.x;
        this.push({ k: 'wall', x, y0: this.y - h, y1: this.y, beat: this.beat });
        if (b.spikes === 'near_face' && h >= 2) this.push({ k: 'spikes', a0: this.y - h, a1: this.y - h + Math.min(2, h - 1), at: x, face: 'left', beat: this.beat });
        this.flat(1);
        this.flatLen = 0;
        this.flat(3);
        return;
      }
      case 'moving_bridge':
        return b.vertical ? this.liftBeat(b) : this.ferryBeat(b);
      case 'crumble_run':
        return this.crumbleBeat(b.n, b.floor);
      case 'saw_corridor':
        return this.sawBeat(b.length, b.saws);
      case 'tower':
        return this.towerBeat(b.tiers, b.rise, b.oneway);
      case 'enemy_gauntlet':
        return this.gauntletBeat(b.archetype, b.n);
      case 'spring_up': {
        this.ensureFlat(2);
        const h = Math.max(2, Math.min(b.height, this.y - L.min_row));
        const sx = this.x + 1;
        this.push({ k: 'spring', x: q(sx + 0.5), y: this.y, strength: this.num('strength', 1.0), beat: this.beat });
        this.flat(3);
        this.step(-h);
        this.flat(3);
        return;
      }
      case 'key':
        return this.keyBeat(b.place);
      case 'door':
        return this.doorBeat();
      case 'checkpoint': {
        this.ensureFlat(1);
        const x0 = this.x;
        this.flat(L.checkpoint_flat_c + 1);
        this.flag(x0 + 2.5, 'checkpoint');
        return;
      }
      case 'goal': {
        if (b.style === 'staircase') {
          for (let i = 0; i < 3; i++) {
            this.ensureFlat(1);
            this.step(-1);
            this.flat(2);
          }
          const x0 = this.x;
          this.flat(4);
          this.flag(x0 + 1.5, 'goal');
        } else {
          this.ensureFlat(1);
          const x0 = this.x;
          this.flat(5);
          this.flag(x0 + 2.5, 'goal');
        }
        return;
      }
    }
  }

  flatBeat(len0: number, enemy: 'none' | 'walker' | 'hopper' | 'chaser', coins: number, spikes: 'none' | 'middle' | 'far_end'): void {
    const sw = this.num('spikes_w', C.spikes_w_c[this.band]);
    let len = len0;
    if (enemy !== 'none') len = Math.max(len, enemy === 'hopper' ? 6 : 8);
    if (spikes !== 'none') len = Math.max(len, sw + 4 + (enemy !== 'none' ? 6 : 0));
    const x0 = this.x;
    this.flat(len);
    const y = this.y;
    let ex = -1;
    if (enemy !== 'none') {
      ex = x0 + len * this.num('enemy_at', spikes !== 'none' ? 0.3 : 0.55);
      const params: EnemyParams = enemy === 'hopper' ? { interval: this.num('enemy_interval', GRIDS.hopper_interval.enum[C.enemy_speed[this.band] as 'normal']) } : { speed: this.num('enemy_speed', this.speedOf(enemy === 'chaser' ? 'chaser' : 'walker')) };
      this.enemy(ex, y, enemy, params);
    }
    let s0 = -1;
    let s1 = -1;
    if (spikes !== 'none') {
      const c = spikes === 'middle' ? x0 + len * (enemy !== 'none' ? 0.72 : 0.5) : x0 + len - 2 - sw / 2;
      s0 = Math.round(c - sw / 2);
      s1 = s0 + sw;
      this.spikesTop(s0, s1, y);
    }
    if (coins > 0) {
      const arc = this.str('coin_arc', ['stomp', 'row', 'jump'] as const, ex >= 0 ? 'stomp' : spikes !== 'none' ? 'jump' : 'row');
      if (arc === 'stomp' && ex >= 0) this.coinArc(ex - 1.5, y - 1.25, ex + 3.5, y, 3.2, coins);
      else if (arc === 'jump' && s0 >= 0) this.coinArc(s0 - 1.5, y, s1 + 1.5, y, 2.6, coins);
      else this.coinRow(x0 + 1, x0 + len - 1, y - 1.5, coins);
    }
  }

  gapBeat(w0: number, floor: 'void' | 'spikes' | 'lava'): void {
    let w = w0;
    if (!this.canRun) w = Math.min(w, gMax(this.p, 0, { run: false }));
    const need = w >= 5 ? (this.band === 'hard' ? C.gap_runway_c.hard : C.gap_runway_c.normal_from_width5) : 1;
    this.ensureFlat(Math.max(need, this.num('runway', need)));
    w = Math.max(2, Math.min(w, gMax(this.p, this.canRun ? Math.min(3, this.flatLen) : 0, { run: this.canRun })));
    const x0 = this.x;
    const y = this.y;
    const coins = this.num('coins', 0);
    if (floor === 'spikes') {
      const d = this.step(Math.min(L.pit_depth_rows, L.max_row + 1 - y));
      this.flat(w);
      this.spikesTop(x0, x0 + w, this.y);
      this.step(-d);
    } else {
      this.gap(w);
      if (floor === 'lava') this.push({ k: 'lava', x0, x1: x0 + w, y: y + L.lava_drop_rows, beat: this.beat });
    }
    if (coins > 0) this.coinArc(x0 - 1, y, x0 + w + 1, y, w >= 5 ? 3.2 : 2.4, coins);
    this.flat(Math.max(2, this.num('landing', 2)));
  }

  stepBeat(rise: number, len: number): void {
    if (rise > 0) {
      this.ensureFlat(2);
      if (this.y - rise < L.min_row) this.step(rise);
      else this.step(-rise);
    } else this.step(-rise);
    this.flat(len);
    const coins = this.num('coins', 0);
    if (coins > 0) this.coinRow(this.x - len + 0.5, this.x - 0.5, this.y - 1.5, coins);
  }

  pillarsBeat(n: number, spacing: number, hazard: 'void' | 'spikes' | 'lava'): void {
    const pw = this.num('pillar_w', C.pillar_w_c[this.band]);
    this.ensureFlat(2);
    const y = this.y;
    // hard: every other pillar stands a row higher, so the rhythm is up-down
    const top = (i: number): number => (i >= n ? y : this.band === 'hard' && i % 2 === 1 ? y - 1 : y);
    for (let i = 0; i <= n; i++) {
      const x0 = this.x;
      if (hazard === 'spikes') {
        this.step(Math.min(y + L.pit_depth_rows, L.max_row) - this.y);
        this.flat(spacing);
        this.spikesTop(x0, x0 + spacing, this.y);
        this.step(top(i) - this.y);
      } else {
        this.gapTo(spacing, top(i));
        if (hazard === 'lava') this.push({ k: 'lava', x0, x1: x0 + spacing, y: y + L.lava_drop_rows, beat: this.beat });
      }
      if (i < n) this.flat(pw);
    }
    this.flat(2);
  }

  floatersBeat(n: number, dy: number, spacing: number, oneway: boolean): void {
    const fw = this.num('floater_w', C.floater_w_c[this.band]);
    const over = this.str('over', ['void', 'spikes', 'ground'] as const, 'void');
    this.ensureFlat(2);
    const y = this.y;
    const x0 = this.x;
    const width = spacing + n * (fw + spacing);
    const offs: number[] = [];
    for (let i = 0; i < n; i++) offs.push(Math.min(dy * (i % 2 === 0 ? 1 : 2), y - L.min_row));
    if (over === 'void') this.gap(width);
    else {
      const d = over === 'spikes' ? this.step(Math.min(L.pit_depth_rows, L.max_row + 1 - y)) : 0;
      this.flat(width);
      if (over === 'spikes') {
        this.spikesTop(x0, x0 + width, this.y);
        this.step(-d);
      }
    }
    let x = x0 + spacing;
    for (let i = 0; i < n; i++) {
      this.push({ k: 'platform', x0: x, x1: x + fw, y: y - offs[i], solid: !oneway, beat: this.beat });
      const coins = this.num('coins', 0);
      if (coins > 0 && i === n - 1) this.coinRow(x + 0.5, x + fw - 0.5, y - offs[i] - 1.5, Math.min(coins, fw));
      x += fw + spacing;
    }
    this.flat(2);
  }

  ceilingBeat(len: number, spikes: boolean, headroom: number): void {
    this.ensureFlat(2);
    const x0 = this.x;
    const y = this.y;
    const hr = Math.max(2, Math.min(headroom, y - 1));
    this.flat(len);
    const under = y - hr;
    this.push({ k: 'mass', x0, x1: x0 + len, y0: 0, y1: under, beat: this.beat });
    if (spikes) this.push({ k: 'spikes', a0: x0 + 1, a1: x0 + len - 1, at: under, face: 'bottom', beat: this.beat });
    // the tap-hop corridor (L2 twist): 1-cell floor strips under a spiky ceiling a full jump would hit
    const strips = this.P('floor_strips');
    if (spikes && (strips === true || (strips !== false && hr === C.tap_corridor_headroom_c))) {
      const every = this.num('strip_every', 4);
      const sw = this.num('strip_w', 1);
      for (let sx = x0 + 3; sx + sw <= x0 + len - 2; sx += every) this.spikesTop(sx, sx + sw, y);
    }
    const coins = this.num('coins', 0);
    if (coins > 0) this.coinRow(x0 + 1.5, x0 + len - 1.5, y - 1.0, coins);
  }

  ferryBeat(b: Bridge): void {
    const n = Math.max(1, Math.round(this.num('platforms', C.bridge_platforms[this.band])));
    const pw = C.bridge_platform_w_c;
    const speed = this.num('speed_cs', GRIDS.platform_speed.enum[b.speed]);
    this.ensureFlat(2);
    const y = this.y;
    const sub = Math.max(pw + 2, Math.round(b.gap / n));
    for (let i = 0; i < n; i++) {
      const x0 = this.x;
      this.gap(sub);
      this.push({ k: 'platform', x0, x1: x0 + pw, y, solid: true, beat: this.beat, move: { dir: 'right', cells: sub - pw, speed } });
      if ((this.band === 'hard' || this.P('saw') === true) && i === Math.floor(n / 2)) {
        this.push({ k: 'saw', x: q(x0 + sub / 2), y: q(y - 3.25), r: 0.75, dir: 'none', cells: 0, speed: 0, beat: this.beat });
      }
      if (i < n - 1) this.flat(2);
    }
    this.flat(2);
  }

  liftBeat(b: Bridge): void {
    const pw = C.bridge_platform_w_c;
    const speed = this.num('speed_cs', GRIDS.platform_speed.enum[b.speed]);
    this.ensureFlat(2);
    const y = this.y;
    const rise = Math.max(C.lift_rise[0], Math.min(this.num('rise', b.gap - 1), C.lift_rise[1], y - L.min_row));
    const x0 = this.x;
    this.gap(pw);
    this.push({ k: 'platform', x0, x1: x0 + pw, y, solid: true, beat: this.beat, move: { dir: 'up', cells: rise, speed } });
    this.step(-rise);
    this.flat(3);
  }

  crumbleBeat(n: number, floor: 'void' | 'shallow'): void {
    const g = this.num('gap', C.crumble_gap_c[this.band]);
    const cw = Math.max(1, Math.round(this.num('crumble_w', C.crumble_w_c)));
    const delay = this.num('delay_s', C.crumble_delay_s[this.band]);
    this.ensureFlat(2);
    const y = this.y;
    const x0 = this.x;
    const width = g + n * (cw + g);
    if (floor === 'void') this.gap(width);
    else {
      const d = this.step(Math.min(3, L.max_row + 1 - y));
      this.flat(width);
      if (this.P('spring') !== false) this.push({ k: 'spring', x: q(x0 + width - 1), y: this.y, strength: 0.8, beat: this.beat });
      this.step(-d);
    }
    let x = x0 + g;
    for (let i = 0; i < n; i++) {
      this.push({ k: 'platform', x0: x, x1: x + cw, y, solid: true, beat: this.beat, crumble: { delay_s: delay } });
      x += cw + g;
    }
    this.flat(2);
  }

  sawBeat(len: number, saws: number): void {
    const mode = this.str('mode', ['vertical', 'high', 'mixed'] as const, 'vertical');
    const speed = this.num('speed_cs', this.speedOf('saw'));
    const r = this.num('r', this.band === 'hard' ? 1 : 0.75);
    const L0 = Math.max(len, 4 + saws * 4);
    this.ensureFlat(2);
    const x0 = this.x;
    const y = this.y;
    this.flat(L0);
    const step = (L0 - 4) / saws;
    for (let i = 0; i < saws; i++) {
      const sx = q(x0 + 2 + step * (i + 0.5));
      const high = mode === 'high' || (mode === 'mixed' && i % 2 === 1);
      if (high) this.push({ k: 'saw', x: sx, y: q(y - 3.25), r, dir: 'none', cells: 0, speed: 0, beat: this.beat });
      else {
        // ground-level saws ride a short vertical path; alternate phases (start low / start high)
        const path = Math.max(2, Math.min(8, Math.round(this.num('path', C.saw_path_c))));
        const low = q(y - r - 0.05);
        const hi = q(low - path);
        if (i % 2 === 0) this.push({ k: 'saw', x: sx, y: low, r, dir: 'up', cells: path, speed, beat: this.beat });
        else this.push({ k: 'saw', x: sx, y: hi, r, dir: 'down', cells: path, speed, beat: this.beat });
      }
    }
  }

  towerBeat(tiers: number, rise: number, oneway: boolean): void {
    const lw = this.num('ledge_w', C.tower_ledge_w_c);
    const floor = this.str('floor', ['safe', 'spikes'] as const, this.band === 'easy' ? 'safe' : 'spikes');
    this.ensureFlat(2);
    const y = this.y;
    const T = Math.max(1, Math.min(tiers, Math.floor((y - L.min_row) / rise)));
    const x0 = this.x;
    const span = 2 * lw + 1;
    this.flat(span);
    if (floor === 'spikes') this.spikesTop(x0 + 1, x0 + span, y);
    for (let k = 1; k <= T; k++) {
      const left = k % 2 === 1;
      const last = k === T;
      const a = left ? x0 + 1 : x0 + 1 + lw;
      const b = left && !last ? x0 + 1 + lw : x0 + span;
      this.push({ k: 'platform', x0: a, x1: b, y: y - rise * k, solid: !oneway, beat: this.beat });
    }
    this.step(-rise * T);
    this.flat(2);
    const coins = this.num('coins', 0);
    if (coins > 0) this.coinRow(x0 + 1.5, x0 + lw - 0.5, y - rise * 2 - 1.5, coins);
  }

  gauntletBeat(arch: 'walker' | 'hopper' | 'flyer' | 'shooter' | 'chaser' | 'crusher', n: number): void {
    const sp = this.num('spacing', arch === 'shooter' ? 7 : arch === 'flyer' ? 4 : C.gauntlet_spacing_c);
    this.ensureFlat(2);
    const y = this.y;
    const x0 = this.x;
    const len = 4 + sp * n + 2;
    if (arch === 'flyer') {
      const over = this.str('over', ['pit', 'ground'] as const, this.band === 'hard' ? 'pit' : 'ground');
      if (over === 'pit') {
        // a stomp chain over a spike pit: hover flyers a hop apart (bounce −280, −380 held)
        const w = sp * n + 1;
        this.ensureFlat(3);
        const px = this.x;
        const d = this.step(Math.min(L.pit_depth_rows, L.max_row + 1 - y));
        this.flat(w);
        this.spikesTop(px, px + w, this.y);
        this.step(-d);
        for (let i = 0; i < n; i++) this.enemy(px + 1 + sp * i + sp / 2 - 0.5, y - this.num('hover_rows', 0.75), 'flyer', { pattern: 'hover' });
        this.flat(3);
        return;
      }
      this.flat(len);
      for (let i = 0; i < n; i++) this.enemy(x0 + 4 + sp * i, y - 2.5, 'flyer', { pattern: 'horizontal', range: 3, speed: this.speedOf('flyer') });
      return;
    }
    if (arch === 'crusher') {
      const hr = this.num('headroom', 6);
      const under = y - hr;
      this.flat(len);
      this.push({ k: 'mass', x0: x0 + 1, x1: x0 + len - 1, y0: 0, y1: under, beat: this.beat });
      for (let i = 0; i < n; i++) this.enemy(x0 + 4 + sp * i, under + 1.75, 'crusher', { warn: this.num('warn', GRIDS.crusher_warn.enum[C.enemy_speed[this.band] as 'normal']) }, [1.75, 1.75]);
      return;
    }
    this.flat(len);
    for (let i = 0; i < n; i++) {
      const ex = x0 + 4 + sp * i;
      if (arch === 'shooter') this.enemy(ex, y, 'shooter', { facing: 'toward_player', interval: this.num('interval', GRIDS.shooter_interval.enum[C.enemy_speed[this.band] as 'normal']) }, [1.25, 1.5]);
      else if (arch === 'hopper') this.enemy(ex, y, 'hopper', { interval: this.num('interval', GRIDS.hopper_interval.enum[C.enemy_speed[this.band] as 'normal']) });
      else this.enemy(ex, y, arch, { speed: this.num('speed', this.speedOf(arch === 'chaser' ? 'chaser' : 'walker')) });
    }
    const coins = this.num('coins', 0);
    if (coins > 0) this.coinRow(x0 + 2, x0 + len - 2, y - 3.5, coins);
  }

  keyBeat(place: 'high' | 'guarded' | 'alcove'): void {
    const tag = this.newTag('key');
    this.ensureFlat(1);
    const x0 = this.x;
    const y = this.y;
    let kx = x0;
    let ky = y;
    if (place === 'high') {
      this.flat(8);
      const ly = Math.max(L.min_row, y - this.num('ledge_rows', 4));
      this.push({ k: 'platform', x0: x0 + 2, x1: x0 + 6, y: ly, solid: false, beat: this.beat });
      kx = x0 + 4;
      ky = ly - 0.9;
    } else if (place === 'alcove') {
      this.flat(2);
      const d = this.step(Math.min(2, L.max_row - y));
      const ax = this.x;
      this.flat(3);
      this.step(-d);
      this.flat(2);
      kx = ax + 1.5;
      ky = y + d - 0.9;
    } else {
      this.flat(10);
      this.enemy(x0 + 4, y, 'walker', { speed: this.speedOf('walker') });
      kx = x0 + 8;
      ky = y - 0.9;
    }
    const prim: Extract<Prim, { k: 'key' }> = { k: 'key', x: q(kx), y: q(ky), tag, door: null, beat: this.beat };
    this.push(prim);
    this.keys.push({ tag, prim });
  }

  doorBeat(): void {
    if (!this.keys.length) this.keyBeat('guarded');
    const key = this.keys.pop()!;
    const tag = this.newTag('door');
    this.ensureFlat(2);
    const x = this.x;
    this.push({ k: 'wall', x, y0: 1, y1: this.y, beat: this.beat, door: tag });
    key.prim.door = tag;
    this.flat(1);
    this.flatLen = 0;
    this.flat(3);
  }

  autoCheckpoint(): boolean {
    const scr = Math.floor((this.x + 3) / WORLD.screen_w);
    if (this.x < L.checkpoint_min_x_c || this.cpScreens.has(scr) || this.x - this.lastCp < L.checkpoint_every_c * 0.6) return false;
    this.ensureFlat(1);
    const x0 = this.x;
    this.flat(L.checkpoint_flat_c + 1);
    this.flag(x0 + 2.5, 'checkpoint');
    return true;
  }
}

/** Lay a clamped plan once with per-beat stretches; beats in `drop` are skipped. */
function layOnce(plan: LevelPlan, p: PhysicsProfile, canRun: boolean, stretch: Map<string, number>, drop: Set<string>, patch: Map<string, Record<string, unknown>>, extraRest: number): Spine {
  const W = WORLD.screen_w * plan.screens;
  const band = bandOf(plan.band);
  const S = new Spine(band, p, canRun, W, patch);
  S.beat = 'start';
  S.flat(L.start_flat_c);
  S.spans.push({ addr: 'start', s: -1, b: -1, kind: 'start', x0: 0, x1: S.x, y0: L.ground_row, y1: S.y });
  let cpN = 0;
  // authored levels (Starter World) place every checkpoint themselves: `{ "beat": "*", "auto_checkpoints": false }`
  const autoCp = patch.get('*')?.auto_checkpoints !== false;
  plan.sections.forEach((sec, si) => {
    const explicitCp = sec.beats[0]?.kind === 'checkpoint';
    if (autoCp && si > 0 && sec.role !== 'rest' && sec.role !== 'teach' && !explicitCp) {
      const x0 = S.x;
      const y0 = S.y;
      S.beat = `cp${++cpN}`;
      if (S.autoCheckpoint()) S.spans.push({ addr: S.beat, s: si, b: -1, kind: 'checkpoint', x0, x1: S.x, y0, y1: S.y });
    }
    sec.beats.forEach((b0, bi) => {
      const addr = `${si}.${bi}`;
      if (drop.has(addr)) return;
      // never run out of world before the goal: late beats are skipped (the fill pass then drops them for good)
      if (b0.kind !== 'goal' && S.x > S.W - L.goal_room_c) {
        S.skipped.push(addr);
        return;
      }
      let b = b0;
      const st = stretch.get(addr) ?? 0;
      if (st && (b.kind === 'flat' || b.kind === 'rest')) b = { ...b, length: Math.max(3, b.length + st) };
      if (b.kind === 'goal' && extraRest > 0) {
        const x0 = S.x;
        const y0 = S.y;
        S.beat = 'rest';
        S.flat(extraRest);
        if (extraRest >= 6) S.coinRow(x0 + 1.5, S.x - 1.5, S.y - 1.5, Math.min(5, Math.floor(extraRest / 3)));
        S.spans.push({ addr: 'rest', s: si, b: bi, kind: 'rest', x0, x1: S.x, y0, y1: S.y });
      }
      // a long stretch with no checkpoint gets one before its next setpiece (F_s ≤ 30 s)
      if (autoCp && b.kind !== 'checkpoint' && b.kind !== 'goal' && b.kind !== 'rest' && b.kind !== 'flat' && S.x - S.lastCp >= L.checkpoint_every_c * 1.4) {
        const x0 = S.x;
        const y0 = S.y;
        S.beat = `cp${++cpN}`;
        if (S.autoCheckpoint()) S.spans.push({ addr: S.beat, s: si, b: -1, kind: 'checkpoint', x0, x1: S.x, y0, y1: S.y });
      }
      const x0 = S.x;
      const y0 = S.y;
      S.beat = addr;
      S.layBeat(b);
      S.spans.push({ addr, s: si, b: bi, kind: b.kind, x0, x1: S.x, y0, y1: S.y });
    });
  });
  return S;
}

function patchMap(o?: LayoutOverrides): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const p of o?.patches ?? []) if (p && typeof p.beat === 'string') m.set(p.beat, { ...(m.get(p.beat) ?? {}), ...p });
  return m;
}

/** The goal beat's start, the x the level needs (end of the goal beat). */
function endOf(S: Spine): number {
  const g = S.spans.find((s) => s.kind === 'goal');
  return g ? g.x1 : S.x;
}

/**
 * Lay out a clamped plan to fill 48·screens: stretch / trim flat and rest beats, add a filler rest before the
 * goal when the plan is short, drop trailing beats when it is long, then run the ground to the world's edge.
 */
export function layoutPrims(plan: LevelPlan, p: PhysicsProfile, canRun: boolean, o?: LayoutOverrides): Layout {
  const W = WORLD.screen_w * plan.screens;
  const target = W - L.end_tail_c;
  const patch = patchMap(o);
  const stretchable: { addr: string; len: number }[] = [];
  plan.sections.forEach((s, si) => s.beats.forEach((b, bi) => {
    if (b.kind === 'flat' || b.kind === 'rest') stretchable.push({ addr: `${si}.${bi}`, len: b.length });
  }));
  const fixedStretch = (o?.patches ?? []).some((x) => x.beat === '*' && x.stretch === false);
  let stretch = new Map<string, number>();
  const drop = new Set<string>();
  let S = layOnce(plan, p, canRun, stretch, drop, patch, 0);
  let extra = 0;
  for (let pass = 0; pass < 8; pass++) {
    const delta = target - endOf(S) - S.skipped.length * 8;
    if (Math.abs(delta) < 1) break;
    if (fixedStretch && delta > 0) {
      extra = Math.max(0, Math.round(delta));
      S = layOnce(plan, p, canRun, stretch, drop, patch, extra);
      break;
    }
    const next = new Map(stretch);
    let left = Math.round(delta);
    if (delta > 0) {
      const room = (a: { addr: string }): number => L.stretch_max_c - (next.get(a.addr) ?? 0);
      const open = stretchable.filter((a) => room(a) > 0);
      for (let k = 0; k < 64 && left > 0 && open.length; k++) {
        for (const a of open) {
          if (left <= 0) break;
          if (room(a) <= 0) continue;
          next.set(a.addr, (next.get(a.addr) ?? 0) + 1);
          left--;
        }
        if (open.every((a) => room(a) <= 0)) break;
      }
      if (left > 0) extra += left;
    } else {
      const room = (a: { addr: string; len: number }): number => a.len + (next.get(a.addr) ?? 0) - 3;
      for (let k = 0; k < 64 && left < 0; k++) {
        let moved = false;
        for (const a of stretchable) {
          if (left >= 0) break;
          if (room(a) <= 0) continue;
          next.set(a.addr, (next.get(a.addr) ?? 0) - 1);
          left++;
          moved = true;
        }
        if (!moved) break;
      }
      if (left < 0) {
        // still too long: drop the last droppable beat (never the goal), then re-lay
        const order: string[] = [];
        plan.sections.forEach((s, si) => s.beats.forEach((b, bi) => {
          if (b.kind !== 'goal' && !drop.has(`${si}.${bi}`)) order.push(`${si}.${bi}`);
        }));
        const victim = order.reverse().find((a) => {
          const [si, bi] = a.split('.').map(Number);
          const k = plan.sections[si].beats[bi].kind;
          return k !== 'key' && k !== 'door';
        });
        if (victim) drop.add(victim);
      }
    }
    stretch = next;
    S = layOnce(plan, p, canRun, stretch, drop, patch, extra);
  }
  // run the ground to the world's right edge after the goal
  S.beat = 'end';
  if (S.x < W) S.flat(W - S.x);
  S.endRun();
  const goal = S.prims.find((x) => x.k === 'flag' && x.role === 'goal');
  addDrawn(S, o?.draw ?? []);
  return { plan, prims: S.prims, spans: S.spans, world: { screens: plan.screens, w: W }, goalX: goal && goal.k === 'flag' ? goal.x : W - 3, dropped: [...new Set([...drop, ...S.skipped])].sort() };
}

/** Starter World extras, absolute or relative to a beat's start (x, ground row). */
function addDrawn(S: Spine, specs: readonly DrawSpec[]): void {
  for (const d of specs) {
    const span = d.beat ? S.spans.find((s) => s.addr === d.beat) : undefined;
    const ax = span ? span.x0 : 0;
    const ay = span ? span.y0 : 0;
    const x = q(d.x ?? ax + (d.dx ?? 0));
    const y = q(d.y ?? ay + (d.dy ?? 0));
    const beat = d.beat ?? 'draw';
    switch (d.kind) {
      case 'big_coin':
        S.push({ k: 'big_coin', x, y, beat });
        break;
      case 'coin':
        S.push({ k: 'coin', x, y, beat });
        break;
      case 'coins': {
        const n = Math.max(1, Math.min(9, Math.round(d.n ?? 3)));
        const x1 = q(d.x1 !== undefined ? (span && d.x === undefined ? ax + d.x1 : d.x1) : x + (d.w ?? 2 * n));
        S.beat = beat;
        if (d.apex) S.coinArc(x, y + 0.9, x1, y + 0.9, d.apex, n);
        else S.coinRow(x, x1, y, n);
        break;
      }
      case 'platform':
        S.push({ k: 'platform', x0: x, x1: x + Math.max(1, Math.round(d.w ?? 3)), y: Math.round(y), solid: !!d.solid, beat, ...(d.move ? { move: d.move } : {}), ...(d.crumble ? { crumble: d.crumble } : {}) });
        break;
      case 'sign':
        S.push({ k: 'sign', text: String(d.text ?? '').slice(0, 16), x, y, beat });
        break;
      case 'spikes': {
        const face: Face = d.face ?? 'top';
        const len = Math.max(0.5, d.w ?? 2);
        if (face === 'top' || face === 'bottom') S.push({ k: 'spikes', a0: x, a1: x + len, at: Math.round(y), face, beat });
        else S.push({ k: 'spikes', a0: y, a1: y + len, at: Math.round(x), face, beat });
        break;
      }
      case 'enemy':
        S.push({ k: 'enemy', x, y, arch: d.arch ?? 'walker', params: d.params ?? {}, w: d.w ?? 1.5, h: d.h ?? 1.25, spiky: !!d.spiky, beat });
        break;
      case 'spring':
        S.push({ k: 'spring', x, y, strength: d.strength ?? 1.0, beat });
        break;
      case 'saw':
        S.push({ k: 'saw', x, y, r: d.r ?? 0.75, dir: d.dir ?? 'none', cells: d.cells ?? 0, speed: d.speed ?? 3, beat });
        break;
      case 'firebar':
        S.push({ k: 'firebar', x, y, balls: d.balls ?? 4, speed: d.speed ?? 90, phase: d.phase ?? 0, beat });
        break;
      case 'mass':
        S.push({ k: 'mass', x0: x, x1: x + Math.max(1, Math.round(d.w ?? 2)), y0: Math.round(y), y1: Math.round(y) + Math.max(1, Math.round(d.h ?? 1)), beat });
        break;
      case 'wall':
        S.push({ k: 'wall', x: Math.round(x), y0: Math.round(y) - Math.max(1, Math.round(d.h ?? 2)), y1: Math.round(y), beat });
        break;
      case 'lava':
        S.push({ k: 'lava', x0: x, x1: x + Math.max(1, Math.round(d.w ?? 2)), y: Math.round(y), beat });
        break;
      // v4: (x, y) is the centre of a portal or pickup, the top-left of a zone, the feet of an npc
      case 'portal':
        S.push({ k: 'v4', x0: x - 0.95, y0: y - 0.95, x1: x + 0.95, y1: y + 0.95, rule: { kind: 'portal', pair: d.pair ?? 'a' }, beat });
        break;
      case 'pickup':
        S.push({ k: 'v4', x0: x - 0.5, y0: y - 0.5, x1: x + 0.5, y1: y + 0.5, beat,
          rule: { kind: 'pickup', item: d.item ?? 'star', effect: (d.effect as PickupEffect | undefined) ?? 'none', seconds: d.seconds ?? 5 } });
        break;
      case 'zone':
        S.push({ k: 'v4', x0: x, y0: y, x1: x + Math.max(1, d.w ?? 3), y1: y + Math.max(1, d.h ?? 3), beat,
          rule: { kind: 'zone', effect: (d.effect as ZoneEffect | undefined) ?? 'wind', dir: d.dir === 'none' || !d.dir ? 'up' : d.dir, strength: d.strength ?? 1 } });
        break;
      case 'npc':
        S.push({ k: 'v4', x0: x - 0.5, y0: y - 2, x1: x + 0.5, y1: y, beat,
          rule: { kind: 'npc', lines: (d.lines?.length ? d.lines : ['Hi!']).slice(0, 6).map((l) => String(l).slice(0, 90)) as BNpc['lines'], ...(d.name ? { name: d.name.slice(0, 16) } : {}) } });
        break;
    }
  }
}
