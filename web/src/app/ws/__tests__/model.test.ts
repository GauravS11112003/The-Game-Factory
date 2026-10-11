/** v4 workspace helpers (lane D): status chips, rule-card sentences, rule ids, block filters, tags and defaults. */
import { describe, expect, it } from 'vitest';
import type { BlockCard, DesignBlock, Flag, LevelV2, RuleDo, RuleV4, RuleWhen } from '../../../core/types.gen.ts';
import type { LevelCard } from '../../api.ts';
import { hasMessage, t } from '../../messages.ts';
import {
  BEHAVIOURS, blockDoes, collisionFor, defaultBehaviour, fallbackRuleParts, filterBlocks, firstLevel, fixCount, levelStatus,
  parseTags, sortBlocks, statusText, withFreshIds,
} from '../model.ts';

const flag = (severity: Flag['severity'], code: Flag['code'] = 'tight_window'): Flag => ({ id: `f_${severity}`, code, severity });

function design(o: Partial<DesignBlock> = {}): DesignBlock {
  return {
    tier: 'polished', band: 'easy', C: 0.2, score: 30, fastest_ms: 12000, par_ms: 18000, casual_clear_s: 30, segments: [],
    flags: [], solvable: true, reach: {}, source: 'greedy', ...o,
  };
}

const level = (d: DesignBlock | null, created = '2026-10-01T00:00:00Z'): LevelV2 => ({ design: d, created_at: created } as unknown as LevelV2);

function block(o: Partial<BlockCard>): BlockCard {
  return { id: 'blk_aaaaaaaa', version: 1, name: 'Zappy', kind: 'creature', author: 'Kai', created_at: '2026-10-01T00:00:00Z', ...o };
}

describe('level status', () => {
  it('counts only hard and block flags as things to fix', () => {
    expect(fixCount([flag('warn'), flag('info'), flag('hard'), flag('block'), flag('target')])).toBe(2);
    expect(fixCount(null)).toBe(0);
  });

  it('is beatable, N to fix, or not checked yet', () => {
    expect(levelStatus(null)).toEqual({ kind: 'unchecked' });
    expect(levelStatus(level(null))).toEqual({ kind: 'unchecked' });
    expect(levelStatus(level(design()))).toEqual({ kind: 'beat' });
    expect(levelStatus(level(design({ flags: [flag('warn')] })))).toEqual({ kind: 'beat' });
    expect(levelStatus(level(design({ flags: [flag('hard'), flag('block')] })))).toEqual({ kind: 'fix', n: 2 });
    expect(levelStatus(level(design({ solvable: false })))).toEqual({ kind: 'fix', n: 1 });
  });

  it('says it in words', () => {
    expect(statusText({ kind: 'beat' })).toBe('Beatable');
    expect(statusText({ kind: 'fix', n: 3 })).toBe('3 to fix');
    expect(statusText({ kind: 'unchecked' })).toBe('Not checked yet');
  });

  it('picks the asked level, else the newest, else the last', () => {
    const card = (id: string, created: string | null): LevelCard => ({ id, level: created ? level(design(), created) : null } as unknown as LevelCard);
    const ls = [card('a', '2026-10-01T00:00:00Z'), card('b', '2026-10-05T00:00:00Z'), card('c', null)];
    expect(firstLevel(ls, 'c')?.id).toBe('c');
    expect(firstLevel(ls, 'nope')?.id).toBe('b');
    expect(firstLevel([card('x', null), card('y', null)], null)?.id).toBe('y');
    expect(firstLevel([], null)).toBeNull();
  });
});

describe('rule cards without the core', () => {
  const rule = (when: RuleWhen, ...then: RuleDo[]): RuleV4 => ({ id: 'r1', when, then: then as RuleV4['then'] });

  it('reads "space flips gravity" as two parts', () => {
    const parts = fallbackRuleParts(rule({ kind: 'key', key: 'space' }, { kind: 'flip_gravity' }));
    expect(parts.map((p) => p.key)).toEqual(['gw.rule.when_key_space', 'gw.rule.do_flip_gravity']);
    expect(parts.map((p) => t(p.key, p.args ?? {}))).toEqual(['When you press space', 'flip gravity']);
  });

  it('says timed effects with their seconds, and until-respawn ones without', () => {
    const [, timed] = fallbackRuleParts(rule({ kind: 'start' }, { kind: 'speed', times: 1.6, seconds: 5 }));
    expect(t(timed.key, timed.args ?? {})).toBe('speed × 1.6 for 5 seconds');
    const [, held] = fallbackRuleParts(rule({ kind: 'start' }, { kind: 'speed', times: 2, seconds: null }));
    expect(t(held.key, held.args ?? {})).toBe('speed × 2');
  });

  it('has a sentence for every trigger and action', () => {
    const whens: RuleWhen[] = [
      { kind: 'start' }, { kind: 'key', key: 'action' }, { kind: 'touch', target: 'star_1' }, { kind: 'collect', target: 'e1' },
      { kind: 'collect', item: 'coin' }, { kind: 'collect', item: 'star' }, { kind: 'all_coins' }, { kind: 'timer', seconds: 10 },
      { kind: 'timer', seconds: 10, every: true }, { kind: 'zone', rect: [0, 0, 2, 2] }, { kind: 'score', at_least: 50 },
      { kind: 'counter', name: 'stars', at_least: 5 },
    ];
    const dos: RuleDo[] = [
      { kind: 'flip_gravity' }, { kind: 'gravity', times: 0.5, seconds: 3 }, { kind: 'jump_power', times: 1.4 }, { kind: 'reverse_controls', seconds: 4 },
      { kind: 'teleport', to: [3, 4] }, { kind: 'teleport', target: 'e2' }, { kind: 'toggle', target: 'e3', to: 'off' }, { kind: 'toggle', target: 'e3' },
      { kind: 'open', target: 'door_1' }, { kind: 'freeze_enemies', seconds: 3 }, { kind: 'add_score', n: 10 }, { kind: 'add_counter', name: 'stars' },
      { kind: 'heal' }, { kind: 'hurt' }, { kind: 'win' }, { kind: 'lose' }, { kind: 'say', text: 'hi' }, { kind: 'sound', name: 'ding' }, { kind: 'shake' },
    ];
    const keys = [...whens.map((w) => fallbackRuleParts(rule(w, { kind: 'win' }))[0]), ...dos.map((d) => fallbackRuleParts(rule({ kind: 'start' }, d))[1])];
    expect(keys.filter((k) => !hasMessage(k.key)).map((k) => k.key)).toEqual([]);
    // raw codes never show: entity ids with underscores come out as words
    expect(t(keys[2].key, keys[2].args ?? {})).toBe('When you touch star 1');
    expect(t(keys[4].key, keys[4].args ?? {})).toBe('When you collect a coin');
  });

  it('gives added rules ids that are new in the game', () => {
    const have: RuleV4[] = [rule({ kind: 'start' }, { kind: 'win' }), { ...rule({ kind: 'start' }, { kind: 'win' }), id: 'g3' }];
    const out = withFreshIds(have, [rule({ kind: 'all_coins' }, { kind: 'win' }), rule({ kind: 'start' }, { kind: 'heal' })]);
    expect(out.map((r) => r.id)).toEqual(['g4', 'g5']);
    expect(withFreshIds([], [rule({ kind: 'start' }, { kind: 'win' })], 'r')[0].id).toBe('r1');
  });
});

describe('blocks', () => {
  const list = [
    block({ id: 'blk_1', name: 'Zappy', kind: 'creature', uses: 2, created_at: '2026-10-02T00:00:00Z', tags: ['spooky'] }),
    block({ id: 'blk_2', name: 'Lava lift', kind: 'platform', uses: 9, created_at: '2026-10-01T00:00:00Z', description: 'Goes up over lava' }),
    block({ id: 'blk_3', name: 'Flip pack', kind: 'rules', uses: 0, created_at: '2026-10-03T00:00:00Z', author: 'Mo' }),
  ];

  it('filters by words (name, author, description, tags) and kind', () => {
    expect(filterBlocks(list, { q: 'lava' }).map((b) => b.id)).toEqual(['blk_2']);
    expect(filterBlocks(list, { q: 'SPOOKY' }).map((b) => b.id)).toEqual(['blk_1']);
    expect(filterBlocks(list, { q: 'mo' }).map((b) => b.id)).toEqual(['blk_3']);
    expect(filterBlocks(list, { kind: 'creature' }).map((b) => b.id)).toEqual(['blk_1']);
    expect(filterBlocks(list, { q: 'zappy', kind: 'rules' })).toEqual([]);
    expect(filterBlocks(list, {})).toHaveLength(3);
  });

  it('sorts newest first or most used first', () => {
    expect(sortBlocks(list, 'new').map((b) => b.id)).toEqual(['blk_3', 'blk_1', 'blk_2']);
    expect(sortBlocks(list, 'popular').map((b) => b.id)).toEqual(['blk_2', 'blk_1', 'blk_3']);
  });

  it('says what a block does', () => {
    const walker = defaultBehaviour('enemy');
    expect(blockDoes({ kind: 'creature', behavior: walker, spiky: true, logic: [] })).toBe('Walks · spiky');
    const rules: RuleV4[] = [{ id: 'r1', when: { kind: 'start' }, then: [{ kind: 'win' }] }, { id: 'r2', when: { kind: 'start' }, then: [{ kind: 'heal' }] }];
    expect(blockDoes({ kind: 'rules', behavior: null, spiky: false, logic: rules })).toBe('2 rules');
    expect(blockDoes({ kind: 'pickup', behavior: { kind: 'pickup', effect: 'speed' }, spiky: false, logic: [] })).toBe('makes you fast');
    expect(blockDoes({ kind: 'prop', behavior: { kind: 'zone', effect: 'low_gravity' }, spiky: false })).toBe('floaty low gravity');
  });

  it('reads tags: trimmed, lower case, no repeats, at most 8 of 20 letters', () => {
    expect(parseTags(' Lava, cave ,CAVE,, #spooky')).toEqual(['lava', 'cave', 'spooky']);
    expect(parseTags('a,b,c,d,e,f,g,h,i,j')).toHaveLength(8);
    expect(parseTags('x'.repeat(30))[0]).toHaveLength(20);
  });

  it('has a default behaviour for every kind the studio offers', () => {
    for (const k of BEHAVIOURS) expect(defaultBehaviour(k, 'Hi').kind).toBe(k);
    expect(collisionFor(defaultBehaviour('move'))).toBe('one_way');
    expect(collisionFor(defaultBehaviour('spring'))).toBe('solid');
    expect(collisionFor(defaultBehaviour('enemy'))).toBe('none');
    expect(collisionFor(null)).toBe('none');
  });
});
