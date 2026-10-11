import { describe, expect, it } from 'vitest';
import {
  chaikin, closeIfNear, cornerFlags, dedupe, medianWidth, pathLength, polishStroke, polishWidth, resampleEven, type Pt,
} from '../theme/polish.ts';
import { rng } from '../theme/rng.ts';

/** A jittery hand-drawn version of a path (seeded). */
function jitter(pts: Pt[], amt: number, seed = 3): Pt[] {
  const r = rng(seed);
  return resampleEven(pts, false, 3).map(([x, y]) => [x + (r() - 0.5) * amt, y + (r() - 0.5) * amt] as Pt);
}

function roughness(pts: Pt[]): number {
  // mean absolute turn per point: smooth paths turn little between neighbours
  let t = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
    let d = Math.abs(b - a);
    if (d > Math.PI) d = 2 * Math.PI - d;
    t += d;
  }
  return t / Math.max(1, pts.length - 2);
}

describe('polish smoothing', () => {
  it('drops duplicate points', () => {
    expect(dedupe([[0, 0], [0.1, 0], [5, 0], [5.2, 0]], 0.8)).toEqual([[0, 0], [5.2, 0]]);
  });

  it('resamples evenly', () => {
    const r = resampleEven([[0, 0], [100, 0]], false, 10);
    expect(r.length).toBe(11);
    expect(pathLength(r)).toBeCloseTo(100);
  });

  it('finds the corners of a box but not along a circle', () => {
    const box = resampleEven([[0, 0], [100, 0], [100, 100], [0, 100]], true, 4);
    const f = cornerFlags(box, true, 48, 3);
    expect(f.filter(Boolean).length).toBe(4);
    const circle: Pt[] = Array.from({ length: 80 }, (_, i) => [Math.cos((i / 80) * Math.PI * 2) * 60, Math.sin((i / 80) * Math.PI * 2) * 60]);
    expect(cornerFlags(circle, true, 48, 3).some(Boolean)).toBe(false);
  });

  it('chaikin keeps flagged corners and the ends of open lines', () => {
    const pts: Pt[] = [[0, 0], [10, 0], [10, 10]];
    const out = chaikin(pts, false, 2, [true, true, true]);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([10, 10]);
    expect(out).toContainEqual([10, 0]);
  });

  it('smooths jitter on a wobbly line but keeps its ends and length', () => {
    const raw = jitter([[0, 0], [300, 0]], 5);
    const p = polishStroke({ points: raw, width: 4, closed: false }, 4);
    expect(p.closed).toBe(false);
    expect(roughness(p.points)).toBeLessThan(roughness(raw) * 0.5);
    expect(p.points[0][0]).toBeCloseTo(raw[0][0], 0);
    expect(p.points[p.points.length - 1][0]).toBeCloseTo(raw[raw.length - 1][0], 0);
    expect(Math.abs(pathLength(p.points) - 300)).toBeLessThan(30);
  });

  it('keeps a drawn box square-cornered', () => {
    const p = polishStroke({ points: [[0, 0], [100, 0], [100, 100], [0, 100]], width: 4, closed: true }, 4);
    for (const c of [[0, 0], [100, 0], [100, 100], [0, 100]] as Pt[]) {
      const d = Math.min(...p.points.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1])));
      expect(d).toBeLessThan(2);
    }
  });

  it('is deterministic', () => {
    const raw = jitter([[0, 0], [120, 40], [200, 0]], 6, 9);
    expect(polishStroke({ points: raw, width: 5, closed: false }, 5)).toEqual(polishStroke({ points: raw, width: 5, closed: false }, 5));
  });
});

describe('polish closing', () => {
  const ring = (gap: number, overshoot = 0): Pt[] => {
    const n = 60;
    const end = Math.PI * 2 - gap + overshoot;
    return Array.from({ length: n + 1 }, (_, i) => [Math.cos((i / n) * end) * 50, Math.sin((i / n) * end) * 50] as Pt);
  };

  it('closes an outline whose ends nearly meet, trimming the overshoot', () => {
    expect(closeIfNear(ring(0.15), 4)).not.toBeNull();
    const over = closeIfNear(ring(0, 0.6), 4);
    expect(over).not.toBeNull();
    expect(over!.length).toBeLessThan(ring(0, 0.6).length);
    const p = polishStroke({ points: ring(0.2), width: 4, closed: false }, 4);
    expect(p.closed).toBe(true);
    expect(p.autoClosed).toBe(true);
  });

  it('leaves open shapes open', () => {
    expect(closeIfNear(ring(2.5), 4)).toBeNull(); // a C
    expect(closeIfNear([[0, 0], [100, 0], [200, 0], [300, 0]], 4)).toBeNull();
    expect(closeIfNear([[0, 0], [4, 3], [8, 0], [1, 0]], 4)).toBeNull(); // tiny scribble
  });
});

describe('polish width', () => {
  it('evens weights toward the median and caps outlines by object size', () => {
    expect(medianWidth([2, 8, 4])).toBe(4);
    expect(polishWidth(14, 6, 60, true)).toBeLessThanOrEqual(2.7); // a 60 px coin gets a fine outline
    expect(polishWidth(14, 6, 400, true)).toBeLessThanOrEqual(6.5);
    expect(polishWidth(3, 6, 400, true)).toBeGreaterThan(3);
    expect(polishWidth(1, 1, 400, true)).toBeGreaterThanOrEqual(1);
    // open strokes (limbs, details) may stay a little thicker than outlines
    expect(polishWidth(10, 10, 100, false)).toBeGreaterThan(polishWidth(10, 10, 100, true));
  });
});
