/** The playtest bot (lane A, §4.1-4.3). P0 stub. */
import type { LevelV2, PlaytestReport } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export interface AnalyzeOptions {
  mode: 'fast' | 'full';
  profile?: 'casual' | 'skilled';
  segments?: string[];
  legacy_measure?: boolean;
}

export function analyze(level: LevelV2, o: AnalyzeOptions): PlaytestReport {
  void level;
  void o;
  throw new NotImplemented('analyze');
}
