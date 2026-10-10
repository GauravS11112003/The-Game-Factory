/** Taps become dots (§3.2, lane F). */
import { describe, expect, it } from 'vitest';
import { isTap } from '../index.ts';

describe('editor taps', () => {
  it('classifies taps by movement and duration', () => {
    expect(isTap(2, 120)).toBe(true);
    expect(isTap(5, 120)).toBe(false);
    expect(isTap(2, 300)).toBe(false);
  });
});
