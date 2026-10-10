/**
 * Derived design facts from the physics envelope (§5.3), used for bounds (C1 never beyond g_max − 1),
 * predicted deltas and failure classification when the bot gives no blocking detail.
 * v2-standard: g_max = 4 cells with no runway, 8 with ≥ 3 cells of runway; walls ≤ 3 rows standing, 4 walking.
 */
import { DERIVED } from '../params.ts';
import { reachFor } from '../bot/envelope.ts';
import type { PhysicsProfile } from '../sim/types.ts';

/** Game abilities that change the reach (§8.2 rules): running off, the double jump on. */
export interface ReachAb {
  run?: boolean;
  double_jump?: boolean;
}

function special(p: PhysicsProfile, ab?: ReachAb): boolean {
  return !!ab && (ab.run === false || !!ab.double_jump) && p.id !== 'v1-classic';
}

const BODY_W_C = 0.75;

/** Widest clearable gap (empty cells) for a runway of r cells (with `ab`: the rules-aware table, measured, A-2). */
export function gMax(p: PhysicsProfile, runway: number, ab?: ReachAb): number {
  if (special(p, ab)) {
    const g = reachFor(p.id, ab).g_max;
    if (g.length) return g[Math.max(0, Math.min(g.length - 1, Math.round(runway)))];
  }
  const walk = p.envelope.dist_c.walk;
  const run = p.envelope.dist_c.run ?? walk;
  const std = p.id === 'v2-standard';
  const lo = std ? DERIVED.g_max_expected.no_runway : Math.floor(walk - BODY_W_C - 0.15);
  const hi = std ? DERIVED.g_max_expected.runway_3 : Math.floor(run - BODY_W_C - 0.15);
  const f = Math.max(0, Math.min(1, runway / DERIVED.run_gap_runway_c));
  return Math.floor(lo + (hi - lo) * f + 1e-9);
}

/** Highest ledge (rows) reachable from a standing / walking / running takeoff (with `ab`: rules-aware, A-2). */
export function hMax(p: PhysicsProfile, speed: 'stand' | 'walk' | 'run', ab?: ReachAb): number {
  if (special(p, ab)) {
    const r = reachFor(p.id, ab);
    return Math.floor((speed === 'stand' ? r.stand_apex_c : r.apex_c) + 1e-9);
  }
  const a = p.envelope.apex_c;
  const v = speed === 'stand' ? a.stand : speed === 'walk' ? a.walk : a.run ?? a.walk;
  return Math.floor(v + 1e-9);
}

/** Apex height (cells) of a jump of a given kind, for coin trails along the bot's arc. */
export function apexOf(p: PhysicsProfile, kind: string): number {
  const a = p.envelope.apex_c;
  if (kind === 'runjump') return (a.run ?? a.walk) - 0.4;
  if (kind === 'jump') return a.walk - 0.4;
  return a.stand - 0.4;
}
