/** Runtime types of the simulation (lane A). Format types come from types.gen.ts. */
import type { ProfileId, Replay } from '../types.gen.ts';

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

/** Input bits of one sim frame (§5.2). */
export const IN_L = 1;
export const IN_R = 2;
export const IN_J = 4;
export const IN_RUN = 8;
export const IN_D = 16;
/** Restart from the checkpoint (R / Select / HUD): counts as a death with cause 'restart' (docs/v2/requests/E-1.md). */
export const IN_RESTART = 32;
export const INPUT_MASK = 63;

/** One sim event; the engine turns these into juice and sound, the bot into metrics. */
export interface SimEvent {
  type:
    | 'jump' | 'double_jump' | 'land' | 'skid' | 'coin' | 'big_coin' | 'big_coin_banked' | 'stomp' | 'hit' | 'death'
    | 'respawn' | 'checkpoint' | 'spring' | 'crumble' | 'door_open' | 'key' | 'win' | 'lose' | 'timer_warn'
    | 'entity_error' | 'bonk' | 'drop_through' | 'shoot' | 'crusher_land' | 'hop' | 'alert' | 'life' | 'game_over'
    | 'falling' | 'start_clock';
  frame: number;
  id?: string; // entity id
  x?: number; // cells
  y?: number;
  cause?: string; // death/hit cause: spikes | lava | pit | enemy | saw | firebar | blob | crusher | crush | hazard | timer
  chain?: number; // stomp chain length (≥ 1)
  vy?: number; // landing / launch speed, px/s
  n?: number; // coins after a coin event; lives after a life event; seconds left for timer_warn
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
  /** Frames into the death sequence (0 when alive). */
  dead_f?: number;
  /** Hit-stop frames left (the engine freezes animation while > 0). */
  hitstop_f?: number;
  /** Hearts left. */
  hp?: number;
  /** True while Run is held and running is allowed. */
  running?: boolean;
  /** Ground under the feet: 'tile', or a kinematic entity id. */
  ground?: string | null;
}

/**
 * One entity's live state. Coordinates follow the entity's level convention (see sim/world.ts):
 * points (coin, big_coin, key, saw, firebar anchor, hint_arrow, blob) are centres; grounded things (enemy, spring,
 * checkpoint, goal, player_start) are x centre + y feet line; boxes (door, moving_platform, crumble,
 * falling_platform) are top-left; spikes are x0 / y with w = length along the face.
 */
export interface EntityView {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  phase?: number; // 0..1 of the entity's cycle when it has one; firebar: the current angle in degrees
  /** Archetype for enemies, facing for spikes. */
  kind?: string;
  /** Animation state: walk | crouch | air | inflate | alert | chase | patrol | warn | drop | rest | rise | squash | shake | fall | gone | idle | open | closed | armed | fired. */
  state?: string;
  facing?: 1 | -1;
  vx?: number; // px/s
  vy?: number;
  r?: number; // cells (saw, firebar balls, blob)
  angle?: number; // turns (firebar)
  balls?: [number, number][]; // firebar ball centres, cells
  /** Frames since the state began. */
  t?: number;
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
  /** Speedrun clock: frames from the first input to the goal (pause excluded, deaths included). */
  clock_frames?: number;
  time_ms?: number;
  big_coins_total?: number;
  keys?: string[];
}

export interface CameraState {
  x: number; // cells, left edge of the 48-cell view
  look: number; // current look-ahead offset (cells)
  facing: 1 | -1;
  max_x: number; // for camera: no_backscroll
  /** 'follow' (default) or 'no_backscroll' (SMB mode: never scrolls left past max_x). */
  mode?: 'follow' | 'no_backscroll';
  /** Walk speed of the level's profile (px/s), for the look-ahead threshold; 96 when absent. */
  walk_px_s?: number;
}

/** Opaque, deterministic snapshot of the whole sim state. */
export interface SimSnapshot {
  frame: number;
  data: unknown;
}

export interface Sim {
  readonly frame: number;
  step(input: number /* bits: L R J RUN D (+ RESTART 32) */): SimEvent[];
  view(): SimView;
  camera(): CameraState;
  snapshot(): SimSnapshot;
  restore(s: SimSnapshot): void;
  hash(): string;
  /**
   * Replay recording hooks (createSim(level, { record: true }), §8.4). The Sim records the byte each step() consumed;
   * restore() to an earlier snapshot truncates the recording, so a rewind never leaves inputs the state did not see.
   */
  inputs?(): Uint8Array;
  recordingValid?(): boolean;
  replay?(coreVersion?: string): Replay | null;
}
