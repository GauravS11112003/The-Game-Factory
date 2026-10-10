/** ArtDoc builder, SVG serializer and rig extraction (lane E, §7). P0 stubs. */
import type { InkStroke, LevelV2, RectCells, Rig, InkDoc, Theme } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';
import type { ArtDoc } from './types.ts';

export function buildArt(level: LevelV2, ink: InkDoc, o: { theme: Theme; seed: number; boilFrame?: 0 | 1 | 2 }): ArtDoc {
  void level;
  void ink;
  void o;
  throw new NotImplemented('buildArt');
}

export function artToSvg(doc: ArtDoc, view: RectCells, o?: { scale?: number }): string {
  void doc;
  void view;
  void o;
  throw new NotImplemented('artToSvg');
}

export function extractRig(strokes: InkStroke[]): Rig {
  void strokes;
  throw new NotImplemented('extractRig');
}
