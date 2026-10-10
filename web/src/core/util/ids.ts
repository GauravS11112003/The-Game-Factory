/**
 * Stable ids (D6): edit and candidate ids are `op:target:hash6(params)`. The hash covers the op's identity
 * parameters in canonical JSON, so the same edit gets the same id in the browser and in Node, at every stage.
 * Fields the normalizer computes from geometry (a placed start, a fitted path length, par) are left out of the
 * hash, so a kid's Undo on "I moved your start" survives a rebuild that moves the start by a pixel.
 */
import type { EditOp } from '../types.gen.ts';
import { canonicalJson } from './canonical.ts';
import { sha256Hex } from './sha256.ts';

export function hash6(x: unknown): string {
  return sha256Hex(canonicalJson(x)).slice(0, 6);
}

export function hash8(x: unknown): string {
  return sha256Hex(canonicalJson(x)).slice(0, 8);
}

/** The object, slot or level an op is about (the middle part of its id). */
export function opTarget(op: EditOp): string {
  switch (op.op) {
    case 'set_role':
    case 'detach':
    case 'bind':
    case 'use_library':
    case 'straighten':
    case 'snap':
    case 'orient':
    case 'set_collision':
    case 'coin_from_dot':
    case 'fix_behavior':
    case 'fit_creature':
    case 'trim':
    case 'extend':
    case 'animate':
    case 'make_mine':
      return op.target;
    case 'group':
      return op.root;
    case 'link':
      return op.key;
    case 'set_start':
      return op.near;
    case 'close_gap':
    case 'join_seam':
      return op.a;
    case 'form_goal':
      return op.flag;
    case 'place_start':
    case 'clear_spawn':
      return 'start';
    case 'dedupe':
      return op.drop;
    case 'nudge':
    case 'shift_platform':
      return op.group;
    case 'add_step':
    case 'add_spring':
    case 'add_checkpoint':
    case 'add_coin':
    case 'add_big_coin':
    case 'add_hint_arrow':
    case 'add_spikes':
    case 'add_enemy':
    case 'add_hazard':
    case 'reprise':
      return op.slot;
    case 'add_coin_trail':
      return op.action;
    case 'tune':
      return op.entity;
    case 'set_par':
    case 'set_timer':
      return 'level';
    case 'widen_gap':
      return op.gap;
    case 'shrink_landing':
    case 'make_crumble':
      return op.surface;
  }
}

/** Fields computed by the normalizer, excluded from the id hash. */
const COMPUTED: Partial<Record<EditOp['op'], readonly string[]>> = {
  place_start: ['at'],
  clear_spawn: ['start_dx', 'trimmed'],
  set_par: ['par_ms'],
  fix_behavior: ['value'],
};

export function opIdentity(op: EditOp): Record<string, unknown> {
  const skip = COMPUTED[op.op] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op)) if (!skip.includes(k)) out[k] = v;
  return out;
}

const SAFE = /[^A-Za-z0-9_.-]/g;

export function editId(op: EditOp): string {
  const target = opTarget(op).replace(SAFE, '_') || 'x';
  return `${op.op}:${target}:${hash6(opIdentity(op))}`;
}
