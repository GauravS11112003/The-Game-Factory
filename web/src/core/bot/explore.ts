/**
 * The bot's search over the real Sim (§4.1). Every action is played frame by frame by the same SimCore the
 * engine uses, from a node snapshot, so the bot and the game cannot disagree.
 *
 * Nodes: (surface, column, key/door/enemy state, phase tokens of up to two timed entities within 12 cells).
 * The player always settles (counter-steers to a stop, then centres on the column) before a node is recorded, so
 * every node is a standing state; momentum between actions is not carried (a careful player's route).
 *
 * Actions from a node: walk ±1 column; walk-off drops (air direction held / released); drop-through (Down + Jump,
 * three air directions); wait 6 f (only near timed entities or on platforms); jumps with
 *   start speed {stand, walk, run if runway ≥ 3 cells}, hold {1, 3, 6, 9, 12, 16, 20, 30, 45} f,
 *   direction release {never, apex, apex + 6 f} + air reverse-steer at apex (edges, full mode),
 *   double jump at {8, 14, 20, 26} f when the ability is on,
 * taking off at the node, one / three cells ahead, or at the surface edge (−16, −8, −2 px, +4 px inside coyote).
 * Interior takeoffs are tried only where something (terrain, platform, entity) lies within jump reach.
 * Expansion is best-first toward the goal; fast mode stops at the goal, full mode continues for coverage.
 * The search is bounded by a deterministic simulated-frame budget (no clocks in bot code).
 *
 * Speed without approximation (§4.1 templates): jump variants that differ only in hold / double-jump timing press
 * identical inputs until their J patterns first differ, so they are played as one group (runGroup): one full run,
 * and every other variant resumes from the snapshot taken on its first differing frame. Every outcome is exactly the
 * outcome of playing that variant alone, so no property test against full simulation is needed for correctness.
 *
 * Game rules: actions follow the abilities (run, double jump); a hit is a failed action even when hearts remain
 * (careful routes take no damage); failures are classed soft (a heart absorbs them: spikes, enemies, saws,
 * firebars, blobs, hazard cells) or hard (pits, lava, crushes, crushers, timers) for the hearts-aware model.
 */
import { BOT } from '../params.ts';
import { SimCore } from '../sim/core.ts';
import type { SimState } from '../sim/core.ts';
import { CELL, T_ONEWAY } from '../sim/tiles.ts';
import { IN_D, IN_J, IN_L, IN_R, IN_RUN } from '../sim/types.ts';
import { BODY_H, HALF_W, firebarReach } from '../sim/world.ts';
import type { DPlatform, EntDef } from '../sim/world.ts';
import { deathProbHearts } from '../difficulty/model.ts';
import type { RouteKind } from '../types.gen.ts';

export const GOAL = -1;

export const A_WALK = 0;
export const A_JUMP = 1;
export const A_DROP = 2;
export const A_THRU = 3;
export const A_WAIT = 4;
export const A_FALL = 5; // settle from an airborne spawn

export interface Act {
  t: number; // A_*
  dir: number; // −1 | 0 | 1
  speed: number; // 0 stand, 1 walk, 2 run
  xt: number; // takeoff x (jumps) or walk target x, px
  hold: number; // J frames from the press
  rel: number; // 0 never, 1 apex, 2 apex + 6, 3 reverse at apex
  dj: number; // double-jump press frame after the first press (0: none)
  air: number; // air direction for drops
  pre: number; // frames of waiting before the action
  edge: number; // 1 when xt is an edge takeoff sample
}

export function act(t: number, o: Partial<Act> = {}): Act {
  return { t, dir: 0, speed: 0, xt: 0, hold: 0, rel: 0, dj: 0, air: 0, pre: 0, edge: 0, ...o };
}

export const EV_STOMP = 1;
export const EV_SPRING = 2;
export const EV_KEY = 4;
export const EV_CHECKPOINT = 8;
export const EV_DOOR = 16;
export const EV_BONK = 64;
export const EV_THRU = 128;
export const EV_JUMP = 256;
export const EV_RIDE = 512;
export const EV_DJUMP = 1024;

export interface Outcome {
  res: 'node' | 'goal' | 'death' | 'fail';
  snap: SimState | null;
  frames: number;
  cause: string;
  /** A death a heart could absorb (a hit), see SOFT_CAUSES. */
  soft: boolean;
  ev: number;
  touched: number[];
  cps: number[];
  takeoffV: number; // |vx| px/frame at the press
  takeoffX: number; // px
  takeoffY: number;
  pressF: number; // action frame of the jump press (−1 none)
  leaveF: number; // action frame the player left the ground (−1 none)
  apexY: number; // min feet y while airborne
  landX: number;
  landY: number;
  inputs: number[] | null;
}

export interface BNode {
  i: number;
  key: string;
  snap: SimState;
  x: number; // px feet centre
  y: number;
  surf: string;
  col: number;
  timed: boolean;
  period: number; // frames of the nearest timed entity (0 when untimed)
  tEnt: number; // that entity's def index (−1)
  oneWay: boolean;
  out: number[];
  inc: number[];
  depth: number;
  t: number; // frames from the start along the discovery path
}

export interface BEdge {
  i: number;
  from: number;
  to: number; // node index or GOAL
  kind: RouteKind;
  act: Act;
  frames: number;
  ev: number;
  touched: number[];
  cps: number[];
  tgtSurf: string;
  w: number; // estimated takeoff window (frames)
  h: number; // estimated hold window (frames)
  L: number; // estimated lethal share
  Ls: number; // share of failures ending in a heart-absorbable hit (≤ L)
  d: number; // estimated death probability (casual, with the level's hearts)
  takeoffV: number;
  takeoffX: number;
  takeoffY: number;
  landX: number;
  landY: number;
  apexY: number;
}

export interface DeathRec {
  from: number;
  x: number;
  y: number;
  cause: string;
  soft: boolean;
}

/** Death causes a heart absorbs when hearts > 1 (§5.5); pits, lava, crush, crusher, timer always kill. */
export const SOFT_CAUSES: ReadonlySet<string> = new Set(['spikes', 'enemy', 'saw', 'firebar', 'blob', 'hazard', 'hit']);

/** Per-run loop state (resumable: a prefix-sharing branch copies it at the frame it diverges). */
interface RunSt {
  f: number;
  phase: number; // 0 pre-wait, 1 action, 2 flight, 3 settle
  pressF: number;
  airF: number;
  apexF: number;
  settleStart: number;
  stuck: number;
  lastX: number;
  wasAir: boolean;
  airDir: number;
  centre: number;
  centring: boolean;
}

interface Cap {
  snap: SimState;
  st: RunSt;
  out: Outcome;
}

/** Variants played alongside one base run; caps[k] is the state at variant k's first differing frame. */
interface Branch {
  acts: Act[];
  caps: (Cap | null)[];
}

/** Is Jump held `since` frames after the press for this action (the only hold-dependent input)? */
function jHeld(a: Act, since: number): boolean {
  if (a.t !== A_JUMP) return false;
  if (a.dj > 0) return since < Math.min(a.hold, a.dj - 1) || (since >= a.dj && since < a.dj + 16);
  return since < a.hold;
}

function cloneOutcome(o: Outcome): Outcome {
  return { ...o, touched: o.touched.slice(), cps: o.cps.slice(), inputs: o.inputs ? o.inputs.slice() : null };
}

export interface ExploreOptions {
  mode: 'fast' | 'full';
  legacy: boolean;
  sigma: number;
  budget: number; // simulated frames
  stopAtGoal: boolean;
  /** Local search (localReach): reaching a standing node at or past this x (px, toward `targetDir`) counts as the goal. */
  targetX?: number;
  targetDir?: 1 | -1;
  /** Local search: nodes outside this x range (px) are not expanded. */
  bounds?: [number, number];
}

const MAX_ACT_F = 240;
const SETTLE_MAX_F = 90;
const NEAR_C = 5;
const FAR_C = 13;
const TIMED_RADIUS_PX = 8 * CELL;
const UNB = 999;
/** Wait lengths (frames) at timed nodes: the 6 f step of §4.1 plus longer waits so slow cycles are reachable. */
const WAITS = [BOT.wait_step_f, 3 * BOT.wait_step_f, 8 * BOT.wait_step_f];

function dirBits(d: number): number {
  return d > 0 ? IN_R : d < 0 ? IN_L : 0;
}

/** Heap keyed by priority (min first); deterministic tie-break by insertion order. */
class Heap {
  private a: { p: number; s: number; v: number }[] = [];
  private seq = 0;
  get size(): number {
    return this.a.length;
  }
  push(v: number, p: number): void {
    const a = this.a;
    a.push({ p, s: this.seq++, v });
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (less(a[i], a[j])) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i = j;
      } else break;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as { p: number; s: number; v: number };
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        const t = a[i];
        a[i] = a[m];
        a[m] = t;
        i = m;
      }
    }
    return top.v;
  }
}

function less(x: { p: number; s: number }, y: { p: number; s: number }): boolean {
  return x.p < y.p || (x.p === y.p && x.s < y.s);
}

export class Explorer {
  readonly sim: SimCore;
  readonly opts: ExploreOptions;
  readonly nodes: BNode[] = [];
  readonly edges: BEdge[] = [];
  readonly byKey = new Map<string, number>();
  readonly deaths: DeathRec[] = [];
  readonly touchedAll = new Set<number>();
  readonly surfSeen = new Set<string>();
  frames = 0;
  approx = false;
  goalFound = false;
  startNode = -1;
  startFail: Outcome | null = null;
  /** Local search: the first node found at or past targetX (−1). */
  targetNode = -1;
  /** Inputs from frame 0 to the start node (an airborne spawn falls and settles first), so traces replay from 0. */
  startInputs: number[] = [];
  readonly holds: number[];
  readonly rels: number[];
  /** Hearts from the level rules (1..3): soft failures cost a heart first. */
  readonly hearts: number;
  /** Rows above the feet that can matter for a jump (more with double jump). */
  private readonly reachRows: number;
  private stuff: Uint8Array;
  private stateful: number[] = [];
  private timedDefs: number[] = [];

  constructor(sim: SimCore, opts: ExploreOptions) {
    this.sim = sim;
    this.opts = opts;
    sim.camOff = true;
    this.holds = opts.mode === 'full' ? BOT.hold_frames.slice() : [3, 9, 16, 45];
    this.rels = opts.legacy ? [0] : opts.mode === 'full' ? [0, 1, 2] : [0, 1];
    this.hearts = sim.W.hearts;
    this.reachRows = sim.W.ab.double_jump ? 8 : 6;
    this.stuff = this.buildStuff();
    const W = sim.W;
    for (const i of W.keys) this.stateful.push(i);
    for (const i of W.doors) this.stateful.push(i);
    for (const i of W.enemies) this.stateful.push(i);
    for (let i = 0; i < W.defs.length; i++) if (W.defs[i].k === 'falling_platform') this.stateful.push(i);
    for (let i = 0; i < W.defs.length; i++) {
      const d = W.defs[i];
      if (this.cycleOf(d) > 0 || d.k === 'crumble') this.timedDefs.push(i);
    }
  }

  // ---- geometry helpers -----------------------------------------------------------------------

  /** Cells that hold something a jump could matter for: terrain, platforms, entities. */
  private buildStuff(): Uint8Array {
    const W = this.sim.W;
    const T = this.sim.T;
    const w = T.w;
    const h = T.h;
    const s = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (T.c[i] !== 0) s[i] = 1;
    const mark = (x0: number, y0: number, x1: number, y1: number, v = 1): void => {
      const c0 = Math.max(0, Math.floor(x0 / CELL));
      const c1 = Math.min(w - 1, Math.floor((x1 - 0.01) / CELL));
      const r0 = Math.max(0, Math.floor(y0 / CELL));
      const r1 = Math.min(h - 1, Math.floor((y1 - 0.01) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (s[r * w + c] === 0 || v === 1) s[r * w + c] = v;
    };
    for (const d of W.defs) {
      switch (d.k) {
        case 'moving_platform':
          if (d.path) for (const p of d.path.pts) mark(p[0], p[1], p[0] + d.w, p[1] + d.h);
          mark(d.x, d.y, d.x + d.w, d.y + d.h);
          break;
        case 'crumble': case 'falling_platform':
          mark(d.x, d.y, d.x + d.w, d.y + d.h);
          break;
        case 'door': mark(d.box[0], d.box[1], d.box[2], d.box[3]); break;
        case 'enemy': {
          const r = d.arch === 'flyer' ? Math.max(d.range, d.radius * 2) / 2 : 0;
          const b0 = (d.bounds ? d.bounds[0] : d.x - r) - d.hw;
          const b1 = (d.bounds ? d.bounds[1] : d.x + r) + d.hw;
          mark(b0, d.y - d.h - r, b1, d.y + r);
          break;
        }
        case 'spikes': mark(d.band[0], d.band[1], d.band[2], d.band[3]); break;
        case 'saw': for (const p of d.path.pts) mark(p[0] - d.r, p[1] - d.r, p[0] + d.r, p[1] + d.r); break;
        case 'firebar': {
          const r = firebarReach(d.balls);
          mark(d.x - r, d.y - r, d.x + r, d.y + r);
          break;
        }
        case 'key': mark(d.x - 8, d.y - 8, d.x + 8, d.y + 8); break;
        case 'coin': case 'big_coin': mark(d.x - 8, d.y - 8, d.x + 8, d.y + 8, 2); break;
        case 'spring': case 'goal': case 'checkpoint': mark(d.box[0], d.box[1], d.box[2], d.box[3]); break;
        default: break;
      }
    }
    return s;
  }

  private interesting(x: number, feet: number, dir: number, range: number): boolean {
    const T = this.sim.T;
    const c = Math.floor(x / CELL);
    const rf = Math.floor((feet - 0.5) / CELL) + 1; // floor row
    const c0 = dir > 0 ? c : c - range;
    const c1 = dir < 0 ? c : c + range;
    // pickups (value 2) only make a spot worth jumping from in full exploration
    const pick = this.opts.mode === 'full';
    for (let r = Math.max(0, rf - this.reachRows); r <= rf - 1; r++) {
      for (let cc = Math.max(0, c0); cc <= Math.min(T.w - 1, c1); cc++) {
        const v = this.stuff[r * T.w + cc];
        if (v === 1 || (v === 2 && pick)) return true;
      }
    }
    return false;
  }

  /** Nominal takeoff speed (px/frame) of a start-speed class under the level's profile and abilities. */
  nominalSpeed(speed: number): number {
    const p = this.sim.W.prof;
    const run = speed === 2 && this.sim.W.ab.run && p.run_max !== null ? p.run_max : p.walk_max;
    return (speed === 0 ? 0 : run) / 60 || 0.5;
  }

  cycleOf(d: EntDef): number {
    switch (d.k) {
      case 'moving_platform': return d.path ? d.path.cycle : 0;
      case 'saw': return d.path.cycle;
      case 'firebar': return d.cycle;
      case 'enemy': return d.arch === 'static' ? 0 : d.cycle;
      default: return 0;
    }
  }

  /** Surface id and column of a standing state. */
  surfOf(S: SimState): { surf: string; col: number; oneWay: boolean } {
    const P = S.p;
    const W = this.sim.W;
    if (P.gnd === 2 && P.gref >= 0) {
      const d = W.defs[P.gref];
      const e = S.e[P.gref];
      const x0 = d.k === 'door' ? d.box[0] : d.k === 'enemy' ? e.x - d.hw : e.x;
      const one = d.k === 'moving_platform' || d.k === 'crumble' || d.k === 'falling_platform' ? (d as DPlatform).oneWay : false;
      return { surf: 'K' + P.gref, col: Math.floor((P.x - x0) / CELL), oneWay: one };
    }
    const T = this.sim.T;
    let piece = T.pieceAt(P.x, P.y);
    if (!piece) piece = T.pieceAt(P.x - HALF_W + 0.5, P.y) ?? T.pieceAt(P.x + HALF_W - 0.5, P.y);
    if (!piece) return { surf: 'A', col: Math.floor(P.x / CELL), oneWay: false };
    return { surf: 'S' + piece.comp, col: Math.floor(P.x / CELL), oneWay: piece.code === T_ONEWAY };
  }

  private stateString(S: SimState): string {
    let s = '';
    for (const i of this.stateful) {
      const e = S.e[i];
      const d = this.sim.W.defs[i];
      if (d.k === 'falling_platform') s += e.s === 0 ? 'i' : 'x';
      else s += e.on ? '1' : '0';
    }
    return s;
  }

  /**
   * Phase token of the nearest timed entity within 8 cells ('' when the spot is time-invariant). Clock-driven
   * entities (moving platforms, saws, firebars, flyers) use 24 buckets of their cycle; simulated enemies use a
   * coarse state (walkers / chasers: 3-cell position bucket + direction; hoppers / shooters: 6 timer buckets;
   * crushers and crumbles: their state), which bounds the time-expanded graph.
   */
  private phaseOf(S: SimState): { key: string; period: number; ent: number } {
    const W = this.sim.W;
    const P = S.p;
    let best = -1;
    let bd = Infinity;
    for (const i of this.timedDefs) {
      const d = W.defs[i];
      const e = S.e[i];
      if (d.k === 'enemy' && e.on === 0) continue;
      if (d.k === 'crumble' && e.s === 0) continue;
      let ex = e.x;
      let reach = 0;
      if (d.k === 'moving_platform') {
        ex = e.x + d.w / 2;
        reach = d.path ? d.path.len / 2 + d.w / 2 : d.w / 2;
      } else if (d.k === 'saw') reach = d.path.len / 2 + d.r;
      else if (d.k === 'firebar') {
        ex = d.x;
        reach = firebarReach(d.balls);
      } else if (d.k === 'enemy' && d.bounds) {
        ex = (d.bounds[0] + d.bounds[1]) / 2;
        reach = (d.bounds[1] - d.bounds[0]) / 2 + d.hw;
      } else if (d.k === 'enemy' && d.arch === 'flyer') reach = Math.max(d.range / 2, d.radius * 2);
      const eff = Math.max(0, Math.abs(ex - P.x) - reach);
      if (eff > TIMED_RADIUS_PX) continue;
      if (eff < bd) {
        bd = eff;
        best = i;
      }
    }
    if (best < 0) return { key: '', period: 0, ent: -1 };
    const d = W.defs[best];
    const e = S.e[best];
    const cyc = this.cycleOf(d);
    let key: string;
    if (d.k === 'enemy' && (d.arch === 'walker' || d.arch === 'chaser')) key = `${best}@${Math.floor(e.x / (3 * CELL))},${e.d}${d.arch === 'chaser' ? ',' + e.s : ''}`;
    else if (d.k === 'enemy' && (d.arch === 'hopper' || d.arch === 'shooter')) key = `${best}@${e.s},${Math.floor((e.t * 6) / Math.max(1, cyc))}`;
    else if (d.k === 'enemy' && d.arch === 'crusher') key = `${best}@${e.s}`;
    else if (d.k === 'crumble') key = `${best}@${e.s},${Math.floor(e.t / 15)}`;
    else if (cyc > 0) {
      const u = S.ent - Math.floor(S.ent / cyc) * cyc;
      key = `${best}@${Math.floor((u * BOT.phase_samples) / cyc)}`;
    } else key = `${best}`;
    return { key, period: cyc > 0 ? cyc : 60, ent: best };
  }

  nodeKeyOf(S: SimState): { key: string; surf: string; col: number; oneWay: boolean; period: number; ent: number; phase: string } {
    const sf = this.surfOf(S);
    const ph = this.phaseOf(S);
    return { key: `${sf.surf}:${sf.col}|${this.stateString(S)}|${ph.key}`, surf: sf.surf, col: sf.col, oneWay: sf.oneWay, period: ph.period, ent: ph.ent, phase: ph.key };
  }

  // ---- running one action -------------------------------------------------------------------

  /** Column centre to settle on (a supported column on the same surface), or the current x. */
  private centreTarget(): number {
    const sim = this.sim;
    const P = sim.S.p;
    if (P.gnd === 2 && P.gref >= 0) {
      const d = sim.W.defs[P.gref];
      const e = sim.S.e[P.gref];
      if (d.k !== 'moving_platform' && d.k !== 'crumble' && d.k !== 'falling_platform') return P.x;
      const ncol = Math.max(1, Math.round(d.w / CELL));
      const cw = d.w / ncol;
      const c = Math.max(0, Math.min(ncol - 1, Math.floor((P.x - e.x) / cw)));
      return e.x + (c + 0.5) * cw;
    }
    const base = Math.floor(P.x / CELL) * CELL + CELL / 2;
    const ok = (x: number): boolean => sim.supportY(x, P.y - 9, P.y + 9, P.y - 9) < Infinity && this.bodyFreeAt(x, P.y);
    if (ok(base)) return base;
    const alt = P.x < base ? base - CELL : base + CELL;
    if (ok(alt)) return alt;
    return P.x;
  }

  private bodyFreeAt(x: number, feet: number): boolean {
    const T = this.sim.T;
    const c0 = Math.floor((x - HALF_W) / CELL);
    const c1 = Math.floor((x + HALF_W - 1e-6) / CELL);
    const r0 = Math.floor((feet - BODY_H) / CELL);
    const r1 = Math.floor((feet - 1) / CELL);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (T.blocksSide(c, r)) return false;
    return true;
  }

  /**
   * Plays one action from `start`. `record` keeps the per-frame inputs; `track` is called after every frame.
   * The result is a settled standing state, the goal, a death, or a failure (stuck / timeout). A hit is a failure
   * too (a careful route never takes damage, even with hearts to spare); `soft` marks failures a heart could absorb.
   */
  run(start: SimState, a: Act, record = false, track?: (sim: SimCore, f: number) => void, maxF = MAX_ACT_F, br: Branch | null = null): Outcome {
    const sim = this.sim;
    sim.load(start);
    const out: Outcome = {
      res: 'fail', snap: null, frames: 0, cause: '', soft: false, ev: 0, touched: [], cps: [], takeoffV: 0, takeoffX: 0, takeoffY: 0,
      pressF: -1, leaveF: -1, apexY: Infinity, landX: 0, landY: 0, inputs: record && !br ? [] : null,
    };
    const st: RunSt = {
      f: 0, phase: a.t === A_FALL ? 2 : 0, pressF: -1, airF: -1, apexF: -1, settleStart: -1, stuck: 0,
      // x before the previous tick: "stuck" means the last tick did not move the player
      lastX: sim.S.p.x, wasAir: sim.S.p.gnd === 0, airDir: a.t === A_JUMP ? a.dir : a.air, centre: NaN, centring: false,
    };
    return this.loop(st, out, a, br ? undefined : track, maxF + a.pre, br);
  }

  /**
   * Plays jump variants that differ only in their J pattern (hold / double-jump timing) with prefix sharing: the
   * variants press the same inputs until their J patterns first differ, so one run is played and every other variant
   * resumes from a snapshot taken at its first differing frame. Exact: each outcome equals run(start, act).
   */
  runGroup(start: SimState, acts: Act[], maxF = MAX_ACT_F): Outcome[] {
    if (acts.length === 1) return [this.run(start, acts[0], false, undefined, maxF)];
    let bi = 0;
    for (let k = 1; k < acts.length; k++) if (acts[k].hold > acts[bi].hold) bi = k;
    const br: Branch = { acts, caps: acts.map(() => null) };
    const base = this.run(start, acts[bi], false, undefined, maxF, br);
    const res: Outcome[] = new Array(acts.length);
    res[bi] = base;
    for (let k = 0; k < acts.length; k++) {
      if (k === bi) continue;
      const c = br.caps[k];
      if (!c) {
        // never diverged: the same inputs to the end, so the same outcome
        res[k] = cloneOutcome(base);
        continue;
      }
      this.sim.load(c.snap);
      res[k] = this.loop({ ...c.st }, cloneOutcome(c.out), acts[k], undefined, maxF + acts[k].pre, null);
    }
    return res;
  }

  private loop(st: RunSt, out: Outcome, a: Act, track: ((sim: SimCore, f: number) => void) | undefined, limit: number, br: Branch | null): Outcome {
    const sim = this.sim;
    const prof = sim.W.prof;
    const stopDist = (vx: number): number => (prof.instant_ground ? 0 : (vx * vx) / (2 * Math.max(1, prof.friction)));
    for (; st.f < limit; st.f++) {
      const f = st.f;
      const P = sim.S.p;
      // prefix sharing: capture the state for every variant whose J input first differs on this frame
      if (br && st.phase === 2 && st.pressF >= 0) {
        const since = f - st.pressF;
        const mine = jHeld(a, since);
        for (let k = 0; k < br.acts.length; k++) {
          if (br.caps[k] === null && jHeld(br.acts[k], since) !== mine) br.caps[k] = { snap: sim.snap(), st: { ...st }, out: cloneOutcome(out) };
        }
      }
      let input = 0;
      if (st.phase === 0) {
        if (f >= a.pre) st.phase = 1;
      }
      if (st.phase === 1) {
        switch (a.t) {
          case A_WAIT:
            if (f - a.pre >= (a.hold > 0 ? a.hold : BOT.wait_step_f)) st.phase = 3;
            break;
          case A_WALK: {
            input = dirBits(a.dir) | (a.speed === 2 && this.sim.W.ab.run ? IN_RUN : 0);
            if (P.gnd === 0) {
              st.phase = 2;
              st.airDir = a.dir;
              st.airF = f;
            } else {
              if (a.dir * (P.x - a.xt) >= -(stopDist(P.vx) + 0.5)) {
                input = 0;
                st.phase = 3;
              } else if (Math.abs(P.x - st.lastX) < 0.01 && f - a.pre > 2) {
                if (++st.stuck > 8) return this.finish(out, 'fail', f);
              } else st.stuck = 0;
            }
            break;
          }
          case A_DROP:
            input = dirBits(a.dir);
            if (P.gnd === 0) {
              st.phase = 2;
              st.airF = f;
              st.airDir = a.air;
            }
            break;
          case A_THRU:
            input = IN_D | IN_J | dirBits(a.air);
            st.pressF = f;
            out.pressF = f;
            st.phase = 2;
            st.airDir = a.air;
            break;
          case A_JUMP: {
            if (a.speed === 0) {
              input = IN_J | dirBits(a.dir);
              st.pressF = f;
              out.pressF = f;
              st.phase = 2;
            } else {
              input = dirBits(a.dir) | (a.speed === 2 ? IN_RUN : 0);
              if (a.dir * (P.x - a.xt) >= 0) {
                input |= IN_J;
                st.pressF = f;
                out.pressF = f;
                st.phase = 2;
                out.takeoffV = Math.abs(P.vx) / 60;
                out.takeoffX = P.x;
                out.takeoffY = P.y;
              } else if (P.gnd === 0) {
                if (st.airF < 0) st.airF = f;
                if (f - st.airF > prof.coyote_f) return this.finish(out, 'fail', f);
              }
              if (Math.abs(P.x - st.lastX) < 0.01 && P.gnd > 0) {
                if (++st.stuck > 8) return this.finish(out, 'fail', f);
              } else st.stuck = 0;
            }
            break;
          }
          default:
            break;
        }
        if (st.phase === 2 && st.pressF === f && a.t === A_JUMP && a.speed === 0) {
          out.takeoffV = 0;
          out.takeoffX = P.x;
          out.takeoffY = P.y;
        }
      } else if (st.phase === 2) {
        // flight
        const since = st.pressF >= 0 ? f - st.pressF : 0;
        const J = jHeld(a, since);
        let d = st.airDir;
        if (a.t === A_JUMP && st.apexF >= 0) {
          if (a.rel === 1) d = 0;
          else if (a.rel === 2 && f - st.apexF >= BOT.release_after_apex_f) d = 0;
          else if (a.rel === 3) d = -a.dir;
        }
        input = dirBits(d) | (J ? IN_J : 0) | (a.t === A_JUMP && a.speed === 2 ? IN_RUN : 0);
        if (a.t === A_THRU && since < 2) input |= IN_D;
      } else if (st.phase === 3) {
        // settle: counter-steer to a stop, then walk to the column centre and stop there
        if (st.settleStart < 0) st.settleStart = f;
        if (P.gnd === 0) {
          st.phase = 2;
          st.airDir = 0;
          st.centring = false;
          if (st.airF < 0) st.airF = f;
        } else {
          if (!st.centring) {
            if (Math.abs(P.vx) > 40 && !prof.instant_ground) input = dirBits(P.vx > 0 ? -1 : 1);
            else if (P.vx !== 0) input = 0;
            else {
              st.centre = this.centreTarget();
              if (Math.abs(st.centre - P.x) > 1.5) st.centring = true;
              else return this.finishNode(out, f);
            }
          }
          if (st.centring) {
            const dx = st.centre - P.x;
            if (Math.abs(dx) > stopDist(P.vx) + 1.5 && dx * P.vx >= 0) input = dirBits(dx);
            else if (P.vx !== 0) input = 0;
            else return this.finishNode(out, f);
          }
          if (f - st.settleStart >= SETTLE_MAX_F) return this.finishNode(out, f);
        }
      }
      if (out.inputs) out.inputs.push(input);
      const xPre = sim.S.p.x;
      sim.tick(input);
      this.frames++;
      // events
      for (const ev of sim.ev) {
        switch (ev.type) {
          case 'hit':
          case 'death':
            out.cause = ev.cause ?? (ev.type === 'hit' ? 'hit' : '');
            out.soft = ev.type === 'hit' || SOFT_CAUSES.has(out.cause);
            out.landX = sim.S.p.x;
            out.landY = sim.S.p.y;
            if (track) track(sim, f);
            return this.finish(out, 'death', f + 1);
          case 'win':
            out.landX = sim.S.p.x;
            out.landY = sim.S.p.y;
            if (track) track(sim, f);
            return this.finish(out, 'goal', f + 1);
          case 'stomp': out.ev |= EV_STOMP; break;
          case 'spring': out.ev |= EV_SPRING; break;
          case 'key': out.ev |= EV_KEY; break;
          case 'door_open': out.ev |= EV_DOOR; break;
          case 'bonk': out.ev |= EV_BONK; break;
          case 'drop_through': out.ev |= EV_THRU; break;
          case 'jump': out.ev |= EV_JUMP; break;
          case 'double_jump': out.ev |= EV_DJUMP; break;
          case 'checkpoint': out.ev |= EV_CHECKPOINT; break;
          case 'lose':
            out.cause = 'timer';
            out.soft = false;
            return this.finish(out, 'death', f + 1);
          default: break;
        }
      }
      for (const t of sim.touched) {
        out.touched.push(t);
        if (sim.W.defs[t].k === 'checkpoint') out.cps.push(t);
      }
      const P2 = sim.S.p;
      if (P2.gnd === 0) {
        if (!st.wasAir && out.leaveF < 0) out.leaveF = f;
        if (P2.y < out.apexY) out.apexY = P2.y;
        if (st.pressF >= 0 && st.apexF < 0 && P2.vy >= 0 && f > st.pressF) st.apexF = f;
        if (st.airF < 0) st.airF = f;
      }
      if (st.phase === 2 && P2.gnd > 0 && (f > st.pressF || st.pressF < 0) && P2.mode === 0) {
        st.phase = 3;
        out.landX = P2.x;
        out.landY = P2.y;
      }
      if (st.phase === 1 && a.t === A_WAIT && P2.gnd === 2) out.ev |= EV_RIDE;
      st.wasAir = P2.gnd === 0;
      st.lastX = xPre;
      if (track) track(sim, f);
    }
    if (sim.S.p.gnd > 0 && st.phase === 3) return this.finishNode(out, limit);
    return this.finish(out, 'fail', limit);
  }

  private finish(out: Outcome, res: Outcome['res'], frames: number): Outcome {
    out.res = res;
    out.frames = frames;
    if (res === 'goal') out.snap = this.sim.snap();
    return out;
  }

  private finishNode(out: Outcome, frames: number): Outcome {
    out.res = 'node';
    out.frames = frames;
    out.snap = this.sim.snap();
    if (!out.landX) {
      out.landX = this.sim.S.p.x;
      out.landY = this.sim.S.p.y;
    }
    return out;
  }

  // ---- graph ------------------------------------------------------------------------------

  addNode(S: SimState, depth: number, t: number): number {
    const k = this.nodeKeyOf(S);
    const have = this.byKey.get(k.key);
    if (have !== undefined) return have;
    const n: BNode = {
      i: this.nodes.length, key: k.key, snap: S, x: S.p.x, y: S.p.y, surf: k.surf, col: k.col, timed: k.phase !== '',
      period: k.period, tEnt: k.ent, oneWay: k.oneWay, out: [], inc: [], depth, t,
    };
    this.nodes.push(n);
    this.byKey.set(k.key, n.i);
    this.surfSeen.add(k.surf);
    return n.i;
  }

  /** Initial settle: from the spawn, fall until standing. */
  start(): number {
    const sim = this.sim;
    const S0 = sim.snap();
    if (S0.p.gnd > 0) {
      this.startNode = this.addNode(S0, 0, 0);
      return this.startNode;
    }
    const o = this.run(S0, act(A_FALL), true);
    if (o.res !== 'node' || !o.snap) {
      this.startFail = o;
      return -1;
    }
    this.startInputs = o.inputs ?? [];
    this.startNode = this.addNode(o.snap, 0, o.frames);
    return this.startNode;
  }

  private surfaceEnds(n: BNode): { l: number; r: number; lWall: boolean; rWall: boolean } {
    const W = this.sim.W;
    const T = this.sim.T;
    if (n.surf[0] === 'K') {
      const i = Number(n.surf.slice(1));
      const d = W.defs[i];
      const e = n.snap.e[i];
      let x0 = e.x;
      let x1 = e.x;
      if (d.k === 'moving_platform' || d.k === 'crumble' || d.k === 'falling_platform') x1 = e.x + d.w;
      else if (d.k === 'door') {
        x0 = d.box[0];
        x1 = d.box[2];
      } else if (d.k === 'enemy') {
        x0 = e.x - d.hw;
        x1 = e.x + d.hw;
      }
      return { l: x0 - HALF_W + 0.5, r: x1 + HALF_W - 0.5, lWall: false, rWall: false };
    }
    if (n.surf[0] !== 'S') return { l: n.x, r: n.x, lWall: false, rWall: false };
    const comp = T.comps[Number(n.surf.slice(1))];
    const rowAbove = (cx: number): number => {
      for (const p of T.pieces[cx] ?? []) if (p.comp === comp.id) return Math.floor((Math.min(p.yl, p.yr) - 1) / CELL);
      return Math.floor((n.y - 1) / CELL);
    };
    const lWall = T.blocksSide(comp.c0 - 1, rowAbove(comp.c0));
    const rWall = T.blocksSide(comp.c1 + 1, rowAbove(comp.c1));
    return {
      l: lWall ? comp.c0 * CELL + HALF_W + 0.01 : comp.c0 * CELL - HALF_W + 0.5,
      r: rWall ? (comp.c1 + 1) * CELL - HALF_W - 0.01 : (comp.c1 + 1) * CELL + HALF_W - 0.5,
      lWall, rWall,
    };
  }

  /** The action set from a standing node (see the file header). */
  actionsFor(n: BNode): Act[] {
    const W = this.sim.W;
    const out: Act[] = [];
    const x0 = n.x;
    const feet = n.y;
    const ends = this.surfaceEnds(n);
    const full = this.opts.mode === 'full';
    // timed nodes multiply by their phases: in fast mode they get a reduced jump set
    const holds = n.timed && !full ? [9, 45] : this.holds;
    const rels = n.timed && !full ? [0] : this.rels;
    const legacy = this.opts.legacy;
    for (const dir of [-1, 1]) {
      const xt = n.surf[0] === 'K' ? x0 + dir * CELL : Math.floor(x0 / CELL) * CELL + CELL / 2 + dir * CELL;
      const end = dir > 0 ? ends.r : ends.l;
      const wall = dir > 0 ? ends.rWall : ends.lWall;
      const inside = dir * (end - xt) >= -0.5;
      if (inside) out.push(act(A_WALK, { dir, xt }));
      else if (!wall) {
        out.push(act(A_DROP, { dir, air: dir }));
        out.push(act(A_DROP, { dir, air: 0 }));
      }
    }
    if (n.timed || n.surf[0] === 'K') for (const w of WAITS) out.push(act(A_WAIT, { hold: w }));
    if (n.oneWay) for (const air of [-1, 0, 1]) out.push(act(A_THRU, { air }));
    // jumps
    const jumps = (dir: number, speed: number, xt: number, edge: number, rs: number[], hs: number[]): void => {
      // a moving takeoff must lie ahead of the node (otherwise it is just a standing jump again)
      if (speed > 0 && dir * (xt - x0) < 2) return;
      for (const hold of hs) {
        if (dir === 0) {
          out.push(act(A_JUMP, { dir, speed, xt, hold, edge }));
          continue;
        }
        for (const rel of rs) {
          if (rel > 0 && hold <= 3) continue;
          out.push(act(A_JUMP, { dir, speed, xt, hold, rel, edge }));
        }
      }
      if (W.ab.double_jump && dir !== 0 && !legacy) {
        for (const dj of BOT.double_jump_frames) for (const hold of [16, 45]) out.push(act(A_JUMP, { dir, speed, xt, hold, dj, edge }));
      }
    };
    if (this.interesting(x0, feet, 0, 2)) jumps(0, 0, x0, 0, [0], holds);
    for (const dir of [-1, 1]) {
      const end = dir > 0 ? ends.r : ends.l;
      const wall = dir > 0 ? ends.rWall : ends.lWall;
      const dist = dir * (end - x0);
      const edgeRels = full && !legacy ? [...rels, 3] : rels;
      const nearInt = this.interesting(x0, feet, dir, NEAR_C);
      // standing jumps
      if (nearInt || dist <= 2.5 * CELL) jumps(dir, 0, x0, 0, rels, holds);
      // walking jumps: one cell ahead, or at the edge
      if (dist > CELL + 0.5 && nearInt) jumps(dir, 1, x0 + dir * CELL, 0, legacy ? [0] : [0, 1], holds);
      if (dist > 4 && dist <= 2.5 * CELL) {
        for (const xt of this.edgePts(end, dir, wall)) jumps(dir, 1, xt, 1, edgeRels, holds);
      }
      // running jumps (runway ≥ 3 cells; a shorter surface runs from its far end)
      if (W.ab.run) {
        if (dist > 3 * CELL + 0.5 && this.interesting(x0 + dir * 3 * CELL, feet, dir, FAR_C)) jumps(dir, 2, x0 + dir * 3 * CELL, 0, legacy ? [0] : [0, 1], holds);
        const farEnd = dir > 0 ? ends.l : ends.r;
        const isFar = Math.abs(x0 - farEnd) < CELL;
        if ((dist > 2.5 * CELL && dist <= 4 * CELL) || (isFar && dist > 4 && dist <= 2.5 * CELL)) {
          for (const xt of this.edgePts(end, dir, wall)) jumps(dir, 2, xt, 1, edgeRels, holds);
        }
      }
    }
    return out;
  }

  private edgePts(end: number, dir: number, wall: boolean): number[] {
    if (wall) return [end - dir * 2, end - dir * 10, end - dir * 24];
    const pts = [end - dir * 16, end - dir * 8, end - dir * 2];
    if (!this.opts.legacy) pts.push(end + dir * 4);
    return pts;
  }

  /** Expands one node: runs every action, adds target nodes, keeps the best edge per target with estimates. */
  expand(ni: number): number[] {
    const n = this.nodes[ni];
    const acts = this.actionsFor(n);
    const res: { a: Act; o: Outcome; tgt: number; surf: string }[] = [];
    const added: number[] = [];
    // jump variants that differ only in their J pattern share their prefix (runGroup)
    const outs: (Outcome | null)[] = new Array(acts.length).fill(null);
    const keys: (string | null)[] = acts.map((a) => (a.t === A_JUMP ? `${a.dir}|${a.speed}|${a.xt}|${a.rel}|${a.pre}` : null));
    const groups = new Map<string, number[]>();
    keys.forEach((k, i) => {
      if (k === null) return;
      const g = groups.get(k);
      if (g) g.push(i);
      else groups.set(k, [i]);
    });
    for (let ai = 0; ai < acts.length; ai++) {
      const a = acts[ai];
      if (outs[ai] === null) {
        if (this.frames > this.opts.budget) {
          this.approx = true;
          break;
        }
        const k = keys[ai];
        const g = k !== null ? (groups.get(k) as number[]).filter((j) => outs[j] === null) : [ai];
        if (g.length > 1) {
          const rs = this.runGroup(n.snap, g.map((j) => acts[j]));
          g.forEach((j, q) => (outs[j] = rs[q]));
        } else outs[ai] = this.run(n.snap, a);
      }
      const o = outs[ai] as Outcome;
      for (const t of o.touched) this.touchedAll.add(t);
      if (o.res === 'death') {
        if (this.deaths.length < 4000) this.deaths.push({ from: ni, x: o.landX, y: o.landY, cause: o.cause, soft: o.soft });
        res.push({ a, o, tgt: -2, surf: '' });
        continue;
      }
      if (o.res === 'goal') {
        res.push({ a, o, tgt: GOAL, surf: 'GOAL' });
        continue;
      }
      if (o.res !== 'node' || !o.snap) {
        res.push({ a, o, tgt: -3, surf: '' });
        continue;
      }
      const before = this.nodes.length;
      const tgt = this.addNode(o.snap, n.depth + 1, n.t + o.frames);
      if (this.nodes.length > before) added.push(tgt);
      res.push({ a, o, tgt, surf: this.nodes[tgt].surf });
    }
    // estimates and best edge per target
    const best = new Map<number, BEdge>();
    for (const r of res) {
      if (r.tgt === -2 || r.tgt === -3) continue;
      if (r.tgt === ni) continue;
      const e = this.makeEdge(ni, r, res);
      const prev = best.get(r.tgt);
      if (!prev || e.d < prev.d - 1e-9 || (Math.abs(e.d - prev.d) <= 1e-9 && e.frames < prev.frames)) best.set(r.tgt, e);
    }
    const tgts = [...best.keys()].sort((a, b) => a - b);
    for (const t of tgts) {
      const e = best.get(t) as BEdge;
      e.i = this.edges.length;
      this.edges.push(e);
      n.out.push(e.i);
      if (t >= 0) this.nodes[t].inc.push(e.i);
      else this.goalFound = true;
    }
    return added;
  }

  private kindOf(a: Act, o: Outcome): RouteKind {
    if (o.ev & EV_STOMP) return 'stomp';
    if (o.ev & EV_SPRING) return 'spring';
    switch (a.t) {
      case A_WALK: return 'walk';
      case A_DROP: return 'drop';
      case A_THRU: return 'dropthrough';
      case A_WAIT: return o.ev & EV_RIDE ? 'ride' : 'wait';
      case A_FALL: return 'drop';
      default: return a.speed === 2 ? 'runjump' : 'jump';
    }
  }

  private makeEdge(ni: number, r: { a: Act; o: Outcome; tgt: number; surf: string }, all: { a: Act; o: Outcome; tgt: number; surf: string }[]): BEdge {
    const a = r.a;
    const o = r.o;
    let w = UNB;
    let h = UNB;
    let L = 0;
    let Ls = 0;
    if (a.t === A_JUMP) {
      // hold window from the hold grid at the same takeoff
      const same = all.filter((x) => x.a.t === A_JUMP && x.a.dir === a.dir && x.a.speed === a.speed && x.a.rel === a.rel && x.a.dj === a.dj && x.a.xt === a.xt);
      const hs = same.map((x) => ({ h: x.a.hold, ok: x.surf === r.surf })).sort((p, q) => p.h - q.h);
      const k = hs.findIndex((x) => x.h === a.hold);
      if (k >= 0) {
        let lo = k;
        let hi = k;
        while (lo > 0 && hs[lo - 1].ok) lo--;
        while (hi + 1 < hs.length && hs[hi + 1].ok) hi++;
        const loEdge = lo > 0 ? (hs[lo - 1].h + hs[lo].h) / 2 : 0;
        const hiEdge = hi + 1 < hs.length ? (hs[hi].h + hs[hi + 1].h) / 2 : UNB;
        h = hiEdge >= UNB ? UNB : hiEdge - loEdge;
      }
      // takeoff window from the edge samples
      if (a.edge && a.speed > 0) {
        const grp = all.filter((x) => x.a.t === A_JUMP && x.a.edge && x.a.dir === a.dir && x.a.speed === a.speed && x.a.rel === a.rel && x.a.dj === a.dj);
        const xs = [...new Set(grp.map((x) => x.a.xt))].sort((p, q) => (p - q) * a.dir);
        const okX = new Set(grp.filter((x) => x.surf === r.surf).map((x) => x.a.xt));
        const k2 = xs.indexOf(a.xt);
        if (k2 >= 0) {
          let lo = k2;
          let hi = k2;
          while (lo > 0 && okX.has(xs[lo - 1])) lo--;
          while (hi + 1 < xs.length && okX.has(xs[hi + 1])) hi++;
          const span = Math.abs(xs[hi] - xs[lo]) + 4;
          const v = Math.max(0.5, o.takeoffV || this.nominalSpeed(a.speed));
          w = lo === 0 && hi === xs.length - 1 ? UNB : span / v;
        }
      }
      // lethal share of the failing variants from this node, same start speed and direction
      const fam = all.filter((x) => x.a.t === A_JUMP && x.a.dir === a.dir && x.a.speed === a.speed);
      let fails = 0;
      let dead = 0;
      let soft = 0;
      for (const x of fam) {
        if (x.surf === r.surf) continue;
        fails++;
        if (x.tgt === -2) {
          dead++;
          if (x.o.soft) soft++;
        }
      }
      L = fails > 0 ? dead / fails : 0;
      Ls = fails > 0 ? soft / fails : 0;
    }
    const d = deathProbHearts({ w, h, phi: null, L, Ls }, this.opts.sigma, this.hearts);
    return {
      i: -1, from: ni, to: r.tgt, kind: this.kindOf(a, o), act: a, frames: o.frames, ev: o.ev, touched: o.touched, cps: o.cps,
      tgtSurf: r.surf, w, h, L, Ls, d, takeoffV: o.takeoffV, takeoffX: o.takeoffX || this.nodes[ni].x, takeoffY: o.takeoffY || this.nodes[ni].y,
      landX: o.landX, landY: o.landY, apexY: o.apexY,
    };
  }

  /** Explores from the start: BFS (full) or best-first toward the goal (fast). */
  explore(): void {
    const s = this.start();
    if (s < 0) return;
    const W = this.sim.W;
    const tx = this.opts.targetX;
    const tdir = this.opts.targetDir ?? 1;
    const goalX = tx !== undefined ? tx : W.goals.length ? (W.defs[W.goals[0]] as { box: number[] }).box[0] : W.wPx;
    const runV = (W.prof.run_max ?? W.prof.walk_max) / 60;
    const bounds = this.opts.bounds;
    const passed = (j: number): boolean => tx !== undefined && tdir * (this.nodes[j].x - tx) >= 0;
    if (passed(s)) {
      this.targetNode = s;
      this.goalFound = true;
      return;
    }
    const heap = new Heap();
    // goal-directed in both modes (so a capped budget still finds the route first); full mode keeps expanding
    // every remaining node afterwards for coverage (softlocks, dead ends, unreachable drawings, risk slots)
    const prio = (i: number): number => {
      const n = this.nodes[i];
      return n.t + (4 * Math.abs(goalX - n.x)) / runV;
    };
    heap.push(s, prio(s));
    const done = new Uint8Array(1 << 20);
    while (heap.size) {
      if (this.frames > this.opts.budget) {
        this.approx = true;
        break;
      }
      if (this.opts.stopAtGoal && this.goalFound) break;
      const i = heap.pop();
      if (i < done.length && done[i]) continue;
      if (i < done.length) done[i] = 1;
      if (this.nodes.length > 60000) {
        this.approx = true;
        break;
      }
      if (bounds && (this.nodes[i].x < bounds[0] || this.nodes[i].x > bounds[1])) continue;
      const added = this.expand(i);
      for (const j of added) {
        if (this.targetNode < 0 && passed(j)) {
          this.targetNode = j;
          this.goalFound = true;
        }
        heap.push(j, prio(j));
      }
    }
  }
}

