/// <reference types="node" />
/** v4 replays and v2 stability (docs/v4/CONTRACTS_V4.md §1.1, §4.1): runs pressing SPACE (64) and ACTION (128) record
 * and verify; v2 levels keep their level_hash and their exact per-frame sim state (hashes pinned before v4). */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSim, decodeReplay, encodeReplay, ghostTrack, levelHash, verifyRun } from '../index.ts';
import { SimCore } from '../sim/core.ts';
import type { LevelV2 } from '../types.gen.ts';
import { LEVELS_DIR, readJson } from './helpers.ts';
import { ACTION, R, SPACE, ceilingRows, rule, v4Level } from './v4.helpers.ts';

describe('replays with the rule keys', () => {
  it('a run that presses SPACE and ACTION records, decodes and verifies', () => {
    const lv = v4Level({
      rows: ceilingRows(5, [12, 36]),
      logic: [rule('r1', { kind: 'key', key: 'space' }, { kind: 'flip_gravity' }), rule('r2', { kind: 'key', key: 'action' }, { kind: 'add_score', n: 1 })],
    });
    const sim = createSim(lv, { record: true });
    const input = (f: number): number => (f === 5 ? SPACE | ACTION : f === 9 ? ACTION : f === 380 ? SPACE | R : R);
    let f = 0;
    for (; f < 600 && !sim.view().won; f++) sim.step(input(f));
    expect(sim.view().won).toBe(true);
    const rp = sim.replay?.();
    expect(rp).toBeTruthy();
    const bits = decodeReplay(rp!.input);
    expect([bits[5], bits[9], bits[380]]).toEqual([SPACE | ACTION, ACTION, SPACE | R]);
    const v = verifyRun(lv, rp!);
    expect([v.finished, v.accepted, v.reason]).toEqual([true, true, 'ok']);
    // ghosts carry the gravity sign (the engine draws a flipped ghost upside down)
    const g = ghostTrack(lv, rp!);
    expect([g.finished, g.pose(3).gravity, g.pose(100).gravity, g.pose(g.lastFrame).gravity]).toEqual([true, 1, -1, 1]);
    // the same run without the key bits does not finish
    expect(verifyRun(lv, { ...rp!, input: encodeReplay(Uint8Array.from(bits, (b) => b & 63)) }).finished).toBe(false);
  });
});

/** The input script the pre-v4 baseline used (12-frame holds of LCG bits; seed 3 mostly runs right). */
function script(seed: number, n: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  let cur = 0;
  for (let i = 0; i < n; i++) {
    if (i % 12 === 0) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      cur = (s >>> 16) & 31;
      if (seed === 3) cur |= 2;
      if ((s >>> 8) % 97 === 0) cur |= 32;
    }
    out.push(cur);
  }
  return out;
}

// sha256 prefixes of sim.hash() at frames 60, 600 and 1500, captured before any v4 code existed
const PINNED: Record<string, { s1: string[]; s3: string[] }> = {
  'minimal_1screen.json': { s1: ['f9bcddc3b4813165', 'cf8335cdcb5633e5', '6ccdda0ddec774ae'], s3: ['e0da755dc23cccbf', '3ee9c9a1f78a2074', '91df179f2316feae'] },
  'entity_zoo_1screen.json': { s1: ['732970d848861e46', '0c81816b0378e7b0', '21b272f35943fcf7'], s3: ['d0ce0134c81c68cc', '09f02e81e9930f13', '77c94f3aab04f4c5'] },
  'example_2screen.json': { s1: ['0e8ea76f4d161adb', 'd40ee5c19eaf13e0', 'bb7ac74a08fe8d3a'], s3: ['8153759f249834c8', '9364c559ecd1938c', 'd60206188ed30022'] },
  'migrated_v1_classic.json': { s1: ['0cbf4452c4cda738', '382fafb5a661a7a0', 'f13edb1925445eb1'], s3: ['19940e0ba0df7415', 'dc7f1be8769e8f6e', 'fe564e87d6b5f332'] },
  'six_screens.json': { s1: ['50d26b49ddc45c98', '793b29cbc466b325', '0b822e9f50b8fc98'], s3: ['3debbe7fb1bb0042', '910f0096be203556', '15fac4e162a0a908'] },
};

describe('v2 levels are unchanged by v4', () => {
  it.each(Object.keys(PINNED))('%s: same level_hash and the same sim state frame by frame', (f) => {
    const lv = readJson<LevelV2>(join(LEVELS_DIR, 'valid', f));
    if (/^sha256:[0-9a-f]{64}$/.test(lv.meta.level_hash)) expect(levelHash(lv)).toBe(lv.meta.level_hash);
    for (const seed of [1, 3] as const) {
      const sim = new SimCore(lv, { seed: 1 });
      const ins = script(seed, 1500);
      const marks: string[] = [];
      for (let k = 0; k < ins.length; k++) {
        sim.step(ins[k] | (k % 5 === 0 ? SPACE | ACTION : 0)); // the rule keys never reach a v2 level
        if (k === 59 || k === 599 || k === 1499) marks.push(sim.hash().slice(7, 23));
      }
      expect(marks).toEqual(seed === 1 ? PINNED[f].s1 : PINNED[f].s3);
      expect(sim.S.r).toBeUndefined();
    }
  });
});
