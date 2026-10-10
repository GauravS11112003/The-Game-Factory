/**
 * Intent cost (§3.6). What makes "lower the wall by 2" beat "lift the wall into a floating pillar":
 *   cost(e) = Σ_moved (|dx|·1.0 + |dy|·1.5)·size(o)·w_role(o)      size(o) = clamp(sqrt(len/4), 0.75, 2)
 *           + 1.2·trim + 0.8·extend + 2.0·[kid role change] + 1.5·[kid collision change]
 *           + 3.0·[topology] + 4.0·[detached pillar]
 *           + adds: 0.5 pickup/checkpoint/arrow · 1.0 hazard/enemy · 6 add_step · 8 add_spring
 *           × 2 when any target is text-labelled or has pinned params
 * Ties → op order, then smaller x, then object id (deterministic in the browser and in Node).
 */
import { COST } from '../params.ts';
import type { EditOp, Role, SceneObject } from '../types.gen.ts';
import type { Outcome } from './apply.ts';
import { OP_ORDER } from './vocabulary.ts';
import { obj, objBBox, objLength } from './work.ts';
import type { Work } from './work.ts';

export function wRole(role: Role): number {
  const w = COST.w_role;
  switch (role) {
    case 'ground':
      return w.ground;
    case 'goal':
    case 'checkpoint':
      return w.goal;
    case 'wall':
    case 'ceiling':
    case 'door':
      return w.wall;
    case 'spikes':
    case 'lava':
    case 'saw':
      return w.hazard;
    case 'enemy':
      return w.enemy;
    case 'platform':
    case 'spring':
      return w.platform;
    case 'coin':
    case 'big_coin':
    case 'key':
      return w.coin;
    default:
      return 0.5;
  }
}

export function sizeOf(o: SceneObject): number {
  const s = COST.size;
  return Math.min(s.max, Math.max(s.min, Math.sqrt(Math.max(0, objLength(o)) / s.len_div)));
}

const ADD: Record<string, number> = {
  pickup: COST.add.pickup, checkpoint: COST.add.checkpoint, arrow: COST.add.arrow, hazard: COST.add.hazard,
  enemy: COST.add.enemy, step: COST.add.add_step, spring: COST.add.add_spring,
};

/** Behaviour-only ops that move nothing still change what the kid drew a little. */
const FLAT: Partial<Record<EditOp['op'], number>> = {
  tune: 0.25, animate: 0.75, make_crumble: 1.5, set_par: 0, set_timer: 0.5, orient: 0.2, fit_creature: 0, place_start: 0.3,
  clear_spawn: 0.5, form_goal: 0.2, snap: 0, straighten: 0, set_collision: 0, coin_from_dot: 0, make_mine: 0,
};

export function intentCost(w: Work, op: EditOp, o: Outcome): number {
  let c = 0;
  const seen = new Set<string>();
  for (const m of o.moved) {
    const x = obj(w, m.id);
    if (!x || seen.has(m.id) || x.rel.part_of) continue;
    seen.add(m.id);
    c += (Math.abs(m.dx) * COST.move_x + Math.abs(m.dy) * COST.move_y) * sizeOf(x) * wRole(x.role);
  }
  c += COST.trim * o.trim + COST.extend * o.extend;
  if (o.roleChangeKid) c += COST.role_change_kid;
  if (o.collisionChangeKid) c += COST.collision_change_kid;
  if (o.topology) c += COST.topology;
  if (o.pillar) c += COST.detached_pillar;
  for (const a of o.adds) c += (ADD[a.what] ?? 1) * (a.what === 'pickup' ? Math.min(1, a.n) : 1);
  c += FLAT[op.op] ?? 0;
  const pinned = o.touched.some((id) => {
    const x = obj(w, id);
    return !!x && x.origin !== 'designer' && (x.pinned.length > 0 || x.role === 'text' || !!x.rel.refers_to && w.objs.some((t) => t.role === 'text' && t.rel.refers_to === x.id));
  });
  return Math.round((pinned ? c * COST.pinned_multiplier : c) * 1000) / 1000;
}

/** Deterministic tie-break key: cost, op order, x, id. */
export function costCompare(a: { cost: number; op: EditOp; x: number; id: string }, b: { cost: number; op: EditOp; x: number; id: string }): number {
  return a.cost - b.cost || OP_ORDER.indexOf(a.op.op) - OP_ORDER.indexOf(b.op.op) || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function opX(w: Work, id: string | undefined): number {
  const x = id ? obj(w, id) : undefined;
  return x ? objBBox(x)[0] : 0;
}
