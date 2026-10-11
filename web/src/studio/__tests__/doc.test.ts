/** Studio geometry: bbox maths, recentring, transforms, hit tests, merge/split, smoothing, history coalescing. */
import { describe, expect, it } from 'vitest';
import {
  addWorldStrokes, cleanPath, ellipsePoints, freshId, localToWorld, mergeObjects, objectFromWorldStrokes, pickObject, recentre, simplify,
  splitObject, strokesBox, worldBox, worldStrokes, worldToLocal,
} from '../model/doc.ts';
import { History } from '../model/history.ts';
import { normalizeDoc, normalizeObject, type Vec } from '../model/types.ts';

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 4));

describe('boxes and centres', () => {
  it('strokesBox covers every point', () => {
    expect(strokesBox([{ points: [[0, 0], [10, 5]] }, { points: [[-3, 8]] }])).toEqual({ minX: -3, minY: 0, maxX: 10, maxY: 8 });
    expect(strokesBox([])).toBeNull();
  });

  it('objectFromWorldStrokes centres the object on the bbox centre', () => {
    const o = objectFromWorldStrokes('a', [{ points: [[100, 100], [200, 150]] }]);
    expect([o.x, o.y]).toEqual([150, 125]);
    expect([o.drawing.w, o.drawing.h]).toEqual([100, 50]);
    expect(o.drawing.strokes[0].points).toEqual([[-50, -25], [50, 25]]);
  });

  it('recentre keeps strokes where they are on screen, even rotated and scaled', () => {
    const o = normalizeObject({ id: 'a', x: 10, y: 20, rotation: 90, scale: 2, drawing: { strokes: [{ points: [[0, 0], [10, 0]] }] } });
    const before = worldStrokes(o)[0].points;
    const r = recentre(o);
    close(worldStrokes(r)[0].points.flat(), before.flat());
    expect(r.drawing.strokes[0].points).toEqual([[-5, 0], [5, 0]]);
    expect([r.drawing.w, r.drawing.h]).toEqual([10, 0]);
  });

  it('local ↔ world round trips', () => {
    const o = { x: 5, y: -7, rotation: 33, scale: 1.7 };
    const p: Vec = [12, -4];
    close(worldToLocal(o, localToWorld(o, p)), p);
    close(localToWorld({ x: 0, y: 0, rotation: 90, scale: 1 }, [1, 0]), [0, 1]);
  });

  it('worldBox of a rotated object', () => {
    const o = normalizeObject({ id: 'a', x: 0, y: 0, rotation: 90, drawing: { w: 100, h: 20 } });
    const b = worldBox(o);
    close([b.minX, b.minY, b.maxX, b.maxY], [-10, -50, 10, 50]);
  });

  it('addWorldStrokes grows the object and recentres', () => {
    const o = objectFromWorldStrokes('a', [{ points: [[0, 0], [10, 0]] }]);
    const g = addWorldStrokes(o, [{ points: [[0, 20], [10, 20]] }]);
    expect([g.x, g.y, g.drawing.w, g.drawing.h]).toEqual([5, 10, 10, 20]);
  });
});

describe('hit tests', () => {
  const doc = normalizeDoc({ id: 'g', scenes: [{ id: 's1', objects: [
    { id: 'hill', x: 0, y: 0, drawing: { strokes: [{ points: [[-500, 0], [500, 0]], width: 8 }], w: 1000, h: 0 } },
    { id: 'zone', x: 300, y: 300, drawing: { w: 100, h: 100 } },
    { id: 'coin', x: 0, y: 40, layer: 1, drawing: { strokes: [{ points: [[-10, -10], [10, -10], [10, 10], [-10, 10]], closed: true }], w: 20, h: 20 } },
  ] }] });
  const objs = doc.scenes[0].objects;
  it('picks ink first, the inside of closed shapes, then boxes', () => {
    expect(pickObject(objs, [100, 2], 4)?.id).toBe('hill');
    expect(pickObject(objs, [0, 40], 4)?.id).toBe('coin');
    expect(pickObject(objs, [320, 310], 4)?.id).toBe('zone');
    expect(pickObject(objs, [900, 900], 4)).toBeNull();
  });
});

describe('merge and split', () => {
  const doc = normalizeDoc({ id: 'g', scenes: [{ id: 's1', objects: [
    { id: 'a', x: 0, y: 0, kind: 'car', drawing: { strokes: [{ points: [[-10, 0], [10, 0]] }], w: 20, h: 0 } },
    { id: 'b', x: 100, y: 0, drawing: { strokes: [{ points: [[-10, 0], [10, 0]] }], w: 20, h: 0 } },
    { id: 'c', x: 0, y: 100, joints: [{ type: 'weld', to: 'b' }] },
  ] }] });

  it('merges into the first object, keeping strokes in place and fixing joints', () => {
    const r = mergeObjects(doc, 's1', ['a', 'b']);
    const objs = r.doc.scenes[0].objects;
    expect(objs.map((o) => o.id)).toEqual(['a', 'c']);
    expect(objs[0].kind).toBe('car');
    expect([objs[0].x, objs[0].drawing.w]).toEqual([50, 120]);
    expect(objs[1].joints[0].to).toBe('a');
  });

  it('splits into one object per stroke', () => {
    const m = mergeObjects(doc, 's1', ['a', 'b']).doc;
    const s = splitObject(m, 's1', 'a');
    expect(s.ids).toEqual(['a', 'o1']);
    const [a, o1] = s.doc.scenes[0].objects;
    expect([a.x, o1.x]).toEqual([0, 100]);
    expect(a.kind).toBe('car');
    expect(o1.kind).toBe('thing');
  });
});

describe('paths', () => {
  it('simplify keeps the corners of a line', () => {
    const pts: Vec[] = Array.from({ length: 50 }, (_, i) => [i, i < 25 ? 0 : i - 25]);
    const s = simplify(pts, 0.5);
    expect(s.length).toBeLessThan(6);
    expect(s[0]).toEqual([0, 0]);
    expect(s[s.length - 1]).toEqual([49, 24]);
  });

  it('cleanPath stays near the raw path and under 2000 points', () => {
    const raw: Vec[] = Array.from({ length: 5000 }, (_, i) => [i / 10, Math.sin(i / 100) * 30 + (i % 2) * 0.2]);
    const c = cleanPath(raw);
    expect(c.length).toBeLessThanOrEqual(2000);
    expect(c.length).toBeGreaterThan(5);
    expect(c[0]).toEqual([0, 0]);
  });

  it('ellipsePoints spans the drag box', () => {
    const b = strokesBox([{ points: ellipsePoints([0, 0], [100, 50]) as [Vec, ...Vec[]] }])!;
    close([b.minX, b.maxX, b.minY, b.maxY], [0, 100, 0, 50]);
  });

  it('freshId', () => {
    expect(freshId('Wheel', new Set(['wheel1']))).toBe('wheel2');
    expect(freshId('!!', new Set())).toBe('o1');
  });
});

describe('history', () => {
  it('undo / redo and coalescing within the window', () => {
    let now = 0;
    const h = new History<number>(10, 1000, () => now);
    h.push(0, 'a');
    h.push(1, 'drag', 'move');
    now = 500;
    h.push(2, 'drag', 'move');
    now = 3000;
    h.push(3, 'drag', 'move');
    expect(h.undo(4)?.doc).toBe(3);
    expect(h.undo(3)?.doc).toBe(1);
    expect(h.redo(1)?.doc).toBe(3);
    h.seal();
    h.push(9, 'x');
    expect(h.canRedo).toBe(false);
  });
});
