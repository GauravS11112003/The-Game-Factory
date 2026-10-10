/**
 * Solver tests (PLAN.md sections 11 and 16). Owned by lane B.
 *
 * The three Starter World fixtures are solvable; programmatically built
 * levels pin the physics limits from PLAN.md section 2: a 7-cell gap and a
 * 4-tall wall are out of reach, a 5-cell gap and a 3-tall wall are not, and
 * a ledge too high to jump to becomes reachable with a bounce pad.
 */
import { describe, expect, it } from 'vitest';
import starter1 from '../../../shared/fixtures/levels/starter_1_first_steps.json';
import starter2 from '../../../shared/fixtures/levels/starter_2_spike_valley.json';
import starter3 from '../../../shared/fixtures/levels/starter_3_key_cave.json';
import type { Entity, Level, Rule } from '../types';
import { GRID_H, GRID_W } from '../game/constants';
import { solve } from './solve';

/** Tiny grid builder mirroring shared/fixtures/make_levels.py: rows 25-26 are the floor. */
class G {
  readonly cells: string[][] = Array.from({ length: GRID_H }, () => Array<string>(GRID_W).fill('0'));

  fill(x0: number, y0: number, x1: number, y1: number, ch: string): this {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.cells[y][x] = ch;
    return this;
  }

  floor(x0 = 0, x1 = GRID_W - 1): this {
    return this.fill(x0, 25, x1, 26, '1');
  }

  /** A pit through the floor, spikes at the bottom (the fixtures' convention). */
  gap(x0: number, x1: number): this {
    return this.fill(x0, 25, x1, 25, '0').fill(x0, 26, x1, 26, '2');
  }

  /** A one-cell-wide wall `height` cells tall standing on the floor. */
  wall(x: number, height: number): this {
    return this.fill(x, 25 - height, x, 24, '1');
  }

  rows(): string[] {
    return this.cells.map((r) => r.join(''));
  }
}

function point(id: string, type: Entity['type'], x: number, y: number, extra: Partial<Entity> = {}): Entity {
  return { id, type, x, y, ...extra };
}

function makeLevel(g: G, entities: Entity[], rules: Rule[] = []): Level {
  return {
    schema_version: 1,
    id: 'lvl_test',
    game_id: null,
    parent_id: null,
    order_index: 0,
    title: 'test',
    author: 'test',
    created_at: '2026-10-09T00:00:00Z',
    source: { kind: 'fixture', photo_url: null, backdrop_url: null, template_version: 1 },
    grid: { w: GRID_W, h: GRID_H, cell: 16, rows: g.rows() },
    sprites: { player: null },
    components: [],
    entities,
    rules,
    meta: { solvable: null, warnings: [], notes_transcript: '' },
  };
}

const startAndGoal = (): Entity[] => [point('start', 'player_start', 2, 24), point('goal', 'goal', 45, 24)];

describe('solve: Starter World fixtures', () => {
  it('starter_1_first_steps is solvable', () => {
    const r = solve(starter1 as Level);
    expect(r.solvable).toBe(true);
    expect(r.reachable).toContain('2,24');
  });

  it('starter_2_spike_valley is solvable (moving platform + bounce pad)', () => {
    const r = solve(starter2 as Level);
    expect(r.solvable).toBe(true);
  });

  it('starter_3_key_cave is solvable (door treated as passable)', () => {
    const r = solve(starter3 as Level);
    expect(r.solvable).toBe(true);
  });
});

describe('solve: gaps', () => {
  it('a 7-cell gap is unsolvable', () => {
    const r = solve(makeLevel(new G().floor().gap(20, 26), startAndGoal()));
    expect(r.solvable).toBe(false);
    expect(r.reason).toBe('goal_unreachable');
    // Everything left of the gap is reachable, nothing right of it.
    expect(r.reachable).toContain('19,24');
    expect(r.reachable.some((k) => Number(k.split(',')[0]) >= 27)).toBe(false);
  });

  it('a 5-cell gap is solvable', () => {
    const r = solve(makeLevel(new G().floor().gap(20, 24), startAndGoal()));
    expect(r.solvable).toBe(true);
  });

  it('a 6-cell gap is solvable (the documented limit)', () => {
    const r = solve(makeLevel(new G().floor().gap(20, 25), startAndGoal()));
    expect(r.solvable).toBe(true);
  });

  it('a 7-cell gap becomes solvable with a moving platform across it', () => {
    const entities = [
      ...startAndGoal(),
      {
        id: 'mp1',
        type: 'moving_platform' as const,
        bbox: [20, 25, 22, 25] as [number, number, number, number],
        path: [
          [20, 25],
          [24, 25],
        ] as [number, number][],
        speed: 2,
      },
    ];
    const g = new G().floor().gap(20, 26);
    const r = solve(makeLevel(g, entities));
    expect(r.solvable).toBe(true);
  });
});

describe('solve: walls', () => {
  it('a 4-tall wall is unsolvable', () => {
    const r = solve(makeLevel(new G().floor().wall(24, 4), startAndGoal()));
    expect(r.solvable).toBe(false);
    expect(r.reason).toBe('goal_unreachable');
  });

  it('a 3-tall wall is solvable', () => {
    const r = solve(makeLevel(new G().floor().wall(24, 3), startAndGoal()));
    expect(r.solvable).toBe(true);
  });
});

describe('solve: bounce pad', () => {
  // The goal sits on a ledge 7 cells above the floor with a wall below it; only a bounce gets there.
  const ledge = (): G => new G().floor().fill(40, 18, 47, 18, '1').fill(40, 19, 40, 24, '1').fill(36, 24, 37, 24, '1');
  const padEntities = (): Entity[] => [
    point('start', 'player_start', 2, 24),
    point('goal', 'goal', 45, 17),
    { id: 'bp1', type: 'bounce_pad', bbox: [36, 24, 37, 24], strength: 1 },
  ];

  it('is unsolvable without the pad', () => {
    const r = solve(makeLevel(ledge(), padEntities().filter((e) => e.type !== 'bounce_pad')));
    expect(r.solvable).toBe(false);
  });

  it('is solvable with the pad', () => {
    const r = solve(makeLevel(ledge(), padEntities()));
    expect(r.solvable).toBe(true);
  });
});

describe('solve: reasons and speed', () => {
  it('reports no_start and no_goal', () => {
    expect(solve(makeLevel(new G().floor(), [point('goal', 'goal', 45, 24)])).reason).toBe('no_start');
    const r = solve(makeLevel(new G().floor(), [point('start', 'player_start', 2, 24)]));
    expect(r.reason).toBe('no_goal');
    expect(r.solvable).toBe(false);
    expect(r.reachable.length).toBeGreaterThan(10);
  });

  it('runs in under 100 ms on a 48x27 level', () => {
    solve(starter2 as Level); // warm-up (JIT)
    const levels = [starter1, starter2, starter3] as Level[];
    for (const lvl of levels) {
      const t0 = performance.now();
      solve(lvl);
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
});
