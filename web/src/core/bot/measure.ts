/**
 * Engine-exact windows for one required route action (§4.4), by re-running the action in the Sim:
 *
 * - w (takeoff window): takeoff x is swept in 2 px steps on both sides of the route takeoff (every grid hold tried
 *   where the route hold fails) until 3 consecutive failures; both ends are refined by bisection to 0.25 px and
 *   the width converted to frames at the takeoff speed. A standing takeoff has no timing window (∞).
 * - h (hold window): from the best takeoff (the window centre), every hold 1..45 f; the consecutive working run
 *   that contains the route hold. A run reaching 45 f is unbounded.
 * - φ (phase window) for nodes near timed entities: the action after waiting k·P/24 frames, k = 0..23; the
 *   working run around the route's own phase, refined to 1 frame by bisection. All 24 working → ∞.
 * - L (lethal share): of every failing sample above, the fraction that ended in death; Ls the fraction that ended
 *   in a death a heart could absorb (a hit: spikes, enemy, saw, firebar, blob, hazard).
 *
 * "Success" = the goal, or landing on a surface whose cost-to-goal is no worse than the route target's surface.
 *
 * Work sharing (exact): the 45-hold sweep and the hold fallbacks are played as prefix-sharing groups
 * (Explorer.runGroup); phase samples share one idle prefix (the node advanced k frames with no input, cached per
 * sample), then play the action from there.
 *
 * Fast mode (quick): φ from 8 phase samples; for a moving takeoff in the middle of a surface (no edge samples in
 * the search) a short takeoff sweep (±4..32 px, the route hold then 16 / 45 f) so C does not read low.
 */
import { BOT } from '../params.ts';
import { UNBOUNDED_F } from '../difficulty/model.ts';
import type { SimState } from '../sim/core.ts';
import { A_JUMP, GOAL, SOFT_CAUSES } from './explore.ts';
import type { Act, BEdge, BNode, Explorer, Outcome } from './explore.ts';

export interface StepWindows {
  w: number;
  h: number;
  phi: number | null;
  L: number;
  /** Share of failing samples that ended in a heart-absorbable hit (≤ L). */
  Ls: number;
  v: number; // takeoff speed px/frame
  measured: boolean;
}

/** A node advanced k idle frames: the state, or how the wait ended. */
type Waited = { s: SimState } | { end: 'goal' } | { end: 'death'; soft: boolean };

const QUICK_OFFSETS = [4, 8, 12, 16, 24, 32];

export class Measurer {
  private readonly ex: Explorer;
  private readonly surfCost: Map<string, number>;
  private readonly budget: number;
  private readonly legacy: boolean;
  private fails = 0;
  private dead = 0;
  private soft = 0;
  private waitNode = -1;
  private waits = new Map<number, Waited>();

  constructor(ex: Explorer, surfCost: Map<string, number>, budget: number, legacy: boolean) {
    this.ex = ex;
    this.surfCost = surfCost;
    this.budget = budget;
    this.legacy = legacy;
  }

  surfKeyOf(S: SimState): string {
    const k = this.ex.nodeKeyOf(S);
    const parts = k.key.split('|');
    return `${k.surf}|${parts[1] ?? ''}`;
  }

  private costOf(o: Outcome): number {
    if (o.res === 'goal') return 0;
    if (o.res !== 'node' || !o.snap) return Infinity;
    return this.surfCost.get(this.surfKeyOf(o.snap)) ?? Infinity;
  }

  private judge(o: Outcome, tgtCost: number): boolean {
    const ok = this.costOf(o) <= tgtCost + 1e-9;
    if (!ok) {
      this.fails++;
      if (o.res === 'death') {
        this.dead++;
        if (o.soft) this.soft++;
      }
    }
    return ok;
  }

  private test(n: BNode, a: Act, tgtCost: number): boolean {
    return this.judge(this.ex.run(n.snap, a), tgtCost);
  }

  /**
   * Does any hold work at this takeoff? `holds[0]` (the route hold) is tried alone first; the rest are played as one
   * prefix-sharing group. Failures are counted as the sequential search would: up to the first working hold.
   */
  private anyHold(n: BNode, a: Act, holds: number[], tgtCost: number): boolean {
    if (this.test(n, { ...a, hold: holds[0] }, tgtCost)) return true;
    if (holds.length < 2 || this.overBudget()) return false;
    const outs = this.ex.runGroup(n.snap, holds.slice(1).map((h) => ({ ...a, hold: h })));
    for (const o of outs) if (this.judge(o, tgtCost)) return true;
    return false;
  }

  /** The node advanced k frames with no input (cached per node; each wait extends the nearest shorter one). */
  private waited(n: BNode, k: number): Waited {
    if (this.waitNode !== n.i) {
      this.waitNode = n.i;
      this.waits = new Map();
      this.waits.set(0, { s: n.snap });
    }
    const hit = this.waits.get(k);
    if (hit) return hit;
    let k0 = 0;
    for (const kk of this.waits.keys()) if (kk <= k && kk > k0) k0 = kk;
    const from = this.waits.get(k0) as Waited;
    if (!('s' in from)) return from;
    const sim = this.ex.sim;
    sim.load(from.s);
    let res: Waited | null = null;
    for (let f = k0; f < k && !res; f++) {
      sim.tick(0);
      this.ex.frames++;
      for (const ev of sim.ev) {
        if (ev.type === 'win') res = { end: 'goal' };
        else if (ev.type === 'death' || ev.type === 'hit') res = { end: 'death', soft: ev.type === 'hit' || SOFT_CAUSES.has(ev.cause ?? '') };
        else if (ev.type === 'lose') res = { end: 'death', soft: false };
        if (res) break;
      }
    }
    const out: Waited = res ?? { s: sim.snap() };
    this.waits.set(k, out);
    return out;
  }

  /** The action after waiting k idle frames at the node (same as playing it with pre = k). */
  private testWait(n: BNode, a: Act, k: number, tgtCost: number): boolean {
    if (k <= 0) return this.test(n, a, tgtCost);
    const w = this.waited(n, k);
    if ('s' in w) return this.judge(this.ex.run(w.s, a), tgtCost);
    if (w.end === 'goal') return true;
    this.fails++;
    this.dead++;
    if (w.soft) this.soft++;
    return false;
  }

  private overBudget(): boolean {
    return this.ex.frames > this.budget;
  }

  private shares(e: BEdge): { L: number; Ls: number } {
    if (this.fails <= 0) return { L: e.L, Ls: e.Ls };
    return { L: this.dead / this.fails, Ls: this.soft / this.fails };
  }

  private resetCounts(): void {
    this.fails = 0;
    this.dead = 0;
    this.soft = 0;
  }

  measure(n: BNode, e: BEdge): StepWindows {
    const a = e.act;
    const est: StepWindows = { w: e.w, h: e.h, phi: null, L: e.L, Ls: e.Ls, v: e.takeoffV, measured: false };
    if (this.overBudget()) return est;
    this.resetCounts();
    const tgtCost = e.to === GOAL ? 0 : this.surfCost.get(this.surfKeyOf(this.ex.nodes[e.to].snap)) ?? Infinity;
    if (!Number.isFinite(tgtCost)) return est;
    // phase window
    let phi: number | null = null;
    if (n.timed && n.period >= 8) phi = this.phaseWindow(n, a, tgtCost);
    // takeoff window
    let w: number = UNBOUNDED_F;
    let late = 0;
    let early = 0;
    const v = e.takeoffV > 0.05 ? e.takeoffV : this.ex.nominalSpeed(a.speed);
    if (a.t === A_JUMP && a.speed > 0) {
      const holds = [a.hold, ...this.ex.holds.filter((h) => h !== a.hold)];
      const okAt = (xt: number): boolean => this.anyHold(n, { ...a, xt }, holds, tgtCost);
      const side = (sgn: number): { ok: number; bounded: boolean } => {
        let lastOk = 0;
        let firstFail = -1;
        let miss = 0;
        for (let j = 1; j <= 32; j++) {
          if (this.overBudget()) return { ok: lastOk, bounded: true };
          const off = 2 * j;
          if (okAt(a.xt + sgn * a.dir * off)) {
            lastOk = off;
            firstFail = -1;
            miss = 0;
          } else {
            if (firstFail < 0) firstFail = off;
            if (++miss >= 3) break;
          }
        }
        if (firstFail < 0) return { ok: lastOk, bounded: false };
        let lo = lastOk;
        let hi = firstFail;
        for (let k = 0; k < 3; k++) {
          const mid = (lo + hi) / 2;
          if (okAt(a.xt + sgn * a.dir * mid)) lo = mid;
          else hi = mid;
        }
        return { ok: lo, bounded: true };
      };
      const L1 = side(1);
      const E1 = side(-1);
      late = L1.ok;
      early = E1.ok;
      if (L1.bounded || E1.bounded) w = (late + early + 0.25) / v;
      if (!L1.bounded || !E1.bounded) w = UNBOUNDED_F;
    }
    // hold window at the best takeoff: every hold 1..45 as one prefix-sharing group
    let h: number = UNBOUNDED_F;
    if (a.t === A_JUMP && !this.overBudget()) {
      const xtBest = a.speed > 0 ? a.xt + (a.dir * (late - early)) / 2 : a.xt;
      const maxH = this.legacy ? 40 : 45;
      const acts: Act[] = [];
      for (let hh = 1; hh <= maxH; hh++) acts.push({ ...a, xt: xtBest, hold: hh });
      const ok = this.ex.runGroup(n.snap, acts).map((o) => this.judge(o, tgtCost));
      if (this.legacy) {
        const cnt = ok.filter(Boolean).length;
        h = cnt >= 30 ? UNBOUNDED_F : cnt;
      } else {
        let k = Math.min(maxH, Math.max(1, a.hold)) - 1;
        if (!ok[k]) {
          let bestK = -1;
          for (let j = 0; j < ok.length; j++) if (ok[j] && (bestK < 0 || Math.abs(j - k) < Math.abs(bestK - k))) bestK = j;
          k = bestK;
        }
        if (k >= 0) {
          let lo = k;
          let hi = k;
          while (lo > 0 && ok[lo - 1]) lo--;
          while (hi + 1 < ok.length && ok[hi + 1]) hi++;
          h = hi === ok.length - 1 ? UNBOUNDED_F : hi - lo + 1;
        } else h = 0;
      }
    }
    const sh = this.fails > 0 ? { L: this.dead / this.fails, Ls: this.soft / this.fails } : { L: 0, Ls: 0 };
    return { w, h, phi, L: sh.L, Ls: sh.Ls, v, measured: true };
  }

  /**
   * Fast-mode estimate (§4.1 approx): φ from the action after k·P/8 frames of waiting, k = 0..7, with the route
   * takeoff and hold (≈ working share × P, ∞ when all 8 work); for a moving interior takeoff a short takeoff sweep;
   * L / Ls from the failing samples.
   */
  quick(n: BNode, e: BEdge): StepWindows {
    const est: StepWindows = { w: e.w, h: e.h, phi: null, L: e.L, Ls: e.Ls, v: e.takeoffV, measured: false };
    if (this.overBudget()) return est;
    const tgtCost = e.to === GOAL ? 0 : this.surfCost.get(this.surfKeyOf(this.ex.nodes[e.to].snap)) ?? Infinity;
    if (!Number.isFinite(tgtCost)) return est;
    this.resetCounts();
    const a = e.act;
    if (n.timed && n.period >= 8) {
      const K = BOT.approx_phase_samples;
      let okN = 0;
      for (let k = 0; k < K; k++) if (this.testWait(n, a, Math.round((k * n.period) / K), tgtCost)) okN++;
      est.phi = okN === K ? UNBOUNDED_F : (okN * n.period) / K;
    }
    if (a.t === A_JUMP && a.speed > 0 && !a.edge && !(est.w < UNBOUNDED_F) && !this.overBudget()) {
      const holds = [a.hold, ...[16, 45].filter((h) => h !== a.hold)];
      const v = e.takeoffV > 0.05 ? e.takeoffV : this.ex.nominalSpeed(a.speed);
      // an earlier press must stay ahead of the node (behind it the press would come at a standstill)
      const room = a.dir * (a.xt - n.x) - 2;
      const side = (sgn: number): { ok: number; open: boolean } => {
        let lastOk = 0;
        for (const off of QUICK_OFFSETS) {
          if (sgn < 0 && off > room) break;
          if (this.overBudget()) return { ok: lastOk, open: false };
          if (!this.anyHold(n, { ...a, xt: a.xt + sgn * a.dir * off }, holds, tgtCost)) return { ok: lastOk, open: false };
          lastOk = off;
        }
        return { ok: lastOk, open: true };
      };
      const late = side(1);
      const early = side(-1);
      est.w = late.open && early.open ? UNBOUNDED_F : (late.ok + early.ok + 2) / v;
    }
    if (this.fails > 0) {
      const sh = this.shares(e);
      est.L = Math.max(e.L, sh.L);
      est.Ls = Math.min(est.L, Math.max(e.Ls, sh.Ls));
    }
    return est;
  }

  /** Phase window (frames) of an action at a timed node; null when the timing does not matter. */
  private phaseWindow(n: BNode, a: Act, tgtCost: number): number | null {
    const P = n.period;
    const S = BOT.phase_samples;
    const preOf = (k: number): number => Math.round((k * P) / S);
    const ok: boolean[] = [];
    for (let k = 0; k < S; k++) {
      if (this.overBudget()) return null;
      ok.push(this.testWait(n, a, preOf(k), tgtCost));
    }
    if (ok.every(Boolean)) return UNBOUNDED_F;
    if (!ok[0]) {
      // the route phase itself should work; fall back to the share of working samples
      const c = ok.filter(Boolean).length;
      return (c * P) / S;
    }
    let k1 = 0;
    while (k1 + 1 < S && ok[k1 + 1]) k1++;
    let k0 = S;
    while (k0 - 1 > k1 && ok[k0 - 1]) k0--;
    // forward boundary: last working wait in (preOf(k1), preOf(k1+1))
    let lo = preOf(k1);
    let hi = preOf(k1 + 1);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.testWait(n, a, mid, tgtCost)) lo = mid;
      else hi = mid;
    }
    const fwd = lo;
    // backward boundary (waiting P − j ≡ −j): first working wait in (preOf(k0−1), preOf(k0)] (k0 = S means none)
    let back = 0;
    if (k0 < S) {
      let blo = preOf(k0 - 1);
      let bhi = preOf(k0);
      while (bhi - blo > 1) {
        const mid = (blo + bhi) >> 1;
        if (this.testWait(n, a, mid, tgtCost)) bhi = mid;
        else blo = mid;
      }
      back = Math.round(P) - bhi;
    }
    return fwd + back + 1;
  }
}
