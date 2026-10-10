/**
 * #/ — the home feed (§7.9, §8.4): draw, scan or start a game; games and their levels sorted by New, Hot, Hard or
 * Most cleared. Level cards show the thumbnail, difficulty badge, measured clear rate and best time.
 */
import { api, ApiError, type GameCard, type LevelCard, type Sort } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { fmtTime, kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { drops } from '../readout.ts';
import { store } from '../store.ts';
import { levelThumb } from '../thumbs.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts'; // v3 lane 5
import { joinStrip } from '../collab/hub.ts';
import { collab } from '../collab/api.ts';

const SORTS: Sort[] = ['new', 'hot', 'hard', 'cleared'];
let lastSort: Sort = 'new';

/** The title of the level to clear first when `l` is still locked on this device (§9 bonus levels), else null. */
export function lockedBy(l: LevelCard, seq: readonly LevelCard[]): string | null {
  if (!l.unlock_after || store.cleared(l.unlock_after)) return null;
  const before = seq.find((x) => x.id === l.unlock_after);
  return before ? before.title || t('ui.untitled') : null;
}

export function levelCardEl(l: LevelCard, o: { index?: number; locked?: string | null } = {}): HTMLElement {
  const n = drops(l.score ?? 0);
  const locked = o.locked ?? null;
  const attrs = locked
    ? { class: 'level-card locked', 'aria-disabled': 'true', title: t('game.locked_after', { title: locked }) }
    : { class: 'level-card', href: `#/play/${encodeURIComponent(l.id)}` };
  return h(locked ? 'div' : 'a', attrs,
    levelThumb(l),
    h('div', { class: 'meta' },
      h('div', { class: 'title' }, o.index !== undefined ? h('span', { class: 'num' }, `${o.index + 1}`) : '', kidText(l.title || t('ui.untitled')),
        l.bonus ? h('span', { class: 'badge bonus' }, icon('star'), t('game.bonus')) : ''),
      locked ? h('div', { class: 'small lock-note' }, icon('lock'), ` ${t('game.locked_after', { title: kidText(locked) })}`) : '',
      h('div', { class: 'small muted' }, t('play.by', { author: l.author || t('ui.someone') }), l.screens > 1 ? ` · ${t('home.screens', { n: l.screens })}` : ''),
      h('div', { class: 'row small' },
        l.band ? h('span', { class: `band-badge band-${l.band}` }, t(`band.${l.band}`), ' ', ...Array.from({ length: n }, () => icon('drop', 'ico drop full'))) : '',
        l.clear_rate !== null ? h('span', { class: 'muted' }, t('home.cleared', { rate: Math.round(l.clear_rate * 100) })) : '',
        l.best_ms ? h('span', { class: 'muted' }, `⏱ ${fmtTime(l.best_ms)}`) : '',
        l.safety === 'unchecked' ? h('span', { class: 'badge' }, t('badge.not_checked')) : '')));
}

function gameEl(g: GameCard): HTMLElement {
  return card('game-row',
    h('div', { class: 'row between wrap' },
      h('div', null, h('h3', null, h('a', { href: `#/game/${encodeURIComponent(g.id)}` }, kidText(g.title || t('ui.untitled')))),
        h('p', { class: 'small muted' }, t('play.by', { author: g.author || t('ui.someone') }), ` · ${t('home.levels', { n: g.levels.length })}`)),
      h('div', { class: 'row' },
        g.levels[0] ? h('a', { class: 'pill small', href: `#/play/${encodeURIComponent(g.levels[0].id)}` }, icon('play'), t('ui.play')) : '',
        h('a', { class: 'pill small', href: `#/draw?new=1&game=${encodeURIComponent(g.id)}` }, icon('plus'), t('game.add_level')))),
    h('div', { class: 'level-strip' }, ...g.levels.slice(0, 8).map((l, i) => levelCardEl(l, { index: i, locked: lockedBy(l, g.levels) }))));
}

export function homeScreen(root: HTMLElement): () => void {
  let disposed = false;
  const status = h('p', { class: 'small muted' });
  const feed = h('div', { class: 'feed' }, h('p', { class: 'muted' }, t('ui.loading')));
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const newTitle = h('input', { type: 'text', class: 'text', maxLength: 40, placeholder: t('home.game_title') });
  const newAuthor = h('input', { type: 'text', class: `text${currentPlayer() ? ' hidden' : ''}`, maxLength: 16, placeholder: t('ui.your_name'), value: currentPlayer()?.name || store.author() });
  const newForm = h('form', { class: 'new-game hidden row wrap' }, newTitle, newAuthor, h('button', { type: 'submit', class: 'pill primary small' }, t('home.make_game')));
  newForm.onsubmit = async (e) => {
    e.preventDefault();
    const title = newTitle.value.trim();
    const author = newAuthor.value.trim().slice(0, 16);
    if (!title || !author) return;
    store.setAuthor(author);
    try {
      // v3: the maker's profile owns the game: its name is the author, and joining right away claims it
      const p = await ensurePlayer().catch(() => null);
      const g = await api.createGame(title, p?.name || author);
      if (p) await collab.join(g.id).catch(() => null);
      navigate(`#/game/${encodeURIComponent(g.id)}`);
    } catch (err) {
      toast(t(err instanceof ApiError ? err.messageKey : 'error.build_failed'));
    }
  };

  // §8.5 import: a zip from "Download" (a level or a whole game) comes back with new ids
  const importIn = h('input', { type: 'file', accept: '.zip,application/zip', class: 'hidden' });
  importIn.onchange = async () => {
    const f = importIn.files?.[0];
    importIn.value = '';
    if (!f) return;
    try {
      const r = await api.importZip(f);
      toast(t('export.imported', { n: r.levels.length }));
      if (r.game_id) navigate(`#/game/${encodeURIComponent(r.game_id)}`);
      else if (r.levels[0]) navigate(`#/play/${encodeURIComponent(r.levels[0])}`);
      else void load(lastSort);
    } catch (err) {
      toast(t(err instanceof ApiError ? err.messageKey : 'error.upload_failed'));
    }
  };
  const hero = card('hero',
    h('h1', { class: 'marker-underline' }, t('home.title')),
    h('p', null, t('home.tagline')),
    h('div', { class: 'row wrap' },
      h('a', { class: 'pill primary big', href: '#/draw' }, icon('marker'), t('home.draw')),
      h('a', { class: 'pill big', href: '#/scan' }, icon('camera'), t('home.scan')),
      h('a', { class: 'pill big', href: '#/prompt' }, icon('pencil'), t('ui.prompt')),
      h('button', { type: 'button', class: 'pill big', onclick: () => { newForm.classList.toggle('hidden'); newTitle.focus(); } }, icon('plus'), t('home.new_game')),
      h('button', { type: 'button', class: 'pill', title: t('export.import_help'), onclick: () => importIn.click() }, icon('plus'), t('export.import'))),
    newForm, h('div', { class: 'row between wrap' }, status, h('a', { class: 'small muted', href: '/v1.html' }, t('home.v1_link'))), importIn);
  root.append(hero, joinStrip(), tabs, feed);

  const load = async (sort: Sort): Promise<void> => {
    lastSort = sort;
    tabs.replaceChildren(...SORTS.map((s) => h('button', { type: 'button', role: 'tab', class: `tab${s === sort ? ' on' : ''}`, onclick: () => void load(s) }, t(`home.sort_${s}`))));
    feed.replaceChildren(h('p', { class: 'muted' }, t('ui.loading')));
    try {
      const r = await api.games(sort);
      if (disposed) return;
      const items: HTMLElement[] = r.games.map(gameEl);
      if (r.levels.length) items.push(card('game-row', h('h3', null, t('home.more_levels')), h('div', { class: 'level-strip' }, ...r.levels.map((l) => levelCardEl(l)))));
      feed.replaceChildren(...(items.length ? items : [card(null, h('p', null, t('home.empty')))]));
    } catch (e) {
      if (disposed) return;
      feed.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.network'))));
    }
  };
  void load(lastSort);

  api.health().then((hl) => {
    if (disposed) return;
    const bits = [hl.worker === 'ok' ? t('home.builder_ready') : t('toast.builder_restarting')];
    if (hl.llm !== 'live') bits.push(t('badge.quick_look_offline'));
    status.textContent = bits.join(' · ');
  }, () => {
    if (!disposed) status.textContent = t('toast.builder_restarting');
  });

  return () => {
    disposed = true;
  };
}
