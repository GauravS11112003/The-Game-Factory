/**
 * Stroke grouping (docs/v6/CONTRACTS_V6.md §6): strokes drawn close together in time and space join one pending
 * object; a pause, a tool switch or Enter finishes it. Pure, so the rule is testable.
 */
import { boxesTouch, expandBox, type Box } from '../model/doc.ts';

export const GROUP_GAP_PX = 32;
export const GROUP_GAP_MS = 1500;

export interface PendingGroup { id: string; box: Box; lastAt: number }

/** Does a stroke (world box, finished at `at` ms) join the pending group? */
export function joinsGroup(g: PendingGroup | null, strokeBox: Box, at: number, gapPx = GROUP_GAP_PX, gapMs = GROUP_GAP_MS): boolean {
  if (!g) return false;
  if (at - g.lastAt > gapMs) return false;
  return boxesTouch(expandBox(g.box, gapPx), strokeBox);
}
