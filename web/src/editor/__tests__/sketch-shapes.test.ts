import { describe, expect, it } from 'vitest';
import { sketchShape } from '../sketch-shapes.ts';

describe('sketch shapes', () => {
  it('supports reverse drags and produces a closed rectangle', () => {
    const points = sketchShape('rectangle', [12, 10], [3, 2], .4, 48, 27);
    expect(points.map(p => [p.x, p.y])).toEqual([[3, 2], [12, 2], [12, 10], [3, 10], [3, 2]]);
    expect(points.every(p => p.w === .4)).toBe(true);
  });
  it('keeps an ellipse inside the drawable world even after dragging outside it', () => {
    const points = sketchShape('ellipse', [-5, -5], [80, 40], .2, 48, 27);
    expect(points).toHaveLength(49);
    expect(points.every(p => p.x >= 0 && p.x <= 48 && p.y >= 0 && p.y <= 27)).toBe(true);
    expect(points[0].x).toBeCloseTo(points.at(-1)!.x);
    expect(points[0].y).toBeCloseTo(points.at(-1)!.y);
  });
  it('ignores clicks and collapsed shapes', () => {
    expect(sketchShape('rectangle', [5, 5], [5, 5], .2, 48, 27)).toEqual([]);
    expect(sketchShape('ellipse', [5, 5], [20, 5], .2, 48, 27)).toEqual([]);
  });
});
