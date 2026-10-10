/** Replays and run verification (lane A). P0: codec real, verifyRun stubbed. */
import type { LevelV2, Replay, RunVerdict } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export { decodeReplay, encodeReplay } from './codec.ts';

export function verifyRun(level: LevelV2, r: Replay): RunVerdict {
  void level;
  void r;
  throw new NotImplemented('verifyRun');
}
