/**
 * Control schemes (docs/v4/CONTRACTS_V4.md §3, §4.1): which keys and touch buttons drive which sim input bit for a
 * level's mode and the keys its rules listen to. Pure decisions, kept out of the DOM so node tests can check them;
 * engine/input.ts holds the live key / touch / gamepad state and folds it through here once per sim step.
 *
 * - Space is Jump (v2) unless a rule listens to Space: then Space sends IN_SPACE only and Jump stays on W / ↑ / Z.
 * - E and Enter send IN_ACTION when a rule listens to the action key (otherwise they stay free: a v2 level never
 *   sees bit 128, so its clock and replays are exactly as before).
 * - Top-down: ↑ / W walk up (IN_J), ↓ / S walk down (IN_D); there is no jump button.
 * - Runner and flappy: touch shows one big Jump / Flap button (the run is automatic).
 */
import type { GameMode, RuleKey } from '../core/types.gen.ts';
import { SIM } from '../core/params.ts';
import { IN_ACTION, IN_SPACE, modeOf, RULE_KEYS } from './v4.ts';

const BIT = SIM.input_bits;

export interface TouchLayout {
  /** The ◀ ▶ pad (left thumb). */
  pad: boolean;
  /** The right thumb's main button: Jump, Flap (flappy) or ▲ (top-down: walk up). */
  jump: 'jump' | 'flap' | 'up';
  /** One big main button (runner, flappy). */
  big: boolean;
  down: boolean;
  run: boolean;
  alwaysRun: boolean;
  /** Buttons for keys a rule listens to. */
  action: boolean;
  space: boolean;
}

export interface ControlScheme {
  mode: GameMode;
  keys: RuleKey[];
  spaceBound: boolean;
  actionBound: boolean;
  codes: { left: string[]; right: string[]; jump: string[]; down: string[]; run: string[]; space: string[]; action: string[] };
  touch: TouchLayout;
}

/** What is held this frame, before folding into bits. */
export interface Held {
  left: boolean;
  right: boolean;
  jump: boolean;
  down: boolean;
  run: boolean;
  space: boolean;
  action: boolean;
}

export const NOTHING_HELD: Readonly<Held> = { left: false, right: false, jump: false, down: false, run: false, space: false, action: false };

export function controlScheme(mode: GameMode | null | undefined, keys: readonly RuleKey[] = []): ControlScheme {
  const m = modeOf(mode);
  const ks = RULE_KEYS.filter((k) => keys.includes(k));
  const spaceBound = ks.includes('space');
  const actionBound = ks.includes('action');
  const topdown = m === 'topdown';
  const oneButton = m === 'runner' || m === 'flappy';
  const jump = topdown ? ['ArrowUp', 'KeyW'] : spaceBound ? ['KeyZ', 'ArrowUp', 'KeyW'] : ['Space', 'KeyZ', 'ArrowUp', 'KeyW'];
  return {
    mode: m,
    keys: ks,
    spaceBound,
    actionBound,
    codes: {
      left: ['ArrowLeft', 'KeyA'],
      right: ['ArrowRight', 'KeyD'],
      jump,
      down: ['ArrowDown', 'KeyS'],
      run: ['KeyX', 'ShiftLeft', 'ShiftRight'],
      space: spaceBound ? ['Space'] : [],
      action: actionBound ? ['KeyE', 'Enter', 'NumpadEnter'] : [],
    },
    touch: {
      pad: !oneButton,
      jump: topdown ? 'up' : m === 'flappy' ? 'flap' : 'jump',
      big: oneButton,
      down: !oneButton,
      run: !oneButton,
      alwaysRun: !oneButton,
      action: actionBound,
      space: spaceBound,
    },
  };
}

/** Key codes the game takes (and keeps from scrolling the page). Space always: it is Jump or a rule's key. */
export function gameCodes(s: ControlScheme): Set<string> {
  const c = s.codes;
  return new Set(['Space', ...c.left, ...c.right, ...c.jump, ...c.down, ...c.run, ...c.space, ...c.action]);
}

/** The keyboard's part of Held. */
export function keysHeld(down: ReadonlySet<string>, s: ControlScheme): Held {
  const k = (codes: readonly string[]): boolean => codes.some((c) => down.has(c));
  const c = s.codes;
  return { left: k(c.left), right: k(c.right), jump: k(c.jump), down: k(c.down), run: k(c.run), space: k(c.space), action: k(c.action) };
}

/** Any source held (keyboard, touch, gamepad). */
export function anyHeld(...hs: Partial<Held>[]): Held {
  const out = { ...NOTHING_HELD };
  for (const h of hs) for (const k of Object.keys(out) as (keyof Held)[]) out[k] ||= !!h[k];
  return out;
}

/** Held → the sim's input bits. Left and right together cancel; unbound keys never set their bit. */
export function foldBits(h: Held, s: ControlScheme): number {
  let bits = 0;
  if (h.left && !h.right) bits |= BIT.L;
  if (h.right && !h.left) bits |= BIT.R;
  if (h.jump) bits |= BIT.J;
  if (h.run) bits |= BIT.RUN;
  if (h.down) bits |= BIT.D;
  if (h.space && s.spaceBound) bits |= IN_SPACE;
  if (h.action && s.actionBound) bits |= IN_ACTION;
  return bits;
}

export function sameScheme(a: ControlScheme, b: ControlScheme): boolean {
  return a.mode === b.mode && a.keys.join() === b.keys.join();
}

export interface Hint {
  key: string;
  args?: Record<string, unknown>;
  fallback: string;
}

/** A short "how to play" note for a scheme that differs from v2's (empty for a plain platformer). */
export function controlHints(s: ControlScheme): Hint[] {
  const out: Hint[] = [];
  const jumpKeys = s.spaceBound ? 'W, Z or ↑' : 'Space, W or ↑';
  if (s.mode === 'topdown') out.push({ key: 'play4.hint_topdown', fallback: 'Walk around with the arrow keys or W A S D.' });
  else if (s.mode === 'runner') out.push({ key: 'play4.hint_runner', args: { keys: jumpKeys }, fallback: 'You run by yourself. Jump with {keys}.' });
  else if (s.mode === 'flappy') out.push({ key: 'play4.hint_flappy', args: { keys: jumpKeys }, fallback: 'Tap {keys} to flap.' });
  // most useful first: the note shows what fits on one plate
  if (s.actionBound) out.push({ key: 'play4.hint_action', fallback: 'Press E or Enter for your special move.' });
  if (s.spaceBound) {
    out.push(s.mode === 'platformer'
      ? { key: 'play4.hint_space', fallback: 'Space has a trick here: jump with W, Z or ↑.' }
      : { key: 'play4.hint_space_short', fallback: 'Space has a trick here!' });
  }
  return out;
}
