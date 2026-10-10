/**
 * #/profile/:id and #/me — a player's page (v3 lane 5): their drawn face and name, badges as big friendly icons (the
 * ones still to earn are shown faded with how to get them), stats, their levels with play counts, and on #/me the
 * levels you sent to other games with their review status, the games you're on, "Change my name or face"
 * (PUT /players/me), plus your secret player code for another device.
 */
import { card, h, icon, toast } from '../dom.ts';
import { currentPlayer, editPlayer, ensurePlayer, forgetPlayer, secretCode, updatePlayer, type Player } from '../identity.ts';
import { hasMessage, kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { levelCardEl } from './home.ts';
import { collab, type PlayerGame, type PlayerPage, type Submission, type SubStatus } from '../collab/api.ts';
import { mySubmissions, type LocalSubmission } from '../collab/contribute.ts';
import { avatar, BADGES, badgeEl, errText, note, roleChip, timeAgo } from '../collab/ui.ts';

const enc = encodeURIComponent;
/** The stats shown, in this order (the server's /players stats keys). */
const STAT_EMOJI: Record<string, string> = {
  levels_published: '🗺️', plays: '▶️', clears: '🏁', accepted: '🎉', submitted: '📬', pending: '⏳', creatures: '🐾', art: '🎨',
  quests_done: '🏆', reviews: '🤝', games: '🎮', levels: '🗺️',
};
const STATUS_EMOJI: Record<SubStatus, string> = { pending: '⏳', accepted: '🎉', changes: '✏️', declined: '🙈' };

interface SubRow {
  id: string;
  status: SubStatus | null;
  game_id: string | null;
  game_title: string;
  level_id: string;
  title: string;
  note: string | null;
  created_at: string | null;
}

export function profileScreen(root: HTMLElement, id: string | null): () => void {
  let disposed = false;
  const body = h('div', { class: 'collab-screen profile-screen' }, card(null, note(t('ui.loading'))));
  root.append(body);
  const me = currentPlayer();
  const isMe = id === null || (!!me && me.id === id);
  if (id === null && !me) {
    body.replaceChildren(card('narrow collab-head',
      h('div', { class: 'collab-big-emoji', 'aria-hidden': 'true' }, '👋'),
      h('h1', { class: 'marker-underline' }, t('collab.who.title')),
      h('p', null, t('collab.who.help')),
      h('button', { type: 'button', class: 'pill primary big', onclick: () => void ensurePlayer().then(() => navigate('#/me'), () => undefined) }, t('collab.who.make'))));
    return () => undefined;
  }
  const pid = id ?? me!.id;
  void (async () => {
    let page: PlayerPage;
    try {
      if (isMe) {
        const [mine, pub] = await Promise.all([collab.me(), collab.player(pid).catch(() => null)]);
        // /players/me has my unlisted levels too (with their review status)
        page = { ...mine, levels: mine.levels.length ? mine.levels : pub?.levels ?? [], submissions: mine.submissions.length ? mine.submissions : pub?.submissions ?? [],
          games: mine.games.length ? mine.games : pub?.games ?? [] };
        if (mine.player.id === pid) updatePlayer({ name: mine.player.name, avatar_url: mine.player.avatar_url });
      } else page = await collab.player(pid);
    } catch (e) {
      if (disposed) return;
      // the server can't say yet: still show who you are on this device
      if (isMe && me) page = { player: me, games: [], badges: [], stats: {}, levels: [], submissions: [] };
      else {
        body.replaceChildren(card(null, note(errText(e, 'error.not_found'))));
        return;
      }
    }
    if (disposed) return;
    const player: Player = page.player.id ? page.player : me ?? page.player;
    body.replaceChildren(head(player, page, isMe), badgesCard(page.badges), gamesCard(page.games, isMe), levelsCard(page, isMe));
    if (isMe) body.append(subsCard(page.submissions, () => disposed), codeCard());
  })();
  return () => {
    disposed = true;
  };
}

function head(p: Player, page: PlayerPage, isMe: boolean): HTMLElement {
  const order = Object.keys(STAT_EMOJI);
  const stats = Object.entries(page.stats).filter(([k]) => hasMessage(`collab.stat.${k}`) && k in STAT_EMOJI)
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return card('collab-head collab-profile-head',
    h('div', { class: 'row wrap' },
      avatar(p, 110),
      h('div', null,
        h('h1', { class: 'marker-underline' }, kidText(p.name || t('ui.someone'))),
        isMe ? h('p', { class: 'muted row wrap' }, t('collab.profile.thats_you'),
          h('button', {
            type: 'button', class: 'pill small',
            onclick: () => void editPlayer().then((x) => x && navigate('#/me')),
          }, icon('pencil'), t('collab.profile.edit'))) : '',
        h('div', { class: 'collab-stats' }, ...(stats.length ? stats : [['levels', page.levels.length] as [string, number]]).map(([k, v]) =>
          h('div', { class: 'collab-stat' }, h('span', { class: 'collab-stat-n' }, STAT_EMOJI[k] ?? '⭐', ' ', String(v)), h('span', { class: 'small muted' }, t(`collab.stat.${k}`))))))));
}

function gamesCard(games: PlayerGame[], isMe: boolean): HTMLElement | '' {
  if (!games.length) return '';
  return card(null, h('h2', null, '🎮 ', t(isMe ? 'collab.profile.my_games' : 'collab.profile.games')),
    h('div', { class: 'row wrap' }, ...games.map((g) => h('a', { class: 'pill', href: `#/game/${enc(g.game_id)}` },
      kidText(g.title || t('ui.untitled')), roleChip(g.role)))));
}

function badgesCard(earned: string[]): HTMLElement {
  const known = new Set(BADGES.map((b) => b.id));
  const have = new Set(earned);
  const ids = [...earned.filter((b) => !known.has(b)), ...BADGES.map((b) => b.id)];
  ids.sort((a, b) => Number(have.has(b)) - Number(have.has(a)));
  return card(null, h('h2', null, '🏅 ', t('collab.profile.badges', { n: have.size })),
    h('div', { class: 'collab-badges' }, ...ids.map((b) => badgeEl(b, have.has(b)))));
}

function levelsCard(page: PlayerPage, isMe: boolean): HTMLElement {
  const name = kidText(page.player.name || t('ui.someone'));
  return card(null, h('h2', null, '🗺️ ', t(isMe ? 'collab.profile.my_levels' : 'collab.profile.their_levels', { name })),
    page.levels.length
      ? h('div', { class: 'level-list' }, ...page.levels.map((l) => h('div', { class: 'collab-level-item' },
        levelCardEl({ ...l, author: l.author || page.player.name }),
        l.plays !== null ? h('span', { class: 'small collab-plays' }, '▶️ ', t('collab.profile.plays', { n: l.plays })) : '')))
      : h('div', null, note(t(isMe ? 'collab.profile.no_levels_me' : 'collab.profile.no_levels')),
        isMe ? h('a', { class: 'pill primary', href: '#/draw' }, icon('marker'), t('home.draw')) : ''));
}

function subRowFrom(s: Submission): SubRow {
  return { id: s.id, status: s.status, game_id: s.game_id, game_title: s.game_title, level_id: s.level_id, title: s.title, note: s.note, created_at: s.created_at };
}

function subRowFromLocal(s: LocalSubmission): SubRow {
  return { id: s.id, status: null, game_id: s.game_id, game_title: s.game_title, level_id: s.level_id, title: s.title, note: null, created_at: s.created_at };
}

/** My submissions: the server's list, plus the ones this device remembers (their status looked up per game). */
function subsCard(server: Submission[], gone: () => boolean): HTMLElement {
  const rows = new Map<string, SubRow>();
  for (const s of server) rows.set(s.id, subRowFrom(s));
  for (const s of mySubmissions()) if (!rows.has(s.id)) rows.set(s.id, subRowFromLocal(s));
  const listEl = h('div', { class: 'collab-my-subs' });
  const render = (): void => {
    const all = [...rows.values()].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    listEl.replaceChildren(...(all.length ? all.map(subRow) : [note(t('collab.profile.no_subs'))]));
  };
  render();
  // look up what this device remembers but the server list didn't include
  const unknown = [...rows.values()].filter((r) => r.status === null && r.game_id);
  const games = [...new Set(unknown.map((r) => r.game_id!))];
  void Promise.all(games.map((g) => collab.submissions(g).catch(() => [] as Submission[]))).then((lists) => {
    if (gone()) return;
    for (const s of lists.flat()) {
      const r = rows.get(s.id);
      if (r) rows.set(s.id, { ...r, ...subRowFrom(s), title: s.title || r.title, game_title: s.game_title || r.game_title, created_at: r.created_at ?? s.created_at });
    }
    render();
  });
  return card(null, h('h2', null, '📬 ', t('collab.profile.my_subs')), h('p', { class: 'small muted' }, t('collab.profile.my_subs_help')), listEl);
}

function subRow(s: SubRow): HTMLElement {
  const st = s.status ?? 'pending';
  return h('div', { class: `collab-my-sub st-${st}` },
    h('span', { class: 'collab-feed-emo', 'aria-hidden': 'true' }, STATUS_EMOJI[st]),
    h('div', { class: 'collab-my-sub-body' },
      h('div', null, h('a', { href: `#/play/${enc(s.level_id)}` }, kidText(s.title || t('ui.untitled'))),
        s.game_id ? h('span', { class: 'small muted' }, ' → ', h('a', { href: `#/game/${enc(s.game_id)}` }, kidText(s.game_title || t('collab.sent.the_game')))) : ''),
      h('div', { class: 'row wrap small' },
        h('span', { class: `collab-status st-${st}` }, t(`collab.submission.${st}`)),
        s.created_at ? h('span', { class: 'muted' }, timeAgo(s.created_at)) : ''),
      s.note ? h('p', { class: 'small collab-review-note' }, '✏️ ', h('q', null, kidText(s.note))) : '',
      st === 'changes' ? h('a', { class: 'pill small', href: `#/draw?remix=${enc(s.level_id)}${s.game_id ? `&game=${enc(s.game_id)}` : ''}` }, icon('pencil'), t('collab.profile.fix_it')) : ''));
}

function codeCard(): HTMLElement {
  const code = secretCode();
  const box = h('div', { class: 'row wrap' });
  const show = (): void => {
    box.replaceChildren(h('code', { class: 'collab-code' }, code ?? ''),
      h('button', {
        type: 'button', class: 'pill small',
        onclick: () => void navigator.clipboard?.writeText(code ?? '').then(() => toast(t('collab.profile.code_copied')), () => undefined),
      }, t('collab.profile.copy')));
  };
  box.append(h('button', { type: 'button', class: 'pill small', onclick: show }, icon('eye'), t('collab.profile.show_code')));
  return card(null,
    h('h3', null, '🔑 ', t('collab.profile.code_title')),
    h('p', { class: 'small muted' }, t('collab.profile.code_help')),
    box,
    h('p', { class: 'small' }, h('button', {
      type: 'button', class: 'link',
      onclick: () => {
        if (!confirm(t('collab.profile.forget_confirm'))) return;
        forgetPlayer();
        navigate('#/');
      },
    }, t('collab.profile.forget'))));
}
