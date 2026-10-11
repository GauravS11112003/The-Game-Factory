/** v7 art in the model (docs/v7/CONTRACTS_V7.md §1, §5): the four new edits, slim payloads, job items → edits. */
import { describe, expect, it } from 'vitest';
import type { ArtJobItem, ArtVariant, StudioEdit } from '../../core/types.gen.ts';
import { applyEdits } from '../model/edits.ts';
import { mergeObjects } from '../model/doc.ts';
import { artTargets, chooseEdit, confirmEdits, itemEdits, newlyFinished, revertEdits, stillDrawing, unasked, type JobPlan } from '../model/art_plan.ts';
import { docChars, jobDoc, slimDoc } from '../model/payload.ts';
import { normalizeDoc, type SDoc } from '../model/types.ts';

const svg = (tag: string, size = 40): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#${tag}"/>${'<g/>'.repeat(size)}</svg>`;
const variant = (id: string, tag = 'abcdef'): ArtVariant => ({ id, svg: svg(tag), w: 80, h: 40, rev: 1 });

function base(): SDoc {
  return normalizeDoc({
    id: 'g1',
    title: 'Art test',
    scenes: [{
      id: 's1',
      world: { width: 3000, height: 900 },
      objects: [
        { id: 'car', kind: 'car', x: 200, y: 300, drawing: { strokes: [{ points: [[-40, -20], [40, 20]] }], w: 80, h: 40 } },
        { id: 'hill', kind: 'ground', x: 1500, y: 700, physics: { shape: 'line', body: 'static' }, drawing: { strokes: [{ points: [[-1500, 0], [0, -100], [1500, 0]] }], w: 3000, h: 100 } },
        { id: 'coin1', kind: 'coin', x: 600, y: 200, drawing: { strokes: [{ points: [[-10, 0], [10, 0]] }], w: 20, h: 10 } },
        { id: 'zone', kind: 'zone', x: 10, y: 10, drawing: { strokes: [], w: 50, h: 50 } },
      ],
    }],
  });
}

const run = (doc: SDoc, ...edits: StudioEdit[]) => applyEdits(doc, 's1', edits);
const obj = (doc: SDoc, id: string) => doc.scenes[0].objects.find((o) => o.id === id)!;

describe('set_art', () => {
  it('stores variants and plays the chosen one', () => {
    const r = run(base(), { action: 'set_art', target: 'car', data: { use: 'ai', chosen: 'v2', variants: [variant('v1'), variant('v2')] } });
    expect(r.warnings).toEqual([]);
    expect(obj(r.doc, 'car').art).toMatchObject({ use: 'ai', chosen: 'v2', asked: false, terrain: null });
    expect(obj(r.doc, 'car').art!.variants.map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('merges a partial update and keeps the variants unless they are given', () => {
    const d = run(base(), { action: 'set_art', target: 'car', data: { variants: [variant('v1'), variant('v2')] } }).doc;
    const r = run(d, { action: 'set_art', target: 'car', data: { use: 'ai', chosen: 'v2', asked: true } });
    expect(obj(r.doc, 'car').art).toMatchObject({ use: 'ai', chosen: 'v2', asked: true });
    expect(obj(r.doc, 'car').art!.variants).toHaveLength(2);
    const replaced = run(r.doc, { action: 'set_art', target: 'car', data: { variants: [variant('v9')] } });
    expect(obj(replaced.doc, 'car').art!.variants.map((v) => v.id)).toEqual(['v9']);
    expect(obj(replaced.doc, 'car').art!.chosen).toBe('v9'); // the old choice is gone, the first variant plays
  });

  it('cannot play AI art that does not exist', () => {
    const r = run(base(), { action: 'set_art', target: 'car', data: { use: 'ai' } });
    expect(obj(r.doc, 'car').art!.use).toBe('sketch');
    expect(r.warnings.join()).toMatch(/no AI drawing/);
  });

  it('drops broken variants and unknown choices', () => {
    const r = run(base(), { action: 'set_art', target: 'car', data: { variants: [variant('ok'), { id: 'bad id!', svg: '<svg/>', w: 1, h: 1 }, { id: 'nosvg', w: 1, h: 1 }, { id: 'zero', svg: '<svg/>', w: 0, h: 2 }], chosen: 'nope' } });
    expect(obj(r.doc, 'car').art!.variants.map((v) => v.id)).toEqual(['ok']);
    expect(obj(r.doc, 'car').art!.chosen).toBe('ok');
    expect(r.warnings.join()).toMatch(/no variant nope/);
  });

  it('caps variants at 6 and keeps a terrain skin on ground', () => {
    const many = Array.from({ length: 9 }, (_, i) => variant(`v${i}`));
    const r = run(base(), { action: 'set_art', target: 'car', data: { variants: many } }, { action: 'set_art', target: 'hill', data: { use: 'ai', terrain: { fill: ['#112233', 'nothex'], surface: '#445566', decor: [variant('rock')] } } });
    expect(obj(r.doc, 'car').art!.variants).toHaveLength(6);
    const hill = obj(r.doc, 'hill').art!;
    expect(hill.use).toBe('ai');
    expect(hill.terrain).toMatchObject({ fill: ['#112233'], surface: '#445566', surface_width: 14, decor_every: 220 });
    expect(hill.terrain!.decor).toHaveLength(1);
    const cleared = run(r.doc, { action: 'set_art', target: 'hill', data: { terrain: null } });
    expect(obj(cleared.doc, 'hill').art).toMatchObject({ terrain: null, use: 'sketch' });
  });

  it('warns about missing objects and is pure', () => {
    const d = base();
    const before = JSON.stringify(d);
    const r = run(d, { action: 'set_art', target: 'ghost', data: { use: 'sketch' } });
    expect(r.warnings.join()).toMatch(/no object ghost/);
    run(d, { action: 'set_art', target: 'car', data: { variants: [variant('v1')] } });
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('set_art_direction, set_backdrop, set_look', () => {
  it('sets and clears the art direction', () => {
    const r = run(base(), { action: 'set_art_direction', data: { rev: 2, prompt: 'hill climb racing in space', summary: 'Moon rovers', guide: 'Flat cel shading…', palette: ['#101820', '#f2aa4c', 'red'], kinds: { car: 'a lunar rover' } } });
    expect(r.doc.art_direction).toEqual({ rev: 2, prompt: 'hill climb racing in space', summary: 'Moon rovers', guide: 'Flat cel shading…', palette: ['#101820', '#f2aa4c'], kinds: { car: 'a lunar rover' } });
    const cleared = run(r.doc, { action: 'set_art_direction', data: {} });
    expect(cleared.doc.art_direction).toBeUndefined();
    expect('art_direction' in cleared.doc).toBe(false);
  });

  it('sets and clears the backdrop (it needs a sky or a layer)', () => {
    const r = run(base(), { action: 'set_backdrop', data: { rev: 1, sky: ['#000011', '#223355'], layers: [{ svg: svg('111111'), w: 2400, h: 900, depth: 3, anchor: 'nowhere' }, { svg: '', w: 1, h: 1 }] } });
    expect(r.doc.backdrop!.sky).toEqual(['#000011', '#223355']);
    expect(r.doc.backdrop!.layers).toEqual([{ svg: svg('111111'), w: 2400, h: 900, depth: 1, anchor: 'bottom', tile_x: true, height: 0.5 }]);
    expect(run(r.doc, { action: 'set_backdrop', data: { layers: [] } }).warnings.join()).toMatch(/backdrop without/);
    const cleared = run(r.doc, { action: 'set_backdrop', data: {} });
    expect(cleared.doc.backdrop).toBeUndefined();
  });

  it('flips the look and rejects anything else', () => {
    const r = run(base(), { action: 'set_look', data: { look: 'sketch' } });
    expect(r.doc.look).toBe('sketch');
    const bad = run(r.doc, { action: 'set_look', data: { look: 'fancy' } });
    expect(bad.doc.look).toBe('sketch');
    expect(bad.warnings).toHaveLength(1);
  });

  it('game-level art edits work even when the scene is unknown', () => {
    const r = applyEdits(base(), 'nope', [{ action: 'set_look', scene: 'nope', data: { look: 'sketch' } }]);
    expect(r.doc.look).toBe('sketch');
  });

  it('normalizeDoc keeps art, look, direction and backdrop through a save round trip', () => {
    const d = run(base(),
      { action: 'set_art', target: 'car', data: { use: 'ai', variants: [variant('v1')] } },
      { action: 'set_backdrop', data: { sky: ['#000000'] } },
      { action: 'set_art_direction', data: { prompt: 'space' } },
      { action: 'set_look', data: { look: 'game' } }).doc;
    const again = normalizeDoc(JSON.parse(JSON.stringify(d)));
    expect(again).toEqual(d);
    expect(obj(again, 'coin1').art).toBeUndefined();
  });

  it('merging objects drops art that no longer fits the drawing', () => {
    const d = run(base(), { action: 'set_art', target: 'car', data: { use: 'ai', variants: [variant('v1')] } }).doc;
    const m = mergeObjects(d, 's1', ['car', 'coin1']);
    expect(obj(m.doc, 'car').art).toBeUndefined();
  });
});

describe('payloads', () => {
  function arty(): SDoc {
    return run(base(),
      { action: 'set_art', target: 'car', data: { use: 'ai', variants: [variant('v1'), variant('v2')] } },
      { action: 'set_art', target: 'coin1', data: { variants: [variant('c1')] } },
      { action: 'set_backdrop', data: { sky: ['#000011'], layers: [{ svg: svg('222222', 2000), w: 2400, h: 900 }] } },
      { action: 'set_art_direction', data: { prompt: 'space', summary: 'Moon', guide: 'x'.repeat(5000), palette: ['#ffffff'] } }).doc;
  }

  it('slimDoc strips art, the backdrop and the guide, and leaves the doc alone', () => {
    const d = arty();
    const before = JSON.stringify(d);
    const s = slimDoc(d);
    expect(JSON.stringify(d)).toBe(before);
    expect(s.backdrop).toBeUndefined();
    expect(s.art_direction).toEqual({ rev: 1, prompt: 'space', summary: 'Moon', palette: ['#ffffff'], kinds: {} });
    expect(s.scenes[0].objects.every((o) => o.art === undefined)).toBe(true);
    expect(JSON.stringify(s)).not.toContain('<svg');
    expect(docChars(s)).toBeLessThan(docChars(d) / 4);
    // a doc without art is shared as is
    const plain = base();
    expect(slimDoc(plain).scenes[0]).toBe(plain.scenes[0]);
  });

  it('jobDoc keeps the targets and the guide, drops other variants and the backdrop', () => {
    const j = jobDoc(arty(), ['coin1']);
    expect(j.backdrop).toBeUndefined();
    expect(j.art_direction!.guide).toHaveLength(5000);
    expect(obj(j, 'coin1').art!.variants).toHaveLength(1);
    expect(obj(j, 'car').art).toEqual({ use: 'ai', chosen: null, variants: [], terrain: null, asked: false });
  });
});

describe('art jobs → edits', () => {
  const plan = (kind: JobPlan['kind'], objects = ['car', 'hill', 'coin1'], backdrop = true): JobPlan => ({ kind, scene: 's1', objects, backdrop });
  const done = (object_id: string | null, art: Record<string, unknown> | null, extra: Partial<ArtJobItem> = {}): ArtJobItem => ({ object_id, status: 'done', art: art as ArtJobItem['art'], ...extra });
  const apply = (d: SDoc, edits: StudioEdit[]) => run(d, ...edits).doc;

  it('targets drawn objects, biggest first', () => {
    expect(artTargets(base(), 's1')).toEqual(['hill', 'car', 'coin1']);
    expect(artTargets(base(), 's1', 1)).toEqual(['hill']);
  });

  it('tracks finished items and what is still drawing', () => {
    const st = { items: [done('car', null), { object_id: 'hill', status: 'drawing' as const }, { object_id: 'coin1', status: 'failed' as const }] };
    expect(newlyFinished(st, new Set(['car'])).map((i) => i.object_id)).toEqual(['coin1']);
    expect(stillDrawing(st, plan('single'))).toEqual(['hill']);
    expect(stillDrawing(null, plan('single'))).toEqual(['car', 'hill', 'coin1']);
  });

  it('single: variants join the list, the sketch keeps playing, the compare card is due', () => {
    const r = itemEdits(base(), plan('single'), done('car', { variants: [variant('v1'), variant('v2'), variant('v3')] }));
    const d = apply(base(), r.edits);
    expect(r.fresh).toEqual(['v1', 'v2', 'v3']);
    expect(obj(d, 'car').art).toMatchObject({ use: 'sketch', chosen: 'v1', asked: false });
    expect(unasked(d, 's1')).toEqual(['car']);
    // pick the second one: one set_art
    const picked = apply(d, [chooseEdit('s1', 'car', 'v2')]);
    expect(obj(picked, 'car').art).toMatchObject({ use: 'ai', chosen: 'v2', asked: true });
    expect(unasked(picked, 's1')).toEqual([]);
    // keep mine
    expect(obj(apply(d, [chooseEdit('s1', 'car', null)]), 'car').art).toMatchObject({ use: 'sketch', asked: true });
  });

  it('try again: clashing ids are renamed and the current choice keeps playing', () => {
    const d = apply(base(), [{ action: 'set_art', target: 'car', data: { use: 'ai', chosen: 'v2', variants: [variant('v1'), variant('v2')], asked: true } }]);
    const r = itemEdits(d, plan('single', ['car'], false), done('car', { variants: [variant('v1', '000000'), variant('v2', '111111')] }));
    const after = apply(d, r.edits);
    expect(r.fresh).toEqual(['v1-2', 'v2-2']);
    expect(obj(after, 'car').art!.variants.map((v) => v.id)).toEqual(['v1-2', 'v2-2', 'v1', 'v2']);
    expect(obj(after, 'car').art).toMatchObject({ use: 'ai', chosen: 'v2', asked: false });
  });

  it('restyle: AI objects switch to the new variant 0, sketch objects get a card, ground takes its skin', () => {
    let d = apply(base(), [{ action: 'set_art', target: 'car', data: { use: 'ai', chosen: 'old', variants: [variant('old')], asked: true } }]);
    const before = d;
    const p = plan('restyle');
    const items = [
      done('car', { variants: [variant('n1'), variant('n2')] }),
      done('coin1', { variants: [variant('c1')] }),
      done('hill', { variants: [], terrain: { fill: ['#333333'], surface: '#999999' } }),
      done(null, null, { backdrop: { sky: ['#000000'], layers: [] } }),
      { object_id: 'zone', status: 'failed' as const, error: 'no drawing' },
    ];
    const fresh = new Map<string, string[]>();
    for (const it of items) {
      const r = itemEdits(d, p, it);
      if (it.object_id) fresh.set(it.object_id, r.fresh);
      d = apply(d, r.edits);
    }
    expect(obj(d, 'car').art).toMatchObject({ use: 'ai', chosen: 'n1', asked: true });
    expect(obj(d, 'car').art!.variants.map((v) => v.id)).toEqual(['n1', 'n2', 'old']); // the old one is kept until confirmed
    expect(obj(d, 'coin1').art).toMatchObject({ use: 'sketch', chosen: 'c1', asked: false });
    expect(obj(d, 'hill').art).toMatchObject({ use: 'ai', asked: true, terrain: { fill: ['#333333'], surface: '#999999' } });
    expect(d.backdrop!.sky).toEqual(['#000000']);
    expect(obj(d, 'zone').art).toBeUndefined();

    // "Use the new look": everything plays the new art, the old variants go
    const confirmed = apply(d, confirmEdits(d, p, fresh));
    expect(obj(confirmed, 'car').art!.variants.map((v) => v.id)).toEqual(['n1', 'n2']);
    expect(obj(confirmed, 'coin1').art).toMatchObject({ use: 'ai', chosen: 'c1', asked: true });
    expect(obj(confirmed, 'hill').art!.use).toBe('ai');

    // "Keep the old one": back to exactly what it was
    const reverted = apply(d, revertEdits(before, d, p));
    expect(obj(reverted, 'car').art).toEqual(obj(before, 'car').art);
    expect(obj(reverted, 'coin1').art).toMatchObject({ use: 'sketch', variants: [] });
    expect(reverted.backdrop).toBeUndefined();
  });

  it('ignores failed items, missing objects and empty results', () => {
    expect(itemEdits(base(), plan('single'), { object_id: 'car', status: 'failed' }).edits).toEqual([]);
    expect(itemEdits(base(), plan('single'), done('ghost', { variants: [variant('v1')] })).edits).toEqual([]);
    expect(itemEdits(base(), plan('single'), done('car', { variants: [] })).edits).toEqual([]);
    expect(itemEdits(base(), plan('single'), done(null, null, { backdrop: { layers: [] } })).edits).toEqual([]);
  });

  it('revert restores the direction, theme and look too', () => {
    const before = base();
    const now = run(before,
      { action: 'set_art_direction', data: { prompt: 'candy land' } },
      { action: 'set_theme', data: { name: 'Candy', palette: { bg: '#ffeeff' } } },
      { action: 'set_look', data: { look: 'sketch' } }).doc;
    const back = apply(now, revertEdits(before, now, plan('restyle', [], false), { theme: true }));
    expect(back.art_direction).toBeUndefined();
    expect(back.theme.name).toBe(before.theme.name);
    expect(back.theme.palette!.bg).toBe(before.theme.palette!.bg);
    expect(back.look).toBe('game');
  });
});
