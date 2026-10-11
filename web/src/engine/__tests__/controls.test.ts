/** Control decisions (docs/v4/CONTRACTS_V4.md §3, §4.1): which keys send which bits, by mode and bound keys. */
import { describe, expect, it } from 'vitest';
import { anyHeld, controlHints, controlScheme, foldBits, gameCodes, keysHeld, NOTHING_HELD, sameScheme } from '../controls.ts';
import type { ControlScheme } from '../controls.ts';
import { IN_ACTION, IN_SPACE } from '../v4.ts';

const L = 1;
const R = 2;
const J = 4;
const RUN = 8;
const D = 16;

/** The bits for a set of held key codes under a scheme. */
const press = (s: ControlScheme, ...codes: string[]): number => foldBits(keysHeld(new Set(codes), s), s);

describe('control scheme: Space', () => {
  it('is Jump when no rule listens to it (v2)', () => {
    const s = controlScheme('platformer', []);
    expect(s.spaceBound).toBe(false);
    expect(press(s, 'Space')).toBe(J);
    expect(press(s, 'KeyW')).toBe(J);
    expect(press(s, 'KeyZ')).toBe(J);
  });

  it('sends IN_SPACE only when a rule listens to it; Jump stays on W / ↑ / Z', () => {
    const s = controlScheme('platformer', ['space']);
    expect(s.spaceBound).toBe(true);
    expect(press(s, 'Space')).toBe(IN_SPACE);
    expect(press(s, 'KeyW')).toBe(J);
    expect(press(s, 'ArrowUp')).toBe(J);
    expect(press(s, 'KeyZ')).toBe(J);
    expect(press(s, 'Space', 'KeyW')).toBe(IN_SPACE | J);
  });

  it('is always a game key (never scrolls the page)', () => {
    expect(gameCodes(controlScheme('platformer', [])).has('Space')).toBe(true);
    expect(gameCodes(controlScheme('topdown', [])).has('Space')).toBe(true);
  });
});

describe('control scheme: the action key', () => {
  it('E and Enter send IN_ACTION when a rule listens to it', () => {
    const s = controlScheme('platformer', ['action']);
    expect(press(s, 'KeyE')).toBe(IN_ACTION);
    expect(press(s, 'Enter')).toBe(IN_ACTION);
    expect(press(s, 'NumpadEnter')).toBe(IN_ACTION);
    expect(press(s, 'Space')).toBe(J); // Space untouched
    expect(gameCodes(s).has('KeyE')).toBe(true);
  });

  it('E and Enter stay free on a level without an action rule (v2 never sees bit 128)', () => {
    const s = controlScheme('platformer', []);
    expect(press(s, 'KeyE')).toBe(0);
    expect(press(s, 'Enter')).toBe(0);
    expect(gameCodes(s).has('KeyE')).toBe(false);
    expect(gameCodes(s).has('Enter')).toBe(false);
    // even a held source cannot set an unbound bit
    expect(foldBits({ ...NOTHING_HELD, action: true, space: true }, s)).toBe(0);
  });

  it('keeps both keys apart when both are bound', () => {
    const s = controlScheme('runner', ['space', 'action']);
    expect(press(s, 'Space', 'KeyE')).toBe(IN_SPACE | IN_ACTION);
    expect(s.keys).toEqual(['space', 'action']);
  });
});

describe('control scheme: modes', () => {
  it('platformer is v2: arrows / WASD, X or Shift runs, ↓ / S is Down', () => {
    const s = controlScheme(null, []);
    expect(s.mode).toBe('platformer');
    expect(press(s, 'ArrowLeft')).toBe(L);
    expect(press(s, 'KeyD')).toBe(R);
    expect(press(s, 'ArrowLeft', 'ArrowRight')).toBe(0); // left and right cancel
    expect(press(s, 'KeyX', 'ArrowRight')).toBe(R | RUN);
    expect(press(s, 'KeyS')).toBe(D);
    expect(s.touch).toMatchObject({ pad: true, jump: 'jump', big: false, down: true, run: true, action: false, space: false });
  });

  it('top-down walks up with ↑ / W (IN_J) and down with ↓ / S (IN_D); no jump key', () => {
    const s = controlScheme('topdown', []);
    expect(press(s, 'KeyW')).toBe(J);
    expect(press(s, 'ArrowUp')).toBe(J);
    expect(press(s, 'KeyS')).toBe(D);
    expect(press(s, 'ArrowDown', 'ArrowLeft')).toBe(D | L);
    expect(press(s, 'Space')).toBe(0);
    expect(press(s, 'KeyZ')).toBe(0);
    expect(s.touch).toMatchObject({ pad: true, jump: 'up', big: false, down: true });
  });

  it('top-down with a Space rule: Space is the rule key, still not a jump', () => {
    const s = controlScheme('topdown', ['space']);
    expect(press(s, 'Space')).toBe(IN_SPACE);
    expect(press(s, 'KeyW')).toBe(J);
  });

  it('runner and flappy show one big Jump / Flap button on touch', () => {
    const run = controlScheme('runner', []);
    expect(run.touch).toMatchObject({ pad: false, jump: 'jump', big: true, down: false, run: false, alwaysRun: false });
    const flap = controlScheme('flappy', ['action']);
    expect(flap.touch).toMatchObject({ pad: false, jump: 'flap', big: true, action: true, space: false });
    expect(press(flap, 'Space')).toBe(J); // flap
  });

  it('an unknown mode plays as a platformer', () => {
    expect(controlScheme('moonwalk' as never, []).mode).toBe('platformer');
  });
});

describe('held sources and hints', () => {
  it('folds keyboard, touch and gamepad together', () => {
    const s = controlScheme('platformer', ['action']);
    const h = anyHeld(keysHeld(new Set(['ArrowRight']), s), { jump: true }, { action: true });
    expect(foldBits(h, s)).toBe(R | J | IN_ACTION);
  });

  it('compares schemes by mode and keys', () => {
    expect(sameScheme(controlScheme('runner', ['space']), controlScheme('runner', ['space']))).toBe(true);
    expect(sameScheme(controlScheme('runner', []), controlScheme('runner', ['space']))).toBe(false);
    expect(sameScheme(controlScheme('runner', []), controlScheme('flappy', []))).toBe(false);
  });

  it('a plain platformer needs no note; v4 schemes say how to play', () => {
    expect(controlHints(controlScheme('platformer', []))).toEqual([]);
    expect(controlHints(controlScheme('topdown', [])).map((h) => h.key)).toEqual(['play4.hint_topdown']);
    expect(controlHints(controlScheme('platformer', ['space', 'action'])).map((h) => h.key)).toEqual(['play4.hint_action', 'play4.hint_space']);
    const flap = controlHints(controlScheme('flappy', ['space']));
    expect(flap[0]).toMatchObject({ key: 'play4.hint_flappy', args: { keys: 'W, Z or ↑' } });
    expect(flap[1].key).toBe('play4.hint_space_short');
  });
});
