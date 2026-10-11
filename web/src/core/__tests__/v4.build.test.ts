/// <reference types="node" />
/** v4 builds (docs/v4/CONTRACTS_V4.md §2.4, §5): typed rules → compiled.logic, mode → the rules snapshot, v4 behaviours
 * → entities, pickup effects → rules, hidden; v2 builds unchanged. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, inkFromStrokes, levelHash, perceiveHeuristic, validateLevel } from '../index.ts';
import type { BuildInput } from '../index.ts';
import { resolveRules } from '../build/level.ts';
import type { EditOp, EditRecord, LevelV2, LibraryType } from '../types.gen.ts';
import { LEVELS_DIR, readJson } from './helpers.ts';

const ex = readJson<LevelV2>(join(LEVELS_DIR, 'valid', 'example_2screen.json'));

function input(typed: string[] = [], o: Partial<BuildInput> = {}): BuildInput {
  const ink = inkFromStrokes(ex.ink!.strokes, ex.world, { typed_rules: typed.map((text) => ({ text, target: null })) });
  const graph0 = perceiveHeuristic(ink, { library: o.library ?? [], parent: null });
  return { ink, graph0, edits: [], rules: ex.rules, library: [], parent: null, tier: 'faithful', repairUnsolvable: true, seed: 1, ...o };
}

function rec(op: EditOp, k: number): EditRecord {
  return {
    id: `u${k}`, op, class: 'U', by: 'kid', stage: 'ink', tier: 'faithful', status: 'applied', reason_key: 'understand.library', reason_args: {},
    reason_text: null, depends_on: [], required: false, group: null, validation: null, ghost: null, reject_reason: null, cid: null,
  };
}

function libType(id: string, kind: LibraryType['kind'], behavior: LibraryType['behavior']): LibraryType {
  return { id, game_id: 'g', version: 1, name: id, letter: 'X', kind, behavior, collision: 'none', art: { strokes: [], size_cells: [1, 1] } as unknown as LibraryType['art'], author: 'a', created_at: 't' };
}

describe('v4 build', () => {
  it('a v2 build carries no logic and no mode', () => {
    const r = build(input());
    expect('logic' in r.level.compiled).toBe(false);
    expect('mode' in r.level.rules || 'logic' in r.level.rules).toBe(false);
    expect(resolveRules({ version: 1 })).toEqual(resolveRules({ version: 1, mode: 'platformer', logic: [] }));
  });

  it('typed rules become compiled.logic (r1, r2, …) and a named mode goes into the rules snapshot', () => {
    const r = build(input(['space flips gravity. it is a runner', 'collect 3 coins to win', 'the platform moves left']));
    expect(r.level.rules.mode).toBe('runner');
    expect(r.level.compiled.logic?.map((x) => [x.id, x.when.kind])).toEqual([['r1', 'key'], ['r2', 'collect'], ['r3', 'counter']]);
    expect(validateLevel(r.level).ok).toBe(true);
    expect(r.level.meta.level_hash).toBe(levelHash(r.level));
  });

  it('given logic is used as is (no keyword parse) and `mode` overrides the game', () => {
    const logic = [{ id: 'm1', when: { kind: 'start' as const }, then: [{ kind: 'shake' as const }] as [{ kind: 'shake' }] }];
    const r = build(input(['space flips gravity'], { logic, mode: 'topdown', rules: { ...ex.rules, mode: 'runner' } }));
    expect(r.level.compiled.logic).toEqual(logic);
    expect(r.level.rules.mode).toBe('topdown');
    const none = build(input(['space flips gravity'], { logic: [] }));
    expect(none.level.compiled.logic).toBeUndefined();
  });

  it('game-wide logic stays in the resolved rules snapshot', () => {
    const g = [{ id: 'g1', when: { kind: 'all_coins' as const }, then: [{ kind: 'win' as const }] as [{ kind: 'win' }] }];
    expect(build(input([], { rules: { ...ex.rules, logic: g } })).level.rules.logic).toEqual(g);
  });

  it('library portal / pickup types and kid bindings become v4 entities; pickup effects become rules; hidden → hidden', () => {
    const lib = [
      libType('lt_portal', 'prop', { kind: 'portal', pair: 'a' }),
      libType('lt_star', 'pickup', { kind: 'pickup', item: 'star', effect: 'speed', seconds: 4 }),
    ];
    const base = input([], { library: lib });
    const ids = base.graph0.objects.filter((o) => !o.rel.part_of && ['spikes', 'enemy', 'coin'].includes(o.role)).map((o) => o.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const sky = base.graph0.objects.find((o) => o.role === 'unknown' || o.role === 'decoration') ?? base.graph0.objects[base.graph0.objects.length - 1];
    const edits = [
      rec({ op: 'use_library', target: ids[0], type_id: 'lt_portal', version: 1 }, 1),
      rec({ op: 'use_library', target: ids[1], type_id: 'lt_portal', version: 1 }, 2),
      rec({ op: 'use_library', target: ids[2], type_id: 'lt_star', version: 1, hidden: true } as EditOp, 3),
      rec({ op: 'bind', target: sky.id, behavior: { kind: 'zone', effect: 'water', dir: 'up', strength: 1 } }, 4),
    ];
    const r = build({ ...base, edits });
    const ents = r.level.compiled.entities;
    const portals = ents.filter((e) => e.type === 'portal');
    expect(portals.map((p) => (p as { pair?: string }).pair)).toEqual([portals[1].id, portals[0].id]);
    expect(ents.find((e) => e.id === ids[2])).toMatchObject({ type: 'pickup', item: 'star', hidden: true });
    expect(ents.find((e) => e.id === sky.id)).toMatchObject({ type: 'zone', effect: 'water' });
    expect(r.level.compiled.logic).toContainEqual({ id: `pk_${ids[2]}`, when: { kind: 'collect', target: ids[2] }, then: [{ kind: 'speed', times: 1.6, seconds: 4 }] });
    expect(validateLevel(r.level).ok).toBe(true);
  });
});
