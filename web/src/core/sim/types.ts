/** Runtime types of the simulation (lane A). Format types come from types.gen.ts. */
import type { ProfileId } from '../types.gen.ts';

/** A physics profile (§5.3). px, px/s, px/s² and frames; immutable by name (a retune ships as a new name). */
export interface PhysicsProfile {
  id: ProfileId;
  walk_max: number;
  run_max: number | null; // null: no run (v1-classic)
  accel_walk: number;
  accel_run: number;
  friction: number;
  skid_decel: number;
  instant_ground: boolean; // v1-classic: velocity snaps to target
  air_accel_frac: number; // of ground accel
  air_drag: number;
  instant_air: boolean; // v1-classic: full air control
  jump_base: number; // launch vy = −(jump_base + jump_vx_bonus·|vx|)
  jump_vx_bonus: number;
  g_rise_held: number;
  g_apex_held: number;
  g_fall: number;
  apex_vy: number; // |vy| below this counts as the apex while held
  release_cut: number; // vy := max(vy, release_cut) on release
  max_fall: number;
  max_fall_fast: number; // with Down held
  coyote_f: number;
  buffer_f: number;
  ceiling_nudge_px: number;
  ledge_pop_px: number;
  step_assist_px: number;
  envelope: {
    apex_c: { stand: number; walk: number; run: number | null };
    dist_c: { walk: number; run: number | null };
    tap_hop_c: number;
  };
}

/** One sim event; the engine turns these into juice and sound, the bot into metrics. */
export interface SimEvent {
  type:
    | 'jump' | 'double_jump' | 'land' | 'skid' | 'coin' | 'big_coin' | 'big_coin_banked' | 'stomp' | 'hit' | 'death'
    | 'respawn' | 'checkpoint' | 'spring' | 'crumble' | 'door_open' | 'key' | 'win' | 'lose' | 'timer_warn'
    | 'entity_error';
  frame: number;
  id?: string; // entity id
  x?: number; // cells
  y?: number;
  cause?: string;
  chain?: number;
}

export interface PlayerView {
  x: number; // cells, feet centre
  y: number;
  vx: number; // px/s
  vy: number;
  facing: 1 | -1;
  on_ground: boolean;
  state: 'idle' | 'run' | 'skid' | 'jump' | 'fall' | 'dead' | 'respawn' | 'win';
  invulnerable_f: number;
}

export interface EntityView {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  phase?: number;
}

export interface SimView {
  frame: number;
  player: PlayerView;
  entities: EntityView[];
  coins: number;
  big_coins_held: number;
  big_coins_banked: number;
  deaths: number;
  lives: number | null;
  hearts: number;
  checkpoint: string | null;
  timer_frames_left: number | null;
  won: boolean;
}

export interface CameraState {
  x: number; // cells, left edge of the 48-cell view
  look: number; // current look-ahead offset (cells)
  facing: 1 | -1;
  max_x: number; // for camera: no_backscroll
}

/** Opaque, deterministic snapshot of the whole sim state. */
export interface SimSnapshot {
  frame: number;
  data: unknown;
}

export interface Sim {
  readonly frame: number;
  step(input: number /* bits: L R J RUN D */): SimEvent[];
  view(): SimView;
  camera(): CameraState;
  snapshot(): SimSnapshot;
  restore(s: SimSnapshot): void;
  hash(): string;
}
