/// <reference types="node" />
/** Conformance levels (§11.3a): core.validateLevel() accepts every valid/ file and rejects every invalid/ file;
 * level_hash is canonical and matches the Python implementation recorded in meta.level_hash. */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { levelHash, validateLevel } from '../index.ts';
import type { LevelV2 } from '../types.gen.ts';
import { canonicalJson } from '../util/canonical.ts';
import { sha256Hex } from '../util/sha256.ts';
import { LEVELS_DIR, listJson, readJson } from './helpers.ts';

const valid = listJson(join(LEVELS_DIR, 'valid'));
const invalid = listJson(join(LEVELS_DIR, 'invalid'));

describe('conformance levels', () => {
  it('has the §2.2 example and both sets', () => {
    expect(valid).toContain('example_2screen.json');
    expect(valid.length).toBeGreaterThanOrEqual(5);
    expect(invalid.length).toBeGreaterThanOrEqual(10);
  });

  it.each(valid)('valid/%s validates', (f) => {
    const r = validateLevel(readJson(join(LEVELS_DIR, 'valid', f)));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it.each(invalid)('invalid/%s is rejected', (f) => {
    expect(validateLevel(readJson(join(LEVELS_DIR, 'invalid', f))).ok).toBe(false);
  });

  it.each(valid)('valid/%s level_hash matches meta.level_hash when recorded', (f) => {
    const lv = readJson<LevelV2>(join(LEVELS_DIR, 'valid', f));
    const h = levelHash(lv);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    if (/^sha256:[0-9a-f]{64}$/.test(lv.meta.level_hash)) expect(h).toBe(lv.meta.level_hash);
  });

  it('level_hash ignores key order, art fields and non-gameplay blocks', () => {
    const lv = readJson<LevelV2>(join(LEVELS_DIR, 'valid', 'example_2screen.json'));
    const h = levelHash(lv);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const shuffled = reverseKeys(lv) as LevelV2;
    expect(levelHash(shuffled)).toBe(h);
    const art = structuredClone(lv);
    for (const e of art.compiled.entities) (e as { sprite?: string }).sprite = 'changed';
    art.design = null;
    art.objects = [];
    art.meta.transcript = 'changed';
    expect(levelHash(art)).toBe(h);
    const moved = structuredClone(lv);
    (moved.compiled.entities[0] as { x: number }).x += 1;
    expect(levelHash(moved)).not.toBe(h);
  });

  it('sha256 and canonical JSON vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    expect(canonicalJson({ b: 2.0, a: [1.23456, -0.00004, 1e-9, -1.5, 7.1], n: null, s: 'é"' })).toBe(
      '{"a":[1.2346,0,0,-1.5,7.1],"b":2,"s":"é\\""}',
    );
  });
});
