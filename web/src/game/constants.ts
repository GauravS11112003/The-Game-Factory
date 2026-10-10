/**
 * Physics and grid constants (PLAN.md section 2). Shared by the engine and the solver.
 * Never change these after hour 1: the fixture levels and the solver depend on them.
 *
 * Derived: max jump height ~60 px (3.8 cells) clears a 3-cell wall, not 4;
 * flat jump distance ~117 px (7.3 cells) clears a 6-cell gap, not 7;
 * a bounce pad sends the player ~12 cells up.
 */
export const GRID_W = 48;
export const GRID_H = 27;
export const CELL = 16;
export const GAME_W = 768;
export const GAME_H = 432;

export const PLAYER_W = 12;
export const PLAYER_H = 28;

/** px/s^2 */
export const GRAVITY = 900;
/** px/s */
export const RUN_SPEED = 160;
/** px/s, applied on jump */
export const JUMP_VY = -330;
/** px/s, vy is clamped to this when the jump button is released early */
export const JUMP_CUT_VY = -120;
export const COYOTE_MS = 80;
export const BUFFER_MS = 100;
/** px/s, bounce pad launch at strength 1.0 */
export const BOUNCE_VY = -600;

/** cells/s */
export const DEFAULT_MOVE_SPEED = 2;
/** cells/s */
export const DEFAULT_PATROL_SPEED = 3;
