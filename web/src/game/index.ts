/**
 * Engine entry point (PLAN.md section 10, "Engine details"). Owned by lane B.
 *
 * mountGame boots a Phaser game inside `container`, loads the level's backdrop,
 * sprite and component crops, and runs LevelScene. The screens never touch
 * Phaser directly; they only hold a GameHandle. renderThumbnail draws the
 * ink-style grid on a plain canvas (no Phaser) for feed cards.
 */
import Phaser from 'phaser';
import type { Level } from '../types';
import { GAME_H, GAME_W } from './constants';
import { LevelScene, type GameEvent } from './LevelScene';
import { PAPER, renderThumbnail } from './tiles';
import { createTouchControls } from './touch';

export type { GameEvent };
export { renderThumbnail };

export interface GameHandle {
  destroy(): void;
  restart(): void;
  on(event: GameEvent, fn: (payload?: any) => void): void;
}

export interface MountOptions {
  /** Shows collision tiles at alpha 0.35, arcade bodies and the solver overlay, with a HUD toggle. */
  debug?: boolean;
  /**
   * Prefixed to every relative image_url / backdrop_url / sprite url.
   * '' in dev because Vite proxies /uploads; the LAN API origin otherwise.
   */
  assetBase?: string;
}

type Listener = (payload?: any) => void;

export function mountGame(container: HTMLElement, level: Level, opts: MountOptions = {}): GameHandle {
  const listeners = new Map<GameEvent, Set<Listener>>();
  let ready = false;
  let readyPayload: unknown;

  const emit = (event: GameEvent, payload?: unknown): void => {
    if (event === 'ready') {
      ready = true;
      readyPayload = payload;
    }
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[draw-a-level] listener for "${event}" threw`, err);
      }
    }
  };

  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const touch = createTouchControls(container);
  const scene = new LevelScene({ level, debug: !!opts.debug, assetBase: opts.assetBase ?? '', touch, emit });

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: container,
    width: GAME_W,
    height: GAME_H,
    backgroundColor: PAPER,
    pixelArt: true,
    transparent: false,
    banner: false,
    audio: { noAudio: true },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: GAME_W,
      height: GAME_H,
    },
    physics: {
      default: 'arcade',
      arcade: { gravity: { x: 0, y: 0 }, debug: false },
    },
    input: { keyboard: true, mouse: true, touch: true },
    scene: [scene],
  });

  let destroyed = false;

  // Phaser measures its parent once at boot and then only on window resize. A
  // container that is detached or 0x0 at mount time (a screen that builds its
  // tree before appending it) would leave the canvas styled 0x0 forever, so
  // re-measure whenever the container's box changes.
  const resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (!destroyed && game.isBooted) game.scale.refresh();
        })
      : null;
  resizeObserver?.observe(container);

  const handle: GameHandle = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      resizeObserver?.disconnect();
      listeners.clear();
      touch?.destroy();
      // Phaser runs the real teardown on its next loop step. Until then its
      // keyboard manager still captures arrows/space on window and marks them
      // defaultPrevented, which makes a game mounted right after this one
      // ignore those keys (forever, if this loop never steps again, e.g. in a
      // hidden tab). Detach it now.
      const kb = game.input?.keyboard;
      if (kb) {
        kb.enabled = false;
        kb.stopListeners();
      }
      game.destroy(true);
    },
    restart() {
      if (destroyed) return;
      const s = game.scene.getScene(LevelScene.KEY);
      if (s) s.scene.restart();
    },
    on(event, fn) {
      if (destroyed) return;
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      // A listener attached after the scene already came up still gets its ready.
      if (event === 'ready' && ready) fn(readyPayload);
    },
  };
  // Non-enumerable escape hatch for devtools/debugging; not part of the GameHandle contract.
  Object.defineProperty(handle, '__phaser', { value: game, enumerable: false });
  return handle;
}
