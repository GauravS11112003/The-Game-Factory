/**
 * The game stage used by the preview and the play screen: one mountGame (§11.3g) that swaps levels in place.
 * In the preview (not playing) swaps are immediate with morphs; while playing they wait for the next respawn, pause
 * or goal ("never yank the level mid-jump", §3.11). Mode changes (preview ↔ test, ghosts) remount.
 */
import type { CellXY, GameRules, InkDoc, LevelV2, Morph } from '../core/types.gen.ts';
import { mountGame, type GameHandle, type GhostOption, type OverlaySpec } from '../engine/index.ts';
import type { GameEvent } from '../engine/types.ts';
import { h, prefersReducedMotion } from './dom.ts';
import { t } from './messages.ts';
import { store } from './store.ts';

export type StageMode = 'preview' | 'test' | 'play';

export interface StageShow {
  level: LevelV2;
  ink: InkDoc;
  rules?: GameRules;
  morphs?: Morph[];
}

type Listener = { ev: GameEvent; fn: (p: any) => void };

export class Stage {
  readonly el: HTMLDivElement;
  private host: HTMLDivElement;
  private handle: GameHandle | null = null;
  private mode: StageMode = 'preview';
  private current: StageShow | null = null;
  private ghosts: GhostOption[] = [];
  private overlays: OverlaySpec = {};
  private listeners: Listener[] = [];
  private startAt: CellXY | undefined;
  private underlay = false;
  failed = false;

  constructor(cls = 'stage') {
    this.host = h('div', { class: 'stage-host' });
    this.el = h('div', { class: cls }, this.host);
  }

  get playing(): boolean {
    return this.mode !== 'preview';
  }

  get level(): LevelV2 | null {
    return this.current?.level ?? null;
  }

  on(ev: GameEvent, fn: (p: any) => void): void {
    this.listeners.push({ ev, fn });
    this.handle?.on(ev, fn);
  }

  /** Show a level: swap in place when possible, otherwise mount. */
  show(s: StageShow, o: { when?: 'now' | 'safe' } = {}): void {
    const sameWorld = this.current && this.current.level.world.w === s.level.world.w;
    const prevInk = this.current?.ink;
    this.current = s;
    if (this.handle && sameWorld && prevInk === s.ink) {
      try {
        this.handle.swapLevel(s.level, { morphs: s.morphs, when: o.when ?? (this.playing ? 'safe' : 'now') });
        return;
      } catch (e) {
        console.warn('swapLevel failed; remounting', e);
      }
    }
    this.mount();
  }

  setMode(mode: StageMode, o: { ghosts?: GhostOption[]; startAt?: CellXY } = {}): void {
    this.mode = mode;
    this.ghosts = o.ghosts ?? [];
    this.startAt = o.startAt;
    this.mount();
  }

  setOverlays(spec: OverlaySpec): void {
    this.overlays = spec;
    try {
      this.handle?.setOverlays(spec);
    } catch (e) {
      console.warn('setOverlays failed', e);
    }
  }

  /** "My original sketch" at 15% behind a paper level (lane E); false when the level has no sheet photos. */
  setUnderlay(on: boolean): boolean {
    this.underlay = on;
    try {
      return this.handle?.setUnderlay ? this.handle.setUnderlay(on) : false;
    } catch {
      return false;
    }
  }

  restart(from: 'start' | 'checkpoint' = 'start'): void {
    this.handle?.restart(from);
  }

  pause(): void {
    this.handle?.pause();
  }

  resume(): void {
    this.handle?.resume();
  }

  /** The current frame as a PNG (the win moment, for a share card); null when the engine can't. */
  snapshot(o: { hud?: boolean } = {}): Promise<Blob | null> {
    try {
      return this.handle?.snapshot ? this.handle.snapshot(o) : Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
  }

  replay(): ReturnType<GameHandle['replay']> | null {
    try {
      return this.handle?.replay() ?? null;
    } catch {
      return null;
    }
  }

  private mount(): void {
    this.handle?.destroy();
    this.handle = null;
    this.failed = false;
    this.host.replaceChildren();
    const s = this.current;
    if (!s) return;
    try {
      this.handle = mountGame(this.host, s.level, s.ink, {
        mode: this.mode, rules: s.rules ?? s.level.rules, startAt: this.startAt, ghosts: this.ghosts.length ? this.ghosts : undefined,
        overlays: this.overlays, audio: this.mode !== 'preview' && !store.flag('muted'), reducedMotion: prefersReducedMotion(),
        record: this.mode === 'play', underlay: this.underlay,
      });
      for (const l of this.listeners) this.handle.on(l.ev, l.fn);
    } catch (e) {
      console.warn('mountGame failed', e);
      this.failed = true;
      this.host.replaceChildren(h('div', { class: 'stage-fallback' }, h('p', null, t('ui.stage_not_ready'))));
    }
  }

  destroy(): void {
    this.handle?.destroy();
    this.handle = null;
    this.el.remove();
  }
}
