/** Core API (§11.3b): every signature is exported; stubs throw NotImplemented('<fn>'); the TS interfaces in
 * index.ts and the generated wire types (api.py BuildInputJson, ...) stay assignable to each other. */
import { describe, expect, it } from 'vitest';
import * as core from '../index.ts';
import type { BuildInput, BuildResult, TierSet } from '../index.ts';
import type { BuildInputJson, BuildResultJson, TierSetJson } from '../types.gen.ts';
import { isNotImplemented } from '../util/errors.ts';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;
export type _BuildInputToJson = Assert<Extends<BuildInput, BuildInputJson>>;
export type _BuildInputFromJson = Assert<Extends<BuildInputJson, BuildInput>>;
export type _BuildResultToJson = Assert<Extends<BuildResult, BuildResultJson>>;
export type _BuildResultFromJson = Assert<Extends<BuildResultJson, BuildResult>>;
export type _TierSetToJson = Assert<Extends<TierSet, TierSetJson>>;

const api = core as unknown as Record<string, unknown>;

describe('core API surface', () => {
  it('exports every §11.3(b) function and PROFILES', () => {
    for (const fn of core.API_FUNCTIONS) expect(typeof api[fn], fn).toBe('function');
    expect(Object.keys(core.PROFILES).sort()).toEqual(['v1-classic', 'v2-gentle', 'v2-snappy', 'v2-standard']);
  });

  it.each(core.API_FUNCTIONS.filter((fn) => !(core.P0_REAL as readonly string[]).includes(fn)))(
    '%s is either real or throws NotImplemented naming itself',
    (fn) => {
      try {
        (api[fn] as (...a: unknown[]) => unknown)({}, {}, {}, {}, {});
      } catch (e) {
        if (isNotImplemented(e)) expect(e.message).toBe(`NotImplemented: ${fn}`);
      }
    },
  );

  it('replay codec round-trips all 8 input bits and rejects bad input', () => {
    // v4 §4.1: RESTART 32, SPACE 64 and ACTION 128 are valid input bits
    const frames = Uint8Array.from([0, 0, 0, 1, 1, 4, 4, 4, 4, 31, 32, 64, 128, 255]);
    expect(Array.from(core.decodeReplay(core.encodeReplay(frames)))).toEqual(Array.from(frames));
    expect(core.encodeReplay(new Uint8Array(0))).toBe('');
    expect(() => core.decodeReplay('AQA=')).toThrow(); // not a whole record
    expect(() => core.decodeReplay('AAAA')).toThrow(); // zero-length run
  });
});
