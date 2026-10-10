/** InkDoc helpers on the app side: a level's stored `ink` block back into an InkDoc for mountGame and thumbnails. */
import type { InkDoc, LevelV2 } from '../core/types.gen.ts';

export function inkFromLevel(level: LevelV2): InkDoc {
  const ink = level.ink;
  return {
    v: 2, source: level.source.kind, world: { screens: level.world.screens, w: level.world.w, h: 27 },
    strokes: ink?.strokes ?? [], components: ink?.components ?? [], character: ink?.character ?? null,
    typed_rules: ink?.typed_rules ?? [], rules_ink: ink?.rules_ink ?? [],
    sheets: (level.source.sheets ?? []).map((s) => ({ index: s.index, photo_url: s.photo_url ?? null, qr: s.qr ?? null, warnings: [] })),
    noise: ink?.noise ?? { count: 0 }, parent: null,
  };
}

/** A blank InkDoc for a world (when a tier level arrives before the ink event). */
export function emptyInkFor(level: LevelV2): InkDoc {
  return {
    v: 2, source: level.source.kind, world: { screens: level.world.screens, w: level.world.w, h: 27 }, strokes: [], components: [],
    character: null, typed_rules: [], rules_ink: [], sheets: [], noise: { count: 0 }, parent: null,
  };
}
