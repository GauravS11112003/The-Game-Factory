/** InkDoc helpers (lane B, §3.2). P0 stub. */
import type { InkDoc, InkStroke, TypedRule, World } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export function inkFromStrokes(strokes: InkStroke[], world: World, o?: { character?: InkStroke[]; typed_rules?: TypedRule[] }): InkDoc {
  void strokes;
  void world;
  void o;
  throw new NotImplemented('inkFromStrokes');
}
