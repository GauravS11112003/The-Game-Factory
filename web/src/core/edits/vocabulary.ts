/** The 43-op vocabulary (§3.5): class per op. P0 data only; lane B adds precondition/apply/explain/clamp per op. */
import type { EditClass, EditOp } from '../types.gen.ts';

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

/** Stable edit / candidate id: `op:target:hash6(params)` (D6). The hash is lane B's; the shape is the contract. */
export const EDIT_ID_RE = /^[a-z_]+:[A-Za-z0-9_.-]+:[0-9a-f]{6}$/;
