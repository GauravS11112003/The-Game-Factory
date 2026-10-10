/** Replays, run verification, ghosts and recording (lane A, §8.4). */
export { decodeReplay, encodeReplay } from './codec.ts';
export {
  MAX_RUN_FRAMES, checkClaim, inputsToTrace, makeReplay, replayMatchesLevel, stampsOf, traceToInputs, verifyRun, verifyRunDetail,
} from './verify.ts';
export type { VerifyDetail, VerifyReason } from './verify.ts';
export { simulateInputs } from './run.ts';
export type { ReplayRun } from './run.ts';
export { GhostTrack, ghostTrack } from './ghost.ts';
export type { GhostEvent, GhostPose } from './ghost.ts';
export { ReplayRecorder, replayOfTrace } from './record.ts';
