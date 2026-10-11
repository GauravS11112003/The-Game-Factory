/**
 * #/games — My games (docs/v4/CONTRACTS_V4.md §7): every game the player makes or helps with, filtered by role,
 * newest first, plus unpublished drafts. Same data as the workspace home (loadWorkspace), without the cap. v6: Studio
 * games first (docs/v6/CONTRACTS_V6.md §9), older tile games under them.
 */
import { timeAgo } from '../collab/ui.ts';
import { h, icon } from '../dom.ts';
import { currentPlayer, ensurePlayer, onPlayerChange } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import type { Shell } from '../shell.ts';
import { gameCardEl, loadWorkspace, type WsData } from './workspace.ts';
import { studioCardEl, studioGames } from '../studio_cards.ts';
import type { StudioGameCard } from '../../core/types.gen.ts';

type Filter = 'all' | 'mine' | 'helping';
let lastFilter: Filter = 'all';

export function gamesScreen(root: HTMLElement, shell: Shell): () => void {
  let disposed = false;
  let data: WsData | null = null;
  let studio: StudioGameCard[] = [];
  const studioGrid = h('div', { class: 'ws-games' });
  const olderHead = h('h2', { class: 'ws-h2 hidden' }, t('ws.older_games'));
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const grid = h('div', { class: 'ws-games' }, h('p', { class: 'muted' }, t('ws.loading')));
  const drafts = h('section', { class: 'ws-drafts hidden', 'aria-label': t('ws.drafts') });

  root.append(h('div', { class: 'ws-page' },
    h('div', { class: 'ws-sec-head' },
      h('div', null, h('h1', { class: 'ws-hello' }, t('ws.games_title')), h('p', { class: 'muted' }, t('ws.games_sub'))),
      h('a', { class: 'pill primary', href: '#/new' }, icon('plus'), t('nav.new_game'))),
    studioGrid, olderHead, tabs, grid, drafts));

  function render(): void {
    tabs.replaceChildren(...(['all', 'mine', 'helping'] as Filter[]).map((f) => h('button', {
      type: 'button', role: 'tab', class: `tab${f === lastFilter ? ' on' : ''}`, 'aria-selected': String(f === lastFilter),
      onclick: () => { lastFilter = f; render(); },
    }, t(`ws.filter_${f}`))));
    if (!data) return;
    const games = data.games.filter((g) => lastFilter === 'all' || (lastFilter === 'mine' ? g.role === 'owner' : g.role !== 'owner'));
    if (!currentPlayer()) {
      grid.replaceChildren(h('div', { class: 'ws-empty' }, h('p', null, t('ws.summary_new')),
        h('button', { type: 'button', class: 'pill primary small', onclick: () => void ensurePlayer().catch(() => null) }, icon('person'), t('ws.who_cta'))));
    } else {
      studioGrid.replaceChildren(...(studio.length ? studio.map((g) => studioCardEl(g))
        : [h('div', { class: 'ws-empty' }, h('p', null, t('ws.no_games')), h('a', { class: 'pill primary small', href: '#/new?blank=1' }, icon('plus'), t('nav.new_game')))]));
      grid.replaceChildren(...games.map(gameCardEl));
    }
    const older = data.games.length > 0;
    olderHead.classList.toggle('hidden', !older);
    tabs.classList.toggle('hidden', !older);
    drafts.classList.toggle('hidden', !data.drafts.length);
    drafts.replaceChildren(h('h2', { class: 'ws-h2' }, t('ws.drafts')),
      h('div', { class: 'ws-draft-list' }, ...data.drafts.map((x) => h('a', { class: 'ws-draft', href: `#/preview/${encodeURIComponent(x.draft_id)}` },
        icon('pencil'), h('span', null, kidText(x.title || t('ws.draft_untitled'))), h('span', { class: 'small muted' }, timeAgo(x.updated_at))))));
  }

  async function load(): Promise<void> {
    render();
    const [d, s] = await Promise.all([loadWorkspace({ maxGames: 60 }), studioGames('mine')]);
    if (disposed) return;
    data = d;
    studio = s;
    shell.rememberTitles(s.map((g) => ({ id: g.id, title: g.title })));
    shell.rememberTitles(d.games.map((g) => ({ id: g.id, title: g.title })));
    render();
  }

  void load();
  const off = onPlayerChange(() => void load());
  return () => {
    disposed = true;
    off();
  };
}
