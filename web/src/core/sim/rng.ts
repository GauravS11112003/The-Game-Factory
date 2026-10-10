/** Seeded xorshift32 (§5.2). The state is a uint32 kept inside the sim snapshot, so replays stay exact. */

export function seedRng(seed: number): number {
  const s = (seed | 0) >>> 0;
  return s === 0 ? 0x9e3779b9 : s;
}

/** Advances the state; returns [nextState, value in [0, 1)]. */
export function nextRng(state: number): [number, number] {
  let x = state >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return [x, x / 4294967296];
}
