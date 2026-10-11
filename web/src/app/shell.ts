/**
 * v4 workspace chrome (docs/v4/CONTRACTS_V4.md §7): a sidebar (brand, New game, the workspace sections, recent games,
 * builder status) and a slim top bar (describe-a-game box, scan, the collab bell and profile, mute). Both live outside
 * #app, so screens keep their (root) => cleanup shape; route() calls setActive() on every hash change.
 * Editor screens (draw, preview, play) shrink the sidebar to an icon rail; phones get a menu button.
 */
import { api } from './api.ts';
import { isStudioId, studioHref, studioTitle } from './studio_cards.ts';
import { collabChrome } from './collab/bell.ts';
import { h, icon } from './dom.ts';
import { kidText, t } from './messages.ts';
import { navigate } from './router.ts';
import { store } from './store.ts';

/** Sidebar icons not in dom.ts ICONS (24-unit outline paths, drawn like icon()). */
const PATHS: Record<string, string> = {
  games: 'M3 8h18v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM7 12h4M9 10v4M15.5 11.5h.01M17.5 13.5h.01',
  blocks: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  styles: 'M12 3a9 9 0 100 18c1 0 1.6-.8 1.6-1.6 0-1-.8-1.2-.8-2.2 0-.8.7-1.4 1.5-1.4H17a4 4 0 004-4c0-4.9-4-8.8-9-8.8zM7.5 11h.01M10 7h.01M15 7h.01',
  templates: 'M4 4h16v16H4zM4 9h16M9 9v11',
  explore: 'M12 3a9 9 0 100 18 9 9 0 000-18zM15.5 8.5l-2 5-5 2 2-5z',
  jams: 'M6 21V4M6 4h11l-2 4 2 4H6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
};

function pathIcon(name: string): SVGSVGElement {
  const el = icon('question');
  const p = el.querySelector('path');
  if (p && PATHS[name]) p.setAttribute('d', PATHS[name]);
  return el;
}

interface NavItem { nav: string; href: string; key: string; ico: () => SVGSVGElement }

const NAV: NavItem[] = [
  { nav: '', href: '#/', key: 'nav.home', ico: () => icon('home') },
  { nav: 'games', href: '#/games', key: 'nav.games', ico: () => pathIcon('games') },
  { nav: 'blocks', href: '#/blocks', key: 'nav.blocks', ico: () => pathIcon('blocks') },
  { nav: 'styles', href: '#/styles', key: 'nav.styles', ico: () => pathIcon('styles') },
  { nav: 'templates', href: '#/templates', key: 'nav.templates', ico: () => pathIcon('templates') },
  { nav: 'explore', href: '#/explore', key: 'nav.explore', ico: () => pathIcon('explore') },
  { nav: 'jams', href: '#/jams', key: 'nav.jams', ico: () => pathIcon('jams') },
];

/** Which sidebar item a route lights up (the game workspace belongs to "My games"). */
const NAV_OF: Record<string, string> = { game: 'games', library: 'blocks', play: 'explore', tree: 'explore' };

// ---- recent games: a per-device list, newest first (dal.v4.recent) -------------------------------------------------

interface Recent { id: string; title: string | null }
const RECENT_KEY = 'dal.v4.recent';

function readRecent(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as Recent[];
    return Array.isArray(v) ? v.filter((r) => r && typeof r.id === 'string').slice(0, 4) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: Recent[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 4)));
  } catch {
    /* storage off: the list just stays empty */
  }
}

export interface Shell {
  setActive(path: string[]): void;
  /** A game was opened: it moves to the top of Recent (its title is looked up when unknown). */
  noteGame(id: string, title?: string | null): void;
  /** Titles a screen already knows, so Recent never shows a bare id. */
  rememberTitles(games: { id: string; title: string }[]): void;
  refreshStatus(): void;
}

export function mountShell(): Shell {
  // ---- sidebar ----
  const links = NAV.map((n) => h('a', { href: n.href, data: { nav: n.nav }, title: t(n.key) }, n.ico(), h('span', { class: 'ws-label' }, t(n.key))));
  const recentBox = h('div', { class: 'ws-recent' });
  const status = h('div', { class: 'ws-status', 'aria-live': 'polite' });
  const side = h('aside', { class: 'ws-side', 'aria-label': t('nav.workspace') },
    h('a', { class: 'ws-brand', href: '#/' }, h('span', { class: 'ws-brand-mark', 'aria-hidden': 'true' }), h('span', { class: 'ws-label' }, 'draw.play')),
    h('a', { class: 'ws-new', href: '#/new', title: t('nav.new_game') }, icon('plus'), h('span', { class: 'ws-label' }, t('nav.new_game'))),
    h('nav', { class: 'ws-nav' }, ...links),
    recentBox,
    status);

  // ---- top bar ----
  const ask = h('input', { type: 'text', class: 'ws-ask-in', maxLength: 300, placeholder: t('ws.ask_placeholder'), 'aria-label': t('ws.ask_label') });
  const askForm = h('form', { class: 'ws-ask', role: 'search' }, pathIcon('search'), ask,
    h('button', { type: 'submit', class: 'ws-ask-go' }, t('ws.ask_go')));
  askForm.onsubmit = (e) => {
    e.preventDefault();
    const text = ask.value.trim();
    ask.value = '';
    navigate(text ? `#/new?text=${encodeURIComponent(text)}` : '#/new');
  };
  const menuBtn = h('button', { type: 'button', class: 'tool ws-menu', 'aria-label': t('nav.menu'), 'aria-expanded': 'false' }, pathIcon('menu'));
  const setOpen = (open: boolean): void => {
    document.body.classList.toggle('ws-nav-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', t(open ? 'nav.close_menu' : 'nav.menu'));
  };
  menuBtn.onclick = () => setOpen(!document.body.classList.contains('ws-nav-open'));
  const scrim = h('div', { class: 'ws-scrim', onclick: () => setOpen(false) });

  const mute = h('button', { type: 'button', class: 'tool', title: t('ui.mute') });
  const syncMute = (): void => {
    const m = store.flag('muted');
    mute.replaceChildren(h('span', { class: 'emo' }, m ? '🔇' : '🔊'));
    mute.title = t(m ? 'ui.unmute' : 'ui.mute');
    mute.setAttribute('aria-label', mute.title);
  };
  mute.onclick = () => {
    store.setFlag('muted', !store.flag('muted'));
    syncMute();
  };
  syncMute();

  const top = h('header', { class: 'app-head ws-top' },
    menuBtn, askForm,
    collabChrome(),
    mute);

  document.body.classList.add('ws');
  document.body.prepend(side, scrim, top);

  // ---- recent games ----
  const titles = new Map<string, string>();
  const asked = new Set<string>();
  function renderRecent(): void {
    const list = readRecent();
    if (!list.length) {
      recentBox.replaceChildren();
      return;
    }
    recentBox.replaceChildren(h('span', { class: 'ws-sec-label' }, t('nav.recent')),
      ...list.map((r) => h('a', { class: 'ws-recent-row', href: isStudioId(r.id) ? studioHref(r.id) : `#/game/${encodeURIComponent(r.id)}`, title: r.title ?? '' },
        h('span', { class: 'ws-recent-dot', 'aria-hidden': 'true' }), h('span', { class: 'ws-label' }, kidText(r.title || titles.get(r.id) || t('ui.untitled'))))));
    for (const r of list) {
      if (r.title || titles.has(r.id) || asked.has(r.id)) continue;
      asked.add(r.id);
      if (isStudioId(r.id)) void studioTitle(r.id).then((title) => title && shell.rememberTitles([{ id: r.id, title }]));
      else api.game(r.id).then((g) => shell.rememberTitles([{ id: g.id, title: g.title }]), () => null);
    }
  }

  // ---- builder status: worker, model, art provider ----
  function dot(state: 'ok' | 'warn' | 'bad', text: string): HTMLElement {
    return h('div', { class: 'ws-stat' }, h('span', { class: `ws-dot ${state}`, 'aria-hidden': 'true' }), h('span', { class: 'ws-label' }, text));
  }

  const shell: Shell = {
    setActive(path) {
      const first = path[0] ?? '';
      const nav = NAV_OF[first] ?? first;
      for (const a of links) {
        const on = a.dataset.nav === nav;
        a.classList.toggle('on', on);
        if (on) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      setOpen(false);
    },
    noteGame(id, title = null) {
      const list = readRecent().filter((r) => r.id !== id);
      writeRecent([{ id, title: title ?? titles.get(id) ?? null }, ...list]);
      renderRecent();
    },
    rememberTitles(games) {
      let changed = false;
      for (const g of games) if (g.title && titles.get(g.id) !== g.title) { titles.set(g.id, g.title); changed = true; }
      const list = readRecent();
      const next = list.map((r) => (titles.has(r.id) ? { ...r, title: titles.get(r.id)! } : r));
      if (changed) {
        writeRecent(next);
        renderRecent();
      }
    },
    refreshStatus() {
      // v6: the copilot is what matters (no AI art, no tile builder for Studio games)
      api.health().then((hl) => {
        status.replaceChildren(dot(hl.llm === 'live' ? 'ok' : 'warn', t(hl.llm === 'live' ? 'nav.copilot_live' : 'nav.copilot_off')));
      }, () => status.replaceChildren(dot('bad', t('nav.copilot_down'))));
    },
  };

  renderRecent();
  shell.refreshStatus();
  return shell;
}
