/**
 * The Studio runtime (docs/v6/CONTRACTS_V6.md §4): plays a GameDoc with Phaser 3 + Matter physics.
 *
 *   mountRuntime(parent, doc, { scene?, onEvent?, muted? }) → { stop, restart, setPaused, counters }
 *
 * Layers: normalize.ts (doc → plain model, never throws) → world.ts + behaviors.ts (pure rules engine and behaviour
 * logic, tested in node) → scene.ts (Phaser/Matter adapter) + hud.ts (DOM overlay) + sound.ts (WebAudio). This file
 * owns the lifecycle: the Phaser game, keyboard listeners, scene changes, win / lose / pause cards and counter events.
 * Several runtimes can live side by side; stop() frees everything.
 */
import Phaser from 'phaser';
import type { GameDoc } from '../../core/types.gen.ts';
import { t } from '../../app/messages.ts';
import { buildRecolorMap, fullTheme, type FullTheme } from '../theme/color.ts';
import { hashStr } from '../theme/rng.ts';
import { InputState } from './behaviors.ts';
import { Hud } from './hud.ts';
import { allGameCodes } from './keys.ts';
import { normalizeDoc, type NDoc } from './normalize.ts';
import { PlayScene, type SceneLink } from './scene.ts';
import { Sound } from './sound.ts';
import type { World } from './world.ts';
import './runtime.css';

export interface RuntimeEvent {
  type: 'ready' | 'win' | 'lose' | 'scene' | 'counter' | 'say' | 'destroyed' | 'spawned' | 'error';
  scene?: string;
  object?: string;
  counter?: string;
  value?: number;
  text?: string;
}

export interface RuntimeOptions {
  scene?: string; // scene id to start in (default: the first)
  onEvent?: (e: RuntimeEvent) => void;
  muted?: boolean;
}

export interface RuntimeHandle {
  stop(): void;
  restart(): void;
  setPaused(paused: boolean): void;
  /** Live counters: `game` plus one entry per object id that has counters (the Studio's watch panel). */
  counters(): Record<string, Record<string, number>>;
}

const GAME_CODES = allGameCodes();

function editable(t: EventTarget | null): boolean {
  const e = t as HTMLElement | null;
  if (!e || !e.tagName) return false;
  return e.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName);
}

class Runner {
  doc: NDoc;
  theme: FullTheme;
  root: HTMLDivElement;
  stage: HTMLDivElement;
  hud: Hud;
  sound: Sound;
  input = new InputState();
  game: Phaser.Game | null = null;
  world: World | null = null;
  scene: PlayScene | null = null;
  sceneIndex = 0;
  firstScene = 0;
  counters: Record<string, number>;
  startCounters: Record<string, number>;
  paused = false;
  userPaused = false;
  state: 'playing' | 'won' | 'lost' | 'moving' = 'playing';
  stopped = false;
  timers: ReturnType<typeof setTimeout>[] = [];
  pendingCounters = new Map<string, RuntimeEvent>();
  lastFlush = 0;
  sceneTime = 0;
  recolor: Map<string, string> | null;
  texScale: number;
  private onEvent?: (e: RuntimeEvent) => void;
  private listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [];

  constructor(parent: HTMLElement, raw: GameDoc, o: RuntimeOptions) {
    this.onEvent = o.onEvent;
    const { doc, errors } = normalizeDoc(raw);
    this.doc = doc;
    this.theme = fullTheme(doc.theme);
    this.recolor = this.theme.recolor ? buildRecolorMap(doc.scenes.flatMap((s) => s.objects.map((x) => x.drawing)), this.theme) : null;
    this.counters = { ...doc.counters };
    this.startCounters = { ...doc.counters };
    const start = o.scene ? doc.scenes.findIndex((s) => s.id === o.scene) : 0;
    this.sceneIndex = Math.max(0, start);
    this.firstScene = this.sceneIndex;
    this.root = document.createElement('div');
    this.root.className = 'rt-root';
    this.root.tabIndex = 0;
    (this.root as HTMLDivElement & { __runtime?: Runner }).__runtime = this; // debugging aid (dev page, tests)
    this.root.style.background = this.theme.palette.bg;
    this.stage = document.createElement('div');
    this.stage.className = 'rt-stage';
    this.root.append(this.stage);
    parent.append(this.root);
    this.sound = new Sound(!!o.muted);
    this.hud = new Hud(this.root, doc, this.theme, {
      onMute: () => {
        this.sound.resume();
        this.sound.setMuted(!this.sound.isMuted);
        this.hud.setMuted(this.sound.isMuted);
      },
      onPause: () => this.togglePause(),
    });
    this.hud.setMuted(!!o.muted);
    const rect = parent.getBoundingClientRect();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.texScale = Math.round(Math.max(1, Math.min(2, ((rect.width || 1600) / 1600) * dpr)) * 2) / 2;
    for (const e of errors) this.emit({ type: 'error', text: e });
    this.setupInput();
    this.setupTouch();
    this.sound.music(this.theme.music, hashStr(doc.id));
    this.boot();
  }

  emit(e: RuntimeEvent): void {
    try {
      this.onEvent?.(e);
    } catch {
      /* the host's handler must not break the game */
    }
  }

  private on(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private setupInput(): void {
    const down = (ev: Event): void => {
      const k = ev as KeyboardEvent;
      if (this.stopped || editable(k.target) || k.ctrlKey || k.metaKey || k.altKey) return;
      if (!this.root.isConnected) return;
      this.sound.resume();
      if (k.code === 'KeyP') {
        this.togglePause();
        return;
      }
      if (k.code === 'KeyM') {
        this.sound.setMuted(!this.sound.isMuted);
        this.hud.setMuted(this.sound.isMuted);
        return;
      }
      if ((k.code === 'Enter' || k.code === 'Space') && this.hud.cardShown && this.state !== 'playing') {
        k.preventDefault();
        (this.root.querySelector('.rt-primary') as HTMLButtonElement | null)?.click();
        return;
      }
      // keep arrows / space from scrolling the page, but leave the host's own buttons their Enter and Space
      const tgt = k.target as Node | null;
      const ours = !tgt || tgt === document.body || tgt === document.documentElement || (tgt instanceof Node && this.root.contains(tgt));
      if (GAME_CODES.has(k.code) && (ours || !['Enter', 'Space', 'NumpadEnter'].includes(k.code))) k.preventDefault();
      if (k.repeat) return;
      this.input.keyDown(k.code);
      this.world?.key('key_down', k.code);
    };
    const up = (ev: Event): void => {
      const k = ev as KeyboardEvent;
      if (this.stopped) return;
      this.input.keyUp(k.code);
      this.world?.key('key_up', k.code);
    };
    this.on(window, 'keydown', down);
    this.on(window, 'keyup', up);
    this.on(window, 'blur', () => this.input.clear());
    this.on(document, 'visibilitychange', () => {
      if (document.hidden) this.input.clear();
    });
    this.on(this.root, 'pointerdown', () => this.sound.resume());
  }

  private setupTouch(): void {
    const used = { left: false, right: false, up: false, down: false, jump: false, action: false, action2: false };
    const all = this.doc.scenes.flatMap((s) => s.objects);
    for (const o of all) {
      if (!o.player) continue;
      for (const b of o.behaviors) {
        if (b.type === 'platformer') Object.assign(used, { left: true, right: true, jump: true });
        if (b.type === 'move_keys') {
          const ax = b.params.axes;
          if (ax !== 'y') Object.assign(used, { left: true, right: true });
          if (ax !== 'x') Object.assign(used, { up: true, down: true });
        }
        if (b.type === 'car' || b.type === 'thrust_ship') Object.assign(used, { left: true, right: true, up: b.type === 'thrust_ship' });
        if (b.type === 'shooter' && b.params.key !== 'auto' && b.params.key !== 'click') used[b.params.key === 'action2' ? 'action2' : b.params.key === 'space' ? 'jump' : 'action'] = true;
        if (b.type === 'melee') used[b.params.key === 'action2' ? 'action2' : 'action'] = true;
      }
    }
    const rules = [...this.doc.rules, ...this.doc.scenes.flatMap((s) => [...s.rules, ...s.objects.flatMap((o) => o.rules)])];
    for (const r of rules) {
      if (r.when.type !== 'key_down' && r.when.type !== 'key_up') continue;
      const k = String(r.when.params.key);
      if (k in used) (used as Record<string, boolean>)[k] = true;
      if (k === 'space' || k === 'w') used.jump = true;
    }
    this.hud.setTouch(used, (codes, isDown) => {
      this.sound.resume();
      for (const c of codes) {
        if (isDown) {
          this.input.keyDown(c);
          this.world?.key('key_down', c);
        } else {
          this.input.keyUp(c);
          this.world?.key('key_up', c);
        }
      }
    });
  }

  private link(): SceneLink {
    return {
      doc: this.doc,
      sceneIndex: this.sceneIndex,
      gameCounters: this.counters,
      input: this.input,
      sound: this.sound,
      theme: this.theme,
      recolor: this.recolor,
      texScale: this.texScale,
      isPaused: () => this.paused || this.stopped,
      emit: (e) => this.emit(e),
      counterChanged: (subject, counter, value) => {
        this.pendingCounters.set(`${subject}|${counter}`, { type: 'counter', object: subject === 'game' ? undefined : subject, counter, value });
      },
      win: (text) => this.win(text),
      lose: (text) => this.lose(text),
      nextScene: () => this.nextScene(),
      goScene: (id) => this.goScene(id),
      onWorld: (w, s) => this.onWorld(w, s),
      say: (text) => this.hud.toast(text),
    };
  }

  private boot(): void {
    try {
      this.game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: this.stage,
        width: 1600,
        height: 900,
        backgroundColor: this.theme.palette.bg,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        physics: {
          default: 'matter',
          matter: { gravity: { x: 0, y: 0 }, autoUpdate: false, enableSleeping: false, positionIterations: 8, velocityIterations: 6,
            constraintIterations: 4, debug: false },
        },
        input: { keyboard: false, gamepad: false },
        audio: { noAudio: true },
        banner: false,
        disableContextMenu: true,
        render: { antialias: this.theme.stroke.style !== 'pixel', roundPixels: false },
        fps: { target: 60, smoothStep: true },
      });
      this.game.scene.add('play', PlayScene, true, { link: this.link() });
    } catch (err) {
      this.emit({ type: 'error', text: `runtime failed to start: ${String((err as Error)?.message ?? err)}` });
    }
  }

  private onWorld(w: World, s: PlayScene): void {
    this.world = w;
    this.scene = s;
    this.state = 'playing';
    this.sceneTime = 0;
    this.hud.hideCard();
    this.hud.setup(w);
    const sc = this.doc.scenes[this.sceneIndex];
    if (this.doc.scenes.length > 1) this.hud.banner(sc.name || t('rt.level', { n: this.sceneIndex + 1 }));
    this.emit({ type: 'scene', scene: sc.id });
    this.emit({ type: 'ready', scene: sc.id });
    this.sound.duckMusic(false);
    // HUD and counter events follow the game's frames
    s.events.on('postupdate', (_t: number, delta: number) => this.frame(delta));
  }

  private frame(delta: number): void {
    if (!this.world || this.stopped) return;
    if (!this.paused && this.state === 'playing') this.sceneTime += delta / 1000;
    this.hud.update(this.world, this.sceneTime);
    const now = performance.now();
    if (this.pendingCounters.size && now - this.lastFlush >= 100) {
      this.lastFlush = now;
      for (const e of this.pendingCounters.values()) this.emit(e);
      this.pendingCounters.clear();
    }
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(() => {
      if (!this.stopped) fn();
    }, ms));
  }

  private startScene(index: number, counters: Record<string, number>): void {
    if (this.stopped || !this.game) return;
    this.sceneIndex = index;
    this.counters = { ...counters };
    this.startCounters = { ...counters };
    this.input.clear();
    this.pendingCounters.clear();
    for (const k of Object.keys(this.counters)) this.pendingCounters.set(`game|${k}`, { type: 'counter', counter: k, value: this.counters[k] });
    try {
      const sc = this.game.scene.getScene('play') as PlayScene | null;
      if (sc) sc.scene.restart({ link: this.link() });
      else this.game.scene.add('play', PlayScene, true, { link: this.link() });
    } catch (err) {
      this.emit({ type: 'error', text: String((err as Error)?.message ?? err) });
    }
  }

  win(text?: string): void {
    if (this.state !== 'playing' || !this.world) return;
    this.state = 'won';
    this.world.over = true;
    const sc = this.scene;
    sc?.burst('confetti', sc.worldCam.midPoint.x, sc.worldCam.worldView.bottom, 80);
    sc?.burst('confetti', sc.worldCam.worldView.left + 100, sc.worldCam.worldView.bottom, 50);
    sc?.burst('confetti', sc.worldCam.worldView.right - 100, sc.worldCam.worldView.bottom, 50);
    this.sound.play('fanfare');
    this.sound.duckMusic(true);
    const title = text ? t(text) : t('rt.you_win');
    this.emit({ type: 'win', scene: this.doc.scenes[this.sceneIndex].id, text: title });
    const score = this.world.game.score;
    const sub = score !== undefined ? t('rt.score_line', { score }) : this.doc.hud.timer ? t('rt.time_line', { time: Math.round(this.sceneTime) }) : '';
    this.later(700, () => this.hud.showCard('win', title, sub, [
      { label: t('rt.play_again'), primary: true, run: () => this.restartGame() },
    ]));
  }

  lose(text?: string): void {
    if (this.state !== 'playing' || !this.world) return;
    this.state = 'lost';
    this.world.over = true;
    this.sound.play('lose');
    this.sound.duckMusic(true);
    this.scene?.shake(0.8);
    this.emit({ type: 'lose', scene: this.doc.scenes[this.sceneIndex].id, text });
    const retry = (): void => {
      if (this.state === 'lost') this.startScene(this.sceneIndex, this.startCounters);
    };
    this.later(500, () => this.hud.showCard('lose', t('rt.oops'), text ? t(text) : '', [{ label: t('rt.try_again'), primary: true, run: retry }]));
    this.later(2600, retry);
  }

  nextScene(): void {
    if (this.state !== 'playing' || !this.world) return;
    if (this.sceneIndex >= this.doc.scenes.length - 1) {
      this.win();
      return;
    }
    this.state = 'moving';
    this.world.over = true;
    this.sound.play('fanfare');
    const carry = { ...this.world.game };
    this.hud.showCard('level', t('rt.level_done'), '', []);
    this.later(1100, () => this.startScene(this.sceneIndex + 1, carry));
  }

  goScene(id: string): void {
    const i = this.doc.scenes.findIndex((s) => s.id === id || s.name === id);
    if (i < 0 || this.state !== 'playing' || !this.world) return;
    this.state = 'moving';
    this.world.over = true;
    const carry = { ...this.world.game };
    this.later(300, () => this.startScene(i, carry));
  }

  restartGame(): void {
    this.startScene(this.firstScene, { ...this.doc.counters });
  }

  togglePause(): void {
    if (this.state !== 'playing') return;
    this.setPaused(!this.userPaused, true);
  }

  setPaused(p: boolean, fromUser = false): void {
    this.paused = p;
    this.userPaused = p && fromUser;
    if (p) {
      this.input.clear();
      this.sound.duckMusic(true);
      this.sound.engine(0);
      if (fromUser && this.state === 'playing') {
        this.hud.showCard('pause', t('rt.paused'), '', [
          { label: t('rt.resume'), primary: true, run: () => this.setPaused(false) },
          { label: t('rt.restart'), run: () => {
            this.setPaused(false);
            this.startScene(this.sceneIndex, this.startCounters);
          } },
        ]);
      }
    } else {
      this.sound.duckMusic(false);
      if (this.state === 'playing') this.hud.hideCard();
    }
  }

  countersSnapshot(): Record<string, Record<string, number>> {
    try {
      return this.world ? this.world.countersSnapshot() : { game: { ...this.counters } };
    } catch {
      return { game: {} };
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const tm of this.timers) clearTimeout(tm);
    for (const [target, type, fn, opts] of this.listeners) target.removeEventListener(type, fn, opts);
    this.listeners = [];
    try {
      this.game?.destroy(true);
    } catch {
      /* already gone */
    }
    this.game = null;
    this.world = null;
    this.sound.dispose();
    this.hud.destroy();
    this.root.remove();
  }
}

export function mountRuntime(parent: HTMLElement, doc: GameDoc, o: RuntimeOptions = {}): RuntimeHandle {
  let r: Runner | null = null;
  try {
    r = new Runner(parent, doc, o);
  } catch (err) {
    try {
      o.onEvent?.({ type: 'error', text: `runtime failed to start: ${String((err as Error)?.message ?? err)}` });
    } catch {
      /* ignore */
    }
  }
  return {
    stop: () => r?.stop(),
    restart: () => r?.restartGame(),
    setPaused: (p: boolean) => r?.setPaused(p),
    counters: () => r?.countersSnapshot() ?? { game: {} },
  };
}
