/** Difficulty model helpers (lane A, §4.4-4.5). Closed-form pieces only; the metrics come from the bot. */
import { DIFFICULTY } from '../params.ts';
import type { Band } from '../types.gen.ts';

export function bandOf(C: number): Band {
  for (const b of DIFFICULTY.bands) if (b.C_max !== null && C < b.C_max) return b.band;
  return 'expert';
}

/** 0-100 badge: round(100 · (1 − e^(−C))). */
export function scoreOf(C: number): number {
  return Math.round(100 * (1 - Math.exp(-C)));
}

/** par_ms = ceil_to_500ms(1.3 × fastest_ms). */
export function parMs(fastestMs: number): number {
  const step = DIFFICULTY.par.round_ms;
  return Math.ceil((DIFFICULTY.par.factor * fastestMs) / step) * step;
}
