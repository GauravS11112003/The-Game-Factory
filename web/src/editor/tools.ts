/** The editor's tool palette contract (§6.3). */
import { CANVAS } from '../core/params.ts';
import { STAMP_KINDS } from './stamps.ts';

/** The four marker colours, each with its meaning icon: ground, spikes, goal, coin. */
export const MARKER_COLORS = ['black', 'red', 'green', 'blue'] as const;
export const STAMPS = STAMP_KINDS;

/** A press with < 4 px of movement and < 250 ms is a tap: a 14 px dot (§3.2, §6.3). */
export function isTap(movePx: number, ms: number): boolean {
  return movePx < CANVAS.tap_max_move_px && ms < CANVAS.tap_max_ms;
}
