/**
 * Ghost tracks (§8.4 ghosts, "beat my level", §7.10 "Watch the bot"). A replay is re-simulated once, with the same
 * loop verifyRun uses, into compact per-frame poses. Up to 3 ghosts then cost nothing per frame, seek instantly
 * (restart, results-card scrubbing) and can say how far ahead or behind the player is.
 *
 * Frames are lock-step with the viewer's own sim: pose(f) is the ghost after f steps from the level start, the same
 * frame index the player's sim is at, so a ghost riding a moving platform rides the platform the player sees (until
 * either one dies: a respawn restarts the entity clock). The speedrun clock of both starts at their first input.
 */
import { SimCore, clockMs } from '../sim/core.ts';
import { CELL } from '../sim/tiles.ts';
import type { PlayerView, SimEvent } from '../sim/types.ts';
import type { LevelV2, Replay } from '../types.gen.ts';
import { decodeReplay } from './codec.ts';
import { simulateInputs } from './run.ts';

const STATES: PlayerView['state'][] = ['idle', 'run', 'skid', 'jump', 'fall', 'dead', 'respawn', 'win'];

export interface GhostPose {
  frame: number;
  x: number; // cells, feet centre
  y: number;
  vx: number; // px/s
  vy: number;
  facing: 1 | -1;
  on_ground: boolean;
  state: PlayerView['state'];
  /** Frames into the death sequence (0 when alive), for the shard / reassemble animation. */
  dead_f: number;
  /** Speedrun clock of the ghost at this frame (ms). */
  clock_ms: number;
}

export interface GhostEvent {
  frame: number;
  type: 'jump' | 'double_jump' | 'land' | 'death' | 'respawn' | 'win' | 'checkpoint' | 'stomp' | 'coin' | 'big_coin' | 'spring';
  x: number;
  y: number;
}

const KEEP_EVENTS = new Set<SimEvent['type']>(['jump', 'double_jump', 'land', 'death', 'respawn', 'win', 'checkpoint', 'stomp', 'coin', 'big_coin', 'spring']);

export class GhostTrack {
  /** Poses stored: index 0 is the start, index f the state after f steps. */
  readonly length: number;
  readonly finished: boolean;
  /** Sim frame of the win (0 when the replay never reaches the goal). */
  readonly winFrame: number;
  /** Sim frame of the first input (the clock start), −1 when the replay never moves. */
  readonly clock0: number;
  readonly time_ms: number;
  readonly deaths: number;
  readonly coins: number;
  readonly big_coins: number;
  readonly events: GhostEvent[];
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pvx: Float32Array;
  private readonly pvy: Float32Array;
  private readonly bits: Uint8Array; // facing (1) | on_ground (2) | state << 2
  private readonly dead: Uint8Array;
  private readonly clock: Uint32Array;
  private readonly maxX: Float32Array; // running max of x (cells), for firstReach

  constructor(d: {
    px: Float32Array; py: Float32Array; pvx: Float32Array; pvy: Float32Array; bits: Uint8Array; dead: Uint8Array; clock: Uint32Array;
    length: number; finished: boolean; winFrame: number; clock0: number; time_ms: number; deaths: number; coins: number; big_coins: number;
    events: GhostEvent[];
  }) {
    this.px = d.px;
    this.py = d.py;
    this.pvx = d.pvx;
    this.pvy = d.pvy;
    this.bits = d.bits;
    this.dead = d.dead;
    this.clock = d.clock;
    this.length = d.length;
    this.finished = d.finished;
    this.winFrame = d.winFrame;
    this.clock0 = d.clock0;
    this.time_ms = d.time_ms;
    this.deaths = d.deaths;
    this.coins = d.coins;
    this.big_coins = d.big_coins;
    this.events = d.events;
    this.maxX = new Float32Array(d.length);
    let m = -Infinity;
    for (let i = 0; i < d.length; i++) {
      const st = d.bits[i] >> 2;
      // a death sequence is not progress
      if (st !== 5 && st !== 6 && d.px[i] > m) m = d.px[i];
      this.maxX[i] = m;
    }
  }

  /** The last stored frame index (the ghost holds this pose afterwards). */
  get lastFrame(): number {
    return this.length - 1;
  }

  /** Pose after `frame` steps (clamped to the recorded range). */
  pose(frame: number): GhostPose {
    const i = Math.max(0, Math.min(this.length - 1, Math.floor(frame)));
    const b = this.bits[i];
    return {
      frame: i, x: this.px[i], y: this.py[i], vx: this.pvx[i], vy: this.pvy[i], facing: b & 1 ? -1 : 1, on_ground: (b & 2) !== 0,
      state: STATES[b >> 2] ?? 'idle', dead_f: this.dead[i], clock_ms: clockMs(this.clock[i]),
    };
  }

  /** Position between frame − 1 and frame (a = 0..1), the way the engine interpolates its own player. */
  positionLerp(frame: number, a: number): [number, number] {
    const i = Math.max(0, Math.min(this.length - 1, Math.floor(frame)));
    const j = Math.max(0, i - 1);
    // never interpolate across a respawn teleport
    if (Math.abs(this.px[i] - this.px[j]) > 4 || Math.abs(this.py[i] - this.py[j]) > 4) return [this.px[i], this.py[i]];
    return [this.px[j] + (this.px[i] - this.px[j]) * a, this.py[j] + (this.py[i] - this.py[j]) * a];
  }

  /** Has the ghost finished (or run out of input) more than `linger` frames before `frame`? */
  over(frame: number, linger = 120): boolean {
    return frame > this.length - 1 + linger;
  }

  /** First frame at which the ghost's feet reached x (cells) going right, or −1 when it never did. */
  firstReach(x: number): number {
    const m = this.maxX;
    if (!this.length || m[this.length - 1] < x) return -1;
    let lo = 0;
    let hi = this.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid] >= x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * Live split against the ghost for a player at `x` (cells) on `frame`: positive lead = the player got there first
   * (ahead), negative = the ghost was there earlier (behind). null when the ghost never got that far.
   */
  split(frame: number, x: number): { lead_frames: number; lead_ms: number } | null {
    const g = this.firstReach(x);
    if (g < 0) return null;
    const lead = g - frame;
    return { lead_frames: lead, lead_ms: Math.round((lead * 1000) / 60) };
  }

  /**
   * The same split on the speedrun clock, for a race where the ghost starts with the player's first input:
   * `playerClockFrames` is the player's clock (frames since their first input). Positive = the player is ahead.
   */
  splitClock(playerClockFrames: number, x: number): { lead_frames: number; lead_ms: number } | null {
    const g = this.firstReach(x);
    if (g < 0) return null;
    const ghostClock = this.clock[g];
    const lead = ghostClock - playerClockFrames;
    return { lead_frames: lead, lead_ms: Math.round((lead * 1000) / 60) };
  }

  /**
   * Ghost frame for a race aligned on first inputs (both speedrun clocks start together). `playerClock0` is the
   * player's sim frame right after the step that carried their first input (−1 before it): the ghost waits at its
   * own first-input frame until then, then advances with the player.
   */
  raceFrame(playerFrame: number, playerClock0: number): number {
    const g0 = this.clock0 < 0 ? 0 : this.clock0;
    if (playerClock0 < 0) return Math.min(Math.max(0, g0 - 1), this.length - 1);
    return g0 + (playerFrame - playerClock0);
  }

  /** Events of frames in (from, to] (for ghost dust puffs and sounds). */
  eventsBetween(from: number, to: number): GhostEvent[] {
    const out: GhostEvent[] = [];
    for (const e of this.events) if (e.frame > from && e.frame <= to) out.push(e);
    return out;
  }
}

/**
 * Re-simulates a replay (or raw inputs) on `level` into a GhostTrack. The track stops at the win (or the end of the
 * input, or `maxFrames`); a ghost that never finishes simply stops where its input ends.
 */
export function ghostTrack(level: LevelV2, src: Replay | Uint8Array | string, o?: { maxFrames?: number }): GhostTrack {
  let input: Uint8Array;
  try {
    input = src instanceof Uint8Array ? src : decodeReplay(typeof src === 'string' ? src : String(src?.input ?? ''));
  } catch {
    input = new Uint8Array(0);
  }
  const n = Math.min(input.length, o?.maxFrames ?? input.length);
  const cap = n + 1;
  const px = new Float32Array(cap);
  const py = new Float32Array(cap);
  const pvx = new Float32Array(cap);
  const pvy = new Float32Array(cap);
  const bits = new Uint8Array(cap);
  const dead = new Uint8Array(cap);
  const clock = new Uint32Array(cap);
  const events: GhostEvent[] = [];
  let len = 0;
  let clock0 = -1;
  const put = (i: number, v: PlayerView, clk: number): void => {
    px[i] = v.x;
    py[i] = v.y;
    pvx[i] = v.vx;
    pvy[i] = v.vy;
    const st = Math.max(0, STATES.indexOf(v.state));
    bits[i] = (v.facing < 0 ? 1 : 0) | (v.on_ground ? 2 : 0) | (st << 2);
    dead[i] = Math.min(255, v.dead_f ?? 0);
    clock[i] = clk;
  };
  const run = simulateInputs(level, input, {
    maxTicks: n,
    onTick: (sim, f) => {
      const S = sim.S;
      const P = S.p;
      if (clock0 < 0 && S.clock0 >= 0) clock0 = S.clock0;
      const state: PlayerView['state'] = P.mode === 2 ? 'win' : P.mode === 1 ? 'dead' : P.mode === 3 ? 'respawn' : P.gnd === 0 ? (P.vy < 0 ? 'jump' : 'fall') : P.skid > 0 ? 'skid' : Math.abs(P.vx) > 1 ? 'run' : 'idle';
      put(f + 1, {
        x: P.x / CELL, y: P.y / CELL, vx: P.vx, vy: P.vy, facing: P.face < 0 ? -1 : 1, on_ground: P.gnd > 0, state,
        invulnerable_f: P.inv, dead_f: P.mode === 1 || P.mode === 3 ? P.df : 0,
      }, S.clockF);
      len = f + 2;
      for (const e of sim.ev) {
        if (!KEEP_EVENTS.has(e.type)) continue;
        events.push({ frame: f + 1, type: e.type as GhostEvent['type'], x: e.x ?? P.x / CELL, y: e.y ?? P.y / CELL });
      }
    },
  });
  // frame 0: the settled spawn before any input
  put(0, new SimCore(level, { seed: 1 }).view().player, 0);
  if (len === 0) len = 1;
  const S = run.sim.S;
  return new GhostTrack({
    px, py, pvx, pvy, bits, dead, clock, length: len, finished: S.won === 1, winFrame: run.winFrame, clock0,
    time_ms: clockMs(S.clockF), deaths: S.deaths, coins: S.coins, big_coins: S.bigBanked, events,
  });
}
