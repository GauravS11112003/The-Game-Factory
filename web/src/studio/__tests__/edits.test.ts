/** StudioEdit semantics (docs/v6/CONTRACTS_V6.md §5.2): every action, fresh ids, dangling joints, ask_draw. */
import { describe, expect, it } from 'vitest';
import type { StudioEdit, StudioTheme } from '../../core/types.gen.ts';
import { applyArchetype, applyEdits, archetypeEdits, cleanParams, fulfilAsk } from '../model/edits.ts';
import { BEHAVIORS } from '../model/catalog.ts';
import { normalizeDoc, normalizeObject, type SDoc } from '../model/types.ts';

function base(): SDoc {
  return normalizeDoc({
    id: 'g1',
    title: 'Test',
    scenes: [{
      id: 's1',
      objects: [
        { id: 'car', kind: 'thing', x: 100, y: 200, drawing: { strokes: [{ points: [[-20, -10], [20, 10]] }], w: 40, h: 20 } },
        { id: 'coin1', kind: 'coin', x: 300, y: 100, tags: ['coin'], behaviors: [{ id: 'b1', type: 'pickup', params: { item: 'coins' } }] },
      ],
    }],
  });
}

const run = (doc: SDoc, ...edits: StudioEdit[]) => applyEdits(doc, 's1', edits);
const obj = (doc: SDoc, id: string) => doc.scenes[0].objects.find((o) => o.id === id);

describe('applyEdits', () => {
  it('is pure: the input doc is never changed', () => {
    const d = base();
    const before = JSON.stringify(d);
    run(d, { action: 'update_object', target: 'car', data: { physics: { body: 'dynamic' } } }, { action: 'set_title', data: { title: 'X' } });
    expect(JSON.stringify(d)).toBe(before);
  });

  it('shares untouched objects', () => {
    const d = base();
    const r = run(d, { action: 'update_object', target: 'car', data: { name: 'Zoom' } });
    expect(obj(r.doc, 'coin1')).toBe(obj(d, 'coin1'));
    expect(obj(r.doc, 'car')).not.toBe(obj(d, 'car'));
  });

  it('set_world deep-merges and merges the camera', () => {
    const r = run(base(), { action: 'set_world', data: { gravity: [0, 0], camera: { mode: 'follow' }, width: 99999 } });
    const w = r.doc.scenes[0].world;
    expect(w.gravity).toEqual([0, 0]);
    expect(w.camera.mode).toBe('follow');
    expect(w.camera.zoom).toBe(1);
    expect(w.width).toBe(40000);
    expect(w.height).toBe(900);
  });

  it('set_theme merges a partial theme or applies a preset', () => {
    const r = run(base(), { action: 'set_theme', data: { palette: { bg: '#000000', bad: 'red' }, stroke: { style: 'neon' } } });
    expect(r.doc.theme.palette?.bg).toBe('#000000');
    expect(r.doc.theme.palette?.ink).toBe('#1f1b18');
    expect(r.doc.theme.palette?.bad).toBeUndefined();
    expect(r.doc.theme.stroke?.style).toBe('neon');
    expect(r.doc.theme.stroke?.width_scale).toBe(1);
    const themes: StudioTheme[] = [{ id: 'neon', name: 'Neon Arcade', palette: { bg: '#0b0b1a' }, stroke: { style: 'neon', glow: true } }];
    const p = applyEdits(base(), 's1', [{ action: 'set_theme', data: { preset: 'neon' } }], { themes });
    expect(p.doc.theme.name).toBe('Neon Arcade');
    expect(p.doc.theme.stroke?.glow).toBe(true);
    const missing = applyEdits(base(), 's1', [{ action: 'set_theme', data: { preset: 'nope' } }], { themes });
    expect(missing.warnings.length).toBe(1);
    expect(missing.doc.theme.name).toBe('Sketchbook');
  });

  it('set_hud replaces the HUD and drops bad items', () => {
    const r = run(base(), { action: 'set_hud', data: { items: [{ counter: 'score' }, { counter: 'Bad Name!' }, { counter: '9x' }], timer: true } });
    expect(r.doc.hud.items).toEqual([{ subject: 'game', counter: 'score', style: 'number' }, { subject: 'game', counter: 'bad name', style: 'number' }]);
    expect(r.doc.hud.timer).toBe(true);
  });

  it('set_title trims and refuses empty titles', () => {
    expect(run(base(), { action: 'set_title', data: { title: '  Hill Climb  ' } }).doc.title).toBe('Hill Climb');
    const r = run(base(), { action: 'set_title', data: { title: '' } });
    expect(r.doc.title).toBe('Test');
    expect(r.warnings).toHaveLength(1);
  });

  it('add_scene adds a fresh id, or copies a scene', () => {
    const r = run(base(), { action: 'add_scene', data: { name: 'Two', id: 's1' } }, { action: 'add_scene', data: { name: 'Copy', copy_from: 's1', world: { width: 2000 } } });
    expect(r.doc.scenes.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(r.doc.scenes[1].objects).toEqual([]);
    expect(r.doc.scenes[2].objects.map((o) => o.id)).toEqual(['car', 'coin1']);
    expect(r.doc.scenes[2].world.width).toBe(2000);
    expect(r.doc.scenes[2].objects[0]).not.toBe(r.doc.scenes[0].objects[0]);
  });

  it('update_object merges physics and counters, replaces lists, forces line bodies static', () => {
    const d = run(base(), { action: 'set_counters', target: 'car', data: { counters: { fuel: 50 } } }).doc;
    const r = run(d, { action: 'update_object', target: 'car', data: { physics: { body: 'dynamic', density: 999 }, counters: { health: 3 }, tags: ['player', 'Player', 'car'] } });
    const c = obj(r.doc, 'car')!;
    expect(c.physics.body).toBe('dynamic');
    expect(c.physics.density).toBe(50);
    expect(c.physics.friction).toBe(0.4);
    expect(c.counters).toEqual({ fuel: 50, health: 3 });
    expect(c.tags).toEqual(['player', 'car']);
    const g = run(base(), { action: 'update_object', target: 'car', data: { physics: { shape: 'line', body: 'dynamic' } } });
    expect(obj(g.doc, 'car')!.physics.body).toBe('static');
  });

  it('update_object never changes strokes', () => {
    const r = run(base(), { action: 'update_object', target: 'car', data: { drawing: { strokes: [], w: 5, h: 5 } } });
    expect(obj(r.doc, 'car')!.drawing.strokes).toHaveLength(1);
    expect(obj(r.doc, 'car')!.drawing.w).toBe(40);
    expect(r.warnings).toHaveLength(1);
  });

  it('update_object with a new id creates an invisible box', () => {
    const r = run(base(), { action: 'update_object', target: 'zone', data: { kind: 'zone', x: 10, y: 20, drawing: { w: 100, h: 50 }, physics: { sensor: true } } });
    const z = obj(r.doc, 'zone')!;
    expect(r.created).toEqual(['zone']);
    expect(z.drawing).toEqual({ strokes: [], w: 100, h: 50 });
    expect([z.x, z.y]).toEqual([10, 20]);
    expect(z.physics.sensor).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('update_object creating with a bad or taken id gets a fresh id', () => {
    const r = run(base(), { action: 'update_object', target: 'bad id!', data: { kind: 'enemy', x: 0, y: 0, drawing: { w: 10, h: 10 } } });
    expect(r.created).toEqual(['enemy1']);
  });

  it('update_object drops unknown behaviours and fills defaults', () => {
    const r = run(base(), { action: 'update_object', target: 'car', data: { behaviors: [{ type: 'car', params: { power: 99, nope: 1 } }, { type: 'teleporter' }] } });
    const b = obj(r.doc, 'car')!.behaviors;
    expect(b).toHaveLength(1);
    expect(b[0].id).toBe('b1');
    expect(b[0].params?.power).toBe(3);
    expect(b[0].params?.max_speed).toBe(900);
    expect(b[0].params && 'nope' in b[0].params).toBe(false);
    expect(r.warnings.length).toBe(1);
  });

  it('delete_object removes it and the joints that pointed at it', () => {
    const d = run(base(), { action: 'add_joint', target: 'car', data: { type: 'weld', to: 'coin1' } }, { action: 'set_world', data: { camera: { target: 'coin1' } } }).doc;
    const r = run(d, { action: 'delete_object', target: 'coin1', data: {} });
    expect(obj(r.doc, 'coin1')).toBeUndefined();
    expect(obj(r.doc, 'car')!.joints).toEqual([]);
    expect(r.doc.scenes[0].world.camera.target).toBeNull();
    expect(run(base(), { action: 'delete_object', target: 'ghost', data: {} }).warnings).toHaveLength(1);
  });

  it('duplicate_object makes copies with fresh ids, offsets and no joints', () => {
    const d = run(base(), { action: 'add_joint', target: 'coin1', data: { type: 'weld', to: 'car' } }).doc;
    const r = run(d, { action: 'duplicate_object', target: 'coin1', data: { count: 3, dx: 50 } });
    expect(r.created).toEqual(['coin2', 'coin3', 'coin4']);
    const xs = r.doc.scenes[0].objects.filter((o) => o.tags.includes('coin')).map((o) => o.x);
    expect(xs).toEqual([300, 350, 400, 450]);
    expect(obj(r.doc, 'coin2')!.joints).toEqual([]);
    expect(obj(r.doc, 'coin2')!.behaviors[0]).not.toBe(obj(r.doc, 'coin1')!.behaviors[0]);
    const at = run(base(), { action: 'duplicate_object', target: 'car', data: { x: 0, y: 0 } });
    expect([obj(at.doc, 'car1')!.x, obj(at.doc, 'car1')!.y]).toEqual([0, 0]);
  });

  it('add_behavior adds with a fresh id, or updates the same type', () => {
    let r = run(base(), { action: 'add_behavior', target: 'car', data: { type: 'car', params: { power: 1 } } });
    expect(obj(r.doc, 'car')!.behaviors.map((b) => [b.id, b.type])).toEqual([['b1', 'car']]);
    r = run(r.doc, { action: 'add_behavior', target: 'car', data: { type: 'car', params: { tilt: 2 } } });
    expect(obj(r.doc, 'car')!.behaviors).toHaveLength(1);
    expect(obj(r.doc, 'car')!.behaviors[0].params).toMatchObject({ power: 1, tilt: 2 });
    r = run(r.doc, { action: 'add_behavior', target: 'car', data: { type: 'health', id: 'b1' } });
    expect(obj(r.doc, 'car')!.behaviors.map((b) => [b.id, b.type])).toEqual([['b1', 'car'], ['b2', 'health']]);
    r = run(r.doc, { action: 'add_behavior', target: 'car', data: { type: 'health', params: { max: 5 } } });
    expect(obj(r.doc, 'car')!.behaviors.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(obj(r.doc, 'car')!.behaviors[1].params?.max).toBe(5);
    expect(run(base(), { action: 'add_behavior', target: 'car', data: { type: 'fly' } }).warnings).toHaveLength(1);
  });

  it('update_behavior merges params by id or type and switches off', () => {
    let r = run(base(), { action: 'update_behavior', target: 'coin1', data: { type: 'pickup', params: { amount: 5 }, off: true } });
    const b = obj(r.doc, 'coin1')!.behaviors[0];
    expect(b.params).toEqual({ item: 'coins', amount: 5 });
    expect(b.off).toBe(true);
    r = run(r.doc, { action: 'update_behavior', target: 'coin1', data: { id: 'b1', off: false } });
    expect(obj(r.doc, 'coin1')!.behaviors[0].off).toBeUndefined();
  });

  it('remove_behavior by id or type', () => {
    expect(obj(run(base(), { action: 'remove_behavior', target: 'coin1', data: { id: 'b1' } }).doc, 'coin1')!.behaviors).toEqual([]);
    expect(obj(run(base(), { action: 'remove_behavior', target: 'coin1', data: { type: 'pickup' } }).doc, 'coin1')!.behaviors).toEqual([]);
    expect(run(base(), { action: 'remove_behavior', target: 'coin1', data: { type: 'car' } }).warnings).toHaveLength(1);
  });

  const rule = { when: { type: 'overlap', params: { with: 'enemy' } }, then: [{ type: 'lose' }, { type: 'explode' }] };

  it('add_rule on an object, the scene and the game (null = game)', () => {
    const r = run(base(),
      { action: 'add_rule', target: 'car', data: rule },
      { action: 'add_rule', target: '@scene', data: { when: { type: 'every', params: { seconds: 2 } }, then: [{ type: 'add' }] } },
      { action: 'add_rule', target: null, data: { id: 'win1', when: { type: 'all_gone' }, then: [{ type: 'win' }] } });
    const c = obj(r.doc, 'car')!;
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0].id).toBe('r1');
    expect(c.rules[0].then.map((a) => a.type)).toEqual(['lose']);
    expect(c.rules[0].when.params).toEqual({ with: 'enemy' });
    expect(r.doc.scenes[0].rules[0].then[0].params).toEqual({ subject: 'game', counter: 'score', amount: 1 });
    expect(r.doc.rules[0].id).toBe('win1');
    expect(r.doc.rules[0].when.params).toEqual({ tag: 'enemy' });
  });

  it('add_rule drops rules with an unknown event or no actions', () => {
    const r = run(base(), { action: 'add_rule', target: 'car', data: { when: { type: 'sneeze' }, then: [{ type: 'win' }] } }, { action: 'add_rule', target: 'car', data: { when: { type: 'start' }, then: [{ type: 'nope' }] } });
    expect(obj(r.doc, 'car')!.rules).toEqual([]);
    expect(r.warnings.length).toBe(3);
  });

  it('update_rule merges and keeps the id; remove_rule removes', () => {
    let r = run(base(), { action: 'add_rule', target: 'car', data: { ...rule, id: 'r9' } });
    r = run(r.doc, { action: 'update_rule', target: 'car', data: { id: 'r9', once: true, conditions: [{ counter: 'coins', op: '>=', value: 3 }], text: 'touch enemy = lose' } });
    const ru = obj(r.doc, 'car')!.rules[0];
    expect(ru.id).toBe('r9');
    expect(ru.once).toBe(true);
    expect(ru.when.type).toBe('overlap');
    expect(ru.conditions).toEqual([{ subject: 'self', counter: 'coins', op: '>=', value: 3 }]);
    expect(ru.text).toBe('touch enemy = lose');
    r = run(r.doc, { action: 'update_rule', target: 'car', data: { id: 'r9', off: true } });
    expect(obj(r.doc, 'car')!.rules[0].off).toBe(true);
    r = run(r.doc, { action: 'remove_rule', target: 'car', data: { id: 'r9' } });
    expect(obj(r.doc, 'car')!.rules).toEqual([]);
    expect(run(base(), { action: 'update_rule', target: '@game', data: { id: 'x' } }).warnings).toHaveLength(1);
  });

  it('add_joint keeps a joint to an object that does not exist yet (dangling until drawn)', () => {
    const r = run(base(), { action: 'add_joint', target: 'car', data: { type: 'wheel', to: 'wheel_front', at: [20, 10], motor: true } });
    expect(obj(r.doc, 'car')!.joints).toEqual([{ type: 'wheel', to: 'wheel_front', at: [20, 10], to_at: [0, 0], motor: true, speed: 0, stiffness: 0.5 }]);
    expect(r.warnings).toEqual([]);
    const again = run(r.doc, { action: 'add_joint', target: 'car', data: { type: 'wheel', to: 'wheel_front', at: [30, 10] } });
    expect(obj(again.doc, 'car')!.joints).toHaveLength(1);
    expect(obj(again.doc, 'car')!.joints[0].at).toEqual([30, 10]);
    expect(run(base(), { action: 'add_joint', target: 'car', data: { type: 'glue', to: 'coin1' } }).warnings).toHaveLength(1);
    expect(run(base(), { action: 'add_joint', target: 'car', data: { type: 'weld', to: 'car' } }).warnings).toHaveLength(1);
  });

  it('set_counters merges and null removes; bad names are skipped', () => {
    let r = run(base(), { action: 'set_counters', target: 'car', data: { counters: { fuel: 100, Keys: 2, '1x': 1 } } });
    expect(obj(r.doc, 'car')!.counters).toEqual({ fuel: 100, keys: 2 });
    expect(r.warnings).toHaveLength(1);
    r = run(r.doc, { action: 'set_counters', target: 'car', data: { counters: { fuel: null } } });
    expect(obj(r.doc, 'car')!.counters).toEqual({ keys: 2 });
  });

  it('set_game_counters', () => {
    const r = run(base(), { action: 'set_game_counters', data: { counters: { score: 0, lives: 3 } } });
    expect(r.doc.counters).toEqual({ score: 0, lives: 3 });
  });

  it('ask_draw returns asks and leaves the doc alone', () => {
    const d = base();
    const r = run(d, { action: 'ask_draw', data: { id: 'wheel1', prompt: 'Draw a wheel', object: { kind: 'wheel', physics: { shape: 'circle' } } } }, { action: 'ask_draw', data: { prompt: '', object: { kind: 'car' } } });
    expect(r.doc).toBe(d);
    expect(r.asks.map((a) => a.id)).toEqual(['wheel1', 'car1']);
    expect(r.asks[1].prompt).toBe('Draw something');
  });

  it('skips edits for a missing scene and unknown actions', () => {
    const r = applyEdits(base(), 's1', [{ action: 'set_title', scene: 'zzz', data: { title: 'ok' } }, { action: 'update_object', scene: 'zzz', target: 'car', data: {} }, { action: 'fly' } as unknown as StudioEdit]);
    expect(r.doc.title).toBe('ok');
    expect(r.warnings).toHaveLength(2);
  });

  it('accepts a raw GameDoc and fills defaults', () => {
    const r = applyEdits({ id: 'g', scenes: [{ id: 's1', objects: [{ id: 'a' }] }] }, 's1', [{ action: 'update_object', target: 'a', data: { name: 'A' } }]);
    expect(r.doc.scenes[0].objects[0].physics.body).toBe('static');
    expect(r.doc.scenes[0].objects[0].name).toBe('A');
  });
});

describe('cleanParams', () => {
  it('clamps, rounds ints, drops unknowns and bad choices', () => {
    expect(cleanParams(BEHAVIORS.get('spawner'), { max: 3.7, every: -1, area: 'moon', velocity: [1, 2], zzz: 1 })).toEqual({ max: 4, every: 0.05, velocity: [1, 2] });
    expect(cleanParams(BEHAVIORS.get('health'), {}, true)).toEqual({ max: 3, invulnerable: 0.6, on_zero: 'destroy', bar: false });
  });
});

describe('archetypes', () => {
  it('applyArchetype merges physics, behaviours, counters and tags', () => {
    const o = applyArchetype(normalizeObject({ id: 'p', tags: ['me'], counters: { health: 5 } }), 'player');
    expect(o.kind).toBe('player');
    expect(o.physics.body).toBe('dynamic');
    expect(o.physics.fixed_rotation).toBe(true);
    expect(o.behaviors.map((b) => b.type)).toEqual(['platformer', 'health']);
    expect(o.behaviors[1].params?.on_zero).toBe('lose');
    expect(o.counters.health).toBe(5);
    expect(o.tags).toEqual(['me', 'player']);
    expect(o.player).toBe(1);
  });

  it('archetypeEdits for a car asks for wheels and joins them', () => {
    const edits = archetypeEdits(base(), 's1', 'car', 'car');
    expect(edits.filter((e) => e.action === 'ask_draw')).toHaveLength(2);
    const r = applyEdits(base(), 's1', edits);
    expect(r.asks.map((a) => a.id)).toEqual(['wheel1', 'wheel2']);
    expect(obj(r.doc, 'car')!.joints.map((j) => j.to)).toEqual(['wheel1', 'wheel2']);
    expect(obj(r.doc, 'car')!.behaviors[0].type).toBe('car');
  });

  it('fulfilAsk renames the drawn object and applies the settings', () => {
    const r = applyEdits(base(), 's1', archetypeEdits(base(), 's1', 'car', 'car'));
    const f = fulfilAsk(r.doc, 's1', 'coin1', r.asks[0]);
    expect(f.id).toBe('wheel1');
    const w = obj(f.doc, 'wheel1')!;
    expect(w.kind).toBe('wheel');
    expect(w.physics.shape).toBe('circle');
    expect(w.x).toBe(300);
    expect(obj(f.doc, 'coin1')).toBeUndefined();
  });

  it('fulfilAsk fills an invisible placeholder with the drawing', () => {
    const d = run(base(), { action: 'update_object', target: 'door', data: { kind: 'door', x: 0, y: 0, drawing: { w: 10, h: 10 }, tags: ['door'] } }).doc;
    const f = fulfilAsk(d, 's1', 'car', { id: 'door', prompt: 'Draw the door', object: { name: 'Door' }, scene: 's1' });
    expect(f.id).toBe('door');
    const door = obj(f.doc, 'door')!;
    expect(door.drawing.strokes).toHaveLength(1);
    expect(door.tags).toEqual(['door']);
    expect(door.name).toBe('Door');
    expect([door.x, door.y]).toEqual([100, 200]);
    expect(obj(f.doc, 'car')).toBeUndefined();
  });
});
