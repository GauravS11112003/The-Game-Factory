/**
 * The game page as the game's hub (lane 5), used by screens/game.ts: the bible summary (pitch, how it works, style
 * picture, starter creatures, team), the big "Add a level to this game" button, Join for non-members, contributor
 * faces on level cards, and tabs: Levels, Quests, Review queue (owner/maintainers, with a count), Credits, What's new.
 * Also the home page's "Join a game" strip (open games looking for helpers, with open quest counts).
 */
import type { LibraryType } from '../../core/types.gen.ts';
import { api, type GameCard, type LevelCard } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { ensurePlayer, type Player } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate, parseHash } from '../router.ts';
import { collab, type Contributor, type Quest } from './api.ts';
import { clearContribution } from './contribute.ts';
import { loadTeam, roleOf, type GameTeam } from './roles.ts';
import { avatarStack, errText, playerChip, roleChip } from './ui.ts';
import { typeThumb } from '../screens/library.ts';
import { questBoard } from '../screens/quests.ts';
import { reviewList } from '../screens/review.ts';
import { creditsList } from '../screens/credits.ts';
import { feedList } from '../screens/activity.ts';

const enc = encodeURIComponent;

type Tab = 'levels' | 'quests' | 'review' | 'credits' | 'activity';

export interface Hub {
  team: GameTeam;
  /** Pitch, how it works, style picture, starters, team, Join — for the game's head card. */
  bibleEl: HTMLElement;
  /** The big primary "Add a level to this game". */
  addButton: HTMLElement;
  /** Who made this level (face + name), under a level card. */
  madeBy(l: LevelCard): HTMLElement;
  /** The tabbed area; `levels` is the game's level list. */
  tabs(levels: HTMLElement): HTMLElement;
  dispose(): void;
}

/** "Add a level to this game": who are you → join an open game → draw for it. */
export function addLevelButton(game: { id: string }, team: GameTeam | null, cls = 'pill primary big'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `${cls} collab-add-level` }, icon('marker'), t('collab.hub.add_level'));
  b.onclick = async () => {
    try {
      const me = await ensurePlayer();
      // an open game: drawing for it makes you a helper (and claims an ownerless game that is yours)
      if (team && (!roleOf(me, team.members, team.bible) || team.claimable) && team.bible?.open_for !== 'invite') await collab.join(game.id).catch(() => undefined);
      clearContribution();
      navigate(`#/draw?new=1&game=${enc(game.id)}`);
    } catch (e) {
      if (!(e instanceof Error && e.message === 'collab.who.cancelled')) toast(errText(e));
    }
  };
  return b;
}

export async function loadHub(game: GameCard): Promise<Hub> {
  const [team, credits] = await Promise.all([loadTeam(game.id), collab.credits(game.id).then((r) => r.contributors, () => [] as Contributor[])]);
  const handles: { dispose(): void }[] = [];
  const isMaint = (): boolean => team.keeper;

  // ---- who made each level ----
  const byLevel = new Map<string, Player>();
  for (const c of credits) for (const l of c.levels) if (l.id) byLevel.set(l.id, c.player);
  const byName = new Map<string, Player>();
  for (const m of team.members) if (m.player.name) byName.set(m.player.name.toLowerCase(), m.player);
  for (const c of credits) if (c.player.name && !byName.has(c.player.name.toLowerCase())) byName.set(c.player.name.toLowerCase(), c.player);
  const madeBy = (l: LevelCard): HTMLElement => {
    const p = byLevel.get(l.id) ?? (l.author ? byName.get(l.author.toLowerCase()) : undefined) ?? null;
    return h('div', { class: 'collab-made-by' }, playerChip(p, { size: 24, fallbackName: l.author || t('ui.someone') }));
  };

  // ---- bible summary + join ----
  const joinSlot = h('div', { class: 'collab-join-slot' });
  const renderJoin = (): void => {
    if (team.role && !team.claimable) {
      joinSlot.replaceChildren(h('span', { class: 'small' }, t('collab.hub.you_are'), ' ', roleChip(team.role)));
    } else if (!team.claimable && team.bible?.open_for === 'invite') {
      joinSlot.replaceChildren(h('span', { class: 'small muted' }, '🔒 ', t('collab.invite_only')));
    } else {
      // an ownerless game whose author is this profile: joining claims it
      const claim = team.claimable;
      const join = h('button', { type: 'button', class: 'pill accent' }, claim ? '👑 ' : '🙌 ', t(claim ? 'collab.hub.claim' : 'collab.hub.join'));
      join.onclick = async () => {
        join.disabled = true;
        try {
          await ensurePlayer();
          await collab.join(game.id);
          toast(t(claim ? 'collab.hub.claimed' : 'collab.hub.joined', { game: kidText(game.title || t('ui.untitled')) }), { ms: 6000 });
          navigate(location.hash); // show the game again with my new role (review tab, quest posting…)
        } catch (e) {
          join.disabled = false;
          if (!(e instanceof Error && e.message === 'collab.who.cancelled')) toast(errText(e));
        }
      };
      joinSlot.replaceChildren(join, h('span', { class: 'small muted' }, t(claim ? 'collab.hub.claim_help' : 'collab.hub.join_help')));
    }
  };
  const teamSlot = h('div', { class: 'row wrap small collab-team-row' });
  const renderTeam = (): void => {
    const ps = team.members.map((m) => m.player);
    teamSlot.replaceChildren(ps.length ? avatarStack(ps, 8, 28) : '', t('collab.hub.team_n', { n: Math.max(ps.length, 1) }));
  };
  renderJoin();
  renderTeam();

  const b = team.bible;
  const starters = h('div', { class: 'row wrap collab-starters-mini' });
  if (b?.starter_type_ids.length) {
    api.library(game.id).then((lib: LibraryType[]) => {
      const picked = lib.filter((x) => b.starter_type_ids.includes(x.id));
      if (picked.length) starters.replaceChildren(h('span', { class: 'small muted' }, t('collab.bible.starters')),
        ...picked.slice(0, 8).map((x) => h('span', { class: 'collab-starter mini', title: kidText(x.name) }, typeThumb(x, 44, 36))));
    }, () => undefined);
  }
  const mech = b?.mechanics_text ? h('details', { class: 'collab-mech', open: b.mechanics_text.length < 400 },
    h('summary', null, '⚙️ ', t('collab.hub.how_it_works')), h('div', { class: 'collab-mechanics' }, kidText(b.mechanics_text))) : '';
  const bibleEl = h('div', { class: 'collab-bible-sum' },
    b?.style_image_url ? h('img', { class: 'collab-style-thumb', src: b.style_image_url, alt: t('collab.bible.style') }) : '',
    h('div', { class: 'collab-bible-text' },
      b?.pitch ? h('p', { class: 'collab-pitch' }, kidText(b.pitch)) : isMaint() ? h('p', { class: 'small muted' }, t('collab.hub.write_bible')) : '',
      mech,
      starters,
      teamSlot,
      h('div', { class: 'row wrap' }, joinSlot,
        h('a', { class: 'pill small', href: `#/bible/${enc(game.id)}` }, '📖 ', t(isMaint() ? 'collab.hub.edit_bible' : 'collab.hub.read_bible')))));

  // ---- tabs ----
  const tabs = (levels: HTMLElement): HTMLElement => {
    const q0 = parseHash().query.get('tab') as Tab | null;
    let tab: Tab = q0 && ['levels', 'quests', 'review', 'credits', 'activity'].includes(q0) && (q0 !== 'review' || isMaint()) ? q0 : 'levels';
    const panes = new Map<Tab, HTMLElement>([['levels', levels]]);
    const bar = h('div', { class: 'tabs collab-hub-tabs', role: 'tablist' });
    const host = h('div', { class: 'collab-hub-pane' });
    const counts: Partial<Record<Tab, number>> = { levels: game.levels.length };
    const label: Record<Tab, string> = {
      levels: `🗺️ ${t('collab.hub.tab_levels')}`, quests: `🏆 ${t('collab.hub.tab_quests')}`, review: `📬 ${t('collab.hub.tab_review')}`,
      credits: `🎬 ${t('collab.hub.tab_credits')}`, activity: `✨ ${t('collab.hub.tab_activity')}`,
    };
    const shown = (): Tab[] => (['levels', 'quests', 'review', 'credits', 'activity'] as Tab[]).filter((x) => x !== 'review' || isMaint());
    const renderBar = (): void => {
      bar.replaceChildren(...shown().map((x) => h('button', {
        type: 'button', role: 'tab', class: `tab${x === tab ? ' on' : ''}`, 'aria-selected': String(x === tab),
        onclick: () => select(x),
      }, label[x], counts[x] ? h('span', { class: `collab-count${x === 'review' ? ' hot' : ''}` }, String(counts[x])) : '')));
    };
    const pane = (x: Tab): HTMLElement => {
      const have = panes.get(x);
      if (have) return have;
      let el: HTMLElement;
      if (x === 'quests') {
        const qb = questBoard(game.id, { canPost: isMaint(), onCount: (n) => { counts.quests = n; renderBar(); } });
        handles.push(qb);
        el = h('div', null, qb.el, h('a', { class: 'small', href: `#/quests/${enc(game.id)}` }, t('collab.hub.open_quests')));
      } else if (x === 'review') {
        const rl = reviewList(game.id, { canReview: true, onCount: (n) => { counts.review = n; renderBar(); } });
        handles.push(rl);
        el = h('div', null, rl.el);
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
    function select(x: Tab): void {
      tab = x;
      renderBar();
      host.replaceChildren(pane(x));
      const { path } = parseHash();
      try {
        history.replaceState(null, '', `#/${path.map(enc).join('/')}${x === 'levels' ? '' : `?tab=${x}`}`);
      } catch {
        /* ignore */
      }
    }
    // counts for the tabs we haven't opened yet
    collab.quests(game.id).then((qs: Quest[]) => {
      counts.quests = qs.filter((q) => q.status !== 'done').length;
      renderBar();
    }, () => undefined);
    if (isMaint()) {
      collab.submissions(game.id, 'pending').then((subs) => {
        counts.review = subs.filter((s) => s.status === 'pending').length;
        renderBar();
      }, () => undefined);
    }
    renderBar();
    host.replaceChildren(pane(tab));
    return card('collab-hub', bar, host);
  };

  return {
    team,
    bibleEl,
    addButton: addLevelButton(game, team),
    madeBy,
    tabs,
    dispose: () => handles.forEach((x) => x.dispose()),
  };
}

// ---- home: "Join a game" ---------------------------------------------------------------------------------------------

/** Open games looking for helpers, busiest quest boards first. Hidden when there are none (or no collab server). */
export function joinStrip(): HTMLElement {
  const el = h('div', { class: 'collab-join-strip hidden' });
  void (async () => {
    let games: GameCard[];
    try {
      games = (await api.games('hot')).games.slice(0, 12);
    } catch {
      return;
    }
    const rows = await Promise.all(games.map(async (g) => {
      const [bible, quests] = await Promise.all([collab.bible(g.id).catch(() => null), collab.quests(g.id).catch(() => null)]);
      return { g, bible, open: quests ? quests.filter((q) => q.status !== 'done').length : 0, known: !!bible || !!quests };
    }));
    const open = rows.filter((r) => r.known && r.bible?.open_for !== 'invite').sort((a, b) => b.open - a.open || b.g.levels.length - a.g.levels.length);
    if (!open.length) return;
    el.replaceChildren(card('collab-join-card',
      h('div', { class: 'row between wrap' },
        h('div', null, h('h2', null, '🙌 ', t('collab.join.title')), h('p', { class: 'small muted' }, t('collab.join.help'))),
        h('a', { class: 'pill small', href: '#/jams' }, '🎪 ', t('collab.jams.nav'))),
      h('div', { class: 'collab-join-row' }, ...open.slice(0, 8).map(({ g, bible, open: n }) => h('a', { class: 'collab-join-game', href: `#/game/${enc(g.id)}` },
        bible?.style_image_url ? h('img', { class: 'collab-join-img', src: bible.style_image_url, alt: '', loading: 'lazy' }) : h('div', { class: 'collab-join-img empty' }, '🎮'),
        h('div', { class: 'collab-join-meta' },
          h('strong', null, kidText(g.title || t('ui.untitled'))),
          bible?.pitch ? h('span', { class: 'small' }, kidText(bible.pitch.length > 80 ? `${bible.pitch.slice(0, 78)}…` : bible.pitch)) : '',
          h('span', { class: 'row wrap small' },
            n ? h('span', { class: 'collab-quest-chip' }, '🏆 ', t('collab.join.quests', { n })) : h('span', { class: 'muted' }, t('collab.join.add_levels')),
            h('span', { class: 'muted' }, t('home.levels', { n: g.levels.length })))))))));
    el.classList.remove('hidden');
  })();
  return el;
}
