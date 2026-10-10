/// <reference types="node" />
/** Every message key the contracts produce has a sentence in shared/spec/messages.json (§7.10). */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LevelV2 } from '../types.gen.ts';
import { LEVELS_DIR, SPEC_DIR, readJson } from './helpers.ts';
import { stubResult } from '../worker/stub.ts';

const messages = readJson<{ messages: Record<string, string> }>(join(SPEC_DIR, 'messages.json')).messages;

function enumOf(schemaFile: string, def: string): string[] {
  const s = readJson<{ $defs: Record<string, { enum?: string[] }> }>(join(SPEC_DIR, schemaFile));
  return s.$defs[def].enum ?? [];
}

describe('messages.json', () => {
  it('covers every flag, ask kind, stage, stage status, role, band and tier', () => {
    const want = [
      ...enumOf('report.schema.json', 'FlagCode').map((c) => `flag.${c}`),
      ...enumOf('scene.schema.json', 'AskKind').map((c) => `ask.${c}`),
      ...enumOf('common.schema.json', 'StageName').map((c) => `stage.${c}`),
      ...enumOf('events.schema.json', 'StageStatus').map((c) => `stage.status.${c}`),
      ...enumOf('common.schema.json', 'Role').map((c) => `role.${c}`),
      ...enumOf('common.schema.json', 'Band').map((c) => `band.${c}`),
      ...enumOf('common.schema.json', 'Tier').map((c) => `tier.${c}`),
    ];
    expect(want.filter((k) => !(k in messages))).toEqual([]);
  });

  it('covers every reason/summary key used by the example level and the stub fixtures', () => {
    const lv = readJson<LevelV2>(join(LEVELS_DIR, 'valid', 'example_2screen.json'));
    const keys = (lv.edits ?? []).map((e) => e.reason_key);
    const tiers = stubResult('build_tiers', {}) as { menu: { summary_key: string }[] };
    keys.push(...tiers.menu.map((c) => c.summary_key));
    keys.push('warning.looked_closer_skipped', 'warning.sheet_missing', 'error.entity', 'error.not_implemented');
    expect(keys.filter((k) => !(k in messages))).toEqual([]);
  });

  it('sentences are short and use only {placeholders}', () => {
    for (const [k, v] of Object.entries(messages)) {
      for (const sentence of v.split(/(?<=[.!?])\s+/)) expect(sentence.split(/\s+/).length, k).toBeLessThanOrEqual(20);
      expect(v.includes('_') && /[a-z]_[a-z]/.test(v.replace(/\{[^}]+\}/g, '')), `${k} shows a raw code`).toBe(false);
    }
  });
});
