/**
 * Static world definition for the sim: the level's tiles and entities resolved into world px with every default
 * filled in (§5.5-5.9, params.ts). Built once per createSim; never mutated while stepping.
 *
 * Entity geometry conventions (cells in the level, px here):
 * - points: coin, big_coin, key, saw, firebar anchor, hint_arrow: (x, y) is the centre;
 * - grounded: player_start, enemy, spring, checkpoint: x is the centre, y the feet line (§2.1); enemy w × h is its
 *   AABB with the feet on y; a flyer's pattern is centred on its initial body centre;
 * - boxes: door (w × h), moving_platform / crumble / falling_platform (w × 1 row): (x, y) is the top-left; a
 *   moving platform's path lists top-left positions;
 * - spikes: x0..x1 run along the face and y is the face line. Up/down faces are horizontal (x0..x1 in x); for
 *   left/right faces the face is vertical: x0..x1 is the vertical extent and y the face's x (docs/v2/requests/A-1.md);
 * - goal: `trigger` is the win rect.
 * - v4 (docs/v4/CONTRACTS_V4.md §5): portal and pickup are centres; zone is a top-left box; npc is x centre + y feet.
 *
 * v4 levels (a mode, rules, v4 entities or hidden entities) set `v4`; every v4 path in the sim is behind it, so a
 * level without v4 fields simulates exactly as in v2.
 */
import { DAMAGE, ENEMIES, HAZARDS } from '../params.ts';
import type { Entity, GameMode, LevelV2, ProfileId, RuleDo, RuleKey, RuleV4, RuleWhen, Trigger, ZoneEffect } from '../types.gen.ts';
import { PROFILES } from './profiles.ts';
import { CELL, TileGrid } from './tiles.ts';
import type { PhysicsProfile } from './types.ts';

export const HZ = 60;
export const DT = 1 / HZ;
export const HALF_W = 6; // collision box 12 × 28 px (§5.4)
export const BODY_H = 28;
export const HURT_HALF_W = 4; // hurtbox 8 × 22 px, inset 2 px at the sides and 6 px at the top
export const HURT_H = 22;
export const ENEMY_G = 1700;
export const ENEMY_MAX_FALL = 400;

export type Rect = [number, number, number, number]; // x0, y0, x1, y1 px, half-open

export type PathMode = 'pingpong' | 'loop';

/** A polyline path traversed at constant speed (moving platforms, saws). */
export interface PathDef {
  pts: [number, number][]; // px
  segs: number[]; // segment lengths px (closed for loop)
  len: number; // total traversal length (one way for pingpong, full loop for loop)
  v: number; // px per frame
  wait: number; // frames at each end (pingpong) / at pts[0] (loop)
  mode: PathMode;
  cycle: number; // frames (float)
}

interface DefBase {
  i: number;
  id: string;
  type: Entity['type'];
}
export interface DSpikes extends DefBase { k: 'spikes'; band: Rect; facing: string; x0: number; x1: number; y: number }
export interface DEnemy extends DefBase {
  k: 'enemy';
  arch: string; // walker | hopper | flyer | shooter | chaser | crusher | static
  x: number; y: number; // centre, feet (px)
  hw: number; h: number; // half width, height (px)
  spiky: boolean;
  speed: number; // px per frame
  ledge: boolean;
  bounds: [number, number] | null; // px, range of the body centre x (lane B insets the host run by half a width)
  interval: number; // frames (hopper, shooter)
  forward: boolean;
  pattern: 'hover' | 'horizontal' | 'vertical' | 'circle';
  range: number; // px (flyer horizontal/vertical)
  radius: number; // px (flyer circle)
  period: number; // frames (flyer circle / hover)
  facing: 'left' | 'right' | 'toward_player';
  blobV: number; // px per frame
  sight: number; // px
  warn: number; // frames
  riseV: number; // px per frame
  cycle: number; // frames, estimated period for the bot (0 when the enemy never moves)
}
export interface DCoin extends DefBase { k: 'coin' | 'big_coin'; x: number; y: number }
export interface DCheckpoint extends DefBase { k: 'checkpoint'; x: number; y: number; box: Rect }
export interface DGoal extends DefBase { k: 'goal'; x: number; y: number; box: Rect }
export interface DKey extends DefBase { k: 'key'; x: number; y: number; doors: number[] }
export interface DDoor extends DefBase { k: 'door'; box: Rect; keys: number[] }
export interface DSpring extends DefBase { k: 'spring'; x: number; y: number; box: Rect; dir: 'up' | 'left' | 'right'; strength: number }
export interface DSaw extends DefBase { k: 'saw'; path: PathDef; rHit: number; r: number }
export interface DFirebar extends DefBase { k: 'firebar'; x: number; y: number; balls: number; turnsPerF: number; phase: number; cycle: number }
export interface DPlatform extends DefBase {
  k: 'moving_platform' | 'crumble' | 'falling_platform';
  x: number; y: number; w: number; h: number; // top-left px, size px
  oneWay: boolean;
  path: PathDef | null; // moving
  delay: number; // frames (crumble shake / falling delay)
  respawn: number; // frames (crumble)
}
export interface DHint extends DefBase { k: 'hint_arrow'; x: number; y: number; dir: string }
/** v4 §5: touching moves the player to `pair` (def index, −1 = a lone portal). */
export interface DPortal extends DefBase { k: 'portal'; x: number; y: number; r: number; pair: number }
export interface DZone extends DefBase { k: 'zone'; box: Rect; effect: ZoneEffect; dx: number; dy: number; strength: number }
export interface DPickup extends DefBase { k: 'pickup'; x: number; y: number; item: string; respawn: number }
export interface DNpc extends DefBase { k: 'npc'; x: number; y: number; box: Rect; lines: string[]; name: string | null }
export type EntDef = DSpikes | DEnemy | DCoin | DCheckpoint | DGoal | DKey | DDoor | DSpring | DSaw | DFirebar | DPlatform | DHint
  | DPortal | DZone | DPickup | DNpc;

/** A v4 action with its references resolved: `ref` = def index (teleport/toggle/open target) or counter index; `f` = frames (−1 until respawn). */
export interface ActDef { a: RuleDo; ref: number; f: number }

/**
 * A v4 rule (§2) with its references resolved: `ref` = def index (touch, collect target), counter index (counter) or
 * frames (timer); −1 when the reference names nothing (the rule never fires). `rect` is the zone trigger in px.
 */
export interface RuleDef { id: string; once: boolean; when: RuleWhen; ref: number; rect: Rect | null; then: ActDef[] }

export interface TriggerDef {
  when: 'collect' | 'touch' | 'timer';
  ref: number; // entity index (collect/touch) or frames (timer)
  then: 'open' | 'win' | 'lose';
  target: number; // door index for open
}

export interface SimWorld {
  level: LevelV2;
  profileId: ProfileId;
  prof: PhysicsProfile;
  tiles: TileGrid;
  wPx: number;
  hPx: number;
  ab: { run: boolean; stomp: boolean; double_jump: boolean; fast_fall: boolean };
  lives: number | null;
  hearts: number;
  cameraMode: 'follow' | 'no_backscroll';
  start: { x: number; y: number; id: string | null };
  defs: EntDef[];
  /** Indices by role. */
  kin: number[]; // kinematic solids/surfaces: moving_platform, crumble, falling_platform, door, crusher enemies
  enemies: number[];
  coins: number[];
  bigs: number[];
  keys: number[];
  doors: number[];
  springs: number[];
  spikes: number[];
  saws: number[];
  firebars: number[];
  checkpoints: number[];
  goals: number[];
  triggers: TriggerDef[];
  loseTimerF: number | null;
  winTimerF: number | null;
  errors: { id: string; message: string }[];
  byId: Map<string, number>;
  // ---- v4 (docs/v4/CONTRACTS_V4.md) ----
  /** The level uses a v4 feature; false keeps every v2 code path (and the state hash) unchanged. */
  v4: boolean;
  mode: GameMode;
  /** rules.logic then compiled.logic, resolved (§2). */
  rules: RuleDef[];
  portals: number[];
  zones: number[];
  pickups: number[];
  npcs: number[];
  /** Initial hidden flag per def (1 = starts hidden). */
  hidden0: number[];
  /** Counter names some rule mentions (SimView.counters order). */
  counterNames: string[];
  usesKeys: RuleKey[];
  /** Some rule can flip gravity (the sim then builds the mirrored tile grid). */
  flips: boolean;
}

const MODES: readonly GameMode[] = ['platformer', 'topdown', 'runner', 'flappy'];
const RULE_KEYS: readonly RuleKey[] = ['space', 'action'];

/** Seconds → whole frames (§1.3); −1 for null (until the player respawns). */
export function framesOf(s: number | null | undefined): number {
  return typeof s === 'number' && s > 0 ? Math.max(1, Math.round(s * HZ)) : -1;
}

const px = (c: number): number => c * CELL;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Builds a constant-speed path. pts in px; speed in px per frame; wait in frames. */
export function makePath(pts: [number, number][], v: number, wait: number, mode: PathMode): PathDef {
  const p = pts.length ? pts : [[0, 0] as [number, number]];
  const segs: number[] = [];
  const n = p.length;
  const closed = mode === 'loop' && n > 1;
  const m = closed ? n : n - 1;
  for (let k = 0; k < m; k++) {
    const a = p[k];
    const b = p[(k + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    segs.push(Math.sqrt(dx * dx + dy * dy));
  }
  let len = 0;
  for (const s of segs) len += s;
  const speed = v > 0 ? v : 0;
  let cycle = 0;
  if (len > 0 && speed > 0) cycle = mode === 'loop' ? len / speed + wait : 2 * (len / speed) + 2 * wait;
  return { pts: p, segs, len, v: speed, wait, mode, cycle };
}

function pointAt(path: PathDef, s: number, out: number[]): void {
  const p = path.pts;
  let d = s;
  for (let k = 0; k < path.segs.length; k++) {
    const L = path.segs[k];
    if (d <= L || k === path.segs.length - 1) {
      const a = p[k];
      const b = p[(k + 1) % p.length];
      const f = L > 0 ? clamp(d / L, 0, 1) : 0;
      out[0] = a[0] + (b[0] - a[0]) * f;
      out[1] = a[1] + (b[1] - a[1]) * f;
      return;
    }
    d -= L;
  }
  out[0] = p[0][0];
  out[1] = p[0][1];
}

/** Position on a path at entity-clock frame t (pure function of t; deterministic). */
export function pathPos(path: PathDef, t: number, out: number[]): void {
  if (path.cycle <= 0) {
    out[0] = path.pts[0][0];
    out[1] = path.pts[0][1];
    return;
  }
  let u = t - Math.floor(t / path.cycle) * path.cycle;
  const move = path.len / path.v;
  if (path.mode === 'loop') {
    if (u < path.wait) return pointAt(path, 0, out);
    return pointAt(path, (u - path.wait) * path.v, out);
  }
  if (u < path.wait) return pointAt(path, 0, out);
  u -= path.wait;
  if (u < move) return pointAt(path, u * path.v, out);
  u -= move;
  if (u < path.wait) return pointAt(path, path.len, out);
  u -= path.wait;
  return pointAt(path, path.len - u * path.v, out);
}

/** Phase 0..1 of a periodic path at frame t. */
export function pathPhase(path: PathDef, t: number): number {
  if (path.cycle <= 0) return 0;
  const u = t - Math.floor(t / path.cycle) * path.cycle;
  return u / path.cycle;
}

function spikeBand(e: { x0: number; x1: number; y: number; facing: string }): Rect {
  const lo = Math.min(e.x0, e.x1);
  const hi = Math.max(e.x0, e.x1);
  const a = px(lo) + 2;
  const b = Math.max(a, px(hi) - 2);
  const f = px(e.y);
  switch (e.facing) {
    case 'down':
      return [a, f, b, f + 6];
    case 'left':
      return [f - 6, a, f, b];
    case 'right':
      return [f, a, f + 6, b];
    default:
      return [a, f - 6, b, f];
  }
}

function flyerCycle(d: DEnemy): number {
  if (d.pattern === 'circle' || d.pattern === 'hover') return d.period;
  return d.speed > 0 ? (2 * d.range) / d.speed : 0;
}

function resolveEnemy(e: Extract<Entity, { type: 'enemy' }>, i: number): DEnemy {
  const p = e.params ?? {};
  const arch = e.archetype;
  const hw = (clamp(num(e.w, 1), 0.25, 4) * CELL) / 2;
  const h = clamp(num(e.h, 1), 0.25, 4) * CELL;
  const defSpeed =
    arch === 'chaser' ? ENEMIES.chaser.speed : arch === 'flyer' ? ENEMIES.flyer.speed : arch === 'crusher' ? 0 : ENEMIES.walker.speed;
  const speedC = num(p.speed, defSpeed);
  const bounds = Array.isArray(e.bounds) && e.bounds.length === 2 ? ([px(Math.min(e.bounds[0], e.bounds[1])), px(Math.max(e.bounds[0], e.bounds[1]))] as [number, number]) : null;
  const interval = arch === 'shooter' ? num(p.interval, ENEMIES.shooter.interval) : num(p.interval, ENEMIES.hopper.interval);
  const pattern = (p.pattern ?? (bounds ? 'horizontal' : 'hover')) as DEnemy['pattern'];
  const d: DEnemy = {
    i, id: e.id, type: 'enemy', k: 'enemy', arch,
    x: px(e.x), y: px(e.y), hw, h,
    spiky: !!e.spiky || arch === 'crusher',
    speed: (speedC * CELL) / HZ,
    ledge: p.ledge_aware ?? (arch === 'walker' ? ENEMIES.walker.ledge_aware : false),
    bounds,
    interval: Math.max(1, Math.round(interval * HZ)),
    forward: !!p.forward,
    pattern,
    range: px(num(p.range, bounds ? (bounds[1] - bounds[0]) / CELL : 4)),
    radius: px(num(p.radius, 2)),
    period: Math.max(1, Math.round(num(p.period, pattern === 'hover' ? ENEMIES.flyer.hover_period_s : 4) * HZ)),
    facing: (p.facing ?? 'toward_player') as DEnemy['facing'],
    blobV: (num(p.blob_speed, ENEMIES.shooter.blob_speed) * CELL) / HZ,
    sight: px(num(p.sight, ENEMIES.chaser.sight)),
    warn: Math.max(1, Math.round(num(p.warn, ENEMIES.crusher.warn) * HZ)),
    riseV: (num(p.rise_speed, ENEMIES.crusher.rise_cs) * CELL) / HZ,
    cycle: 0,
  };
  if (arch === 'walker' || arch === 'chaser') {
    const span = bounds ? bounds[1] - bounds[0] : 16 * CELL;
    const v = arch === 'chaser' ? (ENEMIES.chaser.patrol_cs * CELL) / HZ : d.speed;
    d.cycle = v > 0 ? Math.max(30, (2 * Math.max(CELL, span)) / v) : 0;
  } else if (arch === 'hopper') d.cycle = d.interval + 27;
  else if (arch === 'shooter') d.cycle = d.interval;
  else if (arch === 'flyer') d.cycle = flyerCycle(d);
  else if (arch === 'crusher') d.cycle = d.warn + 60 + 48 + 60;
  return d;
}

function parseTriggers(list: Trigger[], byId: Map<string, number>, errors: { id: string; message: string }[]): TriggerDef[] {
  const out: TriggerDef[] = [];
  for (const t of list) {
    const [wk, wv] = String(t.when).split(':');
    const [tk, tv] = String(t.then).split(':');
    let when: TriggerDef['when'] | null = null;
    let ref = -1;
    if (wk === 'collect' || wk === 'touch') {
      when = wk;
      ref = byId.get(wv ?? '') ?? -1;
    } else if (wk === 'timer') {
      when = 'timer';
      ref = Math.round(num(Number(wv), 0) * HZ);
    }
    let then: TriggerDef['then'] | null = null;
    let target = -1;
    if (tk === 'open') {
      then = 'open';
      target = byId.get(tv ?? '') ?? -1;
    } else if (tk === 'win' || tk === 'lose') then = tk;
    if (!when || !then || (when !== 'timer' && ref < 0) || (then === 'open' && target < 0) || (when === 'timer' && ref <= 0)) {
      errors.push({ id: `trigger:${t.when}`, message: `unsupported trigger ${t.when} → ${t.then}` });
      continue;
    }
    out.push({ when, ref, then, target });
  }
  return out;
}

export function buildWorld(level: LevelV2, startAt?: [number, number]): SimWorld {
  const rules = level.rules ?? ({ version: 1 } as LevelV2['rules']);
  const profileId: ProfileId = (rules.physics_profile && PROFILES[rules.physics_profile] ? rules.physics_profile : 'v2-standard') as ProfileId;
  const prof = PROFILES[profileId];
  const wC = Math.max(1, Math.round(num(level.world?.w, 48)));
  const hC = Math.max(1, Math.round(num(level.world?.h, 27)));
  const tiles = new TileGrid(level.compiled?.tiles?.rows ?? [], wC, hC);
  const ab = rules.abilities ?? {};
  const errors: { id: string; message: string }[] = [];
  const lives = rules.lives === 3 || rules.lives === 5 ? rules.lives : null;
  const hearts = clamp(Math.round(num(rules.hearts, 1)), DAMAGE.hearts[0], DAMAGE.hearts[1]);
  const W: SimWorld = {
    level, profileId, prof, tiles, wPx: wC * CELL, hPx: hC * CELL,
    ab: {
      run: ab.run !== false && prof.run_max !== null,
      stomp: ab.stomp !== false,
      double_jump: !!ab.double_jump,
      fast_fall: ab.fast_fall !== false,
    },
    lives, hearts,
    cameraMode: rules.camera === 'no_backscroll' ? 'no_backscroll' : 'follow',
    start: { x: px(2), y: px(22), id: null },
    defs: [], kin: [], enemies: [], coins: [], bigs: [], keys: [], doors: [], springs: [], spikes: [], saws: [], firebars: [],
    checkpoints: [], goals: [], triggers: [], loseTimerF: null, winTimerF: null, errors, byId: new Map(),
    v4: false, mode: MODES.includes(rules.mode as GameMode) ? (rules.mode as GameMode) : 'platformer', rules: [], portals: [], zones: [],
    pickups: [], npcs: [], hidden0: [], counterNames: [], usesKeys: [], flips: false,
  };
  let anyHidden = false;
  const ents = level.compiled?.entities ?? [];
  let haveStart = false;
  const keyLinks: [number, string | null | undefined][] = [];
  const portalLinks: [number, string | null | undefined][] = [];
  const doorLinks: [number, string | null | undefined][] = [];
  for (const e of ents) {
    if (e.type === 'player_start') {
      if (!haveStart) {
        W.start = { x: px(num(e.x, 2)), y: px(num(e.y, 22)), id: e.id };
        haveStart = true;
      }
      continue;
    }
    const i = W.defs.length;
    let d: EntDef | null = null;
    switch (e.type) {
      case 'spikes': {
        const band = spikeBand(e);
        d = { i, id: e.id, type: e.type, k: 'spikes', band, facing: e.facing, x0: e.x0, x1: e.x1, y: e.y };
        W.spikes.push(i);
        break;
      }
      case 'enemy': {
        const de = resolveEnemy(e, i);
        d = de;
        W.enemies.push(i);
        if (de.arch === 'crusher') W.kin.push(i);
        break;
      }
      case 'coin':
      case 'big_coin':
        d = { i, id: e.id, type: e.type, k: e.type, x: px(e.x), y: px(e.y) };
        (e.type === 'coin' ? W.coins : W.bigs).push(i);
        break;
      case 'checkpoint':
        d = { i, id: e.id, type: e.type, k: 'checkpoint', x: px(e.x), y: px(e.y), box: [px(e.x - 0.5), px(e.y - 2.5), px(e.x + 0.5), px(e.y)] };
        W.checkpoints.push(i);
        break;
      case 'goal': {
        const t = e.trigger;
        const box: Rect = Array.isArray(t) && t.length === 4
          ? [px(Math.min(t[0], t[2])), px(Math.min(t[1], t[3])), px(Math.max(t[0], t[2])), px(Math.max(t[1], t[3]))]
          : [px(e.x - 0.5), px(e.y - 3), px(e.x + 0.5), px(e.y)];
        d = { i, id: e.id, type: e.type, k: 'goal', x: px(e.x), y: px(e.y), box };
        W.goals.push(i);
        break;
      }
      case 'key':
        d = { i, id: e.id, type: e.type, k: 'key', x: px(e.x), y: px(e.y), doors: [] };
        W.keys.push(i);
        keyLinks.push([i, e.door]);
        break;
      case 'door': {
        const box: Rect = [px(e.x), px(e.y), px(e.x + Math.max(0.25, num(e.w, 1))), px(e.y + Math.max(0.25, num(e.h, 2)))];
        d = { i, id: e.id, type: e.type, k: 'door', box, keys: [] };
        W.doors.push(i);
        W.kin.push(i);
        doorLinks.push([i, e.key]);
        break;
      }
      case 'spring': {
        const w = Math.max(0.5, num(e.w, 1));
        const dir = e.dir === 'left' || e.dir === 'right' ? e.dir : 'up';
        const box: Rect = dir === 'up'
          ? [px(e.x - w / 2), px(e.y - 0.5), px(e.x + w / 2), px(e.y)]
          : [px(e.x - w / 2), px(e.y - 1), px(e.x + w / 2), px(e.y)];
        d = { i, id: e.id, type: e.type, k: 'spring', x: px(e.x), y: px(e.y), box, dir, strength: clamp(num(e.strength, 1), HAZARDS.spring.strength_range[0], HAZARDS.spring.strength_range[1]) };
        W.springs.push(i);
        break;
      }
      case 'saw': {
        const pts: [number, number][] = (e.path && e.path.length ? e.path : [[e.x, e.y]]).map((p) => [px(p[0]), px(p[1])] as [number, number]);
        const r = clamp(num(e.r, 1), 0.25, 3);
        const path = makePath(pts, (num(e.speed, HAZARDS.saw.speed) * CELL) / HZ, 0, e.mode === 'loop' ? 'loop' : 'pingpong');
        d = { i, id: e.id, type: e.type, k: 'saw', path, r: px(r), rHit: px(r) * HAZARDS.saw.hitbox_r_frac };
        W.saws.push(i);
        break;
      }
      case 'firebar': {
        const speed = num(e.speed_deg_s, HAZARDS.firebar.speed);
        const turnsPerF = speed / 360 / HZ;
        d = {
          i, id: e.id, type: e.type, k: 'firebar', x: px(e.x), y: px(e.y),
          balls: clamp(Math.round(num(e.balls, 4)), HAZARDS.firebar.balls[0], HAZARDS.firebar.balls[1]),
          turnsPerF, phase: num(e.phase, 0) / 360, cycle: turnsPerF !== 0 ? Math.abs(1 / turnsPerF) : 0,
        };
        W.firebars.push(i);
        break;
      }
      case 'moving_platform': {
        const w = Math.max(0.5, num(e.w, 2));
        const raw = e.path && e.path.length ? e.path : [[e.x, e.y] as [number, number]];
        const pts: [number, number][] = raw.map((p) => [px(p[0]), px(p[1])] as [number, number]);
        if (pts.length >= 1 && (pts[0][0] !== px(e.x) || pts[0][1] !== px(e.y))) pts.unshift([px(e.x), px(e.y)]);
        const path = makePath(pts, (num(e.speed, HAZARDS.moving_platform.speed) * CELL) / HZ, Math.round(num(e.wait_s, HAZARDS.moving_platform.end_wait_s) * HZ), e.mode === 'loop' ? 'loop' : 'pingpong');
        if (path.cycle <= 0) errors.push({ id: e.id, message: 'moving platform has no path; it stays still' });
        d = { i, id: e.id, type: e.type, k: 'moving_platform', x: px(e.x), y: px(e.y), w: px(w), h: CELL, oneWay: e.one_way !== false, path, delay: 0, respawn: 0 };
        W.kin.push(i);
        break;
      }
      case 'crumble':
        d = {
          i, id: e.id, type: e.type, k: 'crumble', x: px(e.x), y: px(e.y), w: px(Math.max(0.5, num(e.w, 2))), h: CELL,
          oneWay: e.one_way !== false, path: null,
          delay: Math.max(1, Math.round(num(e.delay_s, HAZARDS.crumble.shake_s) * HZ)),
          respawn: Math.max(1, Math.round(num(e.respawn_s, HAZARDS.crumble.respawn_s) * HZ)),
        };
        W.kin.push(i);
        break;
      case 'falling_platform':
        d = {
          i, id: e.id, type: e.type, k: 'falling_platform', x: px(e.x), y: px(e.y), w: px(Math.max(0.5, num(e.w, 2))), h: CELL,
          oneWay: e.one_way !== false, path: null, delay: Math.max(1, Math.round(num(e.delay_s, HAZARDS.falling.delay_s) * HZ)), respawn: 0,
        };
        W.kin.push(i);
        break;
      case 'hint_arrow':
        d = { i, id: e.id, type: e.type, k: 'hint_arrow', x: px(e.x), y: px(e.y), dir: e.dir };
        break;
      case 'portal':
        d = { i, id: e.id, type: e.type, k: 'portal', x: px(e.x), y: px(e.y), r: px(0.75), pair: -1 };
        W.portals.push(i);
        portalLinks.push([i, e.pair]);
        break;
      case 'zone': {
        const x0 = px(e.x);
        const y0 = px(e.y);
        const dir = e.dir ?? 'right';
        d = {
          i, id: e.id, type: e.type, k: 'zone', box: [x0, y0, x0 + px(Math.max(0.25, num(e.w, 1))), y0 + px(Math.max(0.25, num(e.h, 1)))], effect: e.effect,
          dx: dir === 'left' ? -1 : dir === 'right' ? 1 : 0, dy: dir === 'up' ? -1 : dir === 'down' ? 1 : 0, strength: clamp(num(e.strength, 1), 0.5, 2),
        };
        W.zones.push(i);
        break;
      }
      case 'pickup':
        d = { i, id: e.id, type: e.type, k: 'pickup', x: px(e.x), y: px(e.y), item: e.item ?? 'star', respawn: framesOf(e.respawn_s) };
        W.pickups.push(i);
        break;
      case 'npc': {
        const w = Math.max(0.25, num(e.w, 1));
        const h = Math.max(0.25, num(e.h, 2));
        d = { i, id: e.id, type: e.type, k: 'npc', x: px(e.x), y: px(e.y), box: [px(e.x - w / 2), px(e.y - h), px(e.x + w / 2), px(e.y)], lines: [...(e.lines ?? [])], name: e.name ?? null };
        W.npcs.push(i);
        break;
      }
      default:
        errors.push({ id: (e as { id?: string }).id ?? '?', message: `unknown entity type ${(e as { type?: string }).type}` });
    }
    if (d) {
      W.defs.push(d);
      W.hidden0.push(e.hidden ? 1 : 0);
      if (e.hidden) anyHidden = true;
      if (!W.byId.has(d.id)) W.byId.set(d.id, i);
    }
  }
  // portals: `pair` names the partner's id (compile writes ids); a label shared by exactly one other portal works too
  for (const [pi, ref] of portalLinks) {
    const di = ref ? W.byId.get(ref) : undefined;
    let pair = di !== undefined && di !== pi && W.defs[di].k === 'portal' ? di : -1;
    if (pair < 0 && ref) {
      const same = portalLinks.filter(([j, r]) => j !== pi && r === ref);
      if (same.length === 1) pair = same[0][0];
    }
    (W.defs[pi] as DPortal).pair = pair;
  }
  // key ↔ door links (either side may name the other; an unnamed single pair links implicitly)
  for (const [ki, dref] of keyLinks) {
    const di = dref ? W.byId.get(dref) : undefined;
    if (di !== undefined && W.defs[di].k === 'door') {
      (W.defs[ki] as DKey).doors.push(di);
      (W.defs[di] as DDoor).keys.push(ki);
    }
  }
  for (const [di, kref] of doorLinks) {
    const ki = kref ? W.byId.get(kref) : undefined;
    if (ki !== undefined && W.defs[ki].k === 'key') {
      const kd = W.defs[ki] as DKey;
      const dd = W.defs[di] as DDoor;
      if (!kd.doors.includes(di)) kd.doors.push(di);
      if (!dd.keys.includes(ki)) dd.keys.push(ki);
    }
  }
  const lonelyKeys = W.keys.filter((k) => (W.defs[k] as DKey).doors.length === 0);
  const lonelyDoors = W.doors.filter((d) => (W.defs[d] as DDoor).keys.length === 0);
  if (lonelyKeys.length === 1 && lonelyDoors.length === 1) {
    (W.defs[lonelyKeys[0]] as DKey).doors.push(lonelyDoors[0]);
    (W.defs[lonelyDoors[0]] as DDoor).keys.push(lonelyKeys[0]);
  } else {
    for (const d of lonelyDoors) errors.push({ id: W.defs[d].id, message: 'door has no key; it stays shut' });
  }
  W.triggers = parseTriggers(level.compiled?.triggers ?? [], W.byId, errors);
  for (const t of W.triggers) {
    if (t.when === 'timer' && t.then === 'lose') W.loseTimerF = W.loseTimerF === null ? t.ref : Math.min(W.loseTimerF, t.ref);
    if (t.when === 'timer' && t.then === 'win') W.winTimerF = W.winTimerF === null ? t.ref : Math.min(W.winTimerF, t.ref);
  }
  if (!haveStart) errors.push({ id: 'start', message: 'level has no player_start' });
  // rules switched off (`off: true`) never fire and count for nothing (keys, counters)
  const logic: RuleV4[] = [...(Array.isArray(rules.logic) ? rules.logic : []), ...(Array.isArray(level.compiled?.logic) ? level.compiled.logic : [])].filter((r) => r && r.off !== true);
  W.rules = resolveRules(logic, W, errors);
  W.v4 = W.mode !== 'platformer' || W.rules.length > 0 || anyHidden || W.portals.length + W.zones.length + W.pickups.length + W.npcs.length > 0;
  if (startAt && Number.isFinite(startAt[0]) && Number.isFinite(startAt[1])) W.start = { x: px(startAt[0]), y: px(startAt[1]), id: W.start.id };
  return W;
}

/** Resolves rule references (§2) to def indices, counter indices and frames; fills counterNames, usesKeys, flips. */
function resolveRules(list: RuleV4[], W: SimWorld, errors: { id: string; message: string }[]): RuleDef[] {
  const counters = new Set<string>();
  const keys = new Set<RuleKey>();
  for (const r of list) {
    if (r?.when?.kind === 'counter') counters.add(r.when.name);
    if (r?.when?.kind === 'key') keys.add(r.when.key);
    for (const a of r?.then ?? []) if (a?.kind === 'add_counter') counters.add(a.name);
  }
  W.counterNames = [...counters].sort();
  W.usesKeys = RULE_KEYS.filter((k) => keys.has(k));
  const ref = (id: string | null | undefined): number => (id ? W.byId.get(id) ?? -1 : -1);
  const out: RuleDef[] = [];
  for (const r of list) {
    if (!r || !r.when || !Array.isArray(r.then)) continue;
    const w = r.when;
    let wref = -1;
    let rect: Rect | null = null;
    if (w.kind === 'touch') wref = ref(w.target);
    else if (w.kind === 'collect') wref = w.target ? ref(w.target) : -1;
    else if (w.kind === 'timer') wref = framesOf(w.seconds);
    else if (w.kind === 'counter') wref = W.counterNames.indexOf(w.name);
    else if (w.kind === 'zone') {
      const z = w.rect;
      rect = [px(Math.min(z[0], z[2])), px(Math.min(z[1], z[3])), px(Math.max(z[0], z[2])), px(Math.max(z[1], z[3]))];
    }
    if ((w.kind === 'touch' || (w.kind === 'collect' && w.target)) && wref < 0) errors.push({ id: r.id, message: `rule ${r.id} names ${w.target}, which is not in the level` });
    const then: ActDef[] = [];
    for (const a of r.then) {
      let aref = -1;
      let f = -1;
      switch (a.kind) {
        case 'teleport': aref = a.target ? ref(a.target) : -1; break;
        case 'toggle': case 'open': aref = ref(a.target); break;
        case 'add_counter': aref = W.counterNames.indexOf(a.name); break;
        case 'gravity': case 'speed': case 'jump_power': case 'reverse_controls': f = framesOf(a.seconds); break;
        case 'freeze_enemies': f = framesOf(a.seconds); break;
        case 'say': f = framesOf(a.seconds ?? 3); break;
        case 'flip_gravity': W.flips = true; break;
        default: break;
      }
      if ((a.kind === 'toggle' || a.kind === 'open' || (a.kind === 'teleport' && a.target)) && aref < 0) errors.push({ id: r.id, message: `rule ${r.id} names ${(a as { target?: string }).target}, which is not in the level` });
      then.push({ a, ref: aref, f });
    }
    out.push({ id: r.id, once: !!r.once, when: w, ref: wref, rect, then });
  }
  return out;
}

/** Outer reach (px) of a firebar's last ball from its anchor (balls at 10 px · (k + 0.6), radius 5 px). */
export function firebarReach(balls: number): number {
  return 10 * (balls - 1 + 0.6) + 5;
}

/** Kinematic box of a platform-like def at a given top-left. */
export function boxAt(x: number, y: number, w: number, h: number): Rect {
  return [x, y, x + w, y + h];
}
