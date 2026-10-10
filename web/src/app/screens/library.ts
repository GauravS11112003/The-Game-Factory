/**
 * #/library?game=<id> (and #/game/:id/library) — the game's object library (§8.1).
 * - "Make a creature" opens the Creature Studio; every saved type is immutable per version (D21).
 * - Each type card shows its own art, its circled paper letter, what it does, its version and author; "Change it"
 *   saves version n + 1 (published levels keep the version they pinned); "Use it" opens the editor with its stamp.
 * - "Update levels to vN" re-verifies, in the browser core, every level of the game that pins an older version:
 *   each is rebuilt with the new version and the bot says whether it still works (and what Faithful repairs would
 *   save the ones that break). Published levels never change silently.
 * - "Print the library sheet" fetches the paper Library Sheet (`dal2|lib|<game>`); "Scan a library sheet" reads it
 *   back: one draft per filled box (its drawing, name, ticks and any question), saved after the kid checks it.
 */
import type { LevelV2, LibraryType } from '../../core/types.gen.ts';
import { api, ApiError, type GameCard, type LibraryDraft } from '../api.ts';
import { assignLetter } from '../creature_words.ts';
import { store } from '../store.ts';
import { coreClient, CoreError } from '../core_client.ts';
import type { DryLevel, DryRow } from '../core_types.ts';
import { card, h, icon } from '../dom.ts';
import { kidText, t, tRef } from '../messages.ts';
import { navigate } from '../router.ts';
import { bindingTag } from '../../editor/chips.ts';
import { openCreatureStudio } from '../../editor/creature.ts';
import { strokesBBox } from '../../editor/geom.ts';
import { paintFit } from '../../editor/paint.ts';
import { openPdf } from './scan.ts';

export function typeThumb(lt: LibraryType, w = 112, hgt = 96): HTMLCanvasElement {
  const c = h('canvas', { class: 'type-thumb', width: w * 2, height: hgt * 2 });
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  paintFit(c, lt.art.strokes, strokesBBox(lt.art.strokes), { pad: 0.25, bg: '#FBF6EA' });
  return c;
}

/** "walks · slow · spiky" for a type. */
export function typeDoes(lt: LibraryType): string {
  const tag = bindingTag({ id: 'x', color: 'black', kind: 'line', pts: [[0, 0]], w: [0.5], closed: false, sheet: 0, origin: 'kid', rule: lt.behavior });
  const bits = [tag ?? t(`library.kind_${lt.kind}`)];
  if (lt.spiky) bits.push(t('creature.spiky_short'));
  return bits.join(' · ');
}

/** Library types a level pins, by type id → version (strokes' lib refs, then embedded types). */
function pinned(level: LevelV2): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of level.ink?.strokes ?? []) if (s.lib) out.set(s.lib.type_id, Math.max(out.get(s.lib.type_id) ?? 0, s.lib.version));
  for (const lt of level.embedded_library ?? []) if (!out.has(lt.id)) out.set(lt.id, lt.version);
  return out;
}

export function libraryScreen(root: HTMLElement, gameId: string | null): () => void {
  let disposed = false;
  const body = h('div', { class: 'library-screen' }, card(null, h('p', { class: 'muted' }, t('ui.loading'))));
  root.append(body);
  if (!gameId) {
    void pickGame(body, () => disposed);
    return () => {
      disposed = true;
    };
  }
  let game: GameCard | null = null;
  let types: LibraryType[] = [];
  const grid = h('div', { class: 'type-grid' });
  const dry = h('div', { class: 'dry-run' });
  const drafts = h('div', { class: 'sheet-drafts' });
  const scanIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });

  const load = async (): Promise<void> => {
    try {
      [game, types] = await Promise.all([api.game(gameId), api.library(gameId)]);
    } catch (e) {
      if (!disposed) body.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.not_found'))));
      return;
    }
    if (disposed) return;
    render();
  };

  const make = (base: LibraryType | null): void => {
    openCreatureStudio({
      gameId, library: types, base,
      onSaved: (lt) => {
        types = [...types.filter((x) => x.id !== lt.id), lt];
        render();
        if (base) void checkLevels(lt);
      },
    });
  };

  function render(): void {
    if (!game) return;
    const g = game;
    const head = card('library-head',
      h('div', { class: 'row between wrap' },
        h('div', null,
          h('h1', { class: 'marker-underline' }, t('library.title', { game: kidText(g.title || t('ui.untitled')) })),
          h('p', { class: 'muted' }, t('library.help'))),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'pill primary big', onclick: () => make(null) }, icon('plus'), t('library.make')),
          h('button', {
            type: 'button', class: 'pill', title: t('library.print_help'),
            onclick: () => void openPdf(`/api/v2/templates/library.pdf?game=${encodeURIComponent(g.id)}`),
          }, icon('rules'), t('library.print')),
          h('button', { type: 'button', class: 'pill', onclick: () => scanIn.click() }, icon('camera'), t('library.scan')),
          h('a', { class: 'pill', href: `#/game/${encodeURIComponent(g.id)}` }, icon('home'), t('ui.game')))));
    grid.replaceChildren(...(types.length
      ? types.slice().sort((a, b) => a.name.localeCompare(b.name)).map(typeCard)
      : [h('p', { class: 'muted' }, t('library.empty'))]));
    body.replaceChildren(head, drafts, card(null, grid), dry, scanIn);
  }

  // ---- a paper Library Sheet → drafts the kid checks, then saves (§8.1 "On paper") ---------------------------------
  scanIn.onchange = async () => {
    const f = scanIn.files?.[0];
    scanIn.value = '';
    if (!f) return;
    drafts.replaceChildren(card(null, h('p', { class: 'muted' }, t('library.scan_reading'))));
    try {
      const ds = await api.scanLibrarySheet(f, gameId);
      if (disposed) return;
      showDrafts(ds);
    } catch (e) {
      drafts.replaceChildren(card(null, h('p', { class: 'warn' }, t(e instanceof ApiError ? e.messageKey : 'error.upload_failed', e instanceof ApiError ? e.args : {}))));
    }
  };

  function draftType(d: LibraryDraft, name: string): LibraryType {
    const nm = kidText(name.trim() || d.name).slice(0, 16) || t('library.creature_n', { n: d.box });
    const slug = nm.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'creature';
    return {
      id: `lt_${slug}_${Math.random().toString(36).slice(2, 7)}`, game_id: gameId!, version: 1, name: nm,
      letter: d.letter ?? assignLetter(nm, types.map((x) => x.letter)), kind: 'creature', behavior: d.behavior, spiky: d.spiky,
      collision: d.collision, art: d.art, symbol: d.symbol, author: store.author() || t('ui.someone'), created_at: new Date().toISOString(),
    };
  }

  function showDrafts(ds: LibraryDraft[]): void {
    if (!ds.length) {
      drafts.replaceChildren(card(null, h('p', null, t('library.scan_empty'))));
      return;
    }
    const rows = ds.map((d) => {
      const nameIn = h('input', { type: 'text', class: 'text', maxLength: 16, value: d.name_source === 'default' ? '' : d.name, placeholder: d.name });
      const status = h('span', { class: 'small' });
      const preview: LibraryType = draftType(d, d.name);
      const save = h('button', { type: 'button', class: 'pill small primary' }, icon('star'), t('creature.save'));
      const change = h('button', {
        type: 'button', class: 'pill small',
        onclick: () => openCreatureStudio({
          gameId: gameId!, library: types, strokes: d.art.strokes, behavior: d.behavior,
          onSaved: (lt) => { types = [...types.filter((x) => x.id !== lt.id), lt]; render(); el.remove(); },
        }),
      }, icon('pencil'), t('library.change'));
      save.onclick = async () => {
        save.disabled = true;
        try {
          const lt = await api.addLibrary(gameId!, draftType(d, nameIn.value));
          types = [...types.filter((x) => x.id !== lt.id), { ...draftType(d, nameIn.value), ...lt }];
          render();
          el.remove();
          if (!drafts.querySelector('.draft-row')) drafts.replaceChildren();
        } catch (e) {
          status.textContent = t(e instanceof ApiError ? e.messageKey : 'error.build_failed');
          save.disabled = false;
        }
      };
      const el = h('div', { class: 'draft-row type-card' },
        typeThumb(preview),
        h('div', { class: 'type-meta' },
          h('div', { class: 'row' }, h('span', { class: 'letter-badge' }, preview.letter), nameIn),
          h('div', { class: 'small' }, typeDoes(preview)),
          ...d.asks.map((m) => h('div', { class: 'small ask-line' }, icon('question'), ' ', t(m.key, m.args ?? {}))),
          ...d.warnings.map((m) => h('div', { class: 'small warn' }, t(m.key, m.args ?? {}))),
          h('div', { class: 'row wrap' }, save, change, status)));
      return el;
    });
    drafts.replaceChildren(card('drafts-card', h('h3', null, t('library.scan_found', { n: ds.length })), h('p', { class: 'small muted' }, t('library.scan_check')),
      h('div', { class: 'type-grid' }, ...rows)));
  }

  function typeCard(lt: LibraryType): HTMLElement {
    const users = (game?.levels ?? []).filter((l) => l.level && pinned(l.level).has(lt.id));
    const older = users.filter((l) => (pinned(l.level!).get(lt.id) ?? lt.version) < lt.version);
    return h('div', { class: 'type-card' },
      typeThumb(lt),
      h('div', { class: 'type-meta' },
        h('div', { class: 'row' }, h('span', { class: 'letter-badge', title: t('creature.letter', { letter: lt.letter }) }, lt.letter),
          h('strong', { class: 'type-name' }, kidText(lt.name))),
        h('div', { class: 'small' }, typeDoes(lt)),
        h('div', { class: 'small muted' }, t('library.version_by', { v: lt.version, author: lt.author || t('ui.someone') }),
          users.length ? ` · ${t('library.used_in', { n: users.length })}` : ''),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'pill small', onclick: () => make(lt) }, icon('pencil'), t('library.change')),
          h('button', {
            type: 'button', class: 'pill small',
            onclick: () => navigate(`#/draw?game=${encodeURIComponent(gameId!)}&stamp=${encodeURIComponent(lt.id)}`),
          }, icon('stamp'), t('library.use')),
          older.length ? h('button', { type: 'button', class: 'pill small accent', onclick: () => void checkLevels(lt) }, icon('retry'),
            t('library.update_levels', { v: lt.version })) : '')));
  }

  /** Dry run: rebuild every level that pins an older version of `lt` with the new one, and say which still work. */
  async function checkLevels(lt: LibraryType): Promise<void> {
    const g = game;
    if (!g) return;
    const levels: DryLevel[] = g.levels.filter((l) => l.level && (pinned(l.level).get(lt.id) ?? lt.version) < lt.version)
      .map((l) => ({ id: l.id, title: l.title || t('ui.untitled'), level: l.level! }));
    if (!levels.length) {
      dry.replaceChildren();
      return;
    }
    dry.replaceChildren(card(null, h('h3', null, t('library.checking', { name: kidText(lt.name), v: lt.version })), h('p', { class: 'muted' }, t('ui.loading'))));
    let rows: DryRow[];
    try {
      rows = await coreClient().libraryCheck({ levels, type: lt, library: types });
    } catch (e) {
      const key = e instanceof CoreError && e.notImplemented ? 'error.not_implemented' : 'error.build_failed';
      dry.replaceChildren(card(null, h('p', null, t(key))));
      return;
    }
    if (disposed) return;
    const ok = rows.filter((r) => r.after);
    dry.replaceChildren(card('dry-card',
      h('h3', null, t('library.checked', { name: kidText(lt.name), v: lt.version })),
      h('p', { class: 'muted small' }, t('library.keeps_versions')),
      h('ul', { class: 'dry-list' }, ...rows.map((r) => h('li', { class: r.after ? 'ok' : 'bad' },
        h('span', { class: 'mark' }, r.after ? '✓' : '✗'), ' ', h('a', { href: `#/play/${encodeURIComponent(r.level_id)}` }, kidText(r.title)), ' · ',
        h('span', { class: 'small' }, r.after ? t('library.still_works') : t(r.reason_key ?? 'library.update_breaks')),
        !r.after && r.repaired ? h('div', { class: 'small muted' }, t('library.repair_saves'), ...r.repairs.slice(0, 3).map((m) => h('div', { class: 'small' }, `• ${tRef(m)}`))) : ''))),
      ok.length ? h('div', { class: 'row wrap' }, h('button', { type: 'button', class: 'pill primary', onclick: (ev: MouseEvent) => void publishUpdates(lt, ev.currentTarget as HTMLButtonElement) },
        icon('check'), t('library.update_now', { n: ok.length })), h('span', { class: 'small muted' }, t('library.update_how', { n: ok.length }))) : ''));
  }

  /** Publish the rebuilt levels as new versions (the server rebuilds and re-verifies them again itself). */
  async function publishUpdates(lt: LibraryType, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const r = await api.updateLevels(lt.id, lt.version);
      const titles = new Map((game?.levels ?? []).map((l) => [l.id, l.title || t('ui.untitled')]));
      dry.replaceChildren(card('dry-card',
        h('h3', null, t('library.updated', { n: r.updated.length, v: lt.version })),
        h('ul', { class: 'dry-list' },
          ...r.updated.map((u) => h('li', { class: 'ok' }, h('span', { class: 'mark' }, '✓'), ' ', h('a', { href: `#/play/${encodeURIComponent(u.level_id)}` }, kidText(titles.get(u.level_id) ?? u.level_id)), ` · v${u.version}`)),
          ...r.broken.map((b) => h('li', { class: 'bad' }, h('span', { class: 'mark' }, '✗'), ' ', kidText(titles.get(b.level_id) ?? b.level_id), ' · ', t(b.reason_key))))));
      game = await api.game(gameId!).catch(() => game);
      render();
    } catch (e) {
      btn.disabled = false;
      dry.append(h('p', { class: 'warn' }, t(e instanceof ApiError ? e.messageKey : 'error.network')));
    }
  }

  void load();
  return () => {
    disposed = true;
  };
}

/** No game chosen: list the games to pick one, or make a new one. */
async function pickGame(body: HTMLElement, gone: () => boolean): Promise<void> {
  try {
    const r = await api.games('new');
    if (gone()) return;
    body.replaceChildren(card(null,
      h('h1', { class: 'marker-underline' }, t('ui.library')),
      h('p', { class: 'muted' }, t('library.pick_game')),
      r.games.length
        ? h('ul', { class: 'pick-list' }, ...r.games.map((g) => h('li', null,
          h('a', { class: 'pill', href: `#/library?game=${encodeURIComponent(g.id)}` }, icon('star'), kidText(g.title || t('ui.untitled'))))))
        : h('p', null, t('studio.library_needs_game')),
      h('a', { class: 'pill', href: '#/' }, icon('plus'), t('home.new_game'))));
  } catch (e) {
    if (!gone()) body.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.network'))));
  }
}
