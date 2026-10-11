/// <reference types="node" />
/** v4 bot (docs/v4/CONTRACTS_V4.md §1.4): honest reports — solvable only when the bot actually won, approximate when
 * the analysis is rough; v2 analysis untouched. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze, replayOfTrace, verifyRun } from '../index.ts';
import type { LevelV2 } from '../types.gen.ts';
import { LEVELS_DIR, readJson } from './helpers.ts';
import { ceilingRows, rows, rule, v4Level } from './v4.helpers.ts';

const conf = (f: string): LevelV2 => readJson<LevelV2>(join(LEVELS_DIR, 'valid', f));

function wins(level: LevelV2, trace: number[]): boolean {
  return verifyRun(level, replayOfTrace(level, trace)).finished;
}

describe('v4 bot', () => {
  const flip = v4Level({ rows: ceilingRows(5, [12, 36]), logic: [rule('r1', { kind: 'key', key: 'space' }, { kind: 'flip_gravity' })] });

  it('solves a flip level by pressing space, and its trace replays to a win', () => {
    for (const mode of ['fast', 'full'] as const) {
      const r = analyze(flip, { mode });
      expect([r.solvable, r.reason, r.approx]).toEqual([true, null, true]);
      expect(wins(flip, r.trace)).toBe(true);
      expect(r.trace.some((b, i) => i % 2 === 1 && (b & 64) !== 0)).toBe(true);
      expect(r.fastest_ms).toBeGreaterThan(0);
    }
    // the same geometry without the rule cannot be cleared (a v2 level: the explorer's exact report)
    const plain = v4Level({ rows: ceilingRows(5, [12, 36]) });
    expect(analyze(plain, { mode: 'fast' })).toMatchObject({ solvable: false, reason: 'goal_unreachable' });
  });

  it('solves a flappy level by flapping through the pipes', () => {
    const lv = conf('v4_flappy.json');
    const r = analyze(lv, { mode: 'fast' });
    expect([r.solvable, r.approx]).toEqual([true, true]);
    expect(wins(lv, r.trace)).toBe(true);
    expect(r.route.filter((s) => s.kind === 'jump').length).toBeGreaterThan(1);
  });

  it('solves the runner and top-down conformance levels (a rule win without the goal, a walk around a wall)', () => {
    for (const f of ['v4_runner.json', 'v4_topdown.json', 'v4_flip_space.json']) {
      const lv = conf(f);
      const r = analyze(lv, { mode: 'fast' });
      expect(r.solvable, f).toBe(true);
      expect(wins(lv, r.trace), f).toBe(true);
    }
  });

  it('plays plain-platformer v4 levels with the explorer (portals, pickups, hidden coins): exact, replayable', () => {
    const lv = conf('v4_primitives.json');
    const r = analyze(lv, { mode: 'fast' });
    expect([r.solvable, r.approx]).toEqual([true, false]);
    expect(wins(lv, r.trace)).toBe(true);
    // full mode spends its whole frame budget on coverage (approx, as for any v2 level), and still wins
    const full = analyze(lv, { mode: 'full' });
    expect(full.solvable).toBe(true);
    expect(wins(lv, full.trace)).toBe(true);
  });

  it('a hidden goal shown by a rule, and a level won by a rule with no goal at all', () => {
    const hidden = v4Level({ ents: [{ id: 'c1', type: 'coin', x: 10, y: 20 }], logic: [rule('r1', { kind: 'all_coins' }, { kind: 'toggle', target: 'goal', to: 'on' })] });
    (hidden.compiled.entities.find((e) => e.id === 'goal') as { hidden?: boolean }).hidden = true;
    const rh = analyze(hidden, { mode: 'fast' });
    expect(rh.solvable).toBe(true);
    expect(wins(hidden, rh.trace)).toBe(true);
    const noGoal = v4Level({ ents: [{ id: 'start', type: 'player_start', x: 2, y: 22 }, { id: 'c1', type: 'coin', x: 30, y: 21.5 }], replace: true, logic: [rule('r1', { kind: 'all_coins' }, { kind: 'win' })] });
    const rn = analyze(noGoal, { mode: 'fast' });
    expect(rn.solvable).toBe(true);
    expect(wins(noGoal, rn.trace)).toBe(true);
    const nothing = v4Level({ ents: [{ id: 'start', type: 'player_start', x: 2, y: 22 }], replace: true, logic: [rule('r1', { kind: 'start' }, { kind: 'shake' })] });
    expect(analyze(nothing, { mode: 'fast' })).toMatchObject({ solvable: false, reason: 'no_goal' });
  });

  it('never says yes without a win: an unwinnable flappy level is unsolvable and approximate', () => {
    const wall = v4Level({ mode: 'flappy', rows: rows((r) => (r >= 22 ? '48#' : '20.2#26.')) });
    const r = analyze(wall, { mode: 'fast' });
    expect([r.solvable, r.reason, r.approx, r.trace]).toEqual([false, 'goal_unreachable', true, []]);
    expect(r.flags.some((f) => f.code === 'unsolvable')).toBe(true);
  });
});
