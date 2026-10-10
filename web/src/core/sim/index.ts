/** The deterministic fixed-step Sim and the camera (lane A, §5.2, §6.2). P0 stubs. */
import type { CellXY, LevelV2, World } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';
import type { CameraState, Sim, SimView } from './types.ts';

export function createSim(level: LevelV2, o?: { startAt?: CellXY; seed?: number }): Sim {
  void level;
  void o;
  throw new NotImplemented('createSim');
}

export function cameraStep(c: CameraState, v: SimView, world: World): CameraState {
  void c;
  void v;
  void world;
  throw new NotImplemented('cameraStep');
}
