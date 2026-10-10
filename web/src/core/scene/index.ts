/** Perception: grouping, grammar, merge, rules parser, remix diff, symbol match (lane B, §3.3, §6.5, §8.1). */
import type { InkDoc, LevelV2 } from '../types.gen.ts';
import { ensureComponents } from '../ink/index.ts';
import { perceiveHeuristic } from './perceive.ts';
import { matchToParent, withParentInk } from './remix.ts';

export { perceiveHeuristic } from './perceive.ts';
export { mergePerception, heuristicAsks } from './merge.ts';
export { parseRules } from './rules_parser.ts';
export { matchSymbol } from './symbol.ts';
export { applyRemixIds, withParentInk } from './remix.ts';

/**
 * §6.5 remix diff: new ink objects matched to the parent's objects by role and overlap (IoU ≥ 0.3, or centre within
 * 1 cell; the parent's own strokes match exactly). `matched` maps component ids to parent object ids; `added` lists
 * the components that are the kid's new objects. A paper remix scan is diffed with the parent's ink merged in, as the
 * build sees it.
 */
export function remixDiff(parent: LevelV2, inkIn: InkDoc): { matched: Record<number, string>; added: number[] } {
  const ink = ensureComponents(withParentInk(inkIn, parent));
  const g = perceiveHeuristic(ink, { library: [], parent: null });
  const m = matchToParent(parent, ink, g.objects);
  const matched: Record<number, string> = {};
  const added: number[] = [];
  for (const c of [...ink.components].sort((a, b) => a.id - b.id)) {
    const p = m.get(c.id);
    if (p) matched[c.id] = p;
    else added.push(c.id);
  }
  return { matched, added };
}
