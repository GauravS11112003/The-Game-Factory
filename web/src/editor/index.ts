/** The long-canvas vector editor (lane F, §6.3). P0: the tool palette contract only. */
import { CANVAS } from '../core/params.ts';

export const MARKER_COLORS = ['black', 'red', 'green', 'blue'] as const;
export const STAMPS = ['coin', 'big_coin', 'spikes', 'flag', 'checkpoint', 'spring', 'saw', 'walker', 'hopper', 'flyer', 'key', 'door', 'start'] as const;

/** A press with < 4 px of movement and < 250 ms is a tap: a 14 px dot (§3.2, §6.3). */
export function isTap(movePx: number, ms: number): boolean {
  return movePx < CANVAS.tap_max_move_px && ms < CANVAS.tap_max_ms;
}
