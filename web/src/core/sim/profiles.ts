/** Physics profiles (§5.3). Normative copy: shared/spec/physics-profiles.json (written by `cli.ts gen-spec-data`). */
import type { ProfileId } from '../types.gen.ts';
import { canonicalJson } from '../util/canonical.ts';
import { sha256Hex } from '../util/sha256.ts';
import type { PhysicsProfile } from './types.ts';

export const PROFILES: Record<ProfileId, PhysicsProfile> = {
  'v2-standard': {
    id: 'v2-standard', walk_max: 96, run_max: 168, accel_walk: 1000, accel_run: 300, friction: 1400, skid_decel: 2400,
    instant_ground: false, air_accel_frac: 0.65, air_drag: 200, instant_air: false, jump_base: 340, jump_vx_bonus: 0.25,
    g_rise_held: 900, g_apex_held: 450, g_fall: 1700, apex_vy: 40, release_cut: -220, max_fall: 330, max_fall_fast: 450,
    coyote_f: 6, buffer_f: 7, ceiling_nudge_px: 4, ledge_pop_px: 3, step_assist_px: 4,
    envelope: { apex_c: { stand: 3.86, walk: 4.45, run: 4.92 }, dist_c: { walk: 4.9, run: 9.1 }, tap_hop_c: 1.1 },
  },
  'v2-gentle': {
    id: 'v2-gentle', walk_max: 88, run_max: 152, accel_walk: 1100, accel_run: 260, friction: 1600, skid_decel: 2400,
    instant_ground: false, air_accel_frac: 0.85, air_drag: 300, instant_air: false, jump_base: 330, jump_vx_bonus: 0.25,
    g_rise_held: 800, g_apex_held: 400, g_fall: 1300, apex_vy: 40, release_cut: -200, max_fall: 280, max_fall_fast: 400,
    coyote_f: 9, buffer_f: 9, ceiling_nudge_px: 5, ledge_pop_px: 4, step_assist_px: 4,
    envelope: { apex_c: { stand: 4.14, walk: 4.7, run: 5.15 }, dist_c: { walk: 5.0, run: 9.3 }, tap_hop_c: 1.2 },
  },
  'v2-snappy': {
    id: 'v2-snappy', walk_max: 104, run_max: 184, accel_walk: 1100, accel_run: 340, friction: 1400, skid_decel: 2600,
    instant_ground: false, air_accel_frac: 0.6, air_drag: 150, instant_air: false, jump_base: 350, jump_vx_bonus: 0.25,
    g_rise_held: 950, g_apex_held: 475, g_fall: 1900, apex_vy: 40, release_cut: -230, max_fall: 360, max_fall_fast: 480,
    coyote_f: 5, buffer_f: 6, ceiling_nudge_px: 4, ledge_pop_px: 3, step_assist_px: 4,
    envelope: { apex_c: { stand: 3.88, walk: 4.48, run: 4.99 }, dist_c: { walk: 5.1, run: 9.6 }, tap_hop_c: 1.1 },
  },
  'v1-classic': {
    id: 'v1-classic', walk_max: 160, run_max: null, accel_walk: 0, accel_run: 0, friction: 0, skid_decel: 0,
    instant_ground: true, air_accel_frac: 1, air_drag: 0, instant_air: true, jump_base: 330, jump_vx_bonus: 0,
    g_rise_held: 900, g_apex_held: 900, g_fall: 900, apex_vy: 40, release_cut: -120, max_fall: 1200, max_fall_fast: 1200,
    coyote_f: 5, buffer_f: 6, ceiling_nudge_px: 0, ledge_pop_px: 0, step_assist_px: 0,
    envelope: { apex_c: { stand: 3.61, walk: 3.61, run: null }, dist_c: { walk: 7.33, run: null }, tap_hop_c: 0.77 },
  },
};

/** `rules.profile_hash`: sha256 of the profile's canonical JSON. */
export function profileHash(id: ProfileId): string {
  return 'sha256:' + sha256Hex(canonicalJson(PROFILES[id]));
}
