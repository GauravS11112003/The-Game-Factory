/**
 * The v4 bot search (docs/v4/CONTRACTS_V4.md §1.4): best-first over input macro-actions played in the real Sim from
 * snapshots, for levels the standing-node explorer cannot play — runner, flappy and top-down modes, rule keys
 * (IN_SPACE / IN_ACTION) and flipped gravity. A macro is a short fixed input pattern (walk, run, jump with a hold,
 * tap a rule key, flap, wait, move in one of eight directions); states are merged on a coarse key (position and
 * velocity buckets, gravity sign, ground contact, and the rule state: score, counters, hidden flags, latches,
 * collected things, active effects), so the graph is time-expanded but bounded.
 *
 * A hit or a death ends a branch (a careful route). The search stops at the first win (the goal or a `win` rule),
 * so `solved` is always a run the Sim actually won; the caller replays the inputs once more to confirm. The budget is
 * deterministic simulated frames, never a clock.
 */
import { SimCore } from '../sim/core.ts';
import type { RuleState, SimState } from '../sim/core.ts';
import { CELL } from '../sim/tiles.ts';
import { IN_ACTION, IN_D, IN_J, IN_L, IN_R, IN_RUN, IN_SPACE } from '../sim/types.ts';
import type { DGoal, SimWorld } from '../sim/world.ts';

/** One macro: [bits, frames] runs played back to back. */
type Macro = [number, number][];

export interface SearchResult {
  solved: boolean;
  /** Inputs from frame 0 to the win (empty when not solved). */
  inputs: number[];
  /** The budget ran out (or the node cap) before the search was exhausted. */
  approx: boolean;
  frames: number;
  /** Feet positions (cells) of the states reached, for the reach halo / frontier. */
  reached: [number, number][];
  /** States kept (merged on the coarse key). */
  nodes: number;
}

interface SNode { snap: SimState; parent: number; macro: number; t: number }

const MAX_NODES = 30000;

/** The macro set for the level's mode, keys and abilities. */
export function macrosFor(W: SimWorld): Macro[] {
  const out: Macro[] = [];
  const keys = W.usesKeys.map((k) => (k === 'space' ? IN_SPACE : IN_ACTION));
  const run = W.ab.run && W.prof.run_max !== null ? IN_RUN : 0;
  if (W.mode === 'topdown') {
    const dirs = [IN_R, IN_L, IN_J, IN_D, IN_R | IN_J, IN_R | IN_D, IN_L | IN_J, IN_L | IN_D];
    for (const d of dirs) for (const n of [6, 16]) out.push([[d, n]]);
    for (const k of keys) for (const d of [0, IN_R, IN_L, IN_J, IN_D]) out.push([[k | d, 1], [d, 7]]);
    out.push([[0, 12]]);
    return out;
  }
  if (W.mode === 'flappy') {
    for (const n of [3, 6, 10, 18]) out.push([[0, n]]);
    for (const n of [4, 8, 14, 22]) out.push([[IN_J, 1], [0, n - 1]]);
    for (const k of keys) {
      out.push([[k, 1], [0, 5]]);
      out.push([[k | IN_J, 1], [0, 7]]);
    }
    return out;
  }
  // platformer and runner (the sim holds Right in runner mode)
  const dirs = W.mode === 'runner' ? [IN_R] : [IN_R, IN_L, 0];
  for (const d of dirs) {
    if (d === 0) continue;
    out.push([[d, 8]], [[d, 20]]);
    if (run) out.push([[d | run, 12]], [[d | run, 28]]);
  }
  for (const d of dirs) {
    for (const h of [3, 9, 18]) {
      out.push([[d | IN_J, h], [d, 30 - h]]);
      if (run && d !== 0) out.push([[d | run | IN_J, h], [d | run, 30 - h]]);
    }
  }
  if (W.ab.double_jump) for (const d of dirs) out.push([[d | IN_J, 10], [d, 4], [d | IN_J, 12], [d, 14]]);
  for (const k of keys) {
    for (const d of dirs) {
      out.push([[k | d, 1], [d, 11]]);
      out.push([[k | d, 1], [d, 3], [d | IN_J, 12], [d, 14]]);
    }
  }
  out.push([[0, 12]]);
  return out;
}

/** Coarse rule state for node keys: what can change what the player is able to do next. */
export function ruleDigest(S: SimState, W: SimWorld, coinsMatter: boolean): string {
  const R: RuleState | undefined = S.r;
  if (!R) return '';
  let s = `g${R.gs}s${R.sc}c${R.cn.join(',')}a${R.allc}e${R.spF !== 0 ? 1 : 0}${R.jpF !== 0 ? 1 : 0}${R.gvF !== 0 ? 1 : 0}${R.rvF !== 0 ? 1 : 0}${R.fzF !== 0 ? 1 : 0}`;
  let h = '';
  for (let i = 0; i < R.hid.length; i++) if (R.hid[i] !== W.hidden0[i]) h += i + ',';
  let o = '';
  for (let k = 0; k < R.once.length; k++) o += R.once[k];
  let p = '';
  for (const i of W.pickups) p += S.e[i].on;
  for (const i of W.doors) p += S.e[i].on;
  for (const i of W.keys) p += S.e[i].on;
  if (coinsMatter) {
    for (const i of W.coins) p += S.e[i].on;
    for (const i of W.bigs) p += S.e[i].s ? 1 : 0;
  }
  return `${s}h${h}o${o}p${p}`;
}

/** Do coins steer the rules (collect item "coin", all_coins)? Then collected coins are part of the state. */
export function coinsMatter(W: SimWorld): boolean {
  return W.rules.some((r) => r.when.kind === 'all_coins' || (r.when.kind === 'collect' && (r.when.item === 'coin' || (r.ref >= 0 && (W.defs[r.ref].k === 'coin' || W.defs[r.ref].k === 'big_coin')))));
}

/** Rule progress of a state (things collected, counters, score, shown entities): more is closer to a rule win. */
function progress(S: SimState, W: SimWorld): number {
  let n = 0;
  for (const i of W.coins) if (S.e[i].on === 0) n++;
  for (const i of W.bigs) if (S.e[i].s !== 0) n++;
  for (const i of W.pickups) if (S.e[i].on === 0) n++;
  for (const i of W.keys) if (S.e[i].on === 0) n++;
  for (const i of W.doors) if (S.e[i].on === 0) n++;
  const R = S.r;
  if (R) {
    for (const c of R.cn) n += Math.max(0, c);
    n += Math.max(0, R.sc) / 10;
    for (let i = 0; i < R.hid.length; i++) if (R.hid[i] !== W.hidden0[i]) n++;
  }
  return n;
}

/** Where the search heads: the goal's box centre when it is shown, else the far right of the world. */
function targetOf(S: SimState, W: SimWorld): [number, number] {
  for (const g of W.goals) {
    if (S.r && S.r.hid[g]) continue;
    const b = (W.defs[g] as DGoal).box;
    return [(b[0] + b[2]) / 2, b[3]];
  }
  return [W.wPx - CELL, W.hPx / 2];
}

/**
 * Best-first macro search from the level start (or `start`). `budget` = simulated frames. Deterministic: macros in
 * fixed order, ties broken by insertion order.
 */
export function macroSearch(sim: SimCore, budget: number): SearchResult {
  const W = sim.W;
  sim.camOff = true;
  const macros = macrosFor(W);
  const cm = coinsMatter(W);
  const td = W.mode === 'topdown';
  const flappy = W.mode === 'flappy';
  const runV = Math.max(1, (W.prof.run_max ?? W.prof.walk_max) / 60);
  const nodes: SNode[] = [];
  const seen = new Set<string>();
  const reached: [number, number][] = [];
  const res: SearchResult = { solved: false, inputs: [], approx: false, frames: 0, reached, nodes: 0 };
  const keyOf = (S: SimState): string => {
    const P = S.p;
    const vy = Math.round(P.vy / (flappy ? 40 : 90));
    const pos = td ? `${Math.floor(P.x / 8)},${Math.floor(P.y / 8)}` : flappy ? `${Math.floor(P.x / 16)},${Math.floor(P.y / 4)},${vy}` : `${Math.floor(P.x / 8)},${Math.floor(P.y / 8)},${P.gnd > 0 ? 'g' : vy}`;
    return `${pos}|${ruleDigest(S, W, cm)}`;
  };
  const prio = (S: SimState, t: number): number => {
    const [tx, ty] = targetOf(S, W);
    const dx = Math.abs(tx - S.p.x);
    const dy = Math.abs(ty - S.p.y);
    const dist = td ? dx + dy : dx + 0.5 * dy;
    return t + (4 * dist) / runV - 90 * progress(S, W);
  };
  // a small binary heap of [priority, seq, node]
  const heap: [number, number, number][] = [];
  let seq = 0;
  const push = (i: number, p: number): void => {
    heap.push([p, seq++, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const j = (k - 1) >> 1;
      if (heap[k][0] < heap[j][0] || (heap[k][0] === heap[j][0] && heap[k][1] < heap[j][1])) {
        [heap[k], heap[j]] = [heap[j], heap[k]];
        k = j;
      } else break;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as [number, number, number];
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && (heap[l][0] < heap[m][0] || (heap[l][0] === heap[m][0] && heap[l][1] < heap[m][1]))) m = l;
        if (r < heap.length && (heap[r][0] < heap[m][0] || (heap[r][0] === heap[m][0] && heap[r][1] < heap[m][1]))) m = r;
        if (m === k) break;
        [heap[k], heap[m]] = [heap[m], heap[k]];
        k = m;
      }
    }
    return top[2];
  };
  const S0 = sim.snap();
  nodes.push({ snap: S0, parent: -1, macro: -1, t: 0 });
  seen.add(keyOf(S0));
  push(0, prio(S0, 0));
  const pathInputs = (ni: number, tail: number[]): number[] => {
    const chain: number[] = [];
    for (let i = ni; i > 0; i = nodes[i].parent) chain.push(nodes[i].macro);
    const out: number[] = [];
    for (let k = chain.length - 1; k >= 0; k--) for (const [b, n] of macros[chain[k]]) for (let f = 0; f < n; f++) out.push(b);
    return out.concat(tail);
  };
  while (heap.length) {
    if (res.frames > budget || nodes.length >= MAX_NODES) {
      res.approx = true;
      break;
    }
    const ni = pop();
    const n = nodes[ni];
    for (let mi = 0; mi < macros.length; mi++) {
      sim.load(n.snap);
      const tail: number[] = [];
      let dead = false;
      let won = false;
      for (const [b, len] of macros[mi]) {
        for (let f = 0; f < len && !dead && !won; f++) {
          sim.tick(b);
          res.frames++;
          tail.push(b);
          for (const ev of sim.ev) {
            if (ev.type === 'win') won = true;
            else if (ev.type === 'death' || ev.type === 'hit' || ev.type === 'lose') dead = true;
          }
        }
        if (dead || won) break;
      }
      if (won) {
        res.solved = true;
        res.inputs = pathInputs(ni, tail);
        res.nodes = nodes.length;
        return res;
      }
      if (dead || sim.S.p.mode !== 0) continue;
      const S = sim.snap();
      const k = keyOf(S);
      if (seen.has(k)) continue;
      seen.add(k);
      const t = n.t + tail.length;
      nodes.push({ snap: S, parent: ni, macro: mi, t });
      if (reached.length < 20000) reached.push([Math.round(S.p.x / 4) / 4, Math.round(S.p.y / 4) / 4]);
      push(nodes.length - 1, prio(S, t));
    }
  }
  res.nodes = nodes.length;
  return res;
}
