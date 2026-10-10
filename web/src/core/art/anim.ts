/**
 * Rig animation from one drawing (PLAN_V2 §7.6), pure and renderer-free: the engine's PlayerView, the ghosts and the
 * Character Studio's mini-stage can all drive the same poses from the same sim-like state, so a character moves the
 * same everywhere. Times are ms; lengths are logical px; angles are radians. Deterministic for a given seed and input
 * sequence (blinks use the seeded art RNG, never Math.random).
 *
 * The §7.6 table:
 * - Run: legs swing ±28° at f = 1.8 + 0.12·speed (c/s) Hz in opposite phase; arms ±20° against them; body bob 1.5 px
 *   at 2f; lean 4°·v/vmax. Walk wobble: the body rocks ±2.5° at f and its top sways 1 px.
 * - Skid: lean back 10°.
 * - Jump: launch squash (0.8, 1.25) easing to 1 over 120 ms; apex (1.05, 0.95); falling: legs together, arms up 30°.
 * - Land: (1.25, 0.75) back to 1 over 140 ms, scaled by impact (vy / 330).
 * - Idle: breathing scaleY 1.00 ↔ 1.03 at 0.6 Hz with a 0.6 px bob; a 100 ms blink every 2.5-5 s (seeded); pupils
 *   1 px toward the look target.
 * - Turn: 60 ms squash, then flip.
 * - Win: arms up and a happy hop every 650 ms.
 *
 * "One drawing" (no legs or arms the rig can swing, e.g. a raster sprite or a single blob): the whole body waddles
 * instead (±5° at f, a 2 px hop at 2f), so it still walks. Every character also gets a jelly sway: the top of the body
 * lags behind horizontal acceleration on a damped spring (≤ 4 px), which is what makes a stiff doodle feel soft.
 */
import { RIG } from '../params.ts';
import { clamp, hash32, rng } from './geom.ts';

export type RigState = 'idle' | 'run' | 'skid' | 'jump' | 'fall' | 'dead' | 'respawn' | 'win';

export interface RigInput {
  dt: number; // ms of (scaled) time since the last update; 0 while frozen (hit-stop, pause)
  now: number; // ms, monotonic
  vx: number; // px/s
  vy: number; // px/s (y down)
  facing: 1 | -1;
  onGround: boolean;
  state: RigState;
  vmax: number; // px/s, the profile's top speed (lean scale)
  /** Direction to look toward (px, world frame, relative to the head), or null. */
  look?: [number, number] | null;
}

export interface RigPose {
  flip: 1 | -1; // shown facing (the turn flips after its 60 ms squash)
  sx: number; // root scale about the feet (squash / stretch, breathing, turn squash)
  sy: number;
  rot: number; // root rotation about the feet (lean, waddle)
  bob: number; // px added to the body's y (negative = up)
  hop: number; // px added to the whole character's y (win hops; negative = up)
  shear: number; // px the top of the body is displaced along local +x (jelly sway + walk wobble), 0 at the feet
  legSwing: number; // rad; leg on side s rotates by s·legSwing + s·legBase
  legBase: number;
  armSwing: number; // rad; arm on side s rotates by −s·armSwing + s·armBase
  armBase: number;
  eye: [number, number]; // pupil offset px, local frame (already flipped)
  blink: boolean;
}

export interface RigAnimOptions {
  /** True when the drawing has legs or arms the rig can swing; false for one-drawing characters. */
  parts?: boolean;
  /** Body height in px (for the jelly spring's reach); 30 by default. */
  heightPx?: number;
}

const DEG = Math.PI / 180;
// jelly sway: a damped spring driven by horizontal acceleration (ω ≈ 18 rad/s ≈ 2.9 Hz, ζ ≈ 0.32)
const JELLY_K = 330;
const JELLY_C = 11.5;
const JELLY_M = 0.0021; // px of lean per px/s² of acceleration: a 1400 px/s² stop sways ≈ 3 px
const JELLY_MAX = 4;
const WOBBLE_DEG = 2.5;
const WADDLE_DEG = 5;
const WADDLE_HOP_PX = 2;
const IDLE_BOB_PX = 0.6;
const WIN_HOP_MS = 650;
const WIN_AIR_MS = 380;
const WIN_HOP_PX = 7;

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export class RigAnimator {
  private sq = { fx: 1, fy: 1, t: 1, dur: 1 };
  private turnT = 1;
  private shown: 1 | -1 = 1;
  private phase = 0;
  private nextBlink: number;
  private blinkUntil = -1;
  private readonly r: () => number;
  private readonly parts: boolean;
  private readonly heightPx: number;
  private shear = 0;
  private shearV = 0;
  private lastVx = 0;
  private hasVx = false;
  private winT = -1;
  private lastHopLand = -1;

  constructor(seed: number, o: RigAnimOptions = {}) {
    this.r = rng(hash32(`rig:${seed}`));
    const [a, b] = RIG.idle.blink_every_s;
    this.nextBlink = (a + this.r() * (b - a)) * 1000;
    this.parts = o.parts ?? true;
    this.heightPx = o.heightPx ?? 30;
  }

  /** Launch squash (jump or double jump). */
  jump(): void {
    this.sq = { fx: RIG.jump_squash[0], fy: RIG.jump_squash[1], t: 0, dur: RIG.squash_ms };
  }

  /** Landing squash scaled by impact = |vy| / 330 (clamped 0.2 … 1.3). */
  land(impact: number): void {
    const k = clamp(impact, 0.2, 1.3);
    const [lx, ly] = RIG.land_squash;
    this.sq = { fx: 1 + (lx - 1) * k, fy: 1 + (ly - 1) * k, t: 0, dur: RIG.land_ms };
  }

  /** Snap to a facing without the turn animation (spawn, respawn). */
  face(f: 1 | -1): void {
    this.shown = f;
    this.turnT = 1;
  }

  /** Forget motion history (teleports: respawn, rewind). */
  reset(): void {
    this.shear = 0;
    this.shearV = 0;
    this.hasVx = false;
    this.winT = -1;
    this.phase = 0;
    this.sq = { fx: 1, fy: 1, t: 1, dur: 1 };
  }

  update(i: RigInput): RigPose {
    const dt = Math.max(0, i.dt);
    const speed = Math.abs(i.vx) / 16; // c/s
    const moving = i.onGround && speed > 0.4 && i.state !== 'skid' && i.state !== 'win';
    // squash / stretch (jump launch, landing)
    this.sq.t = Math.min(this.sq.dur, this.sq.t + dt);
    const k = easeOut(this.sq.t / this.sq.dur);
    let sx = this.sq.fx + (1 - this.sq.fx) * k;
    let sy = this.sq.fy + (1 - this.sq.fy) * k;
    if (!i.onGround && Math.abs(i.vy) < 40 && this.sq.t >= this.sq.dur) {
      sx *= RIG.apex_squash[0];
      sy *= RIG.apex_squash[1];
    }
    // turn: 60 ms squash, then flip
    if (i.facing !== this.shown) {
      if (this.turnT >= 1) this.turnT = 0;
      this.turnT += dt / RIG.turn_ms;
      if (this.turnT >= 1) {
        this.shown = i.facing;
        this.turnT = 1;
      }
    }
    if (this.turnT < 1) sx *= 1 - 0.4 * Math.sin(Math.min(1, this.turnT) * Math.PI);

    let rot = 0;
    let bob = 0;
    let legSwing = 0;
    let armSwing = 0;
    let legBase = 0;
    let armBase = 0;
    let wobbleShear = 0;
    let hop = 0;
    const idle = i.onGround && speed < 0.4 && i.state !== 'dead' && i.state !== 'win';
    if (idle) {
      const b = 0.5 - 0.5 * Math.cos((i.now / 1000) * RIG.idle.hz * Math.PI * 2);
      sy *= 1 + RIG.idle.breath * b;
      bob = -IDLE_BOB_PX * b;
      this.phase *= 0.8;
    }
    if (moving) {
      const f = RIG.run.freq_base_hz + RIG.run.freq_per_cs * speed;
      this.phase += (dt / 1000) * f * Math.PI * 2;
      const s = Math.sin(this.phase);
      const lean = Math.sign(i.vx) * RIG.run.lean_deg * DEG * Math.min(1, Math.abs(i.vx) / Math.max(1, i.vmax));
      const frac = Math.min(1, speed / 6);
      if (this.parts) {
        legSwing = RIG.run.leg_deg * DEG * s;
        armSwing = RIG.run.arm_deg * DEG * s;
        bob = -RIG.run.bob_px * (0.5 - 0.5 * Math.cos(this.phase * 2));
        rot = lean + WOBBLE_DEG * DEG * s * frac;
        wobbleShear = 1 * s * frac;
      } else {
        // one drawing: the whole body waddles and hops on each step
        rot = lean + WADDLE_DEG * DEG * s;
        bob = -WADDLE_HOP_PX * Math.abs(Math.sin(this.phase));
        wobbleShear = 1.4 * s;
        sy *= 1 + 0.04 * Math.abs(Math.cos(this.phase));
      }
    } else if (i.state === 'skid') {
      rot = -i.facing * RIG.skid_lean_deg * DEG;
      legBase = 10 * DEG;
    } else if (!i.onGround && i.state !== 'win') {
      // airborne: legs together, arms up 30° while falling
      armBase = i.vy > 40 ? -30 * DEG : -12 * DEG;
      legBase = i.vy < 0 ? 8 * DEG : 0;
      if (!this.parts) rot = clamp(i.vx / Math.max(1, i.vmax), -1, 1) * 3 * DEG;
      this.phase *= 0.9;
    }
    // win: arms up, a happy hop every 650 ms with a small squash on each landing
    if (i.state === 'win') {
      if (this.winT < 0) this.winT = 0;
      this.winT += dt;
      armBase = -55 * DEG;
      const c = this.winT % WIN_HOP_MS;
      const n = Math.floor(this.winT / WIN_HOP_MS);
      if (c < WIN_AIR_MS) {
        const u = c / WIN_AIR_MS;
        hop = -WIN_HOP_PX * 4 * u * (1 - u);
        legBase = 6 * DEG;
      } else if (n !== this.lastHopLand) {
        this.lastHopLand = n;
        this.land(0.45);
      }
      if (!this.parts) rot = Math.sin((this.winT / WIN_HOP_MS) * Math.PI * 2) * 4 * DEG;
    } else this.winT = -1;

    // jelly sway: the body top lags behind horizontal acceleration (world frame), then springs back
    if (dt > 0) {
      const dts = dt / 1000;
      const acc = this.hasVx ? (i.vx - this.lastVx) / Math.max(1 / 240, dts) : 0;
      this.lastVx = i.vx;
      this.hasVx = true;
      // the spring's rest point: decelerating leaves the top leaning forward, accelerating leaves it behind
      const rest = clamp(-acc, -3000, 3000) * JELLY_M * (this.heightPx / 30);
      let left = dts;
      while (left > 0) {
        const h = Math.min(left, 1 / 120);
        const a = -JELLY_K * (this.shear - rest) - JELLY_C * this.shearV;
        this.shearV += a * h;
        this.shear += this.shearV * h;
        left -= h;
      }
      if (Math.abs(this.shear) > JELLY_MAX) {
        this.shear = Math.sign(this.shear) * JELLY_MAX;
        this.shearV *= 0.5;
      }
    }
    if (i.state === 'dead' || i.state === 'respawn') {
      this.shear = 0;
      this.shearV = 0;
    }

    // blink (only when the drawing has eyes; the caller decides whether to show it)
    if (i.now > this.nextBlink) {
      this.blinkUntil = i.now + RIG.idle.blink_ms;
      const [a, b] = RIG.idle.blink_every_s;
      this.nextBlink = i.now + (a + this.r() * (b - a)) * 1000;
    }
    const blink = i.now < this.blinkUntil;
    let ex = 0;
    let ey = 0;
    if (i.look) {
      const L = Math.hypot(i.look[0], i.look[1]) || 1;
      ex = ((i.look[0] / L) * RIG.idle.pupil_px) * this.shown;
      ey = (i.look[1] / L) * RIG.idle.pupil_px;
    }
    return {
      flip: this.shown, sx, sy, rot, bob, hop,
      shear: this.shear * this.shown + wobbleShear,
      legSwing, legBase, armSwing, armBase,
      eye: [ex, ey], blink,
    };
  }
}

/** The shear (px) at a height above the feet: 0 at the feet, `pose.shear` at the top (yUp = height in px). */
export function shearAt(pose: RigPose, yUpPx: number, heightPx: number): number {
  return pose.shear * clamp(yUpPx / Math.max(1, heightPx), 0, 1.15);
}
