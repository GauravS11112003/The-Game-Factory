/**
 * The deterministic fixed-step Sim and the camera (lane A, §5.2, §6.2).
 *
 * createSim(level) returns a Sim that the engine steps at 60 Hz with a 5-bit input (L=1 R=2 J=4 RUN=8 D=16) and
 * renders through view() / camera(); the bot and verifyRun drive the same class.
 */
import type { CellXY, LevelV2 } from '../types.gen.ts';
import { SimCore } from './core.ts';
import type { Sim } from './types.ts';

export { cameraStep, inView } from './camera.ts';
export { SimCore, clockMs } from './core.ts';
export { INPUT_MASK, IN_D, IN_J, IN_L, IN_R, IN_RESTART, IN_RUN } from './types.ts';

/**
 * `record: true` turns on the replay recording hook: sim.inputs() / sim.replay() give the run so far (ghosts, run
 * submission, "beat my level"); restore() to an earlier snapshot truncates it.
 */
export function createSim(level: LevelV2, o?: { startAt?: CellXY; seed?: number; record?: boolean }): Sim {
  const start = o && Array.isArray(o.startAt) && o.startAt.length === 2 ? ([o.startAt[0], o.startAt[1]] as [number, number]) : undefined;
  return new SimCore(level, { startAt: start, seed: typeof o?.seed === 'number' ? o.seed : 1, record: !!o?.record });
}
