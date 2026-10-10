/// <reference types="node" />
/** Staleness (§11.3a): regenerating the schemas and types.gen.ts from Pydantic changes nothing; params.json and
 * physics-profiles.json match the core. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PARAMS } from '../params.ts';
import { PROFILES, profileHash } from '../sim/profiles.ts';
import { CORE_VERSION } from '../util/version.ts';
import { REPO, SPEC_DIR } from './helpers.ts';

describe('generated contracts are fresh', () => {
  it('shared/spec/*.schema.json and web/src/core/types.gen.ts match vision/app/spec', () => {
    const r = spawnSync('uv', ['run', '--no-sync', 'python', '../scripts/gen_contracts.py', '--check'], {
      cwd: join(REPO, 'vision'),
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(r.error, String(r.error)).toBeUndefined();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 150_000);

  it('shared/spec/params.json mirrors core/params.ts', () => {
    const json = JSON.parse(readFileSync(join(SPEC_DIR, 'params.json'), 'utf8'));
    expect(json.core_version).toBe(CORE_VERSION);
    for (const [k, v] of Object.entries(PARAMS)) expect(json[k], k).toEqual(JSON.parse(JSON.stringify(v)));
  });

  it('shared/spec/physics-profiles.json mirrors sim/profiles.ts', () => {
    const json = JSON.parse(readFileSync(join(SPEC_DIR, 'physics-profiles.json'), 'utf8'));
    for (const [id, p] of Object.entries(PROFILES)) {
      expect(json.profiles[id]).toEqual({ ...p, profile_hash: profileHash(p.id) });
    }
  });
});
