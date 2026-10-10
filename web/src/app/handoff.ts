/**
 * In-memory hand-off from the editor to the preview: the browser core's local Ink build of the drawing just submitted,
 * shown on the stage at once while the server stream starts (D15: canvas Ink build ≤ 0.6 s in the browser core).
 */
import type { InkDoc, LevelV2 } from '../core/types.gen.ts';

let pending: { draftId: string; level: LevelV2; ink: InkDoc } | null = null;

export function setHandoff(draftId: string, level: LevelV2, ink: InkDoc): void {
  pending = { draftId, level, ink };
}

export function takeHandoff(draftId: string): { level: LevelV2; ink: InkDoc } | null {
  if (!pending || pending.draftId !== draftId) return null;
  const p = pending;
  pending = null;
  return { level: p.level, ink: p.ink };
}
