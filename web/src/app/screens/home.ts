/** Personal creator studio: one card per game, plus a creation modal. */
import { api, ApiError, type GameCard, type LevelCard } from '../api.ts';
import { card, h, icon } from '../dom.ts';
import { fmtTime, kidText, t } from '../messages.ts';
import { drops } from '../readout.ts';
import { store } from '../store.ts';
import { generatedThumb, levelThumb } from '../thumbs.ts';
import { onPlayerChange } from '../identity.ts';
import { openCreateGameModal } from './create-game.ts';
import { GAMES } from '../../arcade/catalog.ts';
import { readLevels } from '../../arcade/levels.ts';
import { createGame } from '../../arcade/games.ts';
import { W, H } from '../../arcade/engine.ts';

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
  const gameUrl = `#/game/${encodeURIComponent(g.id)}`;
  const playUrl = g.generated ? `#/imagine/${encodeURIComponent(g.generated.draft_id)}` :
    g.levels[0] ? `#/play/${encodeURIComponent(g.levels[0].id)}` : null;
  const placeholder = (): HTMLElement => h('div', { class: 'studio-placeholder', 'aria-hidden': 'true' }, icon('marker'));
  const cover = g.generated ? generatedThumb(g.generated, g.levels[0] ? levelThumb(g.levels[0]) : placeholder()) :
    g.levels[0] ? levelThumb(g.levels[0]) : placeholder();
  return h('article', { class: 'studio-game' },
    h('a', { class: 'studio-cover', href: gameUrl, 'aria-label': g.title || t('ui.untitled') }, cover),
    h('div', { class: 'studio-game-body' },
      h('span', { class: 'small muted' }, t(`creator_studio.${g.studio_relation ?? 'modified'}`)),
      h('h2', null, h('a', { href: gameUrl }, kidText(g.title || t('ui.untitled')))),
      h('p', { class: 'small muted' }, g.generated ? t(g.generated.publication === 'published' ? 'imagine.published' : 'imagine.draft') : t('home.levels', { n: g.level_count ?? g.levels.length })),
      h('div', { class: 'row between' },
        h('a', { class: 'pill small', href: gameUrl }, icon('pencil'), t('creator_studio.open')),
        playUrl ? h('a', { class: 'pill small', href: playUrl }, icon('play'), t('ui.play')) : '')));
}

function localGameCards(): HTMLElement[] {
  return GAMES.flatMap((entry) => {
    const levels = readLevels(entry.id);
    if (!levels.length) return [];
    const url = `#/arcade/${entry.id}`;
    const cover = h('canvas', { width: W, height: H, role: 'img', 'aria-label': entry.title });
    createGame(entry.id, false, levels.at(-1)).draw(cover.getContext('2d')!, 1.4);
    return [h('article', { class: 'studio-game' },
      h('a', { class: 'studio-cover', href: url, 'aria-label': entry.title }, cover),
      h('div', { class: 'studio-game-body' }, h('span', { class: 'small muted' }, t('creator_studio.modified')),
        h('h2', null, h('a', { href: url }, entry.title)),
        h('p', { class: 'small muted' }, t('home.levels', { n: levels.length })),
        h('a', { class: 'pill small', href: url }, icon('pencil'), t('creator_studio.open'))))];
  });
}

export function homeScreen(root: HTMLElement, createOnOpen = false): () => void {
  let disposed = false;
  let revision = 0;
  let closeModal: (() => void) | undefined;
  const create = (): void => {
    closeModal?.();
    closeModal = openCreateGameModal(() => { if (!disposed) void load(); });
  };
  const feed = h('div', { class: 'studio-games', 'aria-live': 'polite' });
  root.append(h('section', { class: 'studio' },
    h('div', { class: 'studio-heading row between wrap' },
      h('div', null, h('h1', null, t('creator_studio.title')), h('p', { class: 'muted' }, t('creator_studio.subtitle'))),
      h('button', { class: 'pill primary', type: 'button', onclick: create }, icon('plus'), t('home.new_game'))), feed));

  const load = async (): Promise<void> => {
    const current = ++revision;
    const local = localGameCards();
    feed.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('ui.loading')));
    try {
      const { games } = await api.games('new', true);
      if (disposed || current !== revision) return;
      feed.replaceChildren(...(games.length || local.length ? [...games.map(gameEl), ...local] : [h('div', { class: 'studio-empty' },
        icon('marker'), h('h2', null, t('creator_studio.empty')), h('p', { class: 'muted' }, t('creator_studio.empty_help')))]));
    } catch (error) {
      if (disposed || current !== revision) return;
      feed.replaceChildren(...local, card('studio-empty', h('p', { role: 'alert' }, t(error instanceof ApiError ? error.messageKey : 'error.network')),
        h('button', { class: 'pill', type: 'button', onclick: () => void load() }, t('creator_studio.retry'))));
    }
  };
  const unsubscribe = onPlayerChange(() => void load());
  void load();
  if (createOnOpen) create();
  return () => { disposed = true; unsubscribe(); closeModal?.(); };
}
