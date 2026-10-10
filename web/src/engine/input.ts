/**
 * Controls (PLAN_V2 §5.1): keyboard, gamepad (browser API) and touch, folded into the sim's 5-bit input
 * (L=1 R=2 J=4 RUN=8 D=16). Touch auto-runs after a direction is held 0.5 s; "Always run" is a setting.
 * Actions (pause, restart, mute) are edge events, never sim input.
 */
import { SIM } from '../core/params.ts';

export const BIT = SIM.input_bits;
export type Action = 'pause' | 'restart' | 'mute' | 'any';
export type TouchKey = 'left' | 'right' | 'jump' | 'down' | 'run';

const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['Space', 'KeyZ', 'ArrowUp', 'KeyW'],
  run: ['KeyX', 'ShiftLeft', 'ShiftRight'],
  down: ['ArrowDown', 'KeyS'],
} as const;
const GAME_CODES = new Set<string>(Object.values(KEYS).flat());

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
  private touch: Record<TouchKey, boolean> = { left: false, right: false, jump: false, down: false, run: false };
  private pad = { left: false, right: false, jump: false, run: false, down: false };
  private padPrev: boolean[] = [];
  private dirHeldF = 0;
  private listeners: ((a: Action) => void)[] = [];
  private root: HTMLElement;
  private enabled = true;
  alwaysRun = readAlwaysRun();
  touchUsed = false;
  /** Preview stages only take keys once clicked or tabbed into, so the page still scrolls around them. */
  requireFocus = false;

  private onDown = (e: KeyboardEvent): void => {
    if (!this.enabled || !this.focusOk(e)) return;
    if (GAME_CODES.has(e.code)) {
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
    this.touch = { left: false, right: false, jump: false, down: false, run: false };
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
    if (a.tagName === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return false;
    return this.root.isConnected;
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

  /** Poll the first connected gamepad (A jump, B/X run, d-pad / stick, Select restart, Start pause). */
  pollGamepad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const gp = Array.from(pads ?? []).find((p) => p && p.connected) ?? null;
    if (!gp) {
      this.pad = { left: false, right: false, jump: false, run: false, down: false };
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
    };
    const now = gp.buttons.map((x) => x.pressed);
    if (now[9] && !this.padPrev[9]) this.fire('pause');
    if (now[8] && !this.padPrev[8]) this.fire('restart');
    if (now.some((p, i) => p && !this.padPrev[i])) this.fire('any');
    this.padPrev = now;
  }

  /** The sim input for this frame (call once per sim step). */
  bits(): number {
    const k = (codes: readonly string[]): boolean => codes.some((c) => this.keys.has(c));
    const left = k(KEYS.left) || this.touch.left || this.pad.left;
    const right = k(KEYS.right) || this.touch.right || this.pad.right;
    const jump = k(KEYS.jump) || this.touch.jump || this.pad.jump;
    const down = k(KEYS.down) || this.touch.down || this.pad.down;
    let run = k(KEYS.run) || this.pad.run || this.touch.run;
    const touchDir = this.touch.left !== this.touch.right;
    this.dirHeldF = touchDir ? this.dirHeldF + 1 : 0;
    if (touchDir && this.dirHeldF >= SIM.auto_run_after_s * SIM.hz) run = true;
    if (this.alwaysRun && (left || right)) run = true;
    let bits = 0;
    if (left && !right) bits |= BIT.L;
    if (right && !left) bits |= BIT.R;
    if (jump) bits |= BIT.J;
    if (run) bits |= BIT.RUN;
    if (down) bits |= BIT.D;
    return bits;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.listeners = [];
  }
}
