/**
 * #/credits/:game — the game's credit roll (v3 lane 5): a slow scroll of everyone who made the game, with their faces,
 * what each made (levels, creatures, art, quests) and the Adobe Firefly art credits read from the levels' skins.
 * Also: a compact credits list for the game hub, a short roll in a sheet, and the "See who made this" button that
 * play.ts shows after the last level of a game is beaten.
 */
import type { LevelV2 } from '../../core/types.gen.ts';
import { api, type GameCard } from '../api.ts';
import { card, h, icon, prefersReducedMotion } from '../dom.ts';
import { ensurePlayer, type Player } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { collab, type Contributor, type CreditItem, type Role } from '../collab/api.ts';
import { avatar, errText, note, playerChip, roleChip } from '../collab/ui.ts';

const enc = encodeURIComponent;

interface RollPerson {
  player: Player;
  role: Role | null;
  lines: string[];
}

interface RollArt {
  label: string;
  by: string;
  tool: string;
}

interface Roll {
  game: GameCard;
  people: RollPerson[];
  art: RollArt[];
}

type Any = any;

function names(items: CreditItem[], titles: Map<string, string>): string[] {
  return items.map((i) => kidText(i.title || (i.id ? titles.get(i.id) ?? '' : ''))).filter(Boolean);
}

function line(kind: 'levels' | 'creatures' | 'art' | 'quests' | 'reviews', n: number, list: string[]): string | null {
  if (!n && !list.length) return null;
  if (list.length && (kind === 'levels' || kind === 'creatures' || kind === 'art')) return t(`collab.credits.${kind}_list`, { list: list.slice(0, 6).join(', ') });
  return t(`collab.credits.${kind}_n`, { n: n || list.length });
}

/** One person's lines. The server counts levels; their titles come from the game's levels by that author's name. */
function personFrom(c: Contributor, titles: Map<string, string>, byAuthor: Map<string, string[]>): RollPerson {
  const named = names(c.levels, titles);
  const levelTitles = named.length ? named : c.counts.levels ? byAuthor.get(c.player.name.toLowerCase()) ?? [] : [];
  const lines = [
    line('levels', c.counts.levels, levelTitles),
    line('creatures', c.counts.creatures, names(c.creatures, titles)),
    line('art', c.counts.art, names(c.art, titles)),
    line('quests', c.counts.quests, []),
    line('reviews', c.counts.reviews, []),
  ].filter((x): x is string => !!x);
  return { player: c.player, role: c.role, lines };
}

function namePerson(name: string, levels: string[], owner: boolean): RollPerson {
  return { player: { id: `name:${name}`, name, avatar_url: null }, role: owner ? 'owner' : null, lines: levels.length ? [t('collab.credits.levels_list', { list: levels.slice(0, 6).join(', ') })] : [] };
}

/** Art credits from the levels' skins (lane 1's `skin.objects[].credit` and `skin.backdrop.credit`). */
function skinArt(levels: LevelV2[]): RollArt[] {
  const out: RollArt[] = [];
  const seen = new Set<string>();
  for (const lv of levels) {
    const skin = (lv as Any)?.skin;
    if (!skin || typeof skin !== 'object') continue;
    const add = (label: string, credit: Any): void => {
      if (!credit || typeof credit !== 'object') return;
      const by = typeof credit.by === 'string' ? credit.by : '';
      const tool = typeof credit.tool === 'string' ? credit.tool : skin.provider === 'firefly' ? 'Adobe Firefly' : '';
      const k = `${label}|${by}|${tool}`;
      if (!tool || seen.has(k)) return;
      seen.add(k);
      out.push({ label: kidText(label), by: kidText(by), tool });
    };
    if (skin.backdrop) add(t('collab.credits.backdrop', { title: lv.title || t('ui.untitled') }), skin.backdrop.credit);
    for (const o of Array.isArray(skin.objects) ? skin.objects : []) if (o?.mode !== 'ink') add(String(o?.label ?? ''), o?.credit);
  }
  return out;
}

async function loadRoll(gameId: string): Promise<Roll> {
  const game = await api.game(gameId);
  const titles = new Map<string, string>(game.levels.map((l) => [l.id, l.title]));
  const byAuthor = new Map<string, string[]>();
  const authorName = new Map<string, string>();
  for (const l of game.levels) {
    const a = (l.author || t('ui.someone')).trim();
    byAuthor.set(a.toLowerCase(), [...(byAuthor.get(a.toLowerCase()) ?? []), kidText(l.title || t('ui.untitled'))]);
    if (!authorName.has(a.toLowerCase())) authorName.set(a.toLowerCase(), a);
  }
  let people: RollPerson[] = [];
  let authors: string[] | null = null;
  try {
    const r = await collab.credits(gameId);
    people = r.contributors.map((c) => personFrom(c, titles, byAuthor));
    authors = r.authors;
  } catch {
    authors = null;
  }
  // level authors without a profile still get their line (all of them when the server can't say)
  const have = new Set(people.map((p) => p.player.name.toLowerCase()));
  const extra = authors && (authors.length || people.length) ? authors : [...authorName.values()];
  for (const a of extra) {
    if (have.has(a.toLowerCase())) continue;
    have.add(a.toLowerCase());
    people.push(namePerson(a, byAuthor.get(a.toLowerCase()) ?? [], !people.some((p) => p.role === 'owner') && a.toLowerCase() === game.author.toLowerCase()));
  }
  // the owner first, then the biggest helpers
  people.sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : b.lines.length - a.lines.length));
  const embedded = game.levels.map((l) => l.level).filter((l): l is LevelV2 => !!l);
  const missing = game.levels.filter((l) => !l.level).slice(0, 20);
  const fetched = await Promise.all(missing.map((l) => api.level(l.id).then((r) => r.level, () => null)));
  const art = skinArt([...embedded, ...fetched.filter((l): l is LevelV2 => !!l)]);
  return { game, people, art };
}

function rollInner(r: Roll, short: boolean): HTMLElement {
  const g = r.game;
  const firefly = r.art.filter((a) => /firefly/i.test(a.tool));
  const otherArt = r.art.filter((a) => !/firefly/i.test(a.tool));
  return h('div', { class: 'collab-roll-inner' },
    h('div', { class: 'collab-roll-title' },
      h('h1', null, kidText(g.title || t('ui.untitled'))),
      h('p', null, t('collab.credits.made_by_n', { n: r.people.length }))),
    ...r.people.map((p) => h('div', { class: 'collab-roll-person' },
      avatar(p.player, short ? 56 : 84),
      h('div', { class: 'collab-roll-name' }, kidText(p.player.name || t('ui.someone')), ' ', roleChip(p.role)),
      ...p.lines.map((l) => h('div', { class: 'collab-roll-line' }, l)))),
    firefly.length ? h('div', { class: 'collab-roll-art' },
      h('h3', null, '✨ ', t('collab.credits.firefly_title')),
      ...firefly.map((a) => h('div', { class: 'collab-roll-line' }, a.by ? t('collab.credits.art_by', { label: a.label || t('collab.credits.a_picture'), by: a.by }) : a.label))) : '',
    otherArt.length ? h('div', { class: 'collab-roll-art' },
      h('h3', null, '🎨 ', t('collab.credits.other_art_title')),
      ...otherArt.map((a) => h('div', { class: 'collab-roll-line' }, a.by ? t('collab.credits.art_by', { label: a.label || t('collab.credits.a_picture'), by: a.by }) : a.label))) : '',
    h('div', { class: 'collab-roll-end' }, h('h2', null, t('collab.credits.thanks')), h('p', null, t('collab.credits.your_turn'))));
}

/** The scrolling roll with Pause / Roll again / Add your own level. */
function rollEl(r: Roll, short: boolean): HTMLElement {
  const box = h('div', { class: `collab-roll${short ? ' short' : ''}` });
  const dur = Math.round((short ? 10 : 16) + r.people.length * (short ? 2.2 : 3.2) + r.art.length * 0.8);
  box.style.setProperty('--dur', `${dur}s`);
  const start = (): void => {
    box.classList.remove('paused');
    box.replaceChildren(rollInner(r, short));
  };
  start();
  const pause = h('button', { type: 'button', class: 'pill small' }, t('collab.credits.pause'));
  pause.onclick = () => {
    const p = box.classList.toggle('paused');
    pause.textContent = t(p ? 'collab.credits.resume' : 'collab.credits.pause');
  };
  const again = h('button', { type: 'button', class: 'pill small', onclick: () => { start(); pause.textContent = t('collab.credits.pause'); } }, icon('retry'), t('collab.credits.again'));
  const add = h('button', {
    type: 'button', class: 'pill primary',
    onclick: () => void ensurePlayer().then(() => navigate(`#/draw?new=1&game=${enc(r.game.id)}`), () => undefined),
  }, icon('plus'), t('collab.hub.add_level'));
  return h('div', { class: 'collab-roll-wrap' }, box, h('div', { class: 'row wrap end' }, prefersReducedMotion() ? '' : pause, prefersReducedMotion() ? '' : again, add));
}

export function creditsScreen(root: HTMLElement, gameId: string): () => void {
  let disposed = false;
  const body = h('div', { class: 'collab-screen credits-screen' }, card(null, note(t('ui.loading'))));
  root.append(body);
  void loadRoll(gameId).then((r) => {
    if (disposed) return;
    body.replaceChildren(card('collab-head',
      h('div', { class: 'row between wrap' },
        h('h1', { class: 'marker-underline' }, '🎬 ', t('collab.credits.title')),
        h('a', { class: 'pill', href: `#/game/${enc(gameId)}` }, icon('home'), t('ui.game'))),
      rollEl(r, false)));
  }, (e) => {
    if (!disposed) body.replaceChildren(card(null, note(errText(e, 'error.not_found'))));
  });
  return () => {
    disposed = true;
  };
}

/** A short roll in a sheet (after the last level of a game). */
export function openCreditsSheet(gameId: string): void {
  const inner = h('div', null, note(t('ui.loading')));
  const close = (): void => back.remove();
  const back = h('div', { class: 'modal-back collab-top' }, card('collab-roll-sheet',
    h('div', { class: 'row between' }, h('h2', { class: 'marker-underline' }, '🎬 ', t('collab.credits.title')),
      h('button', { type: 'button', class: 'tool', onclick: close, title: t('ui.close') }, icon('close'))),
    inner));
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  document.body.append(back);
  loadRoll(gameId).then((r) => inner.replaceChildren(rollEl(r, true)), (e) => inner.replaceChildren(note(errText(e))));
}

/** play.ts: after a win, when this is the game's last level, add "See who made this" to the results card. */
export function creditsAfterWin(level: { id: string; game_id?: string | null }, host: HTMLElement): void {
  const gid = level.game_id;
  if (!gid) return;
  api.game(gid).then((g) => {
    const i = g.levels.findIndex((l) => l.id === level.id);
    if (i < 0 || g.levels.slice(i + 1).some((l) => !l.bonus) || !host.isConnected) return;
    if (host.querySelector('.collab-credits-cta')) return;
    host.append(h('div', { class: 'collab-credits-cta' },
      h('p', null, '🏆 ', t('collab.credits.beat_game', { game: kidText(g.title || t('ui.untitled')) })),
      h('button', { type: 'button', class: 'pill primary', onclick: () => openCreditsSheet(gid) }, '🎬 ', t('collab.credits.see_who'))));
  }, () => undefined);
}

/** Compact credits for the game hub's Credits tab. */
export function creditsList(gameId: string): { el: HTMLElement; dispose(): void } {
  let disposed = false;
  const el = h('div', { class: 'collab-credits-list' }, note(t('ui.loading')));
  void loadRoll(gameId).then((r) => {
    if (disposed) return;
    el.replaceChildren(
      h('div', { class: 'row wrap between' },
        h('p', { class: 'muted' }, t('collab.credits.made_by_n', { n: r.people.length })),
        h('a', { class: 'pill primary', href: `#/credits/${enc(gameId)}` }, '🎬 ', t('collab.credits.roll'))),
      h('div', { class: 'collab-people' }, ...r.people.map((p) => h('div', { class: 'collab-person' },
        playerChip(p.player.id.startsWith('name:') ? null : p.player, { size: 40, fallbackName: p.player.name }),
        roleChip(p.role),
        ...p.lines.map((l) => h('div', { class: 'small' }, l))))),
      r.art.length ? h('p', { class: 'small muted' }, '✨ ', t('collab.credits.art_count', { n: r.art.length })) : '');
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
