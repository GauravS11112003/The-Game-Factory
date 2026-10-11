/** The v4 view, read defensively (docs/v4/CONTRACTS_V4.md §4.2), and the level facts the engine derives. */
import { describe, expect, it } from 'vitest';
import type { PlayerView, SimView } from '../../core/sim/types.ts';
import type { LevelV2 } from '../../core/types.gen.ts';
import { gravityOf, levelKeys, levelMode, levelUsesScore, mergeKeys, poseInput, toggleTargets, v4Of } from '../v4.ts';

const player = (o: Partial<PlayerView> = {}): PlayerView => ({ x: 4, y: 20, vx: 0, vy: 0, facing: 1, on_ground: true, state: 'idle', invulnerable_f: 0, ...o });

const v2View = (): SimView => ({
  frame: 1, player: player(), entities: [], coins: 0, big_coins_held: 0, big_coins_banked: 0, deaths: 0, lives: null, hearts: 1,
  checkpoint: null, timer_frames_left: null, won: false,
});

/** A level shell with only what these helpers read. */
const level = (rules: Record<string, unknown>, compiled: Record<string, unknown> = {}): LevelV2 =>
  ({ rules: { version: 1, ...rules }, compiled: { tiles: { legend: '.#=/\\abcd~X', rows: [] }, entities: [], ...compiled } }) as unknown as LevelV2;

describe('v4Of', () => {
  it('reads a v2 view as the v2 defaults', () => {
    expect(v4Of(v2View())).toEqual({
      mode: 'platformer', gravity: 1, score: 0, counters: {}, effects: { speed_f: 0, jump_f: 0, gravity_f: 0, reverse_f: 0, freeze_f: 0 },
      say: null, uses_keys: [],
    });
    expect(v4Of(null).mode).toBe('platformer');
  });

  it('reads the v4 fields when the sim reports them', () => {
    const v = {
      ...v2View(), mode: 'topdown', gravity: -1, score: 30, counters: { stars: 2, bad: 'x' },
      effects: { speed_f: 120, jump_f: 0, gravity_f: -1, reverse_f: 0, freeze_f: 60 },
      say: { text: 'Hi!', target: 'npc1', frames_left: 90 }, uses_keys: ['action', 'jump', 'space'],
    } as unknown as SimView;
    const x = v4Of(v);
    expect(x.mode).toBe('topdown');
    expect(x.gravity).toBe(-1);
    expect(x.score).toBe(30);
    expect(x.counters).toEqual({ stars: 2 });
    expect(x.effects.gravity_f).toBe(-1);
    expect(x.say).toEqual({ text: 'Hi!', target: 'npc1', frames_left: 90 });
    expect(x.uses_keys).toEqual(['space', 'action']);
  });

  it('drops an empty bubble and an unknown mode', () => {
    const v = { ...v2View(), mode: 'sideways', say: { text: '  ', target: null, frames_left: 3 } } as unknown as SimView;
    expect(v4Of(v).say).toBeNull();
    expect(v4Of(v).mode).toBe('platformer');
  });

  it('takes the gravity sign from the player view too', () => {
    expect(gravityOf(player({ gravity: -1 } as Partial<PlayerView>))).toBe(-1);
    expect(gravityOf(player())).toBe(1);
    expect(v4Of({ ...v2View(), player: player({ gravity: -1 } as Partial<PlayerView>) }).gravity).toBe(-1);
  });
});

describe('level facts', () => {
  const rule = (id: string, when: unknown, then: unknown[]): unknown => ({ id, when, then });

  it('mode: null and absent are platformer', () => {
    expect(levelMode(level({}))).toBe('platformer');
    expect(levelMode(level({ mode: null }))).toBe('platformer');
    expect(levelMode(level({ mode: 'flappy' }))).toBe('flappy');
  });

  it('keys from game-wide and level rules', () => {
    expect(levelKeys(level({}))).toEqual([]);
    expect(levelKeys(level({ logic: [rule('r1', { kind: 'key', key: 'space' }, [{ kind: 'flip_gravity' }])] }))).toEqual(['space']);
    expect(levelKeys(level({ logic: null }, { logic: [rule('r1', { kind: 'key', key: 'action' }, [{ kind: 'shake' }])] }))).toEqual(['action']);
    expect(mergeKeys(['action'], ['space'])).toEqual(['space', 'action']);
  });

  it('score shows when a rule adds to it or waits for it', () => {
    expect(levelUsesScore(level({}))).toBe(false);
    expect(levelUsesScore(level({}, { logic: [rule('r1', { kind: 'collect', target: 'p1' }, [{ kind: 'add_score', n: 10 }])] }))).toBe(true);
    expect(levelUsesScore(level({ logic: [rule('r1', { kind: 'score', at_least: 50 }, [{ kind: 'win' }])] }))).toBe(true);
    expect(levelUsesScore(level({ logic: [rule('r1', { kind: 'start' }, [{ kind: 'add_counter', name: 'stars' }])] }))).toBe(false);
  });

  it('toggle targets: rule targets and entities that start hidden', () => {
    const lv = level({ logic: [rule('r1', { kind: 'key', key: 'action' }, [{ kind: 'toggle', target: 'bridge', to: 'flip' }])] }, {
      entities: [{ id: 'gem', type: 'pickup', x: 3, y: 3, hidden: true }, { id: 'c1', type: 'coin', x: 1, y: 1 }],
    });
    expect([...toggleTargets(lv)].sort()).toEqual(['bridge', 'gem']);
  });
});

describe('poseInput', () => {
  it('passes platformer motion through', () => {
    const p = player({ vx: 50, vy: -200, on_ground: false, state: 'jump' });
    expect(poseInput(p, 'platformer')).toEqual({ vx: 50, vy: -200, onGround: false, state: 'jump' });
  });

  it('top-down: walking in any direction is a walk on the ground, never a jump or a fall', () => {
    const up = poseInput(player({ vx: 0, vy: -90, on_ground: false, state: 'fall', facing: -1 }), 'topdown');
    expect(up).toEqual({ vx: -90, vy: 0, onGround: true, state: 'run' });
    expect(poseInput(player({ vx: 0, vy: 0, on_ground: false, state: 'jump' }), 'topdown').state).toBe('idle');
    expect(poseInput(player({ state: 'dead' }), 'topdown').state).toBe('dead');
  });
});
