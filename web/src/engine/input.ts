/**
 * Controls (PLAN_V2 §5.1, docs/v4/CONTRACTS_V4.md §4.1): keyboard, gamepad (browser API) and touch, folded into the
 * sim's input bits (L=1 R=2 J=4 RUN=8 D=16, v4: SPACE=64 ACTION=128) through the level's control scheme
 * (engine/controls.ts: the mode and the keys its rules listen to). Touch auto-runs after a direction is held 0.5 s;
 * "Always run" is a setting. Actions (pause, restart, mute) are edge events, never sim input.
 */
import { SIM } from '../core/params.ts';
import { anyHeld, controlScheme, foldBits, gameCodes, keysHeld, NOTHING_HELD } from './controls.ts';
import type { ControlScheme, Held } from './controls.ts';

export const BIT = SIM.input_bits;
export type Action = 'pause' | 'restart' | 'mute' | 'any';
export type TouchKey = 'left' | 'right' | 'jump' | 'down' | 'run' | 'action' | 'space';

const SETTINGS_KEY = 'dal.v2.always_run';
export function readAlwaysRun(): boolean {
  try {
    return localStorage.getItem(SETTINGS_KEY) === '1';
  } catch {
    return false;
  }
}
export function writeAlwaysRun(v: boolean): void {
  try {
    localStorage.setItem(SETTINGS_KEY, v ? '1' : '0');
  } catch {
    /* refused: lasts for this page */
  }
}

export class Input {
  private keys = new Set<string>();
  private touch: Held = { ...NOTHING_HELD };
  private pad: Held & { up: boolean } = { ...NOTHING_HELD, up: false };
  private padPrev: boolean[] = [];
  private dirHeldF = 0;
  private listeners: ((a: Action) => void)[] = [];
  private root: HTMLElement;
  private enabled = true;
  private scheme: ControlScheme = controlScheme('platformer');
  private codes = gameCodes(this.scheme);
  alwaysRun = readAlwaysRun();
  touchUsed = false;
  /** Preview stages only take keys once clicked or tabbed into, so the page still scrolls around them. */
  requireFocus = false;

  private onDown = (e: KeyboardEvent): void => {
    if (!this.enabled || !this.focusOk(e)) return;
    if (this.codes.has(e.code)) {
      e.preventDefault();
      this.keys.add(e.code);
      this.fire('any');
    }
    if (e.repeat) return;
    if (e.code === 'KeyR') this.fire('restart');
    else if (e.code === 'Escape' || e.code === 'KeyP') this.fire('pause');
    else if (e.code === 'KeyM') this.fire('mute');
  };
  private onUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private onBlur = (): void => {
    this.keys.clear();
    this.touch = { ...NOTHING_HELD };
  };

  constructor(root: HTMLElement) {
    this.root = root;
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Keys only drive the game when nothing else (a text field, another widget) has focus. */
  private focusOk(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return false;
    const a = document.activeElement;
    if (a && this.root.contains(a)) return true;
    if (this.requireFocus) return false;
    if (!a || a === document.body || a === document.documentElement) return this.root.isConnected;
    // a focused button elsewhere (e.g. the dial): let Space/Enter activate it, arrows still play
    if (a.tagName === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter')) return false;
    return this.root.isConnected;
  }

  /** The level's control scheme (its mode and the keys its rules listen to). */
  setScheme(s: ControlScheme): void {
    this.scheme = s;
    this.codes = gameCodes(s);
  }

  get controls(): ControlScheme {
    return this.scheme;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) this.onBlur();
  }

  on(fn: (a: Action) => void): void {
    this.listeners.push(fn);
  }

  fire(a: Action): void {
    for (const fn of this.listeners) fn(a);
  }

  setTouch(k: TouchKey, v: boolean): void {
    this.touch[k] = v;
    this.touchUsed = true;
    if (v) this.fire('any');
  }

  /** Poll the first connected gamepad (A jump, B/X run, Y action, RB space, d-pad / stick, Select restart, Start pause). */
  pollGamepad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const gp = Array.from(pads ?? []).find((p) => p && p.connected) ?? null;
    if (!gp) {
      this.pad = { ...NOTHING_HELD, up: false };
      return;
    }
    const b = (i: number): boolean => !!gp.buttons[i]?.pressed;
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    this.pad = {
      left: b(14) || ax < -0.4,
      right: b(15) || ax > 0.4,
      jump: b(0),
      run: b(1) || b(2),
      down: b(13) || ay > 0.55,
      up: b(12) || ay < -0.55,
      action: b(3),
      space: b(5),
    };
    const now = gp.buttons.map((x) => x.pressed);
    if (now[9] && !this.padPrev[9]) this.fire('pause');
    if (now[8] && !this.padPrev[8]) this.fire('restart');
    if (now.some((p, i) => p && !this.padPrev[i])) this.fire('any');
    this.padPrev = now;
  }

  /** The sim input for this frame (call once per sim step). */
  bits(): number {
    const s = this.scheme;
    // top-down walks up with the d-pad / stick; elsewhere A jumps (the d-pad's up never did)
    const pad = s.mode === 'topdown' ? { ...this.pad, jump: this.pad.up } : this.pad;
    const h = anyHeld(keysHeld(this.keys, s), this.touch, pad);
    const touchDir = this.touch.left !== this.touch.right;
    this.dirHeldF = touchDir ? this.dirHeldF + 1 : 0;
    if (touchDir && this.dirHeldF >= SIM.auto_run_after_s * SIM.hz) h.run = true;
    if (this.alwaysRun && (h.left || h.right || (s.mode === 'topdown' && (h.jump || h.down)))) h.run = true;
    return foldBits(h, s);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.listeners = [];
  }
}
