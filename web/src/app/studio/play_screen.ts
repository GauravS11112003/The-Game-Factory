/** #/g/:id — play a Studio game full screen (docs/v6/CONTRACTS_V6.md §6). Skeleton until lane E lands it. */
import { card, h } from '../dom.ts';

export function studioPlayScreen(root: HTMLElement, gameId: string, _query: URLSearchParams): () => void {
  root.append(card(null, h('h2', null, 'Play'), h('p', { class: 'muted' }, gameId)));
  return () => {};
}
