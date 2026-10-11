/** Stroke grouping (docs/v6/CONTRACTS_V6.md §6): within ~32 px of the pending group's box and < 1.5 s apart. */
import { describe, expect, it } from 'vitest';
import { joinsGroup, type PendingGroup } from '../editor/grouping.ts';

const g: PendingGroup = { id: 'o1', box: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, lastAt: 1000 };
const box = (x: number, y: number, s = 10) => ({ minX: x, minY: y, maxX: x + s, maxY: y + s });

describe('joinsGroup', () => {
  it('joins close strokes drawn soon after', () => {
    expect(joinsGroup(g, box(50, 50), 1500)).toBe(true);
    expect(joinsGroup(g, box(125, 50), 2400)).toBe(true);
  });
  it('starts a new object when far away or after a pause', () => {
    expect(joinsGroup(g, box(140, 50), 1200)).toBe(false);
    expect(joinsGroup(g, box(50, 50), 2600)).toBe(false);
    expect(joinsGroup(null, box(50, 50), 1100)).toBe(false);
  });
});
