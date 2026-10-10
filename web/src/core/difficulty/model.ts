/**
 * The difficulty model (§4.4-4.6, formalizing [G §6]). Inputs are engine-exact windows measured by the bot; this
 * file holds only the closed-form part, so the designer, the UI and the bot agree on one formula.
 *
 *   miss(x)        = 2·Φ(−x / (2σ))              σ = 3 f (casual), 1.5 f (skilled); miss(∞) = 0
 *   p_fail_i       = 1 − (1 − miss(w_i))·(1 − miss(h_i))·(1 − miss(φ_i))
 *   d_i            = p_fail_i · L_i
 *   E_s            = Σ_{i∈s} d_i ;  A_s = 1 / Π (1 − d_i) ;  F_s = (A_s − 1) · T_s / 2
 *   C              = max_s E_s + 0.25 · Σ_s E_s ;  F = Σ_s F_s ;  score = round(100 · (1 − e^(−C)))
 *   casual_clear_s = 1.6 · Σ T_s + Σ (A_s − 1) · (T_s/2 + 0.75) ;  par_ms = ceil_to_500ms(1.3 · fastest_ms)
 *
 * Windows are in frames; `Infinity` (or ≥ UNBOUNDED_F) means "no timing needed".
 *
 * Game rules (§5.5, §8.2) enter the model in two places; with the defaults (hearts 1, lives off) every number is the
 * formula above, unchanged:
 * - **Hearts.** A failure that ends on spikes, an enemy, a saw, a firebar, a blob or a hazard cell (the `Ls` share
 *   of L) costs a heart instead of a life while hearts remain; pits, lava, crushes and crushers always kill. With
 *   H hearts, each attempt at action i passes (1 − p_fail·L), dies outright (p_fail·(L − Ls)) or takes a hit
 *   (p_fail·Ls) and retries with one heart less; a hit with the last heart kills. A segment attempt starts with full
 *   hearts (a respawn refills them) and the heart distribution is carried action to action, so d_i is the
 *   probability of dying at action i given the player reached it alive. E_s = Σ d_i, A_s = 1 / Π (1 − d_i).
 * - **Lives** (3 or 5). Game over (the L-th death of one pass) restarts the level. P(clear in one pass) comes from a
 *   DP over segments of the deaths spent so far (deaths per segment are geometric with success 1 / A_s);
 *   casual_clear_s becomes E[time of one pass] / P(clear in one pass) (a renewal: passes repeat until one clears),
 *   and p_game_over = 1 − P(clear in one pass).
 */
import { DIAL, DIFFICULTY } from '../params.ts';
import type { Band, ChallengeBand, DifficultyWish, Tier } from '../types.gen.ts';

export const UNBOUNDED_F = 999;

export type SigmaProfile = 'casual' | 'skilled';

export function sigmaOf(p: SigmaProfile = 'casual'): number {
  return DIFFICULTY.sigma_f[p];
}

/** Standard normal CDF (erf via Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function Phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Probability that a player with timing noise σ misses a window of `w` frames. */
export function miss(w: number | null | undefined, sigma: number): number {
  if (w === null || w === undefined || !(w < UNBOUNDED_F)) return 0;
  if (w <= 0) return 1;
  return Math.min(1, 2 * Phi(-w / (2 * sigma)));
}

export interface ActionWindows {
  w: number; // takeoff window, frames
  h: number; // hold window, frames
  phi: number | null; // phase window, frames (null: untimed)
  L: number; // lethal share of misses, 0..1
  /** Share of misses ending in a hit a heart can absorb (spikes, enemy, saw, firebar, blob, hazard); ≤ L. */
  Ls?: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hearts from the rules (1..3). */
export function heartsOf(h: number | null | undefined): number {
  const v = typeof h === 'number' && Number.isFinite(h) ? Math.round(h) : 1;
  return v < 1 ? 1 : v > 3 ? 3 : v;
}

/**
 * Probability of dying at one action entered with `hearts` hearts (hits retry the action with one heart less).
 * hearts = 1 is deathProb.
 */
export function deathProbHearts(a: ActionWindows, sigma: number, hearts: number): number {
  const H = heartsOf(hearts);
  if (H === 1) return deathProb(a, sigma);
  const f = pFail(a, sigma);
  const L = clamp01(a.L);
  const Ls = Math.min(L, clamp01(a.Ls ?? 0));
  const pb = f * Ls;
  const ps = 1 - f * L;
  let pass = 0;
  let pow = 1;
  for (let k = 0; k < H; k++) {
    pass += ps * pow;
    pow *= pb;
  }
  return clamp01(1 - pass);
}

export function pFail(a: ActionWindows, sigma: number): number {
  return 1 - (1 - miss(a.w, sigma)) * (1 - miss(a.h, sigma)) * (1 - miss(a.phi, sigma));
}

export function deathProb(a: ActionWindows, sigma: number): number {
  const L = a.L < 0 ? 0 : a.L > 1 ? 1 : a.L;
  return pFail(a, sigma) * L;
}

export interface SegmentInput {
  id: string;
  from: string;
  to: string;
  T_ms: number;
  actions: ActionWindows[];
}

export interface SegmentStats {
  id: string;
  from: string;
  to: string;
  E: number;
  A: number;
  T_ms: number;
  F_s: number;
  actions: number;
  /** Per action: probability of dying there given the player reached it alive (hearts carried through). */
  d?: number[];
}

/** Per-action death probabilities of one segment attempt with `hearts` hearts (see the file header). */
export function segmentDeaths(actions: ActionWindows[], sigma: number, hearts = 1): number[] {
  const H = heartsOf(hearts);
  if (H === 1) return actions.map((a) => deathProb(a, sigma));
  // dist[h]: probability of being alive with h hearts, conditioned on being alive
  let dist = new Float64Array(H + 1);
  dist[H] = 1;
  const out: number[] = [];
  for (const a of actions) {
    const f = pFail(a, sigma);
    const L = clamp01(a.L);
    const Ls = Math.min(L, clamp01(a.Ls ?? 0));
    const pb = f * Ls;
    const ps = 1 - f * L;
    const next = new Float64Array(H + 1);
    let die = 0;
    for (let h = 1; h <= H; h++) {
      const m = dist[h];
      if (m <= 0) continue;
      let pow = 1;
      let passed = 0;
      for (let k = h; k >= 1; k--) {
        const q = ps * pow;
        next[k] += m * q;
        passed += q;
        pow *= pb;
      }
      die += m * (1 - passed);
    }
    const alive = 1 - die;
    out.push(clamp01(die));
    if (alive > 1e-12) for (let h = 1; h <= H; h++) next[h] /= alive;
    else {
      next.fill(0);
      next[H] = 1;
    }
    dist = next;
  }
  return out;
}

export function segmentStats(s: SegmentInput, sigma: number, hearts = 1): SegmentStats {
  const d = segmentDeaths(s.actions, sigma, hearts);
  let E = 0;
  let surv = 1;
  for (const di of d) {
    E += di;
    surv *= 1 - Math.min(di, 0.999999);
  }
  const A = 1 / surv;
  const T_s = s.T_ms / 1000;
  return { id: s.id, from: s.from, to: s.to, E, A, T_ms: s.T_ms, F_s: ((A - 1) * T_s) / 2, actions: s.actions.length, d };
}

export interface LevelStats {
  C: number;
  F: number;
  score: number;
  band: Band;
  casual_clear_s: number;
  maxE: number;
  sumE: number;
  /** Probability that one pass through the level ends in a game over (0 with lives off). */
  p_game_over: number;
}

/** Lives from the rules: 3 or 5, else null (off). */
export function livesOf(l: unknown): number | null {
  return l === 3 || l === 5 ? l : null;
}

const MAX_CLEAR_S = 36000;

/**
 * With `lives` on: [expected seconds of one pass, P(the pass clears)] by a DP over segments of the deaths already
 * spent (the pass ends at the lives-th death).
 */
function livesPass(segs: SegmentStats[], lives: number): [number, number] {
  const cc = DIFFICULTY.casual_clear;
  let mass = new Float64Array(lives);
  mass[0] = 1;
  let time = 0;
  for (const s of segs) {
    const T = s.T_ms / 1000;
    const q = s.A > 1 ? 1 / s.A : 1;
    const fail = T / 2 + cc.retry_overhead_s;
    const next = new Float64Array(lives);
    for (let k = 0; k < lives; k++) {
      const m = mass[k];
      if (m <= 0) continue;
      let pj = q; // P(j failures, then a success)
      for (let j = 0; k + j < lives; j++) {
        next[k + j] += m * pj;
        time += m * pj * (j * fail + cc.time_factor * T);
        pj *= 1 - q;
      }
      // game over: lives − k failures before any success
      const go = (1 - q) ** (lives - k);
      time += m * go * ((lives - k) * fail + cc.retry_overhead_s);
    }
    mass = next;
  }
  let ok = 0;
  for (const m of mass) ok += m;
  return [time, ok];
}

export function levelStats(segs: SegmentStats[], o?: { lives?: number | null }): LevelStats {
  let maxE = 0;
  let sumE = 0;
  let F = 0;
  let sumT = 0;
  let retry = 0;
  for (const s of segs) {
    maxE = Math.max(maxE, s.E);
    sumE += s.E;
    F += s.F_s;
    const T = s.T_ms / 1000;
    sumT += T;
    retry += (s.A - 1) * (T / 2 + DIFFICULTY.casual_clear.retry_overhead_s);
  }
  const C = maxE + DIFFICULTY.sum_weight * sumE;
  let casual = DIFFICULTY.casual_clear.time_factor * sumT + retry;
  let pGo = 0;
  const lives = livesOf(o?.lives);
  if (lives !== null && segs.length) {
    const [t, ok] = livesPass(segs, lives);
    pGo = Math.max(0, Math.min(1, 1 - ok));
    casual = ok > 1e-9 ? Math.min(MAX_CLEAR_S, t / ok) : MAX_CLEAR_S;
  }
  return { C, F, score: scoreOf(C), band: bandOf(C), casual_clear_s: casual, maxE, sumE, p_game_over: pGo };
}

export function bandOf(C: number): Band {
  for (const b of DIFFICULTY.bands) if (b.C_max !== null && C < b.C_max) return b.band;
  return 'expert';
}

/** 0-100 badge: round(100 · (1 − e^(−C))). */
export function scoreOf(C: number): number {
  return Math.round(100 * (1 - Math.exp(-C)));
}

/** par_ms = ceil_to_500ms(1.3 × fastest_ms). */
export function parMs(fastestMs: number): number {
  const step = DIFFICULTY.par.round_ms;
  return Math.ceil((DIFFICULTY.par.factor * fastestMs) / step) * step;
}

/** C range of a band (upper bound exclusive; expert open). */
export function bandRange(b: Band): [number, number] {
  let lo = 0;
  for (const x of DIFFICULTY.bands) {
    const hi = x.C_max === null ? Infinity : x.C_max;
    if (x.band === b) return [lo, hi];
    lo = hi;
  }
  return [lo, Infinity];
}

// ---- kid-facing readout (§4.5) ------------------------------------------------------------

/** m:ss for the pill ("0:31"). */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** m:ss.cc for the speedrun clock and results card. */
export function fmtRunClock(ms: number): string {
  const cs = Math.max(0, Math.floor(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs - m * 6000) / 100);
  const c = cs - m * 6000 - s * 100;
  return `${m}:${s < 10 ? '0' : ''}${s}.${c < 10 ? '0' : ''}${c}`;
}

export interface Readout {
  message_key: 'readout.pill' | 'readout.rarely_fall';
  args: { band: Band; n?: number; bot: string; par: string };
  /** One fall in N tries for the hardest part (null when falls are rare). */
  n: number | null;
}

/** "Easy · about 1 fall in N tries · bot 0:31 · par 0:41" (N = round(1 / max_s E_s)); "you'll rarely fall" below 0.05. */
export function readout(r: { band: Band; segments: { E: number }[]; fastest_ms: number; par_ms: number }): Readout {
  let maxE = 0;
  for (const s of r.segments) maxE = Math.max(maxE, s.E);
  const bot = fmtClock(r.fastest_ms);
  const par = fmtClock(r.par_ms);
  if (maxE < DIFFICULTY.rarely_fall_E) return { message_key: 'readout.rarely_fall', args: { band: r.band, bot, par }, n: null };
  const n = Math.max(1, Math.round(1 / maxE));
  return { message_key: 'readout.pill', args: { band: r.band, n, bot, par }, n };
}

/** "Your drawing: Trivial → Polished: Easy (0.14)". */
export function beforeAfter(before: Band, tier: Tier, after: Band, C: number): { message_key: 'readout.before_after'; args: { before: Band; tier: Tier; after: Band; C: string } } {
  return { message_key: 'readout.before_after', args: { before, tier, after, C: (Math.round(C * 100) / 100).toFixed(2) } };
}

// ---- dial targets (§4.6) --------------------------------------------------------------------

export interface DialTarget {
  tier: Tier;
  /** Inclusive lower bound on C the tier must reach (or keep). */
  lo: number;
  /** Exclusive upper bound on C. */
  hi: number;
  aim: number;
  /** Polished may only raise C through P6/P7 (tune, animate). */
  raiseOnly: boolean;
  /** Polished with C_f > 3: offer "gentler" suggestions only, never change C. */
  offerGentler: boolean;
  maxF_s: number;
  maxT_s: number;
  sawtooth: boolean;
}

/**
 * The C band each tier aims for. Faithful keeps C_f; Polished raises toward [max(C_f, 0.1), max(C_f, 0.3)] and
 * never lowers C_f (I7); Challenging·Normal [0.3, 1.0) aim 0.6; Challenging·Hard [1.0, 3.0) aim 1.8.
 * `wish: 'easy'` caps Polished at 0.3; `wish: 'hard'` pre-selects Challenging·Hard (see wishTier).
 */
export function dialTarget(tier: Tier, C_f: number, wish: DifficultyWish = 'none'): DialTarget {
  const base = { tier, maxF_s: DIAL.polished.max_F_s, maxT_s: DIAL.polished.max_T_s };
  if (tier === 'faithful') return { ...base, lo: C_f, hi: C_f, aim: C_f, raiseOnly: false, offerGentler: false, maxF_s: Infinity, maxT_s: Infinity, sawtooth: false };
  if (tier === 'polished') {
    const lo = Math.max(C_f, DIAL.polished.C_min);
    let hi = Math.max(C_f, DIAL.polished.C_raise_max);
    if (wish === 'easy') hi = Math.max(C_f, Math.min(hi, DIAL.wish_easy_C_max));
    return { ...base, lo, hi, aim: lo, raiseOnly: true, offerGentler: C_f > DIAL.polished.gentler_above_C, sawtooth: false };
  }
  const r = tier === 'normal' ? DIAL.normal : DIAL.hard;
  return { ...base, lo: r.C[0], hi: r.C[1], aim: r.aim, raiseOnly: false, offerGentler: false, sawtooth: true };
}

/** Sawtooth target for segment k of n: lo + (hi − lo)·(0.4 + 0.6·k / max(1, n − 1)). */
export function sawtooth(lo: number, hi: number, k: number, n: number): number {
  return lo + (hi - lo) * (DIAL.sawtooth.base + (DIAL.sawtooth.slope * k) / Math.max(1, n - 1));
}

/** Per-segment E targets for a tier (sawtooth for Challenging; the tier aim spread evenly otherwise). */
export function segmentTargets(tier: Tier, n: number, C_f: number, wish: DifficultyWish = 'none'): number[] {
  const t = dialTarget(tier, C_f, wish);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    if (t.sawtooth) {
      // The segment targets are per-segment E; C = max E + 0.25 ΣE, so scale so the hardest lands on the aim.
      const raw = sawtooth(t.lo, t.hi, k, n);
      out.push(raw / (1 + DIFFICULTY.sum_weight * n * 0.7));
    } else out.push(t.aim / (1 + DIFFICULTY.sum_weight * n));
  }
  return out;
}

/** Does a measured C satisfy the tier's target (given the Faithful C_f)? */
export function meetsTarget(tier: Tier, C: number, C_f: number, wish: DifficultyWish = 'none'): boolean {
  const t = dialTarget(tier, C_f, wish);
  if (tier === 'faithful') return true;
  if (tier === 'polished') return C >= Math.min(t.lo, C_f) - 1e-9 && C >= C_f - 1e-9 && (C <= t.hi + 1e-9 || C <= C_f + 1e-9);
  return C >= t.lo - 1e-9 && C < t.hi;
}

/** Distance of C from a tier's band (0 inside); the designer's greedy objective. */
export function targetGap(tier: Tier, C: number, C_f: number, wish: DifficultyWish = 'none'): number {
  const t = dialTarget(tier, C_f, wish);
  if (tier === 'faithful') return 0;
  if (C < t.lo) return t.lo - C;
  if (C >= t.hi && !(tier === 'polished' && C <= C_f)) return C - t.hi;
  return 0;
}

/** difficulty_wish → the dial the build pre-selects (§4.6). */
export function wishTier(wish: DifficultyWish, defaultBand: ChallengeBand = 'normal'): Tier {
  if (wish === 'hard') return 'hard';
  if (wish === 'normal') return defaultBand === 'hard' ? 'hard' : 'normal';
  return 'polished';
}
