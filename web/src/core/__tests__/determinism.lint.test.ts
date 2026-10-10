/// <reference types="node" />
/** Determinism lint (§5.2, lane A): no trig/exp/pow/random, Date or performance in sim/, bot/, replay/. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DETERMINISTIC_DIRS, lintSource } from '../util/lint.ts';
import { CORE_DIR, coreSourceFiles } from './helpers.ts';

describe('determinism lint', () => {
  it('step code uses only deterministic arithmetic', () => {
    const files = coreSourceFiles().filter((f) => DETERMINISTIC_DIRS.some((d) => f.startsWith(d)));
    expect(files.length).toBeGreaterThan(0);
    const issues = files
      .flatMap((f) => lintSource(f, readFileSync(join(CORE_DIR, f), 'utf8')))
      .filter((i) => i.rule.startsWith('determinism:'));
    expect(issues.map((i) => `${i.file}:${i.line} ${i.rule}`)).toEqual([]);
  });

  it('the lint flags every banned API', () => {
    const src = 'Math.sin(a); Math.random(); const t = Date.now(); performance.now(); Math.pow(2, 3);';
    expect(lintSource('sim/step.ts', src).map((i) => i.rule)).toEqual([
      'determinism:Math trig/exp/pow/random', 'determinism:Date', 'determinism:performance',
    ]);
    expect(lintSource('art/x.ts', src).filter((i) => i.rule.startsWith('determinism'))).toEqual([]);
  });
});
