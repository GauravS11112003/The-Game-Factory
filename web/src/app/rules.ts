/** The default game rules (§8.2) used until a game's own rules are loaded. */
import type { GameRules } from '../core/types.gen.ts';

export const DEFAULT_RULES: GameRules = {
  version: 1, physics_profile: 'v2-standard', abilities: { run: true, stomp: true, double_jump: false, fast_fall: true },
  lives: 'off', hearts: 1, theme: 'sketchbook', music: true, timer_pressure: false, camera: 'follow', default_dial: 'polished',
  default_band: 'normal', player_type: null,
};
