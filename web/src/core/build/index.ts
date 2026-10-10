/** The pure build function and level utilities (lane B, §3.1, §2.5, §2.6). P0: build/migrateV1 stubbed. */
import type { BuildInput, BuildResult } from '../index.ts';
import type { LevelV2 } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export { levelHash } from './hash.ts';
export { validateLevel } from './validate.ts';

export function build(i: BuildInput): BuildResult {
  void i;
  throw new NotImplemented('build');
}

export function migrateV1(v1: unknown): LevelV2 {
  void v1;
  throw new NotImplemented('migrateV1');
}
