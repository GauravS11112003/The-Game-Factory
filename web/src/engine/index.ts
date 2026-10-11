/**
 * v2 engine entry (lane E, PLAN_V2 §11.3g): mountGame drives the core Sim at a fixed 60 Hz inside Phaser
 * (pixelArt: false, antialias, no roundPixels, WebGL with a Canvas fallback without boil), at render scale
 * r ∈ {1, 1.5, 2} = the smallest value ≥ min(2, devicePixelRatio × displayed CSS width / 768), re-rasterizing on
 * resize (debounced 250 ms) without restarting the scene. 'thumbnail' mode draws one static frame with no Phaser.
 *
 * The theme and the music loop come from `o.rules` (the game's rules, or the theme picker's choice) before the
 * level's resolved snapshot; both are cosmetic, so swapping them never touches the sim (`setTheme`, `setRules`,
 * `setMusic`). The player's own sound settings (mute M, music ♪) persist across levels.
 */
import Phaser from 'phaser';
import type { GameRules, InkDoc, LevelInk, LevelSkin, LevelV2, Morph, RectCells, Replay, Theme } from '../core/types.gen.ts';
import { ART, PERF } from '../core/params.ts';
import { createMixer } from '../audio/index.ts';
import { paperBase } from '../render/paper.ts';
import { artFor, renderThumbnail as renderThumb } from '../render/thumbnail.ts';
import { objectArtBox, placementWorldBox, resolveSkin, sameExceptSkin, skinOf, withSkin } from '../core/art/skin.ts';
import { resolveTheme } from '../render/themes.ts';
import { createChrome } from './chrome.ts';
import { Input } from './input.ts';
import { PlayScene } from './scene.ts';
import type { GameEvent, GameHandle, MountOptions, OverlaySpec, ScreenRect } from './types.ts';
import { screenRect } from './gfx.ts';

export type { DiePayload, GameEvent, GameHandle, GhostKind, GhostOption, GhostResult, MountOptions, OverlaySpec, ReadyPayload, ScreenRect, WinPayload } from './types.ts';
export { drawInk } from '../render/canvas_ink.ts';
export { thumbnailURL } from '../render/thumbnail.ts';
export { shareCardCanvas, shareCardFile, shareCardPNG } from '../render/sharecard.ts';
export type { ShareCardOptions, ShareCardRun } from '../render/sharecard.ts';
export { auditionTheme, renderThemeSwatch, themeCatalog, themeInfo, themeSwatch, THEME_IDS } from '../render/themes.ts';
export type { ThemeInfo } from '../render/themes.ts';
export { createMixer, readMusicEnabled, readMuted } from '../audio/index.ts';
export type { Mixer, Sfx } from '../audio/index.ts';
export { auditionMusic } from '../audio/index.ts';
export { drawCharacter, RigPreview, stillPose } from '../render/rig2d.ts';
export { RigAnimator } from '../core/art/anim.ts';
// skins (v3): mapping strokes → objects, the shared picture cache, the skin-aware 2D drawing
export { normalizeSkin, sameExceptSkin, skinCredits, skinOf, skinTargetOf, withSkin } from '../core/art/skin.ts';
export type { LevelSkin, SkinPlacement, SkinSpec } from '../core/art/skin.ts';
export { loadSkinImage, skinImagesReady } from '../render/skin.ts';
export { drawLevelArt } from '../render/thumbnail.ts';

const VIEW_W = 768;
const VIEW_H = 432;

/** r = the smallest of {1, 1.5, 2} ≥ min(2, DPR × CSS width / 768). */
export function renderScaleFor(cssWidth: number): number {
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const want = Math.min(PERF.dpr_cap, (dpr * Math.max(1, cssWidth)) / VIEW_W);
  for (const r of ART.render_scale) if (r >= want - 1e-6) return r;
  return ART.render_scale[ART.render_scale.length - 1];
}

function prefersReduced(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Feed thumbnails: the same ArtDoc → Canvas2D path as play (entities, player and goal included) with the level's skin.
 * Skin pictures not loaded yet show as the kid's ink first; the promise resolves true after the canvas repainted with
 * them (cache the canvas after awaiting it).
 */
export function renderThumbnail(c: HTMLCanvasElement, level: LevelV2, ink: InkDoc | LevelInk | null, o?: { view?: RectCells; theme?: Theme }): Promise<boolean> {
  return renderThumb(c, level, ink, o);
}

const THUMB_VIEW: RectCells = [0, 0, 48, 27];

/** A world rect (cells) on a thumbnail canvas (the first screen, letterboxed like drawInk), viewport CSS px. */
function thumbRect(c: HTMLCanvasElement, b: RectCells): ScreenRect | null {
  const rect = c.getBoundingClientRect();
  if (!(rect.width > 0) || !(c.width > 0)) return null;
  const v = THUMB_VIEW;
  const scale = Math.min(c.width / ((v[2] - v[0]) * 16), c.height / ((v[3] - v[1]) * 16)); // canvas px per world px
  const k = (scale * rect.width) / c.width;
  return screenRect(rect.left + (b[0] - v[0]) * 16 * k, rect.top + (b[1] - v[1]) * 16 * k, (b[2] - b[0]) * 16 * k, (b[3] - b[1]) * 16 * k);
}

/** objectScreenRect for a thumbnail canvas. */
function thumbObjectRect(c: HTMLCanvasElement, level: LevelV2, ink: InkDoc | LevelInk | null, theme: Theme, id: string): ScreenRect | null {
  const doc = artFor(level, ink, 1, theme);
  let b: RectCells | null = null;
  const skin = skinOf(level);
  const pl = skin ? resolveSkin(level, ink ?? level.ink ?? null, doc, skin).find((p) => (id === 'player' ? p.target.kind === 'player' : p.target.kind !== 'player' && (p.target.id === id || p.hide.includes(id)))) : undefined;
  if (pl) b = placementWorldBox(pl);
  else if (id === 'player') {
    const st = level.compiled.entities.find((e) => e.type === 'player_start');
    const [x, y] = st ? [st.x, st.y] : [2, 22];
    const pb = doc.player.bbox;
    b = [x + pb[0], y + pb[1], x + pb[2], y + pb[3]];
  } else {
    const sp = doc.sprites.find((s) => s.id === id || s.object_ids.includes(id));
    if (sp) b = [sp.anchor[0] + sp.bbox[0], sp.anchor[1] + sp.bbox[1], sp.anchor[0] + sp.bbox[2], sp.anchor[1] + sp.bbox[3]];
    else {
      const objs = level.objects ?? [];
      const byId = new Map(objs.map((x) => [x.id, x]));
      if (byId.has(id)) b = objectArtBox(doc, [id, ...objs.filter((x) => x.rel?.part_of === id).map((x) => x.id)], byId);
    }
  }
  return b ? thumbRect(c, b) : null;
}

/** The level's music loop: the mount option, else the game's rules, else the level's snapshot (default on). */
function musicFor(level: LevelV2, o: MountOptions): boolean {
  if (o.music !== undefined) return o.music;
  if (o.rules?.music !== undefined) return o.rules.music !== false;
  return level.rules?.music !== false;
}

const emptyReplay = (level: LevelV2): Replay => ({ v: 1, core: '', profile_hash: '', level_id: level.id, level_version: level.version, level_hash: level.meta?.level_hash ?? '', frames: 0, input: '' });

export function mountGame(el: HTMLElement, level: LevelV2, ink: InkDoc | LevelInk | null, o: MountOptions): GameHandle {
  const listeners = new Map<GameEvent, Set<(p: any) => void>>();
  let readyPayload: unknown = null;
  const emit = (ev: GameEvent, p: unknown): void => {
    if (ev === 'ready') readyPayload = p;
    for (const fn of listeners.get(ev) ?? []) {
      try {
        fn(p);
      } catch (e) {
        console.error(`game "${ev}" listener failed`, e);
      }
    }
  };

  // ---- thumbnail: one static frame, no Phaser, no loop ----
  if (o.mode === 'thumbnail') {
    const c = document.createElement('canvas');
    const w = Math.max(160, Math.round((el.clientWidth || 384) * Math.min(2, devicePixelRatio || 1)));
    c.width = w;
    c.height = Math.round((w * VIEW_H) / VIEW_W);
    c.style.width = '100%';
    c.style.display = 'block';
    c.dataset.role = 'thumbnail';
    el.replaceChildren(c);
    let cur = level;
    let theme: Theme = resolveTheme(o.rules, level.rules);
    void renderThumb(c, cur, ink, { theme });
    queueMicrotask(() => emit('ready', { mode: 'thumbnail', theme }));
    const noop = (): void => undefined;
    return {
      on(ev, fn) {
        const set = listeners.get(ev) ?? new Set();
        set.add(fn);
        listeners.set(ev, set);
        if (ev === 'ready' && readyPayload) fn(readyPayload);
      },
      swapLevel(next) {
        const same = sameExceptSkin(cur, next) && JSON.stringify(skinOf(cur)) === JSON.stringify(skinOf(next));
        cur = next;
        if (!same) void renderThumb(c, cur, ink, { theme });
      },
      setOverlays: noop,
      pause: noop,
      resume: noop,
      restart: noop,
      replay(): Replay {
        return emptyReplay(cur);
      },
      destroy() {
        c.remove();
        listeners.clear();
      },
      setTheme(t) {
        theme = t;
        void renderThumb(c, cur, ink, { theme });
      },
      setRules(r: Partial<GameRules>) {
        if (r.theme) this.setTheme(r.theme);
      },
      setSkin(skin: LevelSkin | null) {
        cur = withSkin(cur, skin);
        void renderThumb(c, cur, ink, { theme });
      },
      objectScreenRect(id: string): ScreenRect | null {
        try {
          return thumbObjectRect(c, cur, ink, theme, id);
        } catch {
          return null;
        }
      },
      worldToScreen(r: RectCells): ScreenRect | null {
        return thumbRect(c, r);
      },
      setCredits: noop,
      setMusic: noop,
      setUnderlay: () => false,
      snapshot() {
        return new Promise<Blob | null>((res) => {
          try {
            c.toBlob((b) => res(b), 'image/png');
          } catch {
            res(null);
          }
        });
      },
      ghosts: () => [],
    };
  }

  const reduced = o.reducedMotion ?? prefersReduced();
  const input = new Input(el);
  input.requireFocus = o.mode === 'preview';
  const mixer = o.audio === false ? null : createMixer();
  let scene: PlayScene | null = null;
  const interactive = o.mode === 'play' || o.mode === 'test' || o.mode === 'preview';
  const theme0 = resolveTheme(o.rules, level.rules);
  const music0 = musicFor(level, o);
  const chrome = createChrome(el, {
    theme: theme0,
    buttons: interactive,
    touch: interactive,
    input,
    muted: mixer?.muted ?? true,
    onMute: () => scene?.toggleMute(),
    onRestart: () => { if (!o.race) scene?.restart('checkpoint'); },
    onPause: () => { if (!o.race) scene?.isPaused ? scene.resumeGame() : scene?.pauseGame(); },
    music: mixer ? { available: music0, on: mixer.musicEnabled, onToggle: () => scene?.toggleMusicSetting() } : undefined,
    credits: o.credits !== false,
  });
  const r0 = renderScaleFor(chrome.root.clientWidth || el.clientWidth || VIEW_W);
  scene = new PlayScene({ level, ink, mount: o, theme: theme0, music: music0, r: r0, reduced, emit, input, mixer, chrome });
  let ready = false;
  const queue: (() => void)[] = [];
  const whenReady = (fn: () => void): void => {
    if (ready) fn();
    else queue.push(fn);
  };
  listeners.set('ready', new Set([() => {
    ready = true;
    for (const fn of queue.splice(0)) fn();
  }]));

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: chrome.stage,
    width: VIEW_W * r0,
    height: VIEW_H * r0,
    backgroundColor: paperBase(theme0),
    render: { pixelArt: false, antialias: true, roundPixels: false, powerPreference: 'high-performance' },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    audio: { noAudio: true },
    input: { keyboard: false, mouse: false, touch: false, gamepad: false },
    banner: false,
    disableContextMenu: true,
    scene: [scene],
  });

  // resize → re-rasterize at the new render scale (debounced 250 ms)
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        // Phaser only refits on window resizes: refit the canvas to the stage now, re-rasterize after 250 ms
        try {
          game.scale.refresh();
        } catch {
          /* not booted yet */
        }
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const r = renderScaleFor(chrome.root.clientWidth || VIEW_W);
          whenReady(() => scene?.setRenderScale(r));
        }, ART.resize_debounce_ms);
      })
    : null;
  ro?.observe(chrome.root);
  // auto-pause when the tab is hidden (play / test)
  const onVis = (): void => {
    if (document.hidden && (o.mode === 'play' || o.mode === 'test')) whenReady(() => scene?.pauseGame());
  };
  document.addEventListener('visibilitychange', onVis);
  const focus = (): void => chrome.root.focus({ preventScroll: true });
  chrome.root.addEventListener('pointerdown', focus);
  if (o.mode === 'play' || o.mode === 'test') queueMicrotask(focus);

  let destroyed = false;
  return {
    on(ev, fn) {
      const set = listeners.get(ev) ?? new Set();
      set.add(fn);
      listeners.set(ev, set);
      if (ev === 'ready' && readyPayload) fn(readyPayload);
    },
    swapLevel(next: LevelV2, so?: { morphs?: Morph[]; when?: 'now' | 'safe' }) {
      whenReady(() => scene?.swapLevel(next, so));
    },
    setOverlays(ov: OverlaySpec) {
      o.overlays = ov;
      whenReady(() => scene?.setOverlays(ov));
    },
    pause() {
      whenReady(() => scene?.pauseGame());
    },
    resume() {
      whenReady(() => scene?.resumeGame());
    },
    restart(from?: 'start' | 'checkpoint') {
      whenReady(() => scene?.restart(from ?? 'start'));
    },
    replay(): Replay {
      if (!scene || !ready) return emptyReplay(level);
      return scene.replay();
    },
    setTheme(t: Theme) {
      chrome.setTheme(t);
      whenReady(() => scene?.setTheme(t));
    },
    setRules(r: Partial<GameRules>) {
      if (r.theme) chrome.setTheme(r.theme);
      whenReady(() => scene?.setRules(r));
    },
    setMusic(on: boolean) {
      whenReady(() => scene?.setMusic(on));
    },
    setUnderlay(on: boolean): boolean {
      if (!scene || !ready) {
        whenReady(() => scene?.setUnderlay(on));
        return (level.source?.sheets ?? []).some((s) => !!(s.sketch_url ?? s.photo_url));
      }
      return scene.setUnderlay(on);
    },
    snapshot(so?: { hud?: boolean }): Promise<Blob | null> {
      if (!scene || !ready || destroyed) return Promise.resolve(null);
      return scene.snapshot(so);
    },
    ghosts() {
      return scene?.ghostStatus ?? [];
    },
    setSkin(skin: LevelSkin | null) {
      whenReady(() => scene?.setSkin(skin));
    },
    objectScreenRect(objectId: string): ScreenRect | null {
      if (!scene || !ready || destroyed) return null;
      try {
        return scene.objectScreenRect(objectId);
      } catch {
        return null;
      }
    },
    worldToScreen(r: RectCells): ScreenRect | null {
      if (!scene || !ready || destroyed) return null;
      try {
        return scene.worldToScreen(r);
      } catch {
        return null;
      }
    },
    setCredits(on: boolean) {
      chrome.setCreditsOn(on);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      scene?.shutdownAll();
      ro?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      document.removeEventListener('visibilitychange', onVis);
      chrome.root.removeEventListener('pointerdown', focus);
      input.destroy();
      try {
        game.destroy(true);
      } catch (e) {
        console.warn('game destroy', e);
      }
      mixer?.dispose();
      chrome.destroy();
      listeners.clear();
      scene = null;
    },
  };
}
