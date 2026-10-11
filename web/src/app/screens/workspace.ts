/**
 * #/ — the workspace home (docs/v4/CONTRACTS_V4.md §7): a greeting, ways to start (draw, scan, describe, template)
 * with a "start as" mode, your games with their status (beatable, things to fix, draft), and a rail with the inbox,
 * the blocks you made and a live jam. GET /dashboard feeds it when lane C's endpoint answers; until then the same view
 * is built from collab /players/me, /games/:id, /notifications and /jams. The old feed lives on at #/explore.
 */
import { api, type GameCard, type LevelCard } from '../api.ts';
import { collab, type FeedItem, type Jam, type Role } from '../collab/api.ts';
import { feedRow, timeAgo } from '../collab/ui.ts';
import { h, icon } from '../dom.ts';
import { currentPlayer, ensurePlayer, onPlayerChange } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import type { Shell } from '../shell.ts';
import { levelThumb } from '../thumbs.ts';
import { v4 } from '../v4api.ts';
import type { BlockCard, Dashboard, GameMode } from '../../core/types.gen.ts';

export const MODES: GameMode[] = ['platformer', 'topdown', 'runner', 'flappy'];

/** One game as the workspace shows it, whichever source it came from. */
export interface WsGame {
  id: string;
  title: string;
  role: Role | null;
  mode: GameMode;
  levels: LevelCard[];
  levelCount: number;
  beatable: number;
  toFix: number;
  unchecked: number;
  pendingReviews: number;
  updatedAt: string | null;
}

export interface WsData {
  games: WsGame[];
  drafts: Dashboard['drafts'];
  blocks: BlockCard[];
  inbox: FeedItem[];
  jam: Jam | null;
}

function flagsToFix(l: LevelCard): number {
  return (l.level?.design?.flags ?? []).filter((f) => f.severity === 'hard' || f.severity === 'block').length; // warn = notes, not fixes
}

function fromGameCard(g: GameCard, role: Role | null, extra: Partial<WsGame> = {}): WsGame {
  const levels = g.levels ?? [];
  return {
    id: g.id, title: g.title, role, mode: g.rules?.mode ?? 'platformer', levels, levelCount: levels.length,
    beatable: levels.filter((l) => l.level?.design?.solvable).length,
    toFix: levels.reduce((n, l) => n + flagsToFix(l), 0),
    unchecked: levels.filter((l) => l.safety === 'unchecked').length,
    pendingReviews: 0, updatedAt: g.created_at, ...extra,
  };
}

/** Everything the home and My games show. Never throws: missing pieces come back empty. */
export async function loadWorkspace(o: { maxGames?: number } = {}): Promise<WsData> {
  const max = o.maxGames ?? 12;
  const me = currentPlayer();
  const [dash, page, notes, jams] = await Promise.all([
    me ? v4.dashboard().catch(() => null) : Promise.resolve(null),
    me ? collab.me().catch(() => null) : Promise.resolve(null),
    me ? collab.notifications().catch(() => null) : Promise.resolve(null),
    collab.jams().catch(() => [] as Jam[]),
  ]);
  const owned: { id: string; title: string; role: Role | null }[] = dash
    ? dash.games.map((g) => ({ id: g.game_id, title: g.title, role: g.role }))
    : (page?.games ?? []).map((g) => ({ id: g.game_id, title: g.title, role: g.role }));
  const cards = await Promise.all(owned.slice(0, max).map((g) => api.game(g.id).catch(() => null)));
  const games: WsGame[] = [];
  owned.slice(0, max).forEach((o2, i) => {
    const g = cards[i];
    const d = dash?.games.find((x) => x.game_id === o2.id);
    const extra: Partial<WsGame> = d
      ? { mode: d.mode, levelCount: d.level_count, beatable: d.beatable, toFix: d.to_fix, pendingReviews: d.pending_reviews, updatedAt: d.updated_at }
      : {};
    if (g) games.push(fromGameCard(g, o2.role, extra));
    else games.push({ id: o2.id, title: o2.title, role: o2.role, mode: 'platformer', levels: [], levelCount: 0, beatable: 0, toFix: 0, unchecked: 0, pendingReviews: 0, updatedAt: null, ...extra });
  });
  // without the dashboard, count waiting reviews for the games this player keeps
  if (!dash) {
    const keeps = games.filter((g) => g.role === 'owner' || g.role === 'maintainer');
    const subs = await Promise.all(keeps.map((g) => collab.submissions(g.id, 'pending').catch(() => [])));
    keeps.forEach((g, i) => { g.pendingReviews = subs[i].length; });
  }
  games.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return {
    games,
    drafts: dash?.drafts ?? [],
    blocks: dash?.blocks ?? [],
    inbox: notes?.items ?? [],
    jam: jams.find((j) => j.status === 'live') ?? null,
  };
}

/** The status chip of a game: what to look at first. */
export function statusChip(g: WsGame): HTMLElement {
  if (!g.levelCount) return h('span', { class: 'ws-chip draft' }, t('ws.status_empty'));
  if (g.toFix > 0) return h('span', { class: 'ws-chip fix' }, t('ws.status_fix', { n: g.toFix }));
  if (g.beatable >= g.levelCount) return h('span', { class: 'ws-chip beat' }, t('ws.status_beatable'));
  return h('span', { class: 'ws-chip unchecked' }, t('ws.status_unchecked'));
}

function sketchThumb(): HTMLElement {
  return h('div', { class: 'ws-thumb ws-thumb-empty', 'aria-hidden': 'true' }, icon('pencil'));
}

export function gameCardEl(g: WsGame): HTMLElement {
  const first = g.levels[0];
  const meta = [t(`mode.${g.mode}`), g.levelCount === 1 ? t('ws.levels_one') : t('ws.levels_n', { n: g.levelCount })];
  return h('a', { class: 'ws-game', href: `#/game/${encodeURIComponent(g.id)}` },
    first ? h('div', { class: 'ws-thumb' }, levelThumb(first)) : sketchThumb(),
    h('div', { class: 'ws-game-body' },
      h('div', { class: 'ws-game-head' }, h('span', { class: 'ws-game-title' }, kidText(g.title || t('ui.untitled'))), statusChip(g)),
      h('span', { class: 'ws-game-meta' }, meta.join(' · ')),
      h('span', { class: 'ws-game-foot' },
        g.updatedAt ? t('ws.edited', { when: timeAgo(g.updatedAt) }) : '',
        g.pendingReviews ? h('span', { class: 'ws-chip pub' }, t('ws.reviews_waiting', { n: g.pendingReviews, game: kidText(g.title) })) : '')));
}

function greeting(): string {
  const p = currentPlayer();
  if (!p) return t('ws.greet_new');
  const hr = new Date().getHours();
  return t(hr < 12 ? 'ws.greet_morning' : hr < 18 ? 'ws.greet_afternoon' : 'ws.greet_evening', { name: p.name });
}

function startTiles(): HTMLElement {
  const tile = (href: string, ico: string, title: string, sub: string, primary = false): HTMLElement =>
    h('a', { class: `ws-tile${primary ? ' primary' : ''}`, href }, icon(ico), h('span', { class: 'ws-tile-title' }, t(title)), h('span', { class: 'ws-tile-sub' }, t(sub)));
  return h('div', { class: 'ws-tiles' },
    tile('#/draw?new=1', 'marker', 'ws.start_draw', 'ws.start_draw_sub', true),
    tile('#/scan', 'camera', 'ws.start_scan', 'ws.start_scan_sub'),
    tile('#/prompt', 'pencil', 'ws.start_describe', 'ws.start_describe_sub'),
    tile('#/templates', 'snap', 'ws.start_template', 'ws.start_template_sub'));
}

function modeChips(): HTMLElement {
  return h('div', { class: 'ws-modes' }, h('span', { class: 'muted' }, t('ws.start_as')),
    ...MODES.map((m) => h('a', { class: 'ws-mode-chip', href: `#/new?mode=${m}` }, t(`mode.${m}`))));
}

function blockRow(b: BlockCard): HTMLElement {
  return h('a', { class: 'ws-block-row', href: `#/blocks/${encodeURIComponent(b.id)}` },
    h('span', { class: 'ws-block-ico', 'aria-hidden': 'true' }, b.name.slice(0, 1).toUpperCase()),
    h('span', { class: 'ws-block-text' }, h('span', { class: 'ws-block-name' }, kidText(b.name)), h('span', { class: 'small muted' }, t('ws.block_uses', { n: b.uses }))));
}

export function workspaceScreen(root: HTMLElement, shell: Shell): () => void {
  let disposed = false;
  const hello = h('h1', { class: 'ws-hello' }, h('span', { class: 'marker-underline' }, greeting()));
  const summary = h('p', { class: 'muted ws-summary' }, t('ws.loading'));
  const who = h('button', { type: 'button', class: 'pill small hidden', onclick: () => void ensurePlayer().catch(() => null) }, icon('person'), t('ws.who_cta'));
  const gamesGrid = h('div', { class: 'ws-games' });
  const draftsBox = h('section', { class: 'ws-drafts hidden', 'aria-label': t('ws.drafts') });
  const inbox = h('div', { class: 'ws-inbox' });
  const blocks = h('div', { class: 'ws-blocks' });
  const jamBox = h('div');

  root.append(h('div', { class: 'ws-page' },
    h('div', { class: 'ws-hello-wrap' }, hello, h('div', { class: 'row wrap' }, summary, who)),
    h('section', { class: 'ws-start', 'aria-labelledby': 'ws-start-h' }, h('h2', { id: 'ws-start-h', class: 'ws-h2' }, t('ws.start')), startTiles(), modeChips()),
    h('div', { class: 'ws-cols' },
      h('section', { class: 'ws-main', 'aria-labelledby': 'ws-games-h' },
        h('div', { class: 'ws-sec-head' }, h('h2', { id: 'ws-games-h', class: 'ws-h2' }, t('ws.your_games')), h('a', { class: 'small', href: '#/games' }, t('ws.see_all'))),
        gamesGrid, draftsBox),
      h('aside', { class: 'ws-rail' },
        h('section', { class: 'ws-panel', 'aria-labelledby': 'ws-inbox-h' }, h('h2', { id: 'ws-inbox-h', class: 'ws-h3' }, t('ws.inbox')), inbox),
        h('section', { class: 'ws-panel', 'aria-labelledby': 'ws-blocks-h' },
          h('div', { class: 'ws-sec-head' }, h('h2', { id: 'ws-blocks-h', class: 'ws-h3' }, t('ws.your_blocks')), h('a', { class: 'small', href: '#/blocks/new' }, t('ws.make_block'))),
          blocks),
        jamBox))));

  async function load(): Promise<void> {
    gamesGrid.replaceChildren(h('p', { class: 'muted' }, t('ws.loading')));
    const d = await loadWorkspace({ maxGames: 8 });
    if (disposed) return;
    shell.rememberTitles(d.games.map((g) => ({ id: g.id, title: g.title })));
    hello.replaceChildren(h('span', { class: 'marker-underline' }, greeting()));
    const me = currentPlayer();
    who.classList.toggle('hidden', !!me);
    const levels = d.games.reduce((n, g) => n + g.levelCount, 0);
    const reviews = d.games.reduce((n, g) => n + g.pendingReviews, 0);
    summary.textContent = me ? t('ws.summary', { games: d.games.length, levels, reviews }) : t('ws.summary_new');

    gamesGrid.replaceChildren(...(d.games.length
      ? d.games.slice(0, 8).map(gameCardEl)
      : [h('div', { class: 'ws-empty' }, h('p', null, t('ws.no_games')), h('a', { class: 'pill primary small', href: '#/new' }, icon('plus'), t('nav.new_game')))]));

    draftsBox.classList.toggle('hidden', !d.drafts.length);
    draftsBox.replaceChildren(h('h3', { class: 'ws-h3' }, t('ws.drafts')),
      h('div', { class: 'ws-draft-list' }, ...d.drafts.slice(0, 6).map((x) => h('a', { class: 'ws-draft', href: `#/preview/${encodeURIComponent(x.draft_id)}` },
        icon('pencil'), h('span', null, kidText(x.title || t('ws.draft_untitled'))), h('span', { class: 'small muted' }, timeAgo(x.updated_at))))));

    inbox.replaceChildren(...(d.inbox.length ? d.inbox.slice(0, 5).map((it) => feedRow(it)) : [h('p', { class: 'small muted' }, t('ws.inbox_empty'))]));
    const reviewRows = d.games.filter((g) => g.pendingReviews > 0).map((g) =>
      h('a', { class: 'ws-review-row', href: `#/game/${encodeURIComponent(g.id)}?tab=review` },
        h('span', null, t('ws.reviews_waiting', { n: g.pendingReviews, game: kidText(g.title) })), h('span', { class: 'pill small primary' }, t('ws.review'))));
    if (reviewRows.length) inbox.prepend(...reviewRows);

    blocks.replaceChildren(...(d.blocks.length ? d.blocks.slice(0, 4).map(blockRow) : [h('p', { class: 'small muted' }, t('ws.blocks_empty'))]));

    jamBox.replaceChildren(d.jam ? h('a', { class: 'ws-jam', href: '#/jams' },
      h('span', { class: 'ws-jam-title' }, t('ws.jam_live', { title: kidText(d.jam.title) })),
      d.jam.theme ? h('span', { class: 'small' }, t('ws.jam_theme', { theme: kidText(d.jam.theme) })) : '') : '');
  }

  void load();
  const off = onPlayerChange(() => void load());
  return () => {
    disposed = true;
    off();
  };
}
