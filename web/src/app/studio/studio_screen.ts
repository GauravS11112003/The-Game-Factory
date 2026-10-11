/** #/studio/:id — the Studio (docs/v6/CONTRACTS_V6.md §6). Skeleton until lane E lands the editor. */
import { card, h } from '../dom.ts';

export function studioScreen(root: HTMLElement, gameId: string, _query: URLSearchParams): () => void {
  root.append(card(null, h('h2', null, 'Studio'), h('p', { class: 'muted' }, gameId)));
  return () => {};
}
