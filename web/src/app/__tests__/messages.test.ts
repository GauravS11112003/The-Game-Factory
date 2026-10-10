/// <reference types="node" />
/** Kid-facing text (§7.10, lane F): the sample SSE stream renders through messages.json with no raw codes. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BuildEvent } from '../../core/types.gen.ts';
import { hasMessage, t } from '../messages.ts';

const SAMPLE = join(__dirname, '..', '..', '..', '..', 'shared', 'spec', 'conformance', 'events', 'sample_build.jsonl');

describe('messages', () => {
  it('fills placeholders and never leaks a key', () => {
    expect(t('norm.tidy_lines', { n: 2 })).toBe("I smoothed 2 wobbly lines so you won't trip.");
    expect(t('no.such_key')).toBe('…');
  });

  it('every key in the sample build stream has a sentence', () => {
    const events = readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as BuildEvent);
    const keys = new Set<string>();
    for (const e of events) {
      if (e.event === 'stage') keys.add(`stage.${e.data.stage}`).add(`stage.status.${e.data.status}`);
      if (e.event === 'warning' || e.event === 'error') keys.add(e.data.message_key);
      if (e.event === 'edits' || e.event === 'suggestions') for (const ed of e.data.edits) keys.add(ed.reason_key);
      if (e.event === 'saw') for (const it of e.data.items) keys.add(it.rel_key);
      if (e.event === 'ask') keys.add(e.data.ask.message_key);
    }
    expect([...keys].filter((k) => !hasMessage(k))).toEqual([]);
  });
});
