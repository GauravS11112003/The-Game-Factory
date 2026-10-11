/** The v4 HUD's pure parts: effect rings, the chip row, the speech bubble's place. */
import { describe, expect, it } from 'vitest';
import { bubbleLayout, counterChips, EffectClock, layoutRow } from '../views/hudmodel.ts';
import { NO_EFFECTS } from '../v4.ts';

describe('EffectClock', () => {
  it('shows nothing when no effect is on', () => {
    expect(new EffectClock().update({ ...NO_EFFECTS }, 1)).toEqual([]);
  });

  it('rings empty as time runs out, against the longest time seen', () => {
    const c = new EffectClock();
    expect(c.update({ ...NO_EFFECTS, speed_f: 120 }, 1)).toEqual([{ kind: 'speed', left: 120, frac: 1, forever: false }]);
    expect(c.update({ ...NO_EFFECTS, speed_f: 60 }, 1)[0].frac).toBe(0.5);
    // a new effect of the same kind refills the ring
    expect(c.update({ ...NO_EFFECTS, speed_f: 200 }, 1)[0].frac).toBe(1);
    expect(c.update({ ...NO_EFFECTS, speed_f: 100 }, 1)[0].frac).toBe(0.5);
    // off, then on again: a fresh total
    c.update({ ...NO_EFFECTS }, 1);
    expect(c.update({ ...NO_EFFECTS, speed_f: 30 }, 1)[0].frac).toBe(1);
  });

  it('"until respawn" (−1) is a full ring marked forever; flipped gravity gets its own ring', () => {
    const list = new EffectClock().update({ ...NO_EFFECTS, gravity_f: -1, freeze_f: 90, jump_f: 10 }, -1);
    expect(list.map((e) => e.kind)).toEqual(['jump', 'gravity', 'freeze', 'flip']);
    expect(list.find((e) => e.kind === 'gravity')).toEqual({ kind: 'gravity', left: -1, frac: 1, forever: true });
    expect(list.find((e) => e.kind === 'flip')?.forever).toBe(true);
  });
});

describe('row layout', () => {
  it('places chips left to right and leaves out what does not fit', () => {
    expect(layoutRow([60, 40, 50], 8, 6, 300)).toEqual([8, 74, 120]);
    expect(layoutRow([60, 40, 50], 8, 6, 150)).toEqual([8, 74]);
    expect(layoutRow([400], 8, 6, 300)).toEqual([]);
  });

  it('lists counters in the sim\'s order, at most four', () => {
    expect(counterChips({ stars: 2, keys: 0 })).toEqual([{ name: 'stars', n: 2 }, { name: 'keys', n: 0 }]);
    expect(counterChips({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toHaveLength(4);
  });
});

describe('bubbleLayout', () => {
  const base = { w: 100, h: 30, x: 300, top: 200, bottom: 240, prefer: 'up' as const, camX: 0, viewW: 768, viewH: 432 };

  it('sits above the speaker, centred, with its tail at the speaker', () => {
    const l = bubbleLayout(base);
    expect(l).toEqual({ x: 250, y: 200 - 8 - 30, tailX: 300, side: 'up' });
  });

  it('stays inside the view at its edges (the tail still points at the speaker)', () => {
    const left = bubbleLayout({ ...base, x: 20 });
    expect(left.x).toBe(6);
    expect(left.tailX).toBe(20);
    const right = bubbleLayout({ ...base, x: 1060, camX: 300 });
    expect(right.x).toBe(300 + 768 - 6 - 100);
    expect(right.tailX).toBe(right.x + 100 - 10);
  });

  it('goes below when there is no room above, and above a flipped player when there is none below', () => {
    expect(bubbleLayout({ ...base, top: 20, bottom: 60 }).side).toBe('down');
    expect(bubbleLayout({ ...base, prefer: 'down', top: 380, bottom: 420 }).side).toBe('up');
    expect(bubbleLayout({ ...base, prefer: 'down' })).toMatchObject({ side: 'down', y: 248 });
  });
});
