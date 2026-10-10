/**
 * The deterministic fixed-60 Hz simulation (§5.2-5.9): one implementation used by the engine, the bot, the
 * designer's validator and the replay verifier. State is float64 in world px; step code uses only + − × ÷ floor
 * round min max abs sqrt and the sine table in trig.ts; time is the integer frame counter.
 *
 * Frame order (§5.4): death sequence / hit-stop → timers → kinematic solids move (riders carried by their delta)
 * → player input, x move + tile resolve, y move + tile/one-way/slope/kinematic resolve → enemies → projectiles →
 * contacts (stomp, hazards, pickups, springs, checkpoints, goal, triggers) → camera.
 */
import { ABILITIES, COLLISION, DAMAGE, ENEMIES, HAZARDS, SCORING } from '../params.ts';
import { levelHash } from '../build/hash.ts';
import { encodeReplay } from '../replay/codec.ts';
import type { LevelV2, Replay } from '../types.gen.ts';
import { sha256Hex } from '../util/sha256.ts';
import { CORE_VERSION } from '../util/version.ts';
import { camStep, initCamera } from './camera.ts';
import { profileHash } from './profiles.ts';
import { seedRng } from './rng.ts';
import {
  CELL, T_LAVA, T_ONEWAY, T_SOLID, T_X, TileGrid, isSlope, slopeGrade, slopeRise,
} from './tiles.ts';
import { cosT, sinT } from './trig.ts';
import type { CameraState, EntityView, PlayerView, Sim, SimEvent, SimSnapshot, SimView } from './types.ts';
import { INPUT_MASK, IN_D, IN_J, IN_L, IN_R, IN_RESTART, IN_RUN } from './types.ts';
import {
  BODY_H, DT, ENEMY_G, ENEMY_MAX_FALL, HALF_W, HURT_H, HURT_HALF_W, HZ, buildWorld, pathPhase, pathPos,
} from './world.ts';
import type {
  DCheckpoint, DCoin, DDoor, DEnemy, DFirebar, DGoal, DKey, DPlatform, DSaw, DSpikes, DSpring, EntDef, SimWorld,
} from './world.ts';

// ---- state ------------------------------------------------------------------------------------

export interface PState {
  x: number; y: number; vx: number; vy: number;
  gnd: number; // 0 air, 1 tile, 2 kinematic
  gref: number; // kinematic def index when gnd = 2
  gcode: number; // tile code under the feet when gnd = 1
  coy: number; buf: number; jprev: number; cut: number; face: number;
  drop: number; lock: number; lockvx: number; aj: number; inv: number; hp: number;
  mode: number; // 0 alive, 1 dying (shatter), 2 won, 3 respawning (reassembling at the respawn point)
  df: number; hs: number; chain: number; skid: number;
  prevFeet: number; vyPre: number; upTol: number; bonk: number;
  run: number; // 1 while Run is held and running is allowed (PlayerView.running)
}

/** Generic per-entity dynamic state; field meaning depends on the entity kind. */
export interface EState {
  on: number; x: number; y: number; vx: number; vy: number; s: number; t: number; d: number;
  g: number; gr: number; py: number; dx: number; dy: number; n: number;
}

export interface Blob { x: number; y: number; vx: number; dist: number; owner: number; id: number }

export interface SimState {
  f: number; clock0: number; clockF: number; ent: number; rng: number; tbase: number; blobN: number;
  p: PState; e: EState[]; bl: Blob[];
  coins: number; deaths: number; lives: number; bigBanked: number; cp: number;
  save: { dead: number[]; keys: number[]; doors: number[]; big: number[] } | null;
  won: number; warned: number; errs: number; cam: CameraState;
}

// enemy / platform state codes
export const S_IDLE = 0;
const E_SQUASH = 9;

const EPS = 1e-6;
/** Firebar ball k sits at FIREBAR_STEP · (k + FIREBAR_OFF) px from the anchor (shared with the engine, E-1). */
export const FIREBAR_STEP = 10;
export const FIREBAR_OFF = 0.6;
const DEATH_F = Math.round((DAMAGE.death.total_ms * HZ) / 1000); // 45
const REASSEMBLE_F = Math.round((DAMAGE.death.reassemble_ms * HZ) / 1000); // 12
const SKIP_F = Math.round((DAMAGE.death.skip_after_ms * HZ) / 1000); // 15

function cloneState(s: SimState): SimState {
  const e = new Array<EState>(s.e.length);
  for (let i = 0; i < s.e.length; i++) {
    const a = s.e[i];
    e[i] = { on: a.on, x: a.x, y: a.y, vx: a.vx, vy: a.vy, s: a.s, t: a.t, d: a.d, g: a.g, gr: a.gr, py: a.py, dx: a.dx, dy: a.dy, n: a.n };
  }
  const bl = new Array<Blob>(s.bl.length);
  for (let i = 0; i < s.bl.length; i++) {
    const b = s.bl[i];
    bl[i] = { x: b.x, y: b.y, vx: b.vx, dist: b.dist, owner: b.owner, id: b.id };
  }
  return {
    f: s.f, clock0: s.clock0, clockF: s.clockF, ent: s.ent, rng: s.rng, tbase: s.tbase, blobN: s.blobN,
    p: { ...s.p }, e, bl,
    coins: s.coins, deaths: s.deaths, lives: s.lives, bigBanked: s.bigBanked, cp: s.cp,
    save: s.save ? { dead: s.save.dead.slice(), keys: s.save.keys.slice(), doors: s.save.doors.slice(), big: s.save.big.slice() } : null,
    won: s.won, warned: s.warned, errs: s.errs, cam: { ...s.cam },
  };
}

function overlap(ax0: number, ay0: number, ax1: number, ay1: number, bx0: number, by0: number, bx1: number, by1: number): boolean {
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
}

/** Squared distance from a point to a box. */
function distBox2(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return dx * dx + dy * dy;
}

/** clock frames → ms, the one formula used by the HUD, results card and verifyRun. */
export function clockMs(frames: number): number {
  return Math.round((frames * 1000) / HZ);
}

export class SimCore implements Sim {
  readonly W: SimWorld;
  readonly T: TileGrid;
  S: SimState;
  /** Events of the last step (reused; copied by step()). */
  ev: SimEvent[] = [];
  private readonly initial: SimState;
  private readonly code: number[] = [0];
  private readonly tmp: number[] = [0, 0];
  // scratch for kinematic boxes
  private kx0 = 0; private ky0 = 0; private kx1 = 0; private ky1 = 0; private kOne = false;
  /** Collected/touched entity indices this frame (for triggers and the bot). */
  touched: number[] = [];
  /** The bot turns the camera off while exploring (it replays the route with the camera on). */
  camOff = false;
  // Input recording (createSim(level, { record: true }), §8.4): one byte per step() from frame 0. restore() to an
  // earlier snapshot truncates it, so a rewind keeps the replay consistent with the state.
  private rec: Uint8Array | null = null;
  private recN = 0;
  private recOk = true;

  constructor(level: LevelV2, o?: { startAt?: [number, number]; seed?: number; record?: boolean }) {
    this.W = buildWorld(level, o?.startAt);
    if (o?.record) {
      this.rec = new Uint8Array(4096);
      // a run from "play from here" is not a run of the level: it records, but never verifies
      this.recOk = !o.startAt;
    }
    this.T = this.W.tiles;
    const W = this.W;
    const p: PState = {
      x: W.start.x, y: W.start.y, vx: 0, vy: 0, gnd: 0, gref: -1, gcode: 0, coy: 0, buf: 0, jprev: 0, cut: 0, face: 1,
      drop: 0, lock: 0, lockvx: 0, aj: 0, inv: 0, hp: W.hearts, mode: 0, df: 0, hs: 0, chain: 0, skid: 0,
      prevFeet: W.start.y, vyPre: 0, upTol: 0.5, bonk: 0, run: 0,
    };
    const e = W.defs.map((d) => this.initEntity(d));
    this.S = {
      f: 0, clock0: -1, clockF: 0, ent: 0, rng: seedRng(o?.seed ?? 1), tbase: 0, blobN: 0,
      p, e, bl: [], coins: 0, deaths: 0, lives: W.lives ?? 0, bigBanked: 0, cp: -1, save: null,
      won: 0, warned: 0, errs: 0, cam: initCamera(W.start.x / CELL, W.level.world, W.cameraMode, W.prof.walk_max),
    };
    // settle the spawn onto its support (no time passes)
    this.settleSpawn();
    this.initial = cloneState(this.S);
  }

  get frame(): number {
    return this.S.f;
  }

  // ---- public Sim API -----------------------------------------------------------------------

  step(input: number): SimEvent[] {
    if (this.rec) this.recPush(input & INPUT_MASK);
    this.tick(input);
    return this.ev.slice();
  }

  private recPush(bits: number): void {
    let r = this.rec as Uint8Array;
    if (this.recN >= r.length) {
      const n = new Uint8Array(r.length * 2);
      n.set(r);
      this.rec = r = n;
    }
    r[this.recN++] = bits;
  }

  /** The recorded inputs (one byte per step since frame 0); empty when recording is off. */
  inputs(): Uint8Array {
    return this.rec ? this.rec.slice(0, this.recN) : new Uint8Array(0);
  }

  /** True when the recording is a verifiable run: recording on, default start, never restored past its history. */
  recordingValid(): boolean {
    return this.rec !== null && this.recOk && this.recN === this.S.f;
  }

  /** The recording as a Replay (§8.4) for this level; null when recording is off. */
  replay(coreVersion: string = CORE_VERSION): Replay | null {
    if (!this.rec) return null;
    const lv = this.W.level;
    let lh = '';
    try {
      lh = levelHash(lv);
    } catch {
      lh = lv.meta?.level_hash ?? '';
    }
    return {
      v: 1, core: coreVersion, profile_hash: profileHash(this.W.profileId), level_id: lv.id, level_version: lv.version,
      level_hash: lh, frames: this.recN, input: encodeReplay(this.inputs()),
    };
  }

  camera(): CameraState {
    return { ...this.S.cam };
  }

  snapshot(): SimSnapshot {
    return { frame: this.S.f, data: cloneState(this.S) };
  }

  restore(s: SimSnapshot): void {
    this.S = cloneState(s.data as SimState);
    if (this.rec) {
      // a snapshot from this sim's past truncates the recording; anything else breaks it
      const n = this.S.f;
      if (n >= 0 && n <= this.recN) this.recN = n;
      else this.recOk = false;
    }
  }

  /** Fast internal snapshot for the bot (same object shape as snapshot().data). */
  snap(): SimState {
    return cloneState(this.S);
  }

  load(s: SimState): void {
    this.S = cloneState(s);
  }

  hash(): string {
    return 'sha256:' + sha256Hex(JSON.stringify(this.S));
  }

  view(): SimView {
    const S = this.S;
    const P = S.p;
    const W = this.W;
    let state: PlayerView['state'];
    if (P.mode === 2) state = 'win';
    else if (P.mode === 1) state = 'dead';
    else if (P.mode === 3) state = 'respawn';
    else if (P.gnd === 0) state = P.vy < 0 ? 'jump' : 'fall';
    else if (P.skid > 0) state = 'skid';
    else if (Math.abs(P.vx) > 1) state = 'run';
    else state = 'idle';
    const player: PlayerView = {
      x: P.x / CELL, y: P.y / CELL, vx: P.vx, vy: P.vy, facing: P.face < 0 ? -1 : 1, on_ground: P.gnd > 0, state,
      invulnerable_f: P.inv, dead_f: P.mode === 1 || P.mode === 3 ? P.df : 0, hitstop_f: P.hs, hp: P.hp,
      ground: P.gnd === 2 ? W.defs[P.gref].id : P.gnd === 1 ? 'tile' : null, running: P.run === 1,
    };
    const entities: EntityView[] = [];
    for (let i = 0; i < W.defs.length; i++) entities.push(this.entityView(i));
    for (let k = 0; k < S.bl.length; k++) {
      const b = S.bl[k];
      entities.push({ id: `${W.defs[b.owner].id}#blob${b.id}`, type: 'blob', x: b.x / CELL, y: b.y / CELL, w: 6 / CELL, h: 6 / CELL, active: true, vx: b.vx * HZ, r: 3 / CELL });
    }
    let held = 0;
    for (const i of W.bigs) if (S.e[i].s === 1) held++;
    const keys: string[] = [];
    for (const i of W.keys) if (S.e[i].on === 0) keys.push(W.defs[i].id);
    let left: number | null = null;
    if (W.loseTimerF !== null) left = Math.max(0, W.loseTimerF - (S.clockF - S.tbase));
    return {
      frame: S.f, player, entities, coins: S.coins, big_coins_held: held, big_coins_banked: S.bigBanked, deaths: S.deaths,
      lives: W.lives === null ? null : S.lives, hearts: P.hp, checkpoint: S.cp >= 0 ? W.defs[S.cp].id : null,
      timer_frames_left: left, won: S.won === 1, clock_frames: S.clockF, time_ms: clockMs(S.clockF), big_coins_total: W.bigs.length, keys,
    };
  }

  // ---- entities: init and views -----------------------------------------------------------

  private initEntity(d: EntDef): EState {
    const e: EState = { on: 1, x: 0, y: 0, vx: 0, vy: 0, s: 0, t: 0, d: -1, g: 0, gr: -1, py: 0, dx: 0, dy: 0, n: 0 };
    switch (d.k) {
      case 'enemy':
        e.x = d.x; e.y = d.y; e.py = d.y;
        e.d = d.facing === 'right' ? 1 : -1;
        if (d.arch === 'crusher') e.n = d.y; // home
        break;
      case 'coin': case 'big_coin': case 'key': case 'checkpoint': case 'goal': case 'hint_arrow': case 'firebar': case 'spring':
        e.x = d.x; e.y = d.y; e.t = 999;
        break;
      case 'saw': {
        pathPos(d.path, 0, this.tmp);
        e.x = this.tmp[0]; e.y = this.tmp[1];
        break;
      }
      case 'moving_platform': {
        if (d.path) pathPos(d.path, 0, this.tmp); else { this.tmp[0] = d.x; this.tmp[1] = d.y; }
        e.x = this.tmp[0]; e.y = this.tmp[1];
        break;
      }
      case 'crumble': case 'falling_platform':
        e.x = d.x; e.y = d.y;
        break;
      default:
        break;
    }
    return e;
  }

  private entityView(i: number): EntityView {
    const d = this.W.defs[i];
    const e = this.S.e[i];
    const c = (v: number): number => v / CELL;
    switch (d.k) {
      case 'enemy': {
        const st = this.enemyStateName(d, e);
        return {
          id: d.id, type: 'enemy', kind: d.arch, x: c(e.x), y: c(e.y), w: c(d.hw * 2), h: c(d.h), active: e.on === 1, state: st,
          facing: e.d < 0 ? -1 : 1, vx: e.vx * (d.arch === 'chaser' ? 1 : HZ), vy: e.vy, t: e.t, phase: d.cycle > 0 ? (this.S.ent % d.cycle) / d.cycle : undefined,
        };
      }
      case 'spikes':
        return { id: d.id, type: 'spikes', kind: d.facing, x: Math.min(d.x0, d.x1), y: d.y, w: Math.abs(d.x1 - d.x0), h: 6 / CELL, active: true };
      case 'coin': case 'big_coin':
        return { id: d.id, type: d.k, x: c(e.x), y: c(e.y), w: d.k === 'coin' ? 10 / CELL : 1, h: d.k === 'coin' ? 10 / CELL : 1, active: d.k === 'coin' ? e.on === 1 : e.s !== 2, state: d.k === 'big_coin' ? (e.s === 1 ? 'held' : e.s === 2 ? 'banked' : 'idle') : undefined };
      case 'key':
        return { id: d.id, type: 'key', x: c(e.x), y: c(e.y), w: 1, h: 1, active: e.on === 1 };
      case 'door':
        return { id: d.id, type: 'door', x: c(d.box[0]), y: c(d.box[1]), w: c(d.box[2] - d.box[0]), h: c(d.box[3] - d.box[1]), active: e.on === 1, state: e.on ? 'closed' : 'open', t: e.t };
      case 'checkpoint':
        return { id: d.id, type: 'checkpoint', x: c(d.x), y: c(d.y), w: 1, h: 2.5, active: e.s === 1, state: e.s === 1 ? 'open' : 'idle' };
      case 'goal':
        return { id: d.id, type: 'goal', x: c(d.x), y: c(d.y), w: c(d.box[2] - d.box[0]), h: c(d.box[3] - d.box[1]), active: true };
      case 'spring':
        return { id: d.id, type: 'spring', kind: d.dir, x: c(d.x), y: c(d.y), w: c(d.box[2] - d.box[0]), h: c(d.box[3] - d.box[1]), active: true, state: e.t < 10 ? 'fired' : 'idle', t: e.t };
      case 'saw':
        return { id: d.id, type: 'saw', x: c(e.x), y: c(e.y), w: c(d.r * 2), h: c(d.r * 2), r: c(d.r), active: true, phase: pathPhase(d.path, this.S.ent) };
      case 'firebar': {
        const ang = d.phase + d.turnsPerF * this.S.ent;
        const balls: [number, number][] = [];
        for (let k = 0; k < d.balls; k++) balls.push([c(d.x + cosT(ang) * FIREBAR_STEP * (k + FIREBAR_OFF)), c(d.y + sinT(ang) * FIREBAR_STEP * (k + FIREBAR_OFF))]);
        const turn = ang - Math.floor(ang);
        return { id: d.id, type: 'firebar', x: c(d.x), y: c(d.y), w: c(d.balls * 20), h: c(d.balls * 20), active: true, angle: turn, phase: turn * 360, balls, r: c(HAZARDS.firebar.ball_r_px) };
      }
      case 'moving_platform': case 'crumble': case 'falling_platform': {
        let st = 'idle';
        if (d.k === 'crumble') st = e.s === 0 ? 'idle' : e.s === 1 ? 'shake' : 'gone';
        if (d.k === 'falling_platform') st = e.s === 0 ? 'idle' : e.s === 1 ? 'shake' : e.s === 2 ? 'fall' : 'gone';
        return {
          id: d.id, type: d.k, x: c(e.x), y: c(e.y), w: c(d.w), h: c(d.h), active: this.platformActive(d, e), state: st, t: e.t,
          vx: e.dx * HZ, vy: e.dy * HZ, phase: d.path ? pathPhase(d.path, this.S.ent) : undefined,
        };
      }
      case 'hint_arrow':
        return { id: d.id, type: 'hint_arrow', kind: d.dir, x: c(d.x), y: c(d.y), w: 1, h: 1, active: true };
    }
  }

  private enemyStateName(d: DEnemy, e: EState): string {
    if (e.on === 0) return e.s === E_SQUASH ? 'squash' : 'gone';
    switch (d.arch) {
      case 'hopper': return e.s === 1 ? 'crouch' : e.s === 2 ? 'air' : 'idle';
      case 'shooter': return e.s === 1 ? 'inflate' : 'idle';
      case 'chaser': return e.s === 1 ? 'alert' : e.s === 2 ? 'chase' : 'patrol';
      case 'crusher': return e.s === 1 ? 'warn' : e.s === 2 ? 'drop' : e.s === 3 ? 'rest' : e.s === 4 ? 'rise' : 'idle';
      case 'flyer': return 'fly';
      case 'static': return 'idle';
      default: return e.g ? 'walk' : 'air';
    }
  }

  private platformActive(d: DPlatform, e: EState): boolean {
    if (d.k === 'crumble') return e.s <= 1;
    if (d.k === 'falling_platform') return e.s <= 2;
    return true;
  }

  /** Fills the kinematic scratch box for def i; returns false when it is not solid right now. */
  private kinRect(i: number): boolean {
    const d = this.W.defs[i];
    const e = this.S.e[i];
    if (d.k === 'door') {
      if (e.on === 0) return false;
      this.kx0 = d.box[0]; this.ky0 = d.box[1]; this.kx1 = d.box[2]; this.ky1 = d.box[3]; this.kOne = false;
      return true;
    }
    if (d.k === 'enemy') {
      if (e.on === 0) return false;
      this.kx0 = e.x - d.hw; this.ky0 = e.y - d.h; this.kx1 = e.x + d.hw; this.ky1 = e.y; this.kOne = false;
      return true;
    }
    if (d.k === 'moving_platform' || d.k === 'crumble' || d.k === 'falling_platform') {
      if (!this.platformActive(d, e)) return false;
      this.kx0 = e.x; this.ky0 = e.y; this.kx1 = e.x + d.w; this.ky1 = e.y + d.h; this.kOne = d.oneWay;
      return true;
    }
    return false;
  }

  // ---- the frame ------------------------------------------------------------------------

  tick(input: number): void {
    this.ev.length = 0;
    this.touched.length = 0;
    const S = this.S;
    const P = S.p;
    const W = this.W;
    input &= INPUT_MASK;
    S.f++;
    const J = (input & IN_J) !== 0;
    const Jp = J && P.jprev === 0;
    if (S.errs === 0) {
      S.errs = 1;
      for (const er of W.errors) this.emit({ type: 'entity_error', frame: S.f, id: er.id, cause: er.message });
    }
    if (S.won) {
      P.jprev = J ? 1 : 0;
      return;
    }
    if (S.clock0 < 0 && input !== 0) {
      S.clock0 = S.f;
      this.emit({ type: 'start_clock', frame: S.f });
    }
    if (S.clock0 >= 0) S.clockF++;
    if (P.mode === 1 || P.mode === 3) {
      // death sequence (§5.5): shatter at the death spot, then reassemble at the respawn point; 0.75 s in total,
      // Jump after 250 ms skips the rest
      P.df++;
      if (P.mode === 1 && (P.df >= DEATH_F - REASSEMBLE_F || (Jp && P.df >= SKIP_F))) {
        const skip = P.df < DEATH_F - REASSEMBLE_F;
        const df = P.df;
        this.respawn();
        const Q = this.S.p;
        if (!skip) {
          Q.mode = 3;
          Q.df = df;
        }
        Q.jprev = J ? 1 : 0;
      } else if (P.mode === 3 && (P.df >= DEATH_F || (Jp && P.df >= SKIP_F))) {
        P.mode = 0;
        P.df = 0;
        P.jprev = J ? 1 : 0;
      } else P.jprev = J ? 1 : 0;
      this.cameraUpdate();
      return;
    }
    if ((input & IN_RESTART) !== 0) {
      this.die('restart', P.x);
      P.jprev = J ? 1 : 0;
      this.cameraUpdate();
      return;
    }
    if (Jp) P.buf = W.prof.buffer_f + 1;
    if (P.hs > 0) {
      P.hs--;
      P.jprev = J ? 1 : 0;
      return;
    }
    // timers (from the first input)
    if (S.clock0 >= 0) {
      const el = S.clockF - S.tbase;
      if (W.loseTimerF !== null) {
        const left = W.loseTimerF - el;
        if (left <= SCORING.timer_warn_s * HZ && left > 0 && !S.warned) {
          // once per life of the timer (a game over / lose restarts it); a timer shorter than 10 s warns at once
          S.warned = 1;
          this.emit({ type: 'timer_warn', frame: S.f, n: Math.ceil(left / HZ), x: P.x / CELL, y: P.y / CELL });
        }
        if (left <= 0) {
          this.lose();
          P.jprev = J ? 1 : 0;
          return;
        }
      }
      if (W.winTimerF !== null && el >= W.winTimerF) {
        this.win();
        return;
      }
    }
    S.ent++;
    P.prevFeet = P.y;
    this.moveKinematics();
    if (P.mode === 0) this.playerStep(input, J, Jp);
    this.enemiesStep();
    this.blobsStep();
    if (P.mode === 0) this.contacts(J);
    if (P.mode === 0 && P.y > W.hPx + 2 * CELL) this.die('pit', P.x);
    if (P.mode === 0) this.crushCheck();
    for (const i of W.springs) if (S.e[i].t < 999) S.e[i].t++;
    for (const i of W.doors) if (S.e[i].on === 0 && S.e[i].t < 999) S.e[i].t++;
    P.jprev = J ? 1 : 0;
    this.cameraUpdate();
  }

  private cameraUpdate(): void {
    if (this.camOff) return;
    const P = this.S.p;
    this.S.cam = camStep(this.S.cam, P.x / CELL, P.mode === 1 || P.mode === 3 ? 0 : P.vx, P.face < 0 ? -1 : 1, this.W.level.world);
  }

  private emit(e: SimEvent): void {
    this.ev.push(e);
  }

  // ---- player -----------------------------------------------------------------------------

  private playerStep(input: number, J: boolean, Jp: boolean): void {
    const P = this.S.p;
    const W = this.W;
    const prof = W.prof;
    // 1. carry by the kinematic we stand on
    if (P.gnd === 2) {
      const ks = this.S.e[P.gref];
      if (this.kinRect(P.gref)) {
        if (ks.dx !== 0) this.moveX(ks.dx, true);
        if (ks.dy !== 0) {
          P.y += ks.dy;
          P.prevFeet = P.y;
        }
      } else {
        P.gnd = 0;
        P.coy = prof.coyote_f;
      }
    }
    // 2. horizontal velocity (§5.3)
    let dir = (input & IN_R ? 1 : 0) - (input & IN_L ? 1 : 0);
    if (P.lock > 0) {
      P.lock--;
      dir = 0;
      P.vx = P.lockvx;
      P.run = 0;
    } else {
      const running = (input & IN_RUN) !== 0 && W.ab.run && prof.run_max !== null;
      P.run = running ? 1 : 0;
      let vmax = running ? (prof.run_max as number) : prof.walk_max;
      let walkCap = prof.walk_max;
      if (P.gnd === 1 && isSlope(P.gcode) && dir !== 0) {
        const f = dir === slopeRise(P.gcode) ? COLLISION.slope_uphill : COLLISION.slope_downhill;
        vmax *= f;
        walkCap *= f;
      }
      const target = dir * vmax;
      if (prof.instant_ground) {
        P.vx = target;
      } else if (P.gnd > 0) {
        if (dir === 0) {
          P.vx = towards(P.vx, 0, prof.friction * DT);
          P.skid = 0;
        } else if (P.vx * dir < 0) {
          if (P.skid === 0 && Math.abs(P.vx) > prof.walk_max * 0.5) this.emit({ type: 'skid', frame: this.S.f, x: P.x / CELL, y: P.y / CELL });
          P.skid = 1;
          P.vx = towards(P.vx, 0, prof.skid_decel * DT);
        } else {
          P.skid = 0;
          const sp = Math.abs(P.vx);
          if (sp > vmax) P.vx = towards(P.vx, target, prof.friction * DT);
          else if (sp < walkCap) P.vx = dir * Math.min(walkCap, sp + prof.accel_walk * DT, vmax);
          else P.vx = dir * Math.min(vmax, sp + prof.accel_run * DT);
        }
      } else {
        P.skid = 0;
        const fr = prof.air_accel_frac;
        if (dir === 0) P.vx = towards(P.vx, 0, prof.air_drag * DT);
        else if (P.vx * dir < 0) P.vx = towards(P.vx, target, fr * prof.accel_walk * DT);
        else {
          const sp = Math.abs(P.vx);
          if (sp < vmax) {
            const a = sp < walkCap ? prof.accel_walk : prof.accel_run;
            P.vx = dir * Math.min(vmax, sp + fr * a * DT);
          }
        }
      }
    }
    if (dir !== 0) P.face = dir;
    // 3. jump, drop-through, double jump (§5.1, §5.3, §5.4)
    if (P.buf > 0 && (P.gnd > 0 || P.coy > 0)) {
      if ((input & IN_D) !== 0 && P.gnd > 0 && this.onOneWay()) {
        P.drop = COLLISION.drop_through_f;
        P.gnd = 0;
        P.y += 1;
        P.buf = 0;
        P.coy = 0;
        this.emit({ type: 'drop_through', frame: this.S.f, x: P.x / CELL, y: P.y / CELL });
      } else {
        P.vy = -(prof.jump_base + prof.jump_vx_bonus * Math.abs(P.vx));
        // jumping off a moving platform keeps its horizontal motion
        if (P.gnd === 2 && P.gref >= 0) P.vx += this.S.e[P.gref].dx * HZ;
        P.gnd = 0;
        P.coy = 0;
        P.buf = 0;
        P.cut = 1;
        P.aj = 0;
        this.emit({ type: 'jump', frame: this.S.f, x: P.x / CELL, y: P.y / CELL, vy: P.vy });
      }
    } else if (Jp && P.gnd === 0 && P.coy === 0 && W.ab.double_jump && P.aj === 0) {
      P.vy = ABILITIES.double_jump.vy;
      P.aj = 1;
      P.cut = 1;
      P.buf = 0;
      this.emit({ type: 'double_jump', frame: this.S.f, x: P.x / CELL, y: P.y / CELL, vy: P.vy });
    }
    // 4. variable jump: release cut, then gravity
    if (P.cut && !J && P.vy < prof.release_cut) {
      P.vy = prof.release_cut;
      P.cut = 0;
    }
    if (P.vy >= 0) P.cut = 0;
    if (P.gnd === 0) {
      let g: number;
      if (J && Math.abs(P.vy) < prof.apex_vy) g = prof.g_apex_held;
      else if (J && P.vy < 0) g = prof.g_rise_held;
      else g = prof.g_fall;
      const maxF = (input & IN_D) !== 0 && W.ab.fast_fall ? prof.max_fall_fast : prof.max_fall;
      P.vy = Math.min(P.vy + g * DT, maxF);
    } else {
      P.vy = 0;
    }
    // 5. move and resolve
    this.moveX(P.vx * DT, false);
    this.moveY(P.vy * DT);
    // 6. counters
    if (P.gnd === 0 && P.coy > 0) P.coy--;
    if (P.buf > 0) P.buf--;
    if (P.drop > 0) P.drop--;
    if (P.inv > 0) P.inv--;
  }

  private onOneWay(): boolean {
    const P = this.S.p;
    if (P.gnd === 1) return P.gcode === T_ONEWAY;
    if (P.gnd === 2) return this.kinRect(P.gref) && this.kOne;
    return false;
  }

  /** Is the 12 × 28 body free of side-blocking tiles at (x, feet)? */
  private bodyFree(x: number, feet: number): boolean {
    const T = this.T;
    const c0 = Math.floor((x - HALF_W) / CELL);
    const c1 = Math.floor((x + HALF_W - EPS) / CELL);
    const r0 = Math.floor((feet - BODY_H) / CELL);
    const r1 = Math.floor((feet - EPS) / CELL);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (T.blocksSide(c, r)) return false;
    return true;
  }

  private moveX(dx: number, carry: boolean): void {
    const P = this.S.p;
    const T = this.T;
    const prof = this.W.prof;
    const allow = P.gnd > 0 ? prof.step_assist_px : prof.ledge_pop_px;
    P.upTol = Math.abs(dx) + allow + 0.5;
    if (dx === 0) return;
    let nx = P.x + dx;
    const r0 = Math.floor((P.y - BODY_H) / CELL);
    const r1 = Math.floor((P.y - EPS) / CELL);
    const lead = dx > 0 ? nx + HALF_W : nx - HALF_W;
    const lc = dx > 0 ? Math.floor((lead - EPS) / CELL) : Math.floor(lead / CELL);
    const oc = dx > 0 ? Math.floor((P.x + HALF_W - EPS) / CELL) : Math.floor((P.x - HALF_W) / CELL);
    let blocked = false;
    if (lc !== oc) {
      // every column the leading edge entered (dx < 16 px, so at most one, but stay general)
      const step = dx > 0 ? 1 : -1;
      for (let c = oc + step; c !== lc + step && !blocked; c += step) {
        let rb = -1;
        for (let r = r0; r <= r1; r++) if (T.blocksSide(c, r)) { rb = r; break; }
        if (rb < 0) continue;
        const top = rb * CELL;
        const rise = P.y - top;
        let lowOnly = true;
        for (let r = rb; r <= r1; r++) if (!T.blocksSide(c, r)) lowOnly = false;
        if (lowOnly && rise > 0 && rise <= allow + EPS && !carry && this.bodyFree(nx, top)) {
          P.y = top;
          if (P.gnd === 0 && P.vy > 0) P.vy = 0;
          continue;
        }
        blocked = true;
        nx = dx > 0 ? c * CELL - HALF_W : (c + 1) * CELL + HALF_W;
      }
    }
    // slope solids under the centre: the floor line may rise at most the slope grade × |dx| + allowance
    if (!blocked) {
      const cc = Math.floor(nx / CELL);
      for (let r = r0; r <= r1; r++) {
        const t = T.at(cc, r);
        if (!isSlope(t)) continue;
        const fy = T.slopeY(t, cc, r, nx);
        if (fy >= P.y - EPS || (r + 1) * CELL <= P.y - BODY_H) continue;
        const maxRise = Math.abs(dx) * slopeGrade(t) + allow + 0.5;
        if (P.y - fy > maxRise) {
          blocked = true;
          nx = dx > 0 ? cc * CELL - 0.001 : (cc + 1) * CELL + 0.001;
        }
        break;
      }
    }
    // solid kinematics (closed doors, solid platforms, crushers)
    for (const i of this.W.kin) {
      if (!this.kinRect(i) || this.kOne) continue;
      if (!overlap(nx - HALF_W, P.y - BODY_H, nx + HALF_W, P.y, this.kx0, this.ky0 + EPS, this.kx1, this.ky1)) continue;
      const rise = P.y - this.ky0;
      if (!carry && rise > 0 && rise <= allow + EPS && this.bodyFree(nx, this.ky0)) {
        P.y = this.ky0;
        continue;
      }
      if (P.gnd === 2 && P.gref === i) continue;
      blocked = true;
      nx = dx > 0 ? Math.min(nx, this.kx0 - HALF_W) : Math.max(nx, this.kx1 + HALF_W);
    }
    if (blocked && !carry) P.vx = 0;
    P.x = nx;
  }

  private moveY(dy: number): void {
    const P = this.S.p;
    const T = this.T;
    const W = this.W;
    P.vyPre = P.vy;
    const x0 = P.x - HALF_W;
    const x1 = P.x + HALF_W;
    if (dy < 0) {
      const oldTop = P.y - BODY_H;
      const newTop = oldTop + dy;
      const c0 = Math.floor(x0 / CELL);
      const c1 = Math.floor((x1 - EPS) / CELL);
      let ceil = -Infinity;
      let hitC0 = false;
      let hitC1 = false;
      let hitMid = false;
      const rStart = Math.floor((oldTop - EPS) / CELL);
      const rEnd = Math.floor(newTop / CELL);
      for (let r = rStart; r >= rEnd && ceil === -Infinity; r--) {
        const bottom = (r + 1) * CELL;
        if (bottom <= newTop + EPS || bottom > oldTop + EPS) continue;
        for (let c = c0; c <= c1; c++) {
          if (!T.blocksHead(c, r)) continue;
          ceil = bottom;
          if (c === c0) hitC0 = true;
          else if (c === c1) hitC1 = true;
          else hitMid = true;
        }
      }
      for (const i of W.kin) {
        if (!this.kinRect(i) || this.kOne) continue;
        if (this.kx1 <= x0 || this.kx0 >= x1) continue;
        if (this.ky1 > newTop + EPS && this.ky1 <= oldTop + EPS && this.ky1 > ceil) {
          ceil = this.ky1;
          hitMid = true;
        }
      }
      if (ceil > -Infinity) {
        // corner correction (ceiling nudge): only one end column grazes the ceiling
        const nudge = W.prof.ceiling_nudge_px;
        if (nudge > 0 && !hitMid && hitC0 !== hitC1) {
          const shift = hitC0 ? (c0 + 1) * CELL - x0 + 0.01 : -(x1 - c1 * CELL + 0.01);
          if (Math.abs(shift) <= nudge + 0.01 && this.bodyFree(P.x + shift, P.y) && this.bodyFree(P.x + shift, P.y + dy)) {
            P.x += shift;
            P.y += dy;
            P.gnd = 0;
            return;
          }
        }
        P.y = ceil + BODY_H;
        P.vy = 0;
        P.cut = 0;
        P.bonk = 1;
        this.emit({ type: 'bonk', frame: this.S.f, x: P.x / CELL, y: P.y / CELL });
      } else {
        P.y += dy;
      }
      P.gnd = 0;
      return;
    }
    const was = P.gnd;
    const prevFeet = P.y;
    const stick = was > 0 ? COLLISION.slope_stick_px : 0;
    const yMin = prevFeet - P.upTol;
    const yMax = prevFeet + dy + stick;
    const oneWayMin = P.drop > 0 ? Infinity : prevFeet;
    let best = this.supportY(P.x, yMin, yMax, oneWayMin);
    let bestCode = this.code[0];
    let bestKin = -1;
    for (const i of W.kin) {
      if (!this.kinRect(i)) continue;
      if (this.kOne && P.drop > 0) continue;
      if (this.kx1 <= x0 + 0.01 || this.kx0 >= x1 - 0.01) continue;
      const ks = this.S.e[i];
      const top = this.ky0;
      const riding = was === 2 && P.gref === i;
      if (!riding && prevFeet > top - ks.dy + 0.01) continue;
      if (top < yMin - Math.abs(ks.dy) - 0.01 || top > yMax) continue;
      if (top < best) {
        best = top;
        bestKin = i;
      }
    }
    if (best < Infinity) {
      if (was === 0) {
        this.emit({ type: 'land', frame: this.S.f, x: P.x / CELL, y: best / CELL, vy: P.vyPre });
        P.chain = 0;
      }
      P.aj = 0;
      P.y = best;
      P.vy = 0;
      P.gnd = bestKin >= 0 ? 2 : 1;
      P.gref = bestKin;
      P.gcode = bestKin >= 0 ? 0 : bestCode;
      P.coy = 0;
    } else {
      P.y = prevFeet + dy;
      if (was > 0) P.coy = W.prof.coyote_f;
      P.gnd = 0;
      P.gref = -1;
    }
  }

  /**
   * Tile floor under a body centred at x (half width 6): the centre column first (any tile kind; a slope there
   * wins outright), then the two edge columns (flat tops, slopes read at the boundary nearest the centre).
   */
  supportY(x: number, yMin: number, yMax: number, oneWayMin: number, hw: number = HALF_W): number {
    const T = this.T;
    const cc = Math.floor(x / CELL);
    const code = this.code;
    code[0] = 0;
    const yc = T.floorInColumn(cc, x, yMin, yMax, oneWayMin, false, code);
    if (yc < Infinity && isSlope(code[0])) return yc;
    let best = yc;
    let bestCode = code[0];
    const cl = Math.floor((x - hw + 0.01) / CELL);
    const cr = Math.floor((x + hw - 0.01) / CELL);
    if (cl !== cc) {
      const y = T.floorInColumn(cl, (cl + 1) * CELL, yMin, yMax, oneWayMin, false, code);
      if (y < best) { best = y; bestCode = code[0]; }
    }
    if (cr !== cc) {
      const y = T.floorInColumn(cr, cr * CELL, yMin, yMax, oneWayMin, false, code);
      if (y < best) { best = y; bestCode = code[0]; }
    }
    code[0] = bestCode;
    return best;
  }

  /** Death when the player's core is inside solid geometry (squeezed by a kinematic or carried into a wall). */
  private crushCheck(): void {
    const P = this.S.p;
    const T = this.T;
    const cx = Math.floor(P.x / CELL);
    const rMid = Math.floor((P.y - BODY_H / 2) / CELL);
    const rHead = Math.floor((P.y - BODY_H + 2) / CELL);
    if (T.at(cx, rMid) === T_SOLID || T.at(cx, rHead) === T_SOLID) {
      this.die('crush', P.x);
      return;
    }
    for (const i of this.W.kin) {
      if (!this.kinRect(i) || this.kOne) continue;
      if (overlap(P.x - 2, P.y - BODY_H + 4, P.x + 2, P.y - 4, this.kx0, this.ky0, this.kx1, this.ky1)) {
        this.die('crush', P.x);
        return;
      }
    }
  }

  // ---- kinematics ---------------------------------------------------------------------------

  private moveKinematics(): void {
    const S = this.S;
    const P = S.p;
    const W = this.W;
    const t = S.ent;
    for (const i of W.kin) {
      const d = W.defs[i];
      const e = S.e[i];
      e.dx = 0;
      e.dy = 0;
      if (d.k === 'moving_platform') {
        if (d.path && d.path.cycle > 0) {
          pathPos(d.path, t, this.tmp);
          e.dx = this.tmp[0] - e.x;
          e.dy = this.tmp[1] - e.y;
          e.x = this.tmp[0];
          e.y = this.tmp[1];
          if (!d.oneWay) this.pushPlayer(i, d, e);
        }
      } else if (d.k === 'crumble') {
        const standing = P.mode === 0 && P.gnd === 2 && P.gref === i;
        if (e.s === 0) {
          if (standing) {
            e.s = 1;
            e.t = 0;
            this.emit({ type: 'crumble', frame: S.f, id: d.id, x: d.x / CELL, y: d.y / CELL });
          }
        } else if (e.s === 1) {
          e.t++;
          if (e.t >= d.delay) {
            e.s = 2;
            e.t = 0;
            e.vy = 0;
          }
        } else {
          e.t++;
          e.vy = Math.min(e.vy + HAZARDS.crumble.fall_g * DT, 600);
          e.y += e.vy * DT;
          if (e.t >= d.respawn && !overlap(P.x - HALF_W, P.y - BODY_H, P.x + HALF_W, P.y, d.x, d.y, d.x + d.w, d.y + d.h)) {
            e.s = 0;
            e.t = 0;
            e.x = d.x;
            e.y = d.y;
            e.vy = 0;
          }
        }
      } else if (d.k === 'falling_platform') {
        const standing = P.mode === 0 && P.gnd === 2 && P.gref === i;
        if (e.s === 0) {
          if (standing) {
            e.s = 1;
            e.t = 0;
          }
        } else if (e.s === 1) {
          e.t++;
          if (e.t >= d.delay) {
            e.s = 2;
            e.vy = 0;
            this.emit({ type: 'falling', frame: S.f, id: d.id, x: e.x / CELL, y: e.y / CELL });
          }
        } else if (e.s === 2) {
          e.vy = Math.min(e.vy + HAZARDS.crumble.fall_g * DT, 600);
          e.dy = e.vy * DT;
          e.y += e.dy;
          if (e.y > W.hPx + 4 * CELL) e.s = 3;
        }
      } else if (d.k === 'enemy' && d.arch === 'crusher') {
        this.crusherStep(d, e);
      }
    }
  }

  /** A solid moving platform pushes a player it moves into (never its own rider); squeezing kills. */
  private pushPlayer(i: number, d: DPlatform, e: EState): void {
    const P = this.S.p;
    if (P.mode !== 0 || (P.gnd === 2 && P.gref === i)) return;
    const x0 = e.x;
    const y0 = e.y;
    const x1 = e.x + d.w;
    const y1 = e.y + d.h;
    if (!overlap(P.x - HALF_W, P.y - BODY_H, P.x + HALF_W, P.y, x0, y0 + EPS, x1, y1)) return;
    if (e.dx !== 0 && P.y > y0 + this.W.prof.step_assist_px) {
      const target = e.dx > 0 ? x1 + HALF_W : x0 - HALF_W;
      this.moveX(target - P.x, true);
      if (Math.abs(P.x - target) > 0.5) this.die('crush', P.x);
      return;
    }
    if (e.dy > 0) {
      if (P.gnd > 0) this.die('crush', P.x);
      else {
        P.y = y1 + BODY_H;
        P.vy = Math.max(P.vy, e.dy * HZ);
      }
    }
  }

  private crusherStep(d: DEnemy, e: EState): void {
    if (e.on === 0) return;
    const P = this.S.p;
    const prevY = e.y;
    e.t++;
    if (e.s === 0) {
      if (P.mode === 0 && Math.abs(P.x - e.x) <= ENEMIES.crusher.trigger_dx_c * CELL && P.y - BODY_H >= e.y - 2) {
        e.s = 1;
        e.t = 0;
      }
    } else if (e.s === 1) {
      if (e.t >= d.warn) {
        e.s = 2;
        e.t = 0;
        e.vy = 0;
      }
    } else if (e.s === 2) {
      e.vy = Math.min(e.vy + ENEMIES.crusher.drop_accel * DT, ENEMIES.crusher.drop_max);
      const dy = e.vy * DT;
      const floor = this.supportY(e.x, e.y - 0.5, e.y + dy, Infinity, d.hw);
      if (floor < Infinity) {
        e.y = floor;
        e.s = 3;
        e.t = 0;
        e.vy = 0;
        this.emit({ type: 'crusher_land', frame: this.S.f, id: d.id, x: e.x / CELL, y: e.y / CELL });
      } else {
        e.y += dy;
        if (e.y > this.W.hPx + 4 * CELL) e.on = 0;
      }
      // lethal only while moving down onto the player
      if (P.mode === 0 && overlap(P.x - HURT_HALF_W, P.y - HURT_H, P.x + HURT_HALF_W, P.y, e.x - d.hw, e.y - d.h, e.x + d.hw, e.y) && P.y - BODY_H >= prevY - 6) {
        this.hit('crusher', e.x, true);
      }
    } else if (e.s === 3) {
      if (e.t >= Math.round(ENEMIES.crusher.rest_s * HZ)) {
        e.s = 4;
        e.t = 0;
      }
    } else if (e.s === 4) {
      e.y = Math.max(e.n, e.y - d.riseV);
      if (e.y <= e.n + EPS) {
        e.y = e.n;
        e.s = 0;
        e.t = 0;
      }
    }
    e.dy = e.y - prevY;
    e.py = prevY;
  }

  // ---- enemies ------------------------------------------------------------------------------

  /** Moves an enemy body on x against tiles and closed doors; returns true when blocked. */
  private enemyMoveX(d: DEnemy, e: EState, dx: number): boolean {
    if (dx === 0) return false;
    const T = this.T;
    const nx = e.x + dx;
    const r0 = Math.floor((e.y - d.h + 1) / CELL);
    const r1 = Math.floor((e.y - EPS) / CELL);
    const lead = dx > 0 ? nx + d.hw : nx - d.hw;
    const lc = dx > 0 ? Math.floor((lead - EPS) / CELL) : Math.floor(lead / CELL);
    for (let r = r0; r <= r1; r++) {
      if (T.blocksSide(lc, r)) {
        // allow walking up ≤ 4 px seams
        if (r === r1 && e.g && e.y - r * CELL <= COLLISION.step_assist_px) continue;
        return true;
      }
    }
    for (const i of this.W.doors) {
      if (!this.kinRect(i)) continue;
      if (overlap(nx - d.hw, e.y - d.h, nx + d.hw, e.y, this.kx0, this.ky0, this.kx1, this.ky1)) return true;
    }
    e.x = nx;
    return false;
  }

  /** Gravity + floors for an enemy body (tiles, one-way, slopes, kinematic tops). */
  private enemyFall(d: DEnemy, e: EState): void {
    const W = this.W;
    if (e.g && e.gr >= 0) {
      const ks = this.S.e[e.gr];
      if (this.kinRect(e.gr)) {
        e.x += ks.dx;
        e.y += ks.dy;
      } else {
        e.g = 0;
        e.gr = -1;
      }
    }
    e.vy = e.g ? 0 : Math.min(e.vy + ENEMY_G * DT, ENEMY_MAX_FALL);
    const dy = e.vy * DT;
    if (dy < 0) {
      // rising (hops): ceilings
      const top = e.y - d.h + dy;
      const c0 = Math.floor((e.x - d.hw) / CELL);
      const c1 = Math.floor((e.x + d.hw - EPS) / CELL);
      const r = Math.floor(top / CELL);
      for (let c = c0; c <= c1; c++) {
        if (this.T.blocksHead(c, r) && (r + 1) * CELL > top) {
          e.y = (r + 1) * CELL + d.h;
          e.vy = 0;
          e.g = 0;
          return;
        }
      }
      e.y += dy;
      e.g = 0;
      return;
    }
    const prev = e.y;
    const yMin = prev - 4.5;
    const yMax = prev + dy + (e.g ? COLLISION.slope_stick_px : 0);
    let best = this.supportY(e.x, yMin, yMax, prev, d.hw);
    let bestKin = -1;
    for (const i of W.kin) {
      if (i === d.i || !this.kinRect(i)) continue;
      if (this.kx1 <= e.x - d.hw || this.kx0 >= e.x + d.hw) continue;
      const ks = this.S.e[i];
      const riding = e.gr === i;
      if (!riding && prev > this.ky0 - ks.dy + 0.01) continue;
      if (this.ky0 < yMin - Math.abs(ks.dy) || this.ky0 > yMax) continue;
      if (this.ky0 < best) {
        best = this.ky0;
        bestKin = i;
      }
    }
    if (best < Infinity) {
      e.y = best;
      e.vy = 0;
      e.g = 1;
      e.gr = bestKin;
    } else {
      e.y = prev + dy;
      e.g = 0;
      e.gr = -1;
    }
    if (e.y > W.hPx + 2 * CELL) e.on = 0;
  }

  /** Is there floor ahead of the enemy's leading foot? */
  private floorAhead(d: DEnemy, e: EState, dir: number): boolean {
    const fx = e.x + dir * (d.hw + 1);
    const T = this.T;
    const c = Math.floor(fx / CELL);
    const y = T.floorInColumn(c, fx, e.y - 4.5, e.y + 8, e.y, false);
    if (y < Infinity) return true;
    for (const i of this.W.kin) {
      if (i === d.i || !this.kinRect(i)) continue;
      if (fx >= this.kx0 && fx < this.kx1 && Math.abs(this.ky0 - e.y) <= 4) return true;
    }
    return false;
  }

  private bumpsEnemy(d: DEnemy, e: EState, dir: number): boolean {
    const W = this.W;
    for (const j of W.enemies) {
      if (j === d.i) continue;
      const od = W.defs[j] as DEnemy;
      const oe = this.S.e[j];
      if (oe.on === 0 || od.arch === 'flyer' || od.arch === 'crusher') continue;
      if ((oe.x - e.x) * dir <= 0) continue;
      if (overlap(e.x - d.hw, e.y - d.h, e.x + d.hw, e.y, oe.x - od.hw, oe.y - od.h, oe.x + od.hw, oe.y)) return true;
    }
    return false;
  }

  private canSee(d: DEnemy, e: EState): boolean {
    const P = this.S.p;
    if (P.mode !== 0) return false;
    const dx = P.x - e.x;
    if (Math.abs(dx) > d.sight || Math.abs(P.y - e.y) > ENEMIES.chaser.sight_dy_c * CELL) return false;
    const ex = e.x;
    const ey = e.y - d.h / 2;
    const tx = P.x;
    const ty = P.y - BODY_H / 2;
    const n = Math.ceil(Math.max(Math.abs(tx - ex), Math.abs(ty - ey)) / 8);
    for (let k = 1; k < n; k++) {
      const x = ex + ((tx - ex) * k) / n;
      const y = ey + ((ty - ey) * k) / n;
      if (this.T.solidish(Math.floor(x / CELL), Math.floor(y / CELL))) return false;
    }
    return true;
  }

  private enemiesStep(): void {
    const S = this.S;
    const W = this.W;
    const P = S.p;
    for (const i of W.enemies) {
      const d = W.defs[i] as DEnemy;
      const e = S.e[i];
      if (d.arch === 'crusher') continue;
      if (e.on === 0) {
        if (e.s === E_SQUASH && e.t < 999) e.t++;
        continue;
      }
      e.py = e.y;
      switch (d.arch) {
        case 'walker': {
          this.enemyFall(d, e);
          if (e.on === 0) break;
          if (e.g) {
            let turn = false;
            if (d.ledge && !this.floorAhead(d, e, e.d)) turn = true;
            if (d.bounds && ((e.d > 0 && e.x + d.speed > d.bounds[1]) || (e.d < 0 && e.x - d.speed < d.bounds[0]))) turn = true;
            if (turn) e.d = -e.d;
            else if (this.enemyMoveX(d, e, e.d * d.speed) || this.bumpsEnemy(d, e, e.d)) e.d = -e.d;
            e.vx = e.d * d.speed;
          }
          break;
        }
        case 'static':
          this.enemyFall(d, e);
          break;
        case 'hopper': {
          if (e.s === 2) {
            if (e.vx !== 0 && this.enemyMoveX(d, e, e.vx)) {
              e.d = -e.d;
              e.vx = 0;
            }
            if (d.bounds && (e.x < d.bounds[0] || e.x > d.bounds[1])) {
              e.x = Math.min(Math.max(e.x, d.bounds[0]), d.bounds[1]);
              e.d = -e.d;
              e.vx = 0;
            }
            this.enemyFall(d, e);
            if (e.g && e.vy === 0) {
              e.s = 0;
              e.t = 0;
              e.vx = 0;
            }
          } else {
            this.enemyFall(d, e);
            e.t++;
            const crouch = Math.round((ENEMIES.hopper.crouch_ms * HZ) / 1000);
            if (e.s === 0 && e.t >= d.interval - crouch) {
              e.s = 1;
              e.t = 0;
            } else if (e.s === 1 && e.t >= crouch && e.g) {
              e.s = 2;
              e.t = 0;
              e.vy = ENEMIES.hopper.hop_vy;
              e.g = 0;
              e.gr = -1;
              if (d.forward) {
                if (!this.floorAhead(d, e, e.d) && !this.floorAheadFar(d, e, e.d)) e.d = -e.d;
                e.vx = (e.d * ENEMIES.hopper.drift_cs * CELL) / HZ;
              }
              e.y -= 0.01;
              this.emit({ type: 'hop', frame: S.f, id: d.id, x: e.x / CELL, y: e.y / CELL });
            }
          }
          break;
        }
        case 'flyer': {
          const ox = e.x;
          const oy = e.y;
          this.flyerPos(d, S.ent, this.tmp);
          e.x = this.tmp[0];
          e.y = this.tmp[1];
          e.vx = e.x - ox;
          e.vy = (e.y - oy) * HZ;
          if (e.vx > 0.001) e.d = 1;
          else if (e.vx < -0.001) e.d = -1;
          break;
        }
        case 'shooter': {
          this.enemyFall(d, e);
          if (e.on === 0) break;
          const face = d.facing === 'left' ? -1 : d.facing === 'right' ? 1 : P.x < e.x ? -1 : 1;
          e.d = face;
          e.t++;
          const inflate = Math.round(ENEMIES.shooter.inflate_s * HZ);
          if (e.s === 0 && e.t >= d.interval - inflate) e.s = 1;
          if (e.t >= d.interval) {
            e.s = 0;
            e.t = 0;
            S.bl.push({ x: e.x + face * (d.hw + 3), y: e.y - d.h / 2, vx: face * d.blobV, dist: 0, owner: i, id: S.blobN++ });
            this.emit({ type: 'shoot', frame: S.f, id: d.id, x: e.x / CELL, y: e.y / CELL });
          }
          break;
        }
        case 'chaser': {
          this.enemyFall(d, e);
          if (e.on === 0) break;
          const sees = this.canSee(d, e);
          if (e.s === 0) {
            const v = (ENEMIES.chaser.patrol_cs * CELL) / HZ;
            if (e.g) {
              let turn = false;
              if (d.bounds && ((e.d > 0 && e.x + v > d.bounds[1]) || (e.d < 0 && e.x - v < d.bounds[0]))) turn = true;
              if (turn) e.d = -e.d;
              else if (this.enemyMoveX(d, e, e.d * v) || this.bumpsEnemy(d, e, e.d)) e.d = -e.d;
            }
            e.vx = e.d * v * HZ;
            if (sees) {
              e.s = 1;
              e.t = 0;
              e.vx = 0;
              e.d = P.x < e.x ? -1 : 1;
              this.emit({ type: 'alert', frame: S.f, id: d.id, x: e.x / CELL, y: e.y / CELL });
            }
          } else if (e.s === 1) {
            e.t++;
            if (e.t >= 15) {
              e.s = 2;
              e.t = 0;
              e.n = 0;
            }
          } else {
            const want = P.x < e.x ? -1 : 1;
            const vmax = d.speed * HZ; // px/s
            e.vx = towards(e.vx, want * vmax, ENEMIES.chaser.accel * DT);
            if (e.vx !== 0) e.d = e.vx < 0 ? -1 : 1;
            if (this.enemyMoveX(d, e, e.vx * DT)) {
              if (e.g) {
                e.vy = -Math.sqrt(2 * ENEMY_G * (ENEMIES.chaser.hop_c * CELL + 4));
                e.g = 0;
                e.gr = -1;
                e.y -= 0.01;
              } else e.vx = 0;
            }
            e.n = sees ? 0 : e.n + 1;
            if (e.n >= Math.round(ENEMIES.chaser.give_up_s * HZ)) {
              e.s = 0;
              e.t = 0;
            }
          }
          break;
        }
        default:
          this.enemyFall(d, e);
      }
    }
  }

  private floorAheadFar(d: DEnemy, e: EState, dir: number): boolean {
    const fx = e.x + dir * (d.hw + CELL * 1.5);
    const y = this.T.floorInColumn(Math.floor(fx / CELL), fx, e.y - 4.5, e.y + 32, e.y, false);
    return y < Infinity;
  }

  /** A flyer's position at entity-clock frame t (pure function; no gravity). */
  flyerPos(d: DEnemy, t: number, out: number[]): void {
    const cx = d.x;
    const cy = d.y - d.h / 2;
    let x = cx;
    let y = cy;
    if (d.pattern === 'circle') {
      const a = t / d.period;
      x = cx + d.radius * cosT(a) - d.radius;
      y = cy + d.radius * sinT(a);
    } else if (d.pattern === 'horizontal' || d.pattern === 'vertical') {
      let lo: number;
      let hi: number;
      if (d.pattern === 'horizontal' && d.bounds) {
        lo = d.bounds[0];
        hi = Math.max(lo, d.bounds[1]);
      } else {
        const c0 = d.pattern === 'horizontal' ? cx : cy;
        lo = c0 - d.range / 2;
        hi = c0 + d.range / 2;
      }
      const span = hi - lo;
      if (span > 0 && d.speed > 0) {
        const per = (2 * span) / d.speed;
        const start = ((d.pattern === 'horizontal' ? cx : cy) - lo) / span; // 0..1 along the first leg
        const u = t / per + start / 2;
        const f = u - Math.floor(u);
        const tri = f < 0.5 ? f * 2 : 2 - f * 2;
        if (d.pattern === 'horizontal') x = lo + tri * span;
        else y = lo + tri * span;
      }
    } else {
      y = cy + (ENEMIES.flyer.hover_bob_c * CELL) * sinT(t / d.period);
    }
    out[0] = x;
    out[1] = y + d.h / 2;
  }

  private blobsStep(): void {
    const S = this.S;
    const T = this.T;
    let w = 0;
    for (let k = 0; k < S.bl.length; k++) {
      const b = S.bl[k];
      b.x += b.vx;
      b.dist += Math.abs(b.vx);
      const dead = b.dist > ENEMIES.shooter.blob_max_c * CELL || T.solidish(Math.floor(b.x / CELL), Math.floor(b.y / CELL)) || b.x < -CELL || b.x > this.W.wPx + CELL;
      if (!dead) S.bl[w++] = b;
    }
    S.bl.length = w;
  }

  // ---- contacts -----------------------------------------------------------------------------

  private contacts(J: boolean): void {
    const S = this.S;
    const P = S.p;
    const W = this.W;
    const T = this.T;
    const hx0 = P.x - HURT_HALF_W;
    const hx1 = P.x + HURT_HALF_W;
    const hy0 = P.y - HURT_H;
    const hy1 = P.y;
    const bx0 = P.x - HALF_W;
    const bx1 = P.x + HALF_W;
    const by0 = P.y - BODY_H;
    const by1 = P.y;
    // tiles: lava (always lethal) and legacy hazard cells
    {
      const c0 = Math.floor(hx0 / CELL);
      const c1 = Math.floor((hx1 - EPS) / CELL);
      const r0 = Math.floor(hy0 / CELL);
      const r1 = Math.floor((hy1 - EPS) / CELL);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const t = T.at(c, r);
          if (t === T_LAVA) {
            if (hy1 > T.lavaTop(c, r)) {
              this.die('lava', P.x);
              return;
            }
          } else if (t === T_X) {
            this.hit('hazard', c * CELL + 8, false);
            if (P.mode !== 0) return;
          }
        }
      }
    }
    for (const i of W.spikes) {
      const b = (W.defs[i] as DSpikes).band;
      if (overlap(hx0, hy0, hx1, hy1, b[0], b[1], b[2], b[3])) {
        this.hit('spikes', (b[0] + b[2]) / 2, false);
        if (P.mode !== 0) return;
      }
    }
    for (const i of W.saws) {
      const d = W.defs[i] as DSaw;
      const e = S.e[i];
      if (d.path.cycle > 0) {
        pathPos(d.path, S.ent, this.tmp);
        e.x = this.tmp[0];
        e.y = this.tmp[1];
      }
      if (distBox2(e.x, e.y, hx0, hy0, hx1, hy1) < d.rHit * d.rHit) {
        this.hit('saw', e.x, false);
        if (P.mode !== 0) return;
      }
    }
    const br = HAZARDS.firebar.ball_r_px;
    for (const i of W.firebars) {
      const d = W.defs[i] as DFirebar;
      const a = d.phase + d.turnsPerF * S.ent;
      const ca = cosT(a);
      const sa = sinT(a);
      for (let k = 0; k < d.balls; k++) {
        const x = d.x + ca * FIREBAR_STEP * (k + FIREBAR_OFF);
        const y = d.y + sa * FIREBAR_STEP * (k + FIREBAR_OFF);
        if (distBox2(x, y, hx0, hy0, hx1, hy1) < br * br) {
          this.hit('firebar', x, false);
          if (P.mode !== 0) return;
          break;
        }
      }
    }
    for (let k = 0; k < S.bl.length; k++) {
      const b = S.bl[k];
      if (overlap(hx0, hy0, hx1, hy1, b.x - 3, b.y - 3, b.x + 3, b.y + 3)) {
        S.bl.splice(k, 1);
        this.hit('blob', b.x, false);
        if (P.mode !== 0) return;
        break;
      }
    }
    // enemies: stomp or hurt (§5.5)
    for (const i of W.enemies) {
      const d = W.defs[i] as DEnemy;
      const e = S.e[i];
      if (e.on === 0 || d.arch === 'crusher') continue;
      const inset = 2;
      const ex0 = e.x - d.hw + inset;
      const ex1 = e.x + d.hw - inset;
      const ey0 = e.y - d.h + inset;
      const ey1 = e.y;
      if (!overlap(bx0, by0, bx1, by1, ex0, ey0, ex1, ey1)) continue;
      const prevTop = e.py - d.h;
      if (W.ab.stomp && !d.spiky && P.vyPre > 0 && P.prevFeet <= prevTop + DAMAGE.stomp.prev_tolerance_px) {
        e.on = 0;
        e.s = E_SQUASH;
        e.t = 0;
        P.vy = J ? DAMAGE.stomp.bounce_vy_held : DAMAGE.stomp.bounce_vy;
        P.gnd = 0;
        P.gref = -1;
        P.cut = 0;
        P.coy = 0;
        P.y = Math.min(P.y, prevTop);
        P.hs = DAMAGE.stomp.hitstop_f;
        P.chain++;
        if (P.chain >= DAMAGE.stomp.chain_coin_from) this.addCoins(1);
        this.touched.push(i);
        this.emit({ type: 'stomp', frame: S.f, id: d.id, x: e.x / CELL, y: e.y / CELL, chain: P.chain });
        continue;
      }
      if (overlap(hx0, hy0, hx1, hy1, ex0, ey0, ex1, ey1)) {
        this.hit('enemy', e.x, false);
        if (P.mode !== 0) return;
      }
    }
    // pickups
    const mag = 6;
    for (const i of W.coins) {
      const e = S.e[i];
      if (e.on === 0) continue;
      const r = 5 + mag;
      if (distBox2(e.x, e.y, bx0, by0, bx1, by1) <= r * r) {
        e.on = 0;
        this.touched.push(i);
        this.addCoins(1);
        this.emit({ type: 'coin', frame: S.f, id: W.defs[i].id, x: e.x / CELL, y: e.y / CELL, n: S.coins });
      }
    }
    for (const i of W.bigs) {
      const e = S.e[i];
      if (e.s !== 0) continue;
      const r = 8 + mag;
      if (distBox2(e.x, e.y, bx0, by0, bx1, by1) <= r * r) {
        e.s = 1;
        this.touched.push(i);
        this.emit({ type: 'big_coin', frame: S.f, id: W.defs[i].id, x: e.x / CELL, y: e.y / CELL });
      }
    }
    for (const i of W.keys) {
      const e = S.e[i];
      if (e.on === 0) continue;
      const r = 8 + mag;
      if (distBox2(e.x, e.y, bx0, by0, bx1, by1) <= r * r) {
        e.on = 0;
        this.touched.push(i);
        this.emit({ type: 'key', frame: S.f, id: W.defs[i].id, x: e.x / CELL, y: e.y / CELL });
      }
    }
    // doors open on touch while holding one of their keys
    for (const i of W.doors) {
      const e = S.e[i];
      if (e.on === 0) continue;
      const d = W.defs[i] as DDoor;
      if (!overlap(bx0 - 1.5, by0 - 1.5, bx1 + 1.5, by1 + 1.5, d.box[0], d.box[1], d.box[2], d.box[3])) continue;
      if (d.keys.some((k) => S.e[k].on === 0)) this.openDoor(i);
    }
    // springs
    for (const i of W.springs) {
      const d = W.defs[i] as DSpring;
      const b = d.box;
      if (d.dir === 'up') {
        if (P.vy < 0 || bx1 <= b[0] + 1 || bx0 >= b[2] - 1 || P.y < b[1] || P.y > b[3] + 1) continue;
        P.vy = HAZARDS.spring.up_vy_per_strength * d.strength;
      } else {
        if (!overlap(bx0, by0, bx1, by1, b[0], b[1], b[2], b[3])) continue;
        const s = d.dir === 'left' ? -1 : 1;
        P.vx = s * HAZARDS.spring.side_vx;
        P.lock = HAZARDS.spring.side_lock_f;
        P.lockvx = P.vx;
        P.vy = HAZARDS.spring.side_vy;
        P.face = s;
      }
      P.gnd = 0;
      P.gref = -1;
      P.cut = 0;
      P.coy = 0;
      P.aj = 0;
      P.chain = 0;
      S.e[i].t = 0;
      this.touched.push(i);
      this.emit({ type: 'spring', frame: S.f, id: d.id, x: d.x / CELL, y: d.y / CELL, vy: P.vy });
      break;
    }
    // checkpoints
    for (const i of W.checkpoints) {
      const e = S.e[i];
      if (e.s !== 0) continue;
      const b = (W.defs[i] as DCheckpoint).box;
      if (!overlap(bx0, by0, bx1, by1, b[0], b[1], b[2], b[3])) continue;
      e.s = 1;
      S.cp = i;
      this.touched.push(i);
      this.bankBigCoins();
      const dead: number[] = [];
      for (const j of W.enemies) if (S.e[j].on === 0) dead.push(j);
      const keys: number[] = [];
      for (const j of W.keys) if (S.e[j].on === 0) keys.push(j);
      const doors: number[] = [];
      for (const j of W.doors) if (S.e[j].on === 0) doors.push(j);
      const big: number[] = [];
      for (const j of W.bigs) if (S.e[j].s === 2) big.push(j);
      S.save = { dead, keys, doors, big };
      this.emit({ type: 'checkpoint', frame: S.f, id: W.defs[i].id, x: (W.defs[i] as DCheckpoint).x / CELL, y: (W.defs[i] as DCheckpoint).y / CELL });
    }
    // touch triggers
    if (W.triggers.length) this.runTriggers(bx0, by0, bx1, by1);
    if (P.mode !== 0) return;
    // goal
    for (const i of W.goals) {
      const b = (W.defs[i] as DGoal).box;
      if (overlap(bx0, by0, bx1, by1, b[0], b[1], b[2], b[3])) {
        this.touched.push(i);
        this.win(W.defs[i].id);
        return;
      }
    }
  }

  private runTriggers(bx0: number, by0: number, bx1: number, by1: number): void {
    const W = this.W;
    for (const t of W.triggers) {
      if (t.when === 'timer') continue;
      let fire = false;
      if (t.when === 'collect') fire = this.touched.includes(t.ref);
      else {
        const d = W.defs[t.ref];
        const e = this.S.e[t.ref];
        const cx = d.k === 'door' ? (d.box[0] + d.box[2]) / 2 : e.x;
        const cy = d.k === 'door' ? (d.box[1] + d.box[3]) / 2 : e.y;
        fire = distBox2(cx, cy, bx0, by0, bx1, by1) <= 12 * 12;
      }
      if (!fire) continue;
      if (t.then === 'open') this.openDoor(t.target);
      else if (t.then === 'win') this.win();
      else this.lose();
      if (this.S.p.mode !== 0) return;
    }
  }

  private openDoor(i: number): void {
    const e = this.S.e[i];
    if (e.on === 0) return;
    e.on = 0;
    e.t = 0;
    const db = (this.W.defs[i] as DDoor).box;
    this.emit({ type: 'door_open', frame: this.S.f, id: this.W.defs[i].id, x: (db[0] + db[2]) / 2 / CELL, y: (db[1] + db[3]) / 2 / CELL });
  }

  private addCoins(n: number): void {
    const S = this.S;
    for (let k = 0; k < n; k++) {
      S.coins++;
      if (this.W.lives !== null && S.coins % DAMAGE.coins_per_life === 0) {
        S.lives++;
        this.emit({ type: 'life', frame: S.f, n: S.lives });
      }
    }
  }

  private bankBigCoins(): void {
    const S = this.S;
    for (const i of this.W.bigs) {
      if (S.e[i].s === 1) {
        S.e[i].s = 2;
        S.bigBanked++;
        this.emit({ type: 'big_coin_banked', frame: S.f, id: this.W.defs[i].id, x: S.e[i].x / CELL, y: S.e[i].y / CELL });
      }
    }
  }

  // ---- damage, death, respawn, win, lose ---------------------------------------------------

  /** A hit: with hearts > 1 it costs a heart with knockback (§5.5); otherwise it kills. */
  hit(cause: string, srcX: number, lethal: boolean): void {
    const P = this.S.p;
    if (P.mode !== 0) return;
    if (!lethal && P.inv > 0) return;
    if (!lethal && P.hp > 1) {
      P.hp--;
      P.inv = Math.round(DAMAGE.invulnerable_s * HZ);
      const dir = P.x === srcX ? -P.face : P.x > srcX ? 1 : -1;
      P.vx = dir * DAMAGE.knockback.vx;
      P.vy = DAMAGE.knockback.vy;
      P.gnd = 0;
      P.gref = -1;
      P.cut = 0;
      this.emit({ type: 'hit', frame: this.S.f, cause, x: P.x / CELL, y: P.y / CELL, n: P.hp });
      return;
    }
    this.die(cause, srcX);
  }

  die(cause: string, srcX: number): void {
    void srcX;
    const S = this.S;
    const P = S.p;
    if (P.mode !== 0) return;
    P.mode = 1;
    P.df = 0;
    P.hs = 0;
    P.vx = 0;
    P.vy = 0;
    S.deaths++;
    if (this.W.lives !== null) S.lives = Math.max(0, S.lives - 1);
    this.emit({ type: 'death', frame: S.f, cause, x: P.x / CELL, y: P.y / CELL });
  }

  private respawn(): void {
    const S = this.S;
    const W = this.W;
    if (W.lives !== null && S.lives <= 0) {
      this.emit({ type: 'game_over', frame: S.f });
      this.fullReset();
      return;
    }
    const keepCoins = W.coins.map((i) => S.e[i].on);
    const cps = W.checkpoints.map((i) => S.e[i].s);
    const save = S.save;
    S.e = W.defs.map((d) => this.initEntity(d));
    W.coins.forEach((i, k) => (S.e[i].on = keepCoins[k]));
    W.checkpoints.forEach((i, k) => (S.e[i].s = cps[k]));
    if (save) {
      for (const j of save.dead) S.e[j].on = 0;
      for (const j of save.keys) S.e[j].on = 0;
      for (const j of save.doors) {
        S.e[j].on = 0;
        S.e[j].t = 999;
      }
      for (const j of save.big) S.e[j].s = 2;
    }
    S.bl = [];
    S.ent = 0;
    this.placePlayer();
    this.emit({ type: 'respawn', frame: S.f, id: S.cp >= 0 ? W.defs[S.cp].id : W.start.id ?? 'start', x: S.p.x / CELL, y: S.p.y / CELL });
  }

  private placePlayer(): void {
    const S = this.S;
    const W = this.W;
    const P = S.p;
    const cp = S.cp >= 0 ? (W.defs[S.cp] as DCheckpoint) : null;
    P.x = cp ? cp.x : W.start.x;
    P.y = cp ? cp.y : W.start.y;
    P.vx = 0; P.vy = 0; P.gnd = 0; P.gref = -1; P.gcode = 0; P.coy = 0; P.buf = 0; P.cut = 0; P.face = 1;
    P.drop = 0; P.lock = 0; P.lockvx = 0; P.aj = 0; P.inv = 0; P.hp = W.hearts; P.mode = 0; P.df = 0; P.hs = 0;
    P.chain = 0; P.skid = 0; P.prevFeet = P.y; P.vyPre = 0; P.upTol = 0.5; P.bonk = 0; P.run = 0;
    if (W.cameraMode === 'no_backscroll') S.cam = { ...S.cam, max_x: Math.max(0, Math.min(S.cam.max_x, P.x / CELL - 24)) };
    this.settleSpawn();
  }

  /** Puts a freshly placed player on its support if it is within 1 cell below / 0.5 above the spawn point. */
  private settleSpawn(): void {
    const P = this.S.p;
    const y = this.supportY(P.x, P.y - 8, P.y + CELL, P.y - 8);
    if (y < Infinity) {
      P.y = y;
      P.gnd = 1;
      P.gcode = this.code[0];
    }
    P.prevFeet = P.y;
  }

  private fullReset(): void {
    const S = this.S;
    const W = this.W;
    const keep = { f: S.f, clock0: S.clock0, clockF: S.clockF, deaths: S.deaths, cam: S.cam, rng: S.rng, errs: S.errs };
    this.S = cloneState(this.initial);
    const N = this.S;
    N.f = keep.f; N.clock0 = keep.clock0; N.clockF = keep.clockF; N.deaths = keep.deaths; N.cam = keep.cam; N.rng = keep.rng;
    N.errs = keep.errs;
    N.tbase = keep.clockF;
    N.lives = W.lives ?? 0;
    this.emit({ type: 'respawn', frame: N.f, id: W.start.id ?? 'start', x: N.p.x / CELL, y: N.p.y / CELL });
  }

  private lose(): void {
    this.emit({ type: 'lose', frame: this.S.f, cause: 'timer', x: this.S.p.x / CELL, y: this.S.p.y / CELL });
    this.fullReset();
  }

  private win(id?: string): void {
    const S = this.S;
    this.bankBigCoins();
    S.won = 1;
    S.p.mode = 2;
    S.p.vx = 0;
    S.p.vy = 0;
    this.emit({ type: 'win', frame: S.f, id, x: S.p.x / CELL, y: S.p.y / CELL, n: S.clockF });
  }
}

function towards(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}

export type { DCoin, DKey, DPlatform };
