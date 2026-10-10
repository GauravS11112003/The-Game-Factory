/**
 * The top bar's collaboration corner (lane 5): the notifications bell (unread count polled every 30 s, a dropdown
 * list, mark read, deep links) and your face linking to #/me — or a "Who are you?" button before there is a profile.
 */
import { h, icon } from '../dom.ts';
import { currentPlayer, ensurePlayer, onPlayerChange } from '../identity.ts';
import { t } from '../messages.ts';
import { collab, type FeedItem } from './api.ts';
import { avatar, errText, feedRow, note } from './ui.ts';

const POLL_MS = 30_000;
let poke: (() => void) | null = null;

/** Ask the bell to re-check now (after marking things read elsewhere). */
export function refreshBell(): void {
  poke?.();
}

export function collabChrome(): HTMLElement {
  let items: FeedItem[] = [];
  let unread = 0;
  let open = false;
  let busy = false;

  const count = h('span', { class: 'collab-count hidden', 'aria-hidden': 'true' });
  const bell = h('button', { type: 'button', class: 'tool collab-bell', title: t('collab.bell.title'), 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    h('span', { class: 'emo' }, '🔔'), count);
  const menuList = h('div', { class: 'collab-bell-list' });
  const markAll = h('button', { type: 'button', class: 'pill small' }, icon('check'), t('collab.bell.mark_all'));
  const menu = h('div', { class: 'collab-bell-menu card hidden', role: 'menu' },
    h('div', { class: 'row between' }, h('strong', { class: 'collab-bell-title' }, t('collab.bell.title')), markAll),
    menuList,
    h('a', { class: 'small collab-bell-all', href: '#/activity?tab=me', onclick: () => setOpen(false) }, t('collab.bell.see_all')));
  const bellWrap = h('div', { class: 'collab-bell-wrap hidden' }, bell, menu);
  const me = h('span', { class: 'collab-me-slot' });
  const el = h('div', { class: 'collab-chrome' }, bellWrap, me);

  const syncCount = (): void => {
    count.textContent = unread > 9 ? '9+' : String(unread);
    count.classList.toggle('hidden', unread === 0);
    bell.title = unread ? t('collab.bell.unread', { n: unread }) : t('collab.bell.title');
  };

  const renderMenu = (): void => {
    markAll.disabled = !items.some((i) => !i.read);
    menuList.replaceChildren(...(items.length
      ? items.slice(0, 20).map((it) => feedRow(it, { onOpen: (x) => { setOpen(false); if (!x.read) void markOne(x); } }))
      : [note(t('collab.bell.empty'), 'muted small')]));
  };

  const poll = async (): Promise<void> => {
    if (busy || !currentPlayer()) return;
    busy = true;
    try {
      const r = await collab.notifications();
      items = r.items;
      unread = r.unread;
      syncCount();
      if (open) renderMenu();
    } catch {
      /* the backend may not be up yet: stay quiet, try again later */
    } finally {
      busy = false;
    }
  };
  poke = () => void poll();

  async function markOne(it: FeedItem): Promise<void> {
    it.read = true;
    unread = Math.max(0, unread - 1);
    syncCount();
    await collab.markRead([it.id]).catch(() => undefined);
  }

  markAll.onclick = async () => {
    markAll.disabled = true;
    try {
      await collab.markRead();
      items = items.map((i) => ({ ...i, read: true }));
      unread = 0;
      syncCount();
      renderMenu();
    } catch (e) {
      menuList.prepend(note(errText(e), 'warn small'));
      markAll.disabled = false;
    }
  };

  function setOpen(v: boolean): void {
    open = v;
    menu.classList.toggle('hidden', !v);
    bell.setAttribute('aria-expanded', String(v));
    if (v) {
      renderMenu();
      void poll();
    }
  }
  bell.onclick = () => setOpen(!open);
  document.addEventListener('pointerdown', (e) => {
    if (open && !bellWrap.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') setOpen(false);
  });
  window.addEventListener('hashchange', () => open && setOpen(false));

  const renderMe = (): void => {
    const p = currentPlayer();
    bellWrap.classList.toggle('hidden', !p);
    if (p) {
      me.replaceChildren(h('a', { class: 'collab-me', href: '#/me', title: t('collab.profile.my_page') }, avatar(p, 32)));
    } else {
      items = [];
      unread = 0;
      syncCount();
      me.replaceChildren(h('button', {
        type: 'button', class: 'pill small collab-hello', title: t('collab.who.help'),
        onclick: () => void ensurePlayer().catch(() => undefined),
      }, h('span', { class: 'emo' }, '👋'), h('span', { class: 'lbl' }, t('collab.who.short'))));
    }
  };
  onPlayerChange(() => {
    renderMe();
    void poll();
  });
  renderMe();
  void poll();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void poll();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll();
  });
  return el;
}
