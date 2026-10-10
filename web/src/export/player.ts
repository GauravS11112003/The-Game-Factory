/**
 * The standalone draw.play player ("Export to Phaser"): a title screen, the game's levels in order, a level select,
 * and a credits roll, around the very same engine the app plays with (`mountGame`: Phaser 3 driving the deterministic
 * core sim at 60 Hz, with the engine's own HUD buttons and touch controls).
 *
 * It needs nothing but static files: `game.json` (see ./types.ts) and the images under `assets/`, both fetched by
 * relative URL, so the folder works from any static host (itch.io, GitHub Pages, `npx serve`). No server calls.
 *
 * Progress (cleared levels, best times) stays in this browser. Levels open one after another; a bonus level opens
 * after the level it waits for. `?level=3` in the page URL jumps straight to level 3 (handy while you build).
 */
import type { GameRules, InkDoc, LevelV2, Theme } from '../core/types.gen.ts';
import { mountGame, renderThumbnail, type GameHandle, type WinPayload } from '../engine/index.ts';
import { paperBase } from '../render/paper.ts';
import { fmtClock, msg } from '../render/text.ts';
import { resolveTheme } from '../render/themes.ts';
import { ProgressStore } from './progress.ts';
import { injectPlayerCss } from './style.ts';
import { normalizeGame, type ExportedGame, type ExportedLevel } from './types.ts';

export type { ExportedGame, ExportedLevel } from './types.ts';
export { ProgressStore } from './progress.ts';

export interface LevelStartInfo {
  index: number;
  entry: ExportedLevel;
  level: LevelV2;
  /** The engine handle: pause(), resume(), restart(), swapLevel(), setRules(), snapshot()… (web/src/engine/types.ts). */
  handle: GameHandle;
}

export interface LevelClearInfo {
  index: number;
  entry: ExportedLevel;
  level: LevelV2;
  win: WinPayload;
  /** A new best time for this level in this browser. */
  best: boolean;
}

export interface PlayerOptions {
  /** Where game.json is, relative to the page. Default `game.json`. */
  gameUrl?: string;
  /** Or hand the game over directly (then nothing is fetched). */
  game?: ExportedGame | unknown;
  /** Skip the title screen and start at this level (0-based). `?level=N` in the URL does the same (1-based). */
  startLevel?: number;
  /** Sound (default on). The player's own mute and music buttons still apply. */
  audio?: boolean;
  /** Every level open from the start (no unlocking). */
  unlockAll?: boolean;
  /** Change a level just before it is played (a copy: game.json is untouched). Gameplay comes from `level.compiled`. */
  transformLevel?(level: LevelV2, index: number): LevelV2;
  onLevelStart?(info: LevelStartInfo): void;
  onLevelClear?(info: LevelClearInfo): void;
  /** Every main-path level cleared (once per browser). */
  onGameClear?(game: ExportedGame): void;
}

export interface Player {
  readonly game: ExportedGame;
  readonly progress: ProgressStore;
  /** The running level's engine handle, null on the menus. */
  readonly handle: GameHandle | null;
  title(): void;
  levels(): void;
  credits(won?: boolean): void;
  play(index: number): void;
  destroy(): void;
}

// ---- small helpers ------------------------------------------------------------------------------------------------

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else if (k === 'disabled') (e as HTMLButtonElement).disabled = !!v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** A player sentence: shared/spec/messages.json `export.<key>`, with the English fallback built in. */
function tx(key: string, fallback: string, args: Record<string, unknown> = {}): string {
  return msg(`export.${key}`, args, fallback);
}

function button(label: string, onclick: () => void, o: { cls?: string; icon?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return el('button', { type: 'button', class: `dp-btn${o.cls ? ` ${o.cls}` : ''}`, title: o.title ?? null, disabled: o.disabled, onclick },
    o.icon ? el('span', { 'aria-hidden': 'true' }, o.icon) : null, el('span', { class: 'lbl' }, label));
}

/** A level's stored `ink` block as the InkDoc mountGame draws (same as the app's inkFromLevel). */
export function inkOf(level: LevelV2): InkDoc {
  const ink = level.ink;
  return {
    v: 2, source: level.source?.kind ?? 'canvas', world: { screens: level.world.screens, w: level.world.w, h: 27 },
    strokes: ink?.strokes ?? [], components: ink?.components ?? [], character: ink?.character ?? null,
    typed_rules: ink?.typed_rules ?? [], rules_ink: ink?.rules_ink ?? [],
    sheets: (level.source?.sheets ?? []).map((s) => ({ index: s.index, photo_url: s.photo_url ?? null, qr: s.qr ?? null, warnings: [] })),
    noise: ink?.noise ?? { count: 0 }, parent: null,
  };
}

function urlLevel(): number | null {
  try {
    const n = Number(new URLSearchParams(location.search).get('level'));
    return Number.isInteger(n) && n >= 1 ? n - 1 : null;
  } catch {
    return null;
  }
}

async function loadGame(o: PlayerOptions): Promise<ExportedGame> {
  if (o.game) return normalizeGame(o.game);
  const url = new URL(o.gameUrl ?? 'game.json', document.baseURI).href;
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return normalizeGame(await r.json());
}

// ---- the player ---------------------------------------------------------------------------------------------------

export async function startPlayer(root: HTMLElement, o: PlayerOptions = {}): Promise<Player> {
  injectPlayerCss();
  root.classList.add('dp-root');
  root.replaceChildren(el('div', { class: 'dp-screen' }, el('p', { class: 'dp-msg' }, tx('player_loading', 'Getting the game ready…'))));

  let game: ExportedGame;
  try {
    game = await loadGame(o);
  } catch (e) {
    console.error('draw.play: could not load the game', e);
    const fileUrl = location.protocol === 'file:';
    root.replaceChildren(el('div', { class: 'dp-screen' },
      el('h2', { class: 'dp-h2' }, '🙈'),
      el('p', { class: 'dp-msg' }, fileUrl
        ? tx('player_file_url', 'Open this game from a web server. README.md shows how.')
        : tx('player_load_failed', 'The game file is missing or broken.'))));
    throw e;
  }

  const progress = new ProgressStore(game.game.id);
  const levels = game.levels;
  const mainPath = (e: ExportedLevel): boolean => !e.bonus && !e.unlock_after;
  let handle: GameHandle | null = null;
  let cleanup: (() => void) | null = null;
  let destroyed = false;

  const themeFor = (level: LevelV2 | null): Theme => resolveTheme(game.rules, level?.rules ?? null);
  const rulesFor = (level: LevelV2): GameRules => game.rules ?? level.rules;
  const paint = (level: LevelV2 | null): void => {
    document.documentElement.style.setProperty('--dp-paper', paperBase(themeFor(level)));
  };
  const titleText = game.game.title || tx('player_untitled', 'My game');
  document.title = titleText;

  const isOpen = (i: number): boolean => {
    const e = levels[i];
    if (!e) return false;
    if (o.unlockAll || progress.cleared(e.id)) return true;
    if (e.unlock_after) return progress.cleared(e.unlock_after) || !levels.some((l) => l.id === e.unlock_after);
    for (let j = i - 1; j >= 0; j--) if (mainPath(levels[j])) return progress.cleared(levels[j].id);
    return true;
  };
  const allMainCleared = (): boolean => levels.every((e) => !mainPath(e) || progress.cleared(e.id));
  const nextAfter = (i: number): number | null => {
    for (let j = i + 1; j < levels.length; j++) if (isOpen(j)) return j;
    return null;
  };
  /** Where "Play" goes: the first open level not cleared yet, else level 1. */
  const resumeAt = (): number => {
    for (let i = 0; i < levels.length; i++) if (isOpen(i) && !progress.cleared(levels[i].id)) return i;
    return 0;
  };

  const stopGame = (): void => {
    if (!handle) return;
    try {
      handle.destroy();
    } catch (e) {
      console.warn('draw.play: destroy failed', e);
    }
    handle = null;
  };
  const show = (node: HTMLElement, onKey?: (e: KeyboardEvent) => void, more?: () => void): void => {
    stopGame();
    cleanup?.();
    cleanup = null;
    root.replaceChildren(node);
    const off: (() => void)[] = [];
    if (onKey) {
      const k = (e: KeyboardEvent): void => {
        if (e.defaultPrevented || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        // a focused button already answers Enter / Space with its own click
        if ((e.key === 'Enter' || e.key === ' ') && document.activeElement instanceof HTMLButtonElement) return;
        onKey(e);
      };
      window.addEventListener('keydown', k);
      off.push(() => window.removeEventListener('keydown', k));
    }
    if (more) off.push(more);
    cleanup = () => off.forEach((f) => f());
    window.scrollTo(0, 0);
  };

  const thumb = (e: ExportedLevel, w = 640): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round((w * 9) / 16);
    try {
      renderThumbnail(c, e.level, inkOf(e.level), { theme: themeFor(e.level) });
    } catch (err) {
      console.warn('draw.play: thumbnail failed', err);
    }
    return c;
  };

  const fullscreenBtn = (): HTMLButtonElement | null => {
    if (!document.fullscreenEnabled) return null;
    return button(tx('player_fullscreen', 'Full screen'), () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else {
        void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => {
          const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
          return so?.lock?.('landscape');
        }).catch(() => undefined);
      }
    }, { cls: 'small', icon: '⛶' });
  };

  // ---- title -----------------------------------------------------------------------------------------------------
  const title = (): void => {
    paint(levels[0].level);
    const some = progress.clearedCount > 0;
    const playLabel = some && !allMainCleared() ? tx('player_continue', 'Keep playing') : tx('player_play', 'Play');
    const playBtn = button(playLabel, () => api.play(resumeAt()), { cls: 'primary', icon: '▶' });
    show(el('div', { class: 'dp-screen' },
      el('div', { class: 'dp-cover' }, thumb(levels[0], 960)),
      el('h1', { class: 'dp-h1' }, titleText),
      el('p', { class: 'dp-sub' },
        game.game.author ? tx('player_by', 'by {author}', { author: game.game.author }) : '',
        game.game.author ? ' · ' : '',
        levels.length === 1 ? tx('player_one_level', '1 level') : tx('player_level_count', '{n} levels', { n: levels.length })),
      el('div', { class: 'dp-menu' },
        playBtn,
        some || o.unlockAll ? button(tx('player_levels', 'Levels'), () => api.levels(), { icon: '▦' }) : null,
        button(tx('player_credits', 'Credits'), () => api.credits(), { icon: '★' })),
      el('p', { class: 'dp-foot' }, tx('player_made_with', 'Made with draw.play and Phaser 3'))),
    (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        api.play(resumeAt());
      }
    });
    playBtn.focus({ preventScroll: true });
  };

  // ---- level select ----------------------------------------------------------------------------------------------
  const levelSelect = (): void => {
    paint(levels[0].level);
    const grid = el('div', { class: 'dp-grid' });
    const pending: (() => void)[] = [];
    levels.forEach((e, i) => {
      const open = isOpen(i);
      const done = progress.cleared(e.id);
      const best = progress.best(e.id);
      const box = el('div', { class: 'thumb' });
      pending.push(() => box.append(thumb(e, 480)));
      const lockedTitle = e.unlock_after
        ? tx('player_locked_after', 'Clear "{title}" to open this one.', { title: levels.find((l) => l.id === e.unlock_after)?.title ?? '' })
        : tx('player_locked', 'Clear the level before to open this one.');
      grid.append(el('button', {
        type: 'button', class: 'dp-level', disabled: !open, title: open ? null : lockedTitle,
        onclick: () => open && api.play(i),
      },
      box,
      el('div', { class: 't' }, el('span', { class: 'n' }, String(i + 1)), e.title || tx('player_untitled_level', 'A level')),
      el('div', { class: 'm' },
        e.author ? el('span', null, tx('player_by', 'by {author}', { author: e.author })) : null,
        e.bonus ? el('span', { class: 'dp-badge' }, tx('player_bonus', 'Bonus')) : null,
        done ? el('span', { class: 'dp-badge green' }, '✓', best !== null ? ` ${fmtClock(best)}` : '') : null),
      open ? null : el('span', { class: 'lock', 'aria-hidden': 'true' }, '🔒')));
    });
    // draw the thumbnails a few at a time so the screen shows at once
    let alive = true;
    const step = (): void => {
      if (!alive) return;
      const t0 = performance.now();
      while (pending.length && performance.now() - t0 < 24) pending.shift()!();
      if (pending.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    show(el('div', { class: 'dp-screen top' },
      el('h2', { class: 'dp-h2' }, tx('player_pick', 'Pick a level')),
      el('p', { class: 'dp-sub' }, titleText),
      grid,
      el('div', { class: 'dp-row' }, button(tx('player_back', 'Back'), () => api.title(), { icon: '←' }))),
    (e) => {
      if (e.key === 'Escape') api.title();
    }, () => {
      alive = false;
    });
  };

  // ---- credits ---------------------------------------------------------------------------------------------------
  const credits = (won = false): void => {
    paint(levels[0].level);
    const c = game.credits;
    const list = (items: (Node | string)[][]): HTMLUListElement => el('ul', null, ...items.map((kids) => el('li', null, ...kids)));
    const levelLines = (c.levels.length ? c.levels : levels.map((l, i) => ({ index: i + 1, id: l.id, title: l.title, author: l.author, license: l.level.license ?? null })))
      .map((l) => [`${l.index}. ${l.title || tx('player_untitled_level', 'A level')}`, l.author ? el('span', { class: 'dp-small' }, tx('player_by', 'by {author}', { author: l.author })) : '']);
    const artLines = c.art.map((a) => [a.label ? `${a.label}: ` : '', a.by, a.tool ? el('span', { class: 'dp-small' }, `(${a.tool})`) : '']);
    const libLines = c.library.map((t) => [t.name, t.author ? el('span', { class: 'dp-small' }, tx('player_by', 'by {author}', { author: t.author })) : '']);
    const helperLines = c.contributors.map((p) => {
      const bits = [
        p.levels ? tx('player_n_levels', '{n} levels', { n: p.levels }) : '',
        p.creatures ? tx('player_n_creatures', '{n} creatures', { n: p.creatures }) : '',
        p.art ? tx('player_n_art', '{n} art', { n: p.art }) : '',
        p.quests ? tx('player_n_quests', '{n} quests', { n: p.quests }) : '',
        p.reviews ? tx('player_n_reviews', '{n} reviews', { n: p.reviews }) : '',
      ].filter(Boolean).join(' · ');
      return [p.name, bits ? el('span', { class: 'dp-small' }, bits) : ''];
    });
    const licenses = [...new Set(c.levels.map((l) => l.license).filter((x): x is string => !!x))];
    const back = button(tx('player_menu', 'Menu'), () => api.title(), { cls: 'primary', icon: '⌂' });
    show(el('div', { class: 'dp-screen top' },
      el('div', { class: 'dp-credits' },
        won ? el('p', { class: 'dp-big' }, '🎉') : null,
        won ? el('h2', { class: 'dp-h2' }, tx('player_won', 'You beat the whole game!')) : null,
        el('h1', { class: 'dp-h1' }, titleText),
        game.game.author ? el('p', { class: 'dp-sub' }, tx('player_game_by', 'A game by {author}', { author: game.game.author })) : null,
        el('h3', { class: 'dp-h3' }, tx('player_level_list', 'Levels')), list(levelLines),
        artLines.length ? el('h3', { class: 'dp-h3' }, tx('player_art', 'Art')) : null, artLines.length ? list(artLines) : null,
        libLines.length ? el('h3', { class: 'dp-h3' }, tx('player_creatures', 'Creatures')) : null, libLines.length ? list(libLines) : null,
        helperLines.length ? el('h3', { class: 'dp-h3' }, tx('player_helpers', 'Helpers')) : null, helperLines.length ? list(helperLines) : null,
        el('h3', { class: 'dp-h3' }, tx('player_thanks', 'Thanks for playing!')),
        el('p', { class: 'dp-small' }, tx('player_made_with', 'Made with draw.play and Phaser 3')),
        licenses.length ? el('p', { class: 'dp-small' }, tx('player_license', 'Levels shared under {license}.', { license: licenses.join(', ') })) : null,
        el('div', { class: 'dp-row' }, back, progress.clearedCount ? button(tx('player_levels', 'Levels'), () => api.levels(), { icon: '▦' }) : null))),
    (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') api.title();
    });
    back.focus({ preventScroll: true });
  };

  // ---- play ------------------------------------------------------------------------------------------------------
  const play = (index: number): void => {
    const i = Math.max(0, Math.min(levels.length - 1, Math.floor(index)));
    const entry = levels[i];
    let level = entry.level;
    if (o.transformLevel) {
      try {
        level = o.transformLevel(structuredClone(entry.level), i);
      } catch (e) {
        console.warn('draw.play: transformLevel failed; playing the level as it is', e);
      }
    }
    paint(level);
    const host = el('div', { class: 'dp-stage-host' });
    const stage = el('div', { class: 'dp-stage' }, host);
    const name = el('div', { class: 'dp-name' },
      el('b', null, tx('player_level_n', 'Level {n}', { n: i + 1 })), entry.title || '',
      entry.author ? el('span', { class: 'dp-small' }, ` ${tx('player_by', 'by {author}', { author: entry.author })}`) : '');
    const bar = el('div', { class: 'dp-bar' }, name,
      el('div', { class: 'dp-row' },
        button(tx('player_levels', 'Levels'), () => api.levels(), { cls: 'small', icon: '▦' }),
        button(tx('player_menu', 'Menu'), () => api.title(), { cls: 'small', icon: '⌂' }),
        fullscreenBtn()));
    let overlay: HTMLElement | null = null;
    let onOverlayKey: ((e: KeyboardEvent) => void) | null = null;
    const closeOverlay = (): void => {
      overlay?.remove();
      overlay = null;
      onOverlayKey = null;
    };
    show(el('div', { class: 'dp-play' }, bar, stage, el('p', { class: 'dp-rotate' }, tx('player_rotate', 'Turn your phone sideways to play.'))),
      (e) => onOverlayKey?.(e));

    try {
      handle = mountGame(host, level, inkOf(level), { mode: 'play', rules: rulesFor(level), audio: o.audio !== false });
    } catch (e) {
      console.error('draw.play: the game could not start', e);
      host.replaceChildren(el('div', { class: 'dp-screen' }, el('p', { class: 'dp-msg' }, tx('player_no_stage', 'This browser could not start the game.'))));
      return;
    }
    const h = handle;
    try {
      o.onLevelStart?.({ index: i, entry, level, handle: h });
    } catch (e) {
      console.warn('draw.play: onLevelStart failed', e);
    }

    h.on('win', (p: WinPayload) => {
      if (handle !== h || destroyed) return;
      const wasAll = allMainCleared();
      const practice = !!(p.rewound && p.rewound > 0);
      const prev = progress.best(entry.id);
      const best = progress.clear(entry.id, p.time_ms, !practice);
      const nowAll = allMainCleared();
      try {
        o.onLevelClear?.({ index: i, entry, level, win: p, best });
      } catch (e) {
        console.warn('draw.play: onLevelClear failed', e);
      }
      if (nowAll && !wasAll) {
        try {
          o.onGameClear?.(game);
        } catch (e) {
          console.warn('draw.play: onGameClear failed', e);
        }
      }
      const next = nextAfter(i);
      const finale = nowAll && (!wasAll || next === null);
      const again = (): void => {
        closeOverlay();
        h.restart('start');
      };
      const primary = next !== null
        ? button(tx('player_next', 'Next level'), () => api.play(next), { cls: 'primary', icon: '▶' })
        : finale
          ? button(tx('player_the_end', 'The end!'), () => api.credits(true), { cls: 'primary', icon: '★' })
          : button(tx('player_levels', 'Levels'), () => api.levels(), { cls: 'primary', icon: '▦' });
      closeOverlay();
      overlay = el('div', { class: 'dp-over' }, el('div', { class: 'dp-card', role: 'dialog', 'aria-live': 'polite' },
        el('p', { class: 'dp-big' }, finale && !wasAll ? '🎉' : '⭐'),
        el('h2', { class: 'dp-h2' }, finale && !wasAll ? tx('player_won', 'You beat the whole game!') : tx('player_cleared', 'Level cleared!')),
        el('div', { class: 'dp-stats' },
          el('span', null, tx('player_time', 'Time {time}', { time: fmtClock(p.time_ms) })),
          el('span', null, tx('player_deaths', 'Oops: {n}', { n: p.deaths })),
          p.coins ? el('span', null, tx('player_coins', 'Coins: {n}', { n: p.coins })) : null,
          p.big_coins_banked ? el('span', null, tx('player_big_coins', 'Big coins: {n}', { n: p.big_coins_banked })) : null),
        practice
          ? el('span', { class: 'dp-badge' }, tx('player_practice', 'Practice run: rewinds do not count for best times.'))
          : best ? el('span', { class: 'dp-badge' }, tx('player_new_best', 'New best time!'))
            : prev !== null ? el('span', { class: 'dp-small' }, tx('player_best', 'Best {time}', { time: fmtClock(Math.min(prev, p.time_ms)) })) : null,
        el('div', { class: 'dp-row' },
          primary,
          button(tx('player_again', 'Play again'), again, { icon: '↻' }),
          next !== null || finale ? button(tx('player_levels', 'Levels'), () => api.levels(), { icon: '▦' }) : null)));
      stage.append(overlay);
      onOverlayKey = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          primary.click();
        } else if (e.key === 'r' || e.key === 'R') {
          // the engine also hears R (restart from the checkpoint): restart from the start after it
          closeOverlay();
          setTimeout(() => {
            if (handle === h) h.restart('start');
          }, 0);
        } else if (e.key === 'Escape') api.levels();
      };
      primary.focus({ preventScroll: true });
    });
  };

  const api: Player = {
    game,
    progress,
    get handle() {
      return handle;
    },
    title,
    levels: levelSelect,
    credits,
    play,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopGame();
      cleanup?.();
      cleanup = null;
      root.replaceChildren();
    },
  };

  const start = o.startLevel ?? urlLevel();
  if (start !== null && start !== undefined && start < levels.length) play(start);
  else title();
  return api;
}
