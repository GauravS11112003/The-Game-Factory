/** Art API (§11.3b, lane E). P0: the stubs exist and name themselves. */
import { describe, expect, it } from 'vitest';
import { artToSvg, buildArt, extractRig } from '../art/index.ts';

describe('art API', () => {
  it('stubs throw NotImplemented naming the function', () => {
    expect(() => extractRig([])).toThrow('NotImplemented: extractRig');
    expect(() => artToSvg({} as never, [0, 0, 48, 27])).toThrow('NotImplemented: artToSvg');
    expect(() => buildArt({} as never, {} as never, { theme: 'sketchbook', seed: 1 })).toThrow('NotImplemented: buildArt');
  });
});
