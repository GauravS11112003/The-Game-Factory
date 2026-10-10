/**
 * The 43-op vocabulary (§3.5): class, card group and explanation per op. Preconditions, bounds and apply live in
 * apply.ts (`applyOp`, `clampOp`); intent cost in cost.ts; invariants in invariants.ts.
 */
import type { EditClass, EditOp, MessageArgs, Tier } from '../types.gen.ts';
import type { Outcome } from './apply.ts';

export const OP_CLASS: Record<EditOp['op'], EditClass> = {
  set_role: 'U', group: 'U', detach: 'U', bind: 'U', link: 'U', set_start: 'U', use_library: 'U',
  straighten: 'N', close_gap: 'N', snap: 'N', orient: 'N', form_goal: 'N', set_collision: 'N', place_start: 'N',
  clear_spawn: 'N', coin_from_dot: 'N', dedupe: 'N', join_seam: 'N', fix_behavior: 'N', fit_creature: 'N',
  nudge: 'R', trim: 'R', extend: 'R', add_step: 'R', add_spring: 'R',
  add_checkpoint: 'P', add_coin_trail: 'P', add_coin: 'P', add_big_coin: 'P', add_hint_arrow: 'P', tune: 'P',
  animate: 'P', set_par: 'P',
  widen_gap: 'C', shrink_landing: 'C', shift_platform: 'C', add_spikes: 'C', add_enemy: 'C', add_hazard: 'C',
  make_crumble: 'C', set_timer: 'C', reprise: 'C',
  make_mine: 'K',
};

/** Stable edit / candidate id: `op:target:hash6(params)` (D6). */
export const EDIT_ID_RE = /^[a-z_]+:[A-Za-z0-9_.-]+:[0-9a-f]{6}$/;

/** Vocabulary order, used for deterministic tie-breaks (§3.6). */
export const OP_ORDER: readonly EditOp['op'][] = Object.keys(OP_CLASS) as EditOp['op'][];

/** The lowest tier at which an op class may appear (U and N at every tier, R in Faithful+, P in Polished+, C in Challenging). */
export function minTier(cls: EditClass): Tier {
  return cls === 'P' ? 'polished' : cls === 'C' ? 'normal' : 'faithful';
}

export const TIER_ORDER: readonly Tier[] = ['faithful', 'polished', 'normal', 'hard'];

export function tierRank(t: Tier): number {
  return TIER_ORDER.indexOf(t);
}

/** Default reason key per op (kid-readable sentence in shared/spec/messages.json). */
const REASON: Record<EditOp['op'], string> = {
  set_role: 'understand.role', group: 'understand.grouped', detach: 'understand.detached', bind: 'understand.bound',
  link: 'understand.linked', set_start: 'understand.start', use_library: 'understand.library',
  straighten: 'norm.straightened', close_gap: 'norm.gap_closed', snap: 'norm.snapped', orient: 'norm.oriented',
  form_goal: 'norm.pole_scenery', set_collision: 'norm.oneway_platform', place_start: 'norm.start_placed',
  clear_spawn: 'norm.spawn_moved', coin_from_dot: 'norm.coin_from_dot', dedupe: 'norm.deduped', join_seam: 'norm.seam_joined',
  fix_behavior: 'norm.behavior_fixed', fit_creature: 'norm.creature_fit',
  nudge: 'repair.nudged', trim: 'repair.trimmed', extend: 'repair.extended', add_step: 'repair.step_added',
  add_spring: 'repair.spring_added',
  add_checkpoint: 'polish.checkpoint', add_coin_trail: 'polish.coin_trail', add_coin: 'polish.coin',
  add_big_coin: 'polish.big_coin', add_hint_arrow: 'polish.hint_arrow', tune: 'polish.tune', animate: 'polish.monster_walks',
  set_par: 'polish.par',
  widen_gap: 'challenge.widen_gap', shrink_landing: 'challenge.shrink_landing', shift_platform: 'challenge.shift_platform',
  add_spikes: 'challenge.add_spikes', add_enemy: 'challenge.add_enemy', add_hazard: 'challenge.add_hazard',
  make_crumble: 'challenge.make_crumble', set_timer: 'challenge.set_timer', reprise: 'challenge.reprise',
  make_mine: 'kid.make_mine',
};

/** Card groups (§3.5: N edits show as grouped cards). */
const GROUP: Partial<Record<EditOp['op'], string>> = {
  straighten: 'tidy_lines', close_gap: 'tidy_lines', join_seam: 'tidy_lines', set_collision: 'platforms', snap: 'snap_hazards',
  orient: 'snap_hazards', coin_from_dot: 'coins', fit_creature: 'creatures', add_coin_trail: 'coins',
};

export interface Explained {
  reason_key: string;
  reason_args: MessageArgs;
  group: string | null;
}

/** explain → reason_key (+ args) for an applied op. */
export function explain(op: EditOp, o: Outcome | null): Explained {
  let key = o?.reason ?? REASON[op.op];
  const args: MessageArgs = { ...(o?.args ?? {}) };
  switch (op.op) {
    case 'set_collision':
      key = op.mode === 'one_way' ? 'norm.oneway_platform' : op.mode === 'solid' ? 'norm.solid_platform' : 'norm.not_solid';
      break;
    case 'snap':
      if (o?.args.facing) key = 'norm.spikes_snapped';
      else key = 'norm.snapped';
      break;
    case 'set_role':
      if (op.role === 'decoration' || op.role === 'unknown') {
        key = 'understand.decoration';
        args.what = String(args.role ?? 'drawing');
      } else if (op.role === 'text') key = 'understand.text_sign';
      break;
    case 'straighten':
      if (o && Number(o.args.ramps ?? 0) > 0) key = 'norm.ramp';
      break;
    case 'trim':
      if (op.side === 'top') key = 'repair.wall_trimmed';
      break;
    case 'extend':
      break;
    case 'bind':
      if (op.behavior.kind === 'move') {
        key = 'understand.moves';
        args.dir = op.behavior.dir;
        args.cells = op.behavior.cells;
      } else if (op.behavior.kind === 'enemy' && op.behavior.archetype === 'walker') key = 'understand.walks';
      break;
    default:
      break;
  }
  return { reason_key: key, reason_args: args, group: GROUP[op.op] ?? null };
}

export { applyOp, clampOp } from './apply.ts';
