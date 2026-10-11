/// <reference types="node" />
/** v4 test levels (docs/v4/CONTRACTS_V4.md): the minimal conformance level with tiles, entities, rules and a mode. */
import { join } from 'node:path';
import { SimCore } from '../sim/core.ts';
import type { SimEvent } from '../sim/types.ts';
import type { Entity, GameMode, LevelV2, RuleV4 } from '../types.gen.ts';
import { LEVELS_DIR, readJson } from './helpers.ts';

export const R = 2;
export const L = 1;
export const J = 4;
export const RUN = 8;
export const D = 16;
export const SPACE = 64;
export const ACTION = 128;

export function v4Level(o: { rows?: string[]; ents?: Entity[]; replace?: boolean; logic?: RuleV4[]; game?: RuleV4[]; mode?: GameMode; hearts?: number } = {}): LevelV2 {
  const lv = structuredClone(readJson<LevelV2>(join(LEVELS_DIR, 'valid', 'minimal_1screen.json')));
  if (o.rows) lv.compiled.tiles.rows = o.rows;
  if (o.ents) lv.compiled.entities = o.replace ? o.ents : [...lv.compiled.entities, ...o.ents];
  if (o.logic) lv.compiled.logic = o.logic;
  if (o.game) lv.rules.logic = o.game;
  if (o.mode) lv.rules.mode = o.mode;
  if (o.hearts) lv.rules.hearts = o.hearts;
  return lv;
}

/** 27 rows: `fill(r)` gives each row's RLE text. */
export function rows(fill: (r: number) => string): string[] {
  return Array.from({ length: 27 }, (_, r) => fill(r));
}

/** Ground rows 22..26 with a ceiling row `ceil` and an optional pit (columns a..b). */
export function ceilingRows(ceil: number, pit?: [number, number]): string[] {
  return rows((r) => (r === ceil ? '48#' : r >= 22 ? (pit ? `${pit[0]}#${pit[1] - pit[0]}.${48 - pit[1]}#` : '48#') : '48.'));
}

export interface Played {
  sim: SimCore;
  events: SimEvent[];
}

/** Steps a fresh sim `n` frames with `input(f)`, collecting every event. */
export function play(level: LevelV2, input: (f: number) => number, n: number): Played {
  const sim = new SimCore(level, { seed: 1 });
  const events: SimEvent[] = [];
  for (let f = 0; f < n; f++) events.push(...sim.step(input(f)));
  return { sim, events };
}

export function types(p: Played, t: SimEvent['type']): SimEvent[] {
  return p.events.filter((e) => e.type === t);
}

export function rule(id: string, when: RuleV4['when'], ...then: RuleV4['then'][number][]): RuleV4 {
  return { id, when, then: then as RuleV4['then'] };
}
