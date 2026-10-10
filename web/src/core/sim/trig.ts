/**
 * Deterministic trigonometry for step code (§5.2): a 1024-entry sine table built at module load from a Taylor
 * series using only + − × ÷ (IEEE-754 double arithmetic is exact-reproducible across engines), read with linear
 * interpolation. Angles are in turns (1 turn = 360°). Never use Math.sin/cos in sim/, bot/ or replay/.
 */

export const TRIG_N = 1024;
const PI = 3.141592653589793;

function sinSeries(x: number): number {
  // x in [0, π/2]; 14 terms is far below double precision there.
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let k = 1; k < 14; k++) {
    term = (-term * x2) / (2 * k * (2 * k + 1));
    sum += term;
  }
  return sum;
}

const TABLE: Float64Array = (() => {
  const t = new Float64Array(TRIG_N + 1);
  const q = TRIG_N / 4;
  for (let i = 0; i <= q; i++) t[i] = sinSeries((i / TRIG_N) * 2 * PI);
  for (let i = q + 1; i <= 2 * q; i++) t[i] = t[2 * q - i];
  for (let i = 2 * q + 1; i <= TRIG_N; i++) t[i] = -t[i - 2 * q];
  t[0] = 0;
  t[2 * q] = 0;
  t[TRIG_N] = 0;
  return t;
})();

/** sin of an angle given in turns. */
export function sinT(turns: number): number {
  const u = turns - Math.floor(turns);
  const p = u * TRIG_N;
  const i = Math.floor(p);
  const f = p - i;
  const a = TABLE[i];
  return a + (TABLE[i + 1] - a) * f;
}

/** cos of an angle given in turns. */
export function cosT(turns: number): number {
  return sinT(turns + 0.25);
}

/** Triangle wave in [0, 1] with period 1 (0 at u = 0, 1 at u = 0.5). Used for ping-pong paths. */
export function triT(u: number): number {
  const f = u - Math.floor(u);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}
