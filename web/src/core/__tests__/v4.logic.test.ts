/// <reference types="node" />
/** v4 written rules (docs/v4/CONTRACTS_V4.md §2.4): core.parseLogic, core.describeRule, the v2 parser hand-off. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRule, parseLogic, parseRules } from '../index.ts';
import { LOGIC_MESSAGE_KEYS } from '../logic/index.ts';
import type { RuleV4, SceneGraph } from '../types.gen.ts';
import { dispatch } from '../worker/dispatch.ts';
import { stubResult } from '../worker/stub.ts';
import { SPEC_DIR, readJson } from './helpers.ts';

const one = (s: string, ids: string[] = [], aliases: Record<string, string> = {}) => parseLogic([s], ids, { aliases });

describe('parseLogic: the §2.4 examples', () => {
  it('keys', () => {
    expect(one('space flips gravity').rules).toEqual([{ id: 'r1', when: { kind: 'key', key: 'space' }, then: [{ kind: 'flip_gravity' }] }]);
    expect(one('press E to flip gravity').rules[0]).toMatchObject({ when: { kind: 'key', key: 'action' }, then: [{ kind: 'flip_gravity' }] });
    expect(one('enter makes you fast').rules[0]).toMatchObject({ when: { kind: 'key', key: 'action' }, then: [{ kind: 'speed', times: 1.6 }] });
  });

  it('timers with an unknown action stay unknown; all coins; touching a star', () => {
    const lava = one('every 10 seconds lava rises');
    expect([lava.rules, lava.unknown]).toEqual([[], ['every 10 seconds lava rises']]);
    expect(one('get all coins to win').rules[0]).toMatchObject({ when: { kind: 'all_coins' }, then: [{ kind: 'win' }] });
    expect(one('touching the star gives you a speed boost').rules[0]).toMatchObject({
      when: { kind: 'collect', item: 'star' }, then: [{ kind: 'speed', times: 1.6, seconds: 5 }],
    });
    expect(one('touching the star gives you a speed boost', ['o3'], { star: 'o3' }).rules[0].when).toEqual({ kind: 'touch', target: 'o3' });
  });

  it('modes, hearts and counters', () => {
    expect(one("it's like flappy bird")).toMatchObject({ rules: [], mode: 'flappy', unknown: [] });
    expect(one('top-down').mode).toBe('topdown');
    expect(one('runner').mode).toBe('runner');
    expect(one('you have 3 hearts')).toMatchObject({ rules: [], mode: null, unknown: ['you have 3 hearts'] });
    expect(one('collect 5 stars to win').rules).toEqual([
      { id: 'r1', when: { kind: 'collect', item: 'star' }, then: [{ kind: 'add_counter', name: 'stars', n: 1 }] },
      { id: 'r2', when: { kind: 'counter', name: 'stars', at_least: 5 }, then: [{ kind: 'win' }] },
    ]);
  });

  it('ids run r1, r2, … across sentences; source is keywords', () => {
    const r = parseLogic(['space flips gravity', 'collect 3 gems to win', 'the platform moves left', 'every 5 seconds shake the screen'], []);
    expect(r.rules.map((x) => x.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(r.unknown).toEqual(['the platform moves left']);
    expect(r.source).toBe('keywords');
  });
});

describe('parseLogic: variants', () => {
  const cases: [string, Partial<RuleV4>][] = [
    ['Press space to jump higher for 3 seconds', { when: { kind: 'key', key: 'space' }, then: [{ kind: 'jump_power', times: 1.4, seconds: 3 }] }],
    ['after 30 seconds you lose', { when: { kind: 'timer', seconds: 30, every: false }, then: [{ kind: 'lose' }] }],
    ['when your score reaches 50 you win', { when: { kind: 'score', at_least: 50 }, then: [{ kind: 'win' }] }],
    ['collecting a coin gives you 10 points', { when: { kind: 'collect', item: 'coin' }, then: [{ kind: 'add_score', n: 10 }] }],
    ['touching the door opens it', { when: { kind: 'touch', target: 'o7' }, then: [{ kind: 'open', target: 'o7' }] }],
    ['gravity is low', { when: { kind: 'start' }, then: [{ kind: 'gravity', times: 0.5 }] }],
    ['hit enter to freeze the monsters', { when: { kind: 'key', key: 'action' }, then: [{ kind: 'freeze_enemies', seconds: 5 }] }],
    ['touching the monster teleports you to the checkpoint', { when: { kind: 'touch', target: 'o9' }, then: [{ kind: 'teleport', target: 'cp1' }] }],
    ['press e and the npc says "hello there"', { when: { kind: 'key', key: 'action' }, then: [{ kind: 'say', text: 'hello there', seconds: 3 }] }],
    ['the controls are reversed', { when: { kind: 'start' }, then: [{ kind: 'reverse_controls' }] }],
    ['grab the red gem to show the door', { when: { kind: 'collect', item: 'gem' }, then: [{ kind: 'toggle', target: 'o7', to: 'on' }] }],
    ['when the level starts say "go go go"', { when: { kind: 'start' }, then: [{ kind: 'say', text: 'go go go', seconds: 3 }] }],
    ['Space: flip!', { when: { kind: 'key', key: 'space' }, then: [{ kind: 'flip_gravity' }] }],
    ['every 5 seconds the screen shakes', { when: { kind: 'timer', seconds: 5, every: true }, then: [{ kind: 'shake' }] }],
  ];
  it.each(cases)('%s', (s, want) => {
    const r = one(s, ['o7', 'o9', 'cp1'], { door: 'o7', monster: 'o9', checkpoint: 'cp1' });
    expect(r.rules.length).toBe(1);
    expect(r.rules[0]).toMatchObject(want);
    expect(r.rules[0].off).toBeUndefined();
  });

  it.each(['the key opens the door', 'you have 60 seconds', 'the platform moves left', 'the monster is fast', 'when you enter the cave you slow down', 'press space to jump', 'it is in space'])(
    'leaves v2 or unknown sentences alone: %s',
    (s) => expect(one(s, [], { door: 'o7' }).rules).toEqual([]),
  );
});

describe('describeRule', () => {
  const core = readJson<{ messages: Record<string, string> }>(join(SPEC_DIR, 'messages-v4', 'core.json')).messages;

  it('gives one sentence per part with logic.when / logic.do keys', () => {
    const r = describeRule({ id: 'r1', when: { kind: 'key', key: 'space' }, then: [{ kind: 'flip_gravity' }, { kind: 'speed', times: 2, seconds: 3 }], once: true });
    expect(r).toEqual([
      { key: 'logic.when.key_space', args: {} }, { key: 'logic.do.flip_gravity', args: {} },
      { key: 'logic.do.speed_timed', args: { times: 2, seconds: 3 } }, { key: 'logic.once', args: {} },
    ]);
  });

  it('every key it can return has a sentence in messages-v4/core.json, with matching placeholders', () => {
    for (const k of LOGIC_MESSAGE_KEYS) expect(core[k], k).toBeTypeOf('string');
    const all: RuleV4[] = parseLogic([
      'space flips gravity', 'collect 5 stars to win', 'every 2 seconds you get 3 points', 'after 4 seconds you lose',
      'touching the door opens it', 'when your score reaches 9 hide the door', 'press e to say "hi"', 'get all coins and play a ding',
    ], ['o7'], { aliases: { door: 'o7' } }).rules;
    for (const r of all) {
      for (const m of describeRule(r)) {
        expect(core[m.key], m.key).toBeTypeOf('string');
        for (const ph of core[m.key].match(/\{(\w+)\}/g) ?? []) expect(m.args, `${m.key} ${ph}`).toHaveProperty(ph.slice(1, -1));
      }
    }
  });
});

describe('the v2 rules parser and the worker', () => {
  const graph: SceneGraph = {
    objects: [
      { id: 'o7', components: [7], strokes: ['s7'], role: 'door', conf: 1, role_by: 'heuristic', origin: 'kid', shape: { k: 'wall', x: 10, y0: 18, y1: 22, w: 1 }, collision: 'solid', rel: {}, pinned: [] },
      { id: 'o8', components: [8], strokes: ['s8'], role: 'platform', conf: 1, role_by: 'heuristic', origin: 'kid', shape: { k: 'surface', segs: [{ a: [14, 16], b: [18, 16], slope: 0 }], fill: 'one_row' }, collision: 'one_way', rel: {}, pinned: [] },
    ],
  };

  it('parseRules skips sentences that became logic and keeps the rest', () => {
    expect(parseRules('space flips gravity. touching the door opens it', graph, null).edits).toEqual([]);
    expect(parseRules('space flips gravity. the platform moves left', graph, null).edits.map((e) => e.op.op)).toEqual(['bind']);
  });

  it('worker parse_logic answers with the keyword parser; the stub has a canned answer', () => {
    const r = dispatch({ id: 4, method: 'parse_logic', params: { sentences: ['space flips gravity', 'you have 3 hearts'], entity_ids: [] } }, { runtime: 'test' });
    expect(r.ok).toBe(true);
    expect((r as { result: { rules: RuleV4[]; unknown: string[] } }).result.unknown).toEqual(['you have 3 hearts']);
    const s = stubResult('parse_logic', { sentences: ['a', 'b'] }) as { rules: RuleV4[]; unknown: string[]; source: string };
    expect([s.rules.length, s.unknown, s.source]).toEqual([1, ['b'], 'keywords']);
  });
});
