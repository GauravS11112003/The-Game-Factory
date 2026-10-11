/**
 * "Which game?" (lane D): the player's own games, from GET /dashboard when lane C serves it, else from the collab
 * profile (/players/me). Used by "Add to a game" in the blocks library and "Use on a game" on the styles page.
 */
import type { GameMode } from '../../core/types.gen.ts';
import { collab } from '../collab/api.ts';
import { h, icon } from '../dom.ts';
import { ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { v4 } from '../v4api.ts';
import { studioGames } from '../studio_cards.ts';
import { btn, dialog, emptyState, modeName } from './ui.ts';

export interface MyGame {
  id: string;
  title: string;
  mode: GameMode | null;
}

/** The games this player owns or helps with. Never throws: none found is an empty list. */
export async function myGames(): Promise<MyGame[]> {
  try {
    const d = await v4.dashboard();
    return d.games.map((g) => ({ id: g.game_id, title: g.title, mode: g.mode ?? null }));
  } catch {
    try {
      const me = await collab.me();
      return me.games.map((g) => ({ id: g.game_id, title: g.title, mode: null }));
    } catch {
      return [];
    }
  }
}

/** Ask who you are when needed, then pick one of your games. Null when closed. */
export async function pickGame(title: string, help?: string): Promise<MyGame | null> {
  try {
    await ensurePlayer();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let done = false;
    const list = h('div', null, h('p', { class: 'muted small' }, t('ui.loading')));
    const d = dialog(title, h('div', null, help ? h('p', { class: 'w-sub' }, help) : '', list), {
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    void myGames().then((games) => {
      if (!d.el.isConnected) return;
      list.replaceChildren(games.length
        ? h('ul', { class: 'w-pick-list' }, ...games.map((g) => h('li', null, h('button', {
          type: 'button', class: 'w-btn block',
          onclick: () => {
            done = true;
            d.close();
            resolve(g);
          },
        }, icon('play'), h('span', null, kidText(g.title || t('ui.untitled'))), g.mode ? h('span', { class: 'w-chip plain' }, modeName(g.mode)) : ''))))
        : emptyState(t('gw.pick_none'), btn(t('gw.pick_new'), { href: '#/new', icon: 'plus', cls: 'primary small' })));
    });
  });
}

/** v6: pick one of your Studio games (for object and theme blocks). Null when closed. */
export async function pickStudioGame(title: string, help?: string): Promise<{ id: string; title: string } | null> {
  try {
    await ensurePlayer();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    let done = false;
    const list = h('div', null, h('p', { class: 'muted small' }, t('ui.loading')));
    const d = dialog(title, h('div', null, help ? h('p', { class: 'w-sub' }, help) : '', list), {
      onClose: () => {
        if (!done) resolve(null);
      },
    });
    void studioGames('mine').then((games) => {
      if (!d.el.isConnected) return;
      list.replaceChildren(games.length
        ? h('ul', { class: 'w-pick-list' }, ...games.map((g) => h('li', null, h('button', {
          type: 'button', class: 'w-btn block',
          onclick: () => {
            done = true;
            d.close();
            resolve({ id: g.id, title: g.title });
          },
        }, icon('play'), h('span', null, kidText(g.title || t('ui.untitled')))))))
        : emptyState(t('gw.pick_none'), btn(t('gw.pick_new'), { href: '#/new?blank=1', icon: 'plus', cls: 'primary small' })));
    });
  });
}
