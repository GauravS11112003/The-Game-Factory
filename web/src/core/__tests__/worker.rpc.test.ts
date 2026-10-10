/// <reference types="node" />
/** Worker RPC (§11.3c): JSON lines over stdio; stub fixtures are contract-valid. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkerResponse } from '../types.gen.ts';
import { SchemaValidator } from '../util/schema.ts';
import { CORE_DIR, REPO, SPEC_DIR, readJson } from './helpers.ts';

function rpc(requests: object[], stub: boolean): Promise<WorkerResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(CORE_DIR, 'worker', 'main.ts')], {
      cwd: REPO,
      env: { ...process.env, DAL_CORE_STUB: stub ? '1' : '0' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', () => resolve(out.trim().split('\n').map((l) => JSON.parse(l) as WorkerResponse)));
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();
  });
}

function validatorFor(schemaFile: string, def: string): SchemaValidator {
  const s = readJson<Record<string, unknown>>(join(SPEC_DIR, schemaFile));
  return new SchemaValidator({ ...s, $ref: `#/$defs/${def}` });
}

describe('core worker', () => {
  it('answers ping, rejects unknown methods and reports stubs as internal errors', async () => {
    const [ping, bad, build] = await rpc(
      [
        { id: 1, method: 'ping', params: {} },
        { id: 2, method: 'teleport', params: {} },
        { id: 3, method: 'build', params: { ink: {}, graph0: {}, edits: [], rules: {}, tier: 'faithful' } },
      ],
      false,
    );
    expect(ping).toMatchObject({ id: 1, ok: true, result: { core_version: '2.0.0' } });
    expect(bad).toMatchObject({ id: 2, ok: false, error: { code: 'invalid' } });
    expect(build).toMatchObject({ id: 3, ok: false, error: { code: 'internal', message: 'NotImplemented: build' } });
  }, 20_000);

  it('DAL_CORE_STUB=1 returns contract-valid fixtures', async () => {
    const level = readJson(join(SPEC_DIR, 'conformance', 'levels', 'valid', 'example_2screen.json'));
    const res = await rpc(
      [
        { id: 1, method: 'build_tiers', params: { ink: {}, graph0: {}, edits: [], rules: {}, deadlineMs: 3000 } },
        { id: 2, method: 'perceive_heuristic', params: { ink: {} } },
        { id: 3, method: 'analyze', params: { level, mode: 'fast' } },
        { id: 4, method: 'level_hash', params: { level } },
        { id: 5, method: 'keyword_plan', params: { prompt: 'lava key', screens: 2 } },
      ],
      true,
    );
    expect(res.every((r) => r.ok)).toBe(true);
    const r = res.map((x) => x.result as Record<string, unknown>);
    expect(validatorFor('api.schema.json', 'TierSetJson').validate(r[0])).toEqual([]);
    expect(validatorFor('scene.schema.json', 'SceneGraph').validate(r[1].graph)).toEqual([]);
    expect(validatorFor('report.schema.json', 'PlaytestReport').validate(r[2].report)).toEqual([]);
    expect(String(r[3].hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validatorFor('plan.schema.json', 'LevelPlan').validate(r[4].plan)).toEqual([]);
  }, 20_000);
});
