/**
 * #/game/:id — the game workspace (docs/v4/CONTRACTS_V4.md §7). A workspace, not a feed:
 * - left: the levels in order (thumbnail, title, status chip from the bot's design report) and the ways to add one
 *   (draw, scan, describe);
 * - centre: the picked level large, Play, and its bot summary;
 * - right: the inspector, tabs Rules / Legend / Blocks / Style / Bot / Send to (gw_rules.ts, gw_panels.ts, gw_send.ts);
 * - below: the v3 team area, About (the game book summary and Join), Quests, Review, Credits and What's new.
 * `?level=<id>` picks a level and `?tab=<name>` opens an inspector or team tab (the workspace home links
 * `?tab=review`); both are kept in the URL with replaceState so a reload comes back to the same place.
 */
import type { GameRules, LevelV2, LibraryType } from '../../core/types.gen.ts';
import { api, type GameCard, type LevelCard } from '../api.ts';
import { loadHub, addLevelButton, type Hub } from '../collab/hub.ts';
import { verdictEl } from '../collab/ui.ts';
import { h, icon } from '../dom.ts';
import { kidText, t, tRef } from '../messages.ts';
import { parseHash } from '../router.ts';
import { levelThumb } from '../thumbs.ts';
import { questBoard } from '../screens/quests.ts';
import { reviewList } from '../screens/review.ts';
import { creditsList } from '../screens/credits.ts';
import { feedList } from '../screens/activity.ts';
import { withDefaults, type GwCtx } from './gw_ctx.ts';
import { botPanel, blocksPanel, legendPanel, stylePanel } from './gw_panels.ts';
import { rulesPanel } from './gw_rules.ts';
import { sendPanel } from './gw_send.ts';
import { designPill, firstLevel, flagRef, fixCount, levelStatus } from './model.ts';
import { btn, calm, chip, emptyState, enc, modeName, note, statusChip, tabs, type Tabs } from './ui.ts';

type Inspect = 'rules' | 'legend' | 'blocks' | 'style' | 'bot' | 'send';
type Team = 'about' | 'quests' | 'review' | 'credits' | 'activity';
const INSPECT: Inspect[] = ['rules', 'legend', 'blocks', 'style', 'bot', 'send'];
const TEAM: Team[] = ['about', 'quests', 'review', 'credits', 'activity'];

export function gameWorkspaceScreen(root: HTMLElement, gameId: string, query: URLSearchParams): () => void {
  let disposed = false;
  let hub: Hub | null = null;
  const handles: { dispose(): void }[] = [];
  const page = h('div', { class: 'w-page gw-page' }, h('p', { class: 'muted' }, t('ui.loading')));
  root.append(page);

  void (async () => {
    let game: GameCard;
    let rules: GameRules;
    let lib: LibraryType[];
    try {
      const [g, r, l] = await Promise.all([api.game(gameId), api.rules(gameId).catch(() => null), api.library(gameId).catch(() => [] as LibraryType[])]);
      game = g;
      rules = withDefaults(r ?? g.rules);
      lib = l;
    } catch (e) {
      if (!disposed) page.replaceChildren(emptyState(calm(e, 'error.not_found'), btn(t('nav.games'), { href: '#/games', cls: 'small' })));
      return;
    }
    if (disposed) return;
    hub = await loadHub(game).catch(() => null);
    if (disposed) return;
    mount(game, rules, lib);
  })();

  function mount(game: GameCard, rules0: GameRules, lib0: LibraryType[]): void {
    let rules = rules0;
    let lib = lib0;
    const loaded = new Map<string, LevelV2>();
    const asked = query.get('tab');
    let selected = firstLevel(game.levels, query.get('level'));
    const levelOf = (c: LevelCard | null): LevelV2 | null => (c ? c.level ?? loaded.get(c.id) ?? null : null);

    const keepUrl = (patch: Record<string, string | null>): void => {
      const { path, query: q } = parseHash();
      for (const [k, v] of Object.entries(patch)) {
        if (v) q.set(k, v);
        else q.delete(k);
      }
      const s = q.toString();
      try {
        history.replaceState(null, '', `#/${path.map(enc).join('/')}${s ? `?${s}` : ''}`);
      } catch {
        /* ignore */
      }
    };

    const ctx: GwCtx = {
      game, team: hub?.team ?? null,
      rules: () => rules,
      setRules: (r) => {
        rules = withDefaults(r);
        renderHead();
      },
      library: () => lib,
      setLibrary: (l) => {
        lib = l;
      },
      levelCard: () => selected,
      level: () => levelOf(selected),
      show: (tab) => {
        if ((INSPECT as string[]).includes(tab)) inspector.select(tab as Inspect);
      },
      gone: () => disposed,
    };

    // ---- head ----
    const head = h('div', { class: 'w-head' });
    function renderHead(): void {
      const statuses = game.levels.map((l) => levelStatus(levelOf(l)));
      const beat = statuses.filter((s) => s.kind === 'beat').length;
      const fix = statuses.reduce((n, s) => n + (s.kind === 'fix' ? s.n : 0), 0);
      const first = game.levels[0];
      head.replaceChildren(
        h('div', { class: 'w-head-text' },
          h('div', { class: 'w-crumbs' }, h('a', { href: '#/games' }, t('nav.games')), ' › ', kidText(game.title || t('ui.untitled'))),
          h('div', { class: 'gw-title-row' },
            h('h1', { class: 'w-h1' }, kidText(game.title || t('ui.untitled'))),
            chip(modeName(rules.mode), 'kind'),
            beat ? chip(t('gw.beatable_n', { n: beat, total: game.levels.length }), 'beat') : '',
            fix ? chip(t('gw.status_fix', { n: fix }), 'fix') : ''),
          h('p', { class: 'w-sub' }, t('play.by', { author: game.author || t('ui.someone') }), ' · ', t('home.levels', { n: game.levels.length }))),
        h('div', { class: 'row wrap' },
          btn(t('collab.bible.title'), { href: `#/bible/${enc(game.id)}`, icon: 'rules', cls: 'small' }),
          first ? btn(t('game.play_from_start'), { href: `#/play/${enc(first.id)}`, icon: 'play', cls: 'primary' }) : ''));
    }

    // ---- left: levels ----
    const list = h('ol', { class: 'gw-levels', 'aria-label': t('gw.levels') });
    function renderList(): void {
      list.replaceChildren(...game.levels.map((l, i) => h('li', null, h('button', {
        type: 'button', class: 'gw-level', 'aria-current': String(l.id === selected?.id),
        onclick: () => pick(l),
      },
      h('span', { class: 'gw-level-n' }, String(i + 1)),
      h('span', { class: 'gw-level-thumb', 'aria-hidden': 'true' }, levelThumb(l)),
      h('span', { class: 'gw-level-text' },
        h('span', { class: 'gw-level-title' }, kidText(l.title || t('ui.untitled'))),
        h('span', null, statusChip(levelOf(l))))))));
      revealPick();
    }
    /** A narrow page shows the levels as a strip: keep the chosen one in view. */
    function revealPick(): void {
      const cur = list.querySelector<HTMLElement>('[aria-current="true"]')?.parentElement;
      if (cur && list.scrollWidth > list.clientWidth + 4) list.scrollLeft = Math.max(0, cur.offsetLeft - 8);
    }
    const drawBtn = addLevelButton(game, hub?.team ?? null, 'w-btn primary');
    drawBtn.replaceChildren(icon('marker'), t('gw.add_draw'));
    const left = h('section', { class: 'gw-col', 'aria-label': t('gw.levels') },
      h('div', { class: 'w-card' },
        h('div', { class: 'row between' }, h('h2', { class: 'w-h3' }, t('gw.levels')), h('span', { class: 'small muted' }, String(game.levels.length))),
        game.levels.length ? list : note(t('game.no_levels')),
        h('div', { class: 'gw-add' },
          drawBtn,
          btn(t('gw.add_scan'), { href: `#/scan?game=${enc(game.id)}`, icon: 'camera' }),
          btn(t('gw.add_describe'), { href: `#/prompt?game=${enc(game.id)}`, icon: 'pencil' }))));

    // ---- centre: the picked level ----
    const centre = h('section', { class: 'gw-col', 'aria-label': t('gw.level_panel') });
    function renderCentre(): void {
      const l = selected;
      if (!l) {
        centre.replaceChildren(h('div', { class: 'w-card' }, emptyState(t('gw.no_levels'), btn(t('gw.add_draw'), { href: `#/draw?new=1&game=${enc(game.id)}`, icon: 'marker', cls: 'primary small' }))));
        return;
      }
      const lv = levelOf(l);
      const d = lv?.design ?? null;
      const flags = (d?.flags ?? []).filter((f) => f.severity === 'block' || f.severity === 'hard').slice(0, 3);
      centre.replaceChildren(h('div', { class: 'w-card' },
        h('div', { class: 'gw-level-head' },
          h('div', null,
            h('h2', { class: 'w-h2' }, kidText(l.title || t('ui.untitled'))),
            h('p', { class: 'w-sub small' }, t('play.by', { author: l.author || t('ui.someone') }), l.screens > 1 ? ` · ${t('home.screens', { n: l.screens })}` : '')),
          statusChip(lv)),
        h('div', { class: 'gw-stage' }, levelThumb(l),
          h('a', { class: 'w-btn primary gw-stage-play', href: `#/play/${enc(l.id)}` }, icon('play'), t('ui.play'))),
        h('div', { class: 'gw-level-actions' },
          btn(t('gw.level_remix'), { href: `#/draw?remix=${enc(l.id)}`, icon: 'remix', cls: 'small' }),
          btn(t('ui.tree'), { href: `#/tree/${enc(l.id)}`, icon: 'tree', cls: 'small' }),
          hub ? hub.madeBy(l) : ''),
        h('div', { class: 'gw-bot' },
          h('h3', { class: 'w-h4' }, t('gw.bot_summary')),
          lv ? verdictEl(lv) : note(t('ui.loading')),
          d ? h('span', { class: 'small' }, designPill(d)) : '',
          flags.length ? h('ul', { class: 'gw-flags' }, ...flags.map((f) => h('li', null, chip(t('gw.flag_fix'), 'fix'), h('span', null, tRef(flagRef(f)))))) : '',
          d && fixCount(d.flags) > flags.length ? note(t('gw.bot_more', { n: fixCount(d.flags) - flags.length })) : '',
          lv ? h('div', null, btn(t('gw.bot_open'), { cls: 'small quiet', icon: 'bot', onclick: () => inspector.select('bot') })) : '')));
    }

    function pick(l: LevelCard): void {
      selected = l;
      keepUrl({ level: l.id });
      renderList();
      renderCentre();
      if (inspectorTab === 'bot' || inspectorTab === 'send') inspector.select(inspectorTab);
      void ensureLevel(l);
    }

    /** Fetch a level's JSON when the game list did not carry it (for its status chip and bot report). */
    async function ensureLevel(l: LevelCard): Promise<void> {
      if (levelOf(l)) return;
      try {
        const r = await api.level(l.id, l.version);
        if (disposed) return;
        loaded.set(l.id, r.level);
      } catch {
        return;
      }
      renderList();
      renderHead();
      if (selected?.id === l.id) {
        renderCentre();
        if (inspectorTab === 'bot') inspector.select('bot');
      }
    }

    // ---- right: the inspector ----
    let inspectorTab: Inspect = asked && (INSPECT as string[]).includes(asked) ? (asked as Inspect) : 'rules';
    const inspector: Tabs<Inspect> = tabs<Inspect>(INSPECT.map((id) => ({ id, label: t(`gw.tab.${id}`) })), inspectorTab, (id, panel) => {
      if (id === 'rules') rulesPanel(ctx, panel);
      else if (id === 'legend') legendPanel(ctx, panel);
      else if (id === 'blocks') blocksPanel(ctx, panel);
      else if (id === 'style') stylePanel(ctx, panel);
      else if (id === 'bot') botPanel(ctx, panel);
      else sendPanel(ctx, panel);
    }, {
      label: t('gw.inspector'),
      onSelect: (id) => {
        if (id !== inspectorTab) keepUrl({ tab: id === 'rules' ? null : id });
        inspectorTab = id;
      },
    });
    const right = h('section', { class: 'gw-col gw-inspector', 'aria-label': t('gw.inspector') }, h('div', { class: 'w-card' }, inspector.el));

    // ---- below: the team (v3 collaboration) ----
    const keeper = !!hub?.team.keeper;
    const teamTabs = TEAM.filter((x) => x !== 'review' || keeper);
    const teamFirst: Team = asked && (teamTabs as string[]).includes(asked) ? (asked as Team) : 'about';
    const panes = new Map<Team, HTMLElement>();
    let team: Tabs<Team> | null = null;
    const pane = (x: Team): HTMLElement => {
      const have = panes.get(x);
      if (have) return have;
      let el: HTMLElement;
      if (x === 'about') el = hub ? hub.bibleEl : note(t('gw.team_offline'));
      else if (x === 'quests') {
        const qb = questBoard(game.id, { canPost: keeper, onCount: (n) => team?.setCount('quests', n) });
        handles.push(qb);
        el = qb.el;
      } else if (x === 'review') {
        const rl = reviewList(game.id, { canReview: true, onCount: (n) => team?.setCount('review', n) });
        handles.push(rl);
        el = rl.el;
      } else if (x === 'credits') {
        const cl = creditsList(game.id);
        handles.push(cl);
        el = cl.el;
      } else {
        const fl = feedList(game.id);
        handles.push(fl);
        el = fl.el;
      }
      panes.set(x, el);
      return el;
    };
    team = tabs<Team>(teamTabs.map((id) => ({ id, label: t(`gw.team.${id}`) })), teamFirst, (id, panel) => panel.append(pane(id)), {
      label: t('gw.team_title'),
      onSelect: (id) => {
        if (id !== teamFirst || asked === id) keepUrl({ tab: id === 'about' ? null : id });
      },
    });
    const teamEl = h('section', { class: 'w-card gw-team', 'aria-labelledby': 'gw-team-h' },
      h('h2', { id: 'gw-team-h', class: 'w-h3' }, t('gw.team_title')), team.el);

    renderHead();
    renderList();
    renderCentre();
    page.replaceChildren(head, h('div', { class: 'gw' }, left, centre, right), teamEl);
    revealPick();
    if (asked && (teamTabs as string[]).includes(asked) && asked !== 'about') window.setTimeout(() => teamEl.scrollIntoView({ block: 'start' }), 0);

    // status chips for levels the game list did not embed (a few at a time is plenty for a game)
    if (selected) void ensureLevel(selected);
    void (async () => {
      for (const l of game.levels.slice(0, 30)) {
        if (disposed) return;
        await ensureLevel(l);
      }
    })();
  }

  return () => {
    disposed = true;
    hub?.dispose();
    handles.forEach((x) => x.dispose());
  };
}
