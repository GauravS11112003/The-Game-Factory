/**
 * Re-simulation of recorded inputs from the level start (§8.4): the one loop that verifyRun and ghost tracks share,
 * so a ghost always shows exactly the run the server verified.
 */
import { SimCore } from '../sim/core.ts';
import { INPUT_MASK } from '../sim/types.ts';
import type { LevelV2 } from '../types.gen.ts';

export interface ReplayRun {
  sim: SimCore;
  /** Sim frame (1-based tick count) at which the goal was touched; 0 when it never was. */
  winFrame: number;
  /** Ticks simulated (≤ inputs.length). */
  ticks: number;
}

/**
 * Plays `input` (one byte per frame) on a fresh Sim of `level`. Stops at the win unless `stopAtWin` is false (after a
 * win the Sim ignores input, so stopping changes no number). `onTick` sees the sim after every frame.
 */
export function simulateInputs(
  level: LevelV2,
  input: ArrayLike<number>,
  o?: { stopAtWin?: boolean; maxTicks?: number; onTick?: (sim: SimCore, f: number) => void },
): ReplayRun {
  const sim = new SimCore(level, { seed: 1 });
  // the camera is presentation only; nothing in a run depends on it
  sim.camOff = true;
  const stop = o?.stopAtWin !== false;
  const n = Math.min(input.length, o?.maxTicks ?? Infinity);
  let winFrame = 0;
  let ticks = 0;
  for (let f = 0; f < n; f++) {
    sim.tick(input[f] & INPUT_MASK);
    ticks++;
    if (o?.onTick) o.onTick(sim, f);
    if (sim.S.won && !winFrame) {
      winFrame = sim.S.f;
      if (stop) break;
    }
  }
  return { sim, winFrame, ticks };
}
