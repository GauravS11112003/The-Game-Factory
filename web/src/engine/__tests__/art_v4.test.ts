/** House art for the v4 entities (core/art/v4art.ts): every type draws, pairs share a colour, hidden stays out. */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArt } from '../../core/art/artdoc.ts';
import { pickupShape, PORTAL_COLORS, PORTAL_LONE, portalColors } from '../../core/art/v4art.ts';
import type { Entity, LevelV2 } from '../../core/types.gen.ts';

const LEVEL = join(__dirname, '..', '..', '..', '..', 'shared', 'spec', 'conformance', 'levels', 'valid', 'minimal_1screen.json');

function withEntities(extra: unknown[]): LevelV2 {
  const lv = JSON.parse(readFileSync(LEVEL, 'utf8')) as LevelV2;
  return { ...lv, objects: [], ink: null, compiled: { ...lv.compiled, entities: [...lv.compiled.entities, ...(extra as Entity[])] } };
}

const V4 = [
  { id: 'pa', type: 'portal', x: 10, y: 20, pair: 'pb' },
  { id: 'pb', type: 'portal', x: 30, y: 20, pair: 'pa' },
  { id: 'pc', type: 'portal', x: 12, y: 10, pair: 'pd' },
  { id: 'pd', type: 'portal', x: 32, y: 10, pair: 'pc' },
  { id: 'lone', type: 'portal', x: 20, y: 5 },
  { id: 'wind', type: 'zone', x: 4, y: 14, w: 6, h: 4, effect: 'wind', dir: 'up' },
  { id: 'belt', type: 'zone', x: 12, y: 22, w: 5, h: 1, effect: 'conveyor', dir: 'left' },
  { id: 'pool', type: 'zone', x: 20, y: 18, w: 6, h: 4, effect: 'water' },
  { id: 'gem', type: 'pickup', x: 8, y: 18, item: 'gem' },
  { id: 'sneaky', type: 'pickup', x: 9, y: 18, item: 'star', hidden: true },
  { id: 'bob', type: 'npc', x: 16, y: 23, lines: ['Hi!'], name: 'Bob' },
];

describe('v4 art', () => {
  const doc = buildArt(withEntities(V4), null, { seed: 1 });
  const sprite = (id: string) => doc.sprites.find((s) => s.id === id);

  it('draws every v4 entity as a house doodle', () => {
    for (const e of V4) {
      const s = sprite(e.id);
      expect(s, e.id).toBeTruthy();
      expect(s!.source).toBe('house');
      expect(s!.paths.length).toBeGreaterThan(0);
    }
  });

  it('gives both ends of a pair one colour, each pair its own, a lone portal graphite', () => {
    const c = portalColors(V4 as Entity[]);
    expect(c.get('pa')).toBe(c.get('pb'));
    expect(c.get('pc')).toBe(c.get('pd'));
    expect(c.get('pa')).not.toBe(c.get('pc'));
    expect(PORTAL_COLORS as readonly string[]).toContain(c.get('pa'));
    expect(c.get('lone')).toBe(PORTAL_LONE);
  });

  it('tags the parts the engine animates (zone glyph, npc bubble)', () => {
    expect(sprite('wind')!.paths.some((p) => p.part === 'shine')).toBe(true);
    expect(sprite('bob')!.paths.some((p) => p.part === 'shine')).toBe(true);
    expect(sprite('gem')!.paths.some((p) => p.part === 'shine')).toBe(false);
  });

  it('a zone covers its box (top-left anchor)', () => {
    const z = sprite('pool')!;
    expect(z.anchor).toEqual([20, 18]);
    expect(z.bbox[0]).toBeLessThanOrEqual(0.01);
    expect(z.bbox[2]).toBeGreaterThanOrEqual(5.99);
    expect(z.bbox[3]).toBeGreaterThanOrEqual(3.99);
  });

  it('keeps an entity that starts hidden out of the still picture (it keeps its sprite for the engine)', () => {
    const ents = doc.layers.find((l) => l.id === 'entities')!;
    expect(sprite('sneaky')).toBeTruthy();
    expect(ents.paths.some((p) => p.object_id === 'sneaky')).toBe(false);
    expect(ents.paths.some((p) => p.object_id === 'gem')).toBe(true);
  });

  it('picks a pickup doodle by item name', () => {
    expect(pickupShape(undefined)).toBe('star');
    expect(pickupShape('big star')).toBe('star');
    expect(pickupShape('extra life')).toBe('heart');
    expect(pickupShape('ruby')).toBe('gem');
    expect(pickupShape('speed boots')).toBe('bolt');
    expect(pickupShape('sock')).toBe('gift');
  });

  it('leaves v2 levels drawn as before (no v4 entity, no change in sprite count)', () => {
    const plain = buildArt(withEntities([]), null, { seed: 1 });
    expect(plain.sprites.length).toBe(doc.sprites.length - V4.length);
  });
});
