/**
 * #/activity[?game=<id>&tab=me|all] — what's new (v3 lane 5): "For you" (your bell: reviews of your levels, plays,
 * quests, badges) and "Everyone" (the public feed, or one game's feed). Every line deep-links to where it happened.
 */
import { api } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { collab, type FeedItem } from '../collab/api.ts';
import { refreshBell } from '../collab/bell.ts';
import { errText, feedRow, note } from '../collab/ui.ts';

/** The activity feed (all games, or one). */
export function feedList(gameId: string | null): { el: HTMLElement; dispose(): void } {
  let disposed = false;
  const el = h('div', { class: 'collab-feed' }, note(t('ui.loading')));
  collab.activity(gameId).then((items) => {
    if (disposed) return;
    el.replaceChildren(...(items.length ? items.map((it) => feedRow({ ...it, read: true })) : [note(t(gameId ? 'collab.activity.empty_game' : 'collab.activity.empty'))]));
  }, (e) => {
    if (!disposed) el.replaceChildren(note(errText(e), 'warn'));
  });
  return {
    el,
    dispose: () => {
      disposed = true;
    },
  };
}

/** Your notifications, with "Mark all read". */
function forYou(): { el: HTMLElement; dispose(): void } {
  let disposed = false;
  const el = h('div', { class: 'collab-feed' });
  if (!currentPlayer()) {
    el.append(note(t('collab.activity.need_profile')),
      h('button', { type: 'button', class: 'pill primary', onclick: () => void ensurePlayer().then(() => navigate('#/activity?tab=me'), () => undefined) }, '👋 ', t('collab.who.title')));
    return { el, dispose: () => undefined };
  }
  el.append(note(t('ui.loading')));
  const open = (it: FeedItem): void => {
    if (!it.read) void collab.markRead([it.id]).then(() => refreshBell(), () => undefined);
  };
  collab.notifications().then(({ items }) => {
    if (disposed) return;
    const markAll = h('button', { type: 'button', class: 'pill small', disabled: !items.some((i) => !i.read) }, icon('check'), t('collab.bell.mark_all'));
    markAll.onclick = async () => {
      try {
        await collab.markRead();
        el.querySelectorAll('.collab-feed-row.unread').forEach((n) => n.classList.remove('unread'));
        markAll.disabled = true;
        refreshBell();
      } catch (e) {
        toast(errText(e));
      }
    };
    el.replaceChildren(h('div', { class: 'row end' }, markAll),
      ...(items.length ? items.map((it) => feedRow(it, { onOpen: open })) : [note(t('collab.bell.empty'))]));
  }, (e) => {
    if (!disposed) el.replaceChildren(note(errText(e), 'warn'));
  });
  return {
    el,
    dispose: () => {
      disposed = true;
    },
  };
}

export function activityScreen(root: HTMLElement, query: URLSearchParams): () => void {
  const gameId = query.get('game');
  let tab: 'me' | 'all' = query.get('tab') === 'me' || (!gameId && query.get('tab') !== 'all' && !!currentPlayer()) ? 'me' : 'all';
  let current: { el: HTMLElement; dispose(): void } | null = null;
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const host = h('div', null);
  const gameLine = h('p', { class: 'muted' });
  if (gameId) {
    api.game(gameId).then((g) => {
      gameLine.replaceChildren(h('a', { href: `#/game/${encodeURIComponent(gameId)}` }, kidText(g.title || t('ui.untitled'))));
    }, () => undefined);
  }
  const render = (): void => {
    current?.dispose();
    tabs.replaceChildren(
      h('button', { type: 'button', role: 'tab', class: `tab${tab === 'me' ? ' on' : ''}`, onclick: () => { tab = 'me'; render(); } }, '🔔 ', t('collab.activity.for_you')),
      h('button', { type: 'button', role: 'tab', class: `tab${tab === 'all' ? ' on' : ''}`, onclick: () => { tab = 'all'; render(); } }, '🌍 ', t(gameId ? 'collab.activity.this_game' : 'collab.activity.everyone')));
    current = tab === 'me' ? forYou() : feedList(gameId);
    host.replaceChildren(current.el);
  };
  root.append(h('div', { class: 'collab-screen activity-screen' },
    card('collab-head', h('h1', { class: 'marker-underline' }, t('collab.activity.title')), gameLine, tabs),
    card(null, host)));
  render();
  return () => current?.dispose();
}
