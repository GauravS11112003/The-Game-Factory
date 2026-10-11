/** v7 editor look helpers (docs/v7/CONTRACTS_V7.md §5): which look plays, the compare-card preview override. */
import { describe, expect, it } from 'vitest';
import { chosenVariant, docLook, lookObject, objectLook } from '../editor/look.ts';
import { normalizeDoc } from '../model/types.ts';

const v = (id: string) => ({ id, svg: '<svg viewBox="0 0 10 10"></svg>', w: 10, h: 10 });

describe('editor look', () => {
  it('previews a variant or the drawing without touching the object', () => {
    const doc = normalizeDoc({ id: 'g', scenes: [{ id: 's1', objects: [{ id: 'a', drawing: { strokes: [{ points: [[0, 0], [1, 1]] }], w: 10, h: 10 }, art: { use: 'sketch', variants: [v('v1'), v('v2')] } }] }] });
    const a = doc.scenes[0].objects[0];
    const p = lookObject(a, { variant: 'v2' });
    expect(p.look).toBe('game');
    expect(p.obj.art).toMatchObject({ use: 'ai', chosen: 'v2' });
    expect(lookObject(a, { variant: null }).obj.art!.use).toBe('sketch');
    expect(lookObject(a).obj).toBe(a);
    expect(a.art!.use).toBe('sketch');
  });

  it('plays AI art only in the game look and only when it exists', () => {
    const doc = normalizeDoc({
      id: 'g', scenes: [{ id: 's1', objects: [
        { id: 'a', drawing: { strokes: [{ points: [[0, 0], [1, 1]] }], w: 10, h: 10 }, art: { use: 'ai', chosen: 'v2', variants: [v('v1'), v('v2')] } },
        { id: 'b', drawing: { strokes: [{ points: [[0, 0], [1, 1]] }], w: 10, h: 10 } },
      ] }],
    });
    const [a, b] = doc.scenes[0].objects;
    expect(docLook(doc)).toBe('game');
    expect(objectLook(a, doc)).toBe('ai');
    expect(objectLook(b, doc)).toBe('sketch');
    expect(chosenVariant(a)?.id).toBe('v2');
    expect(chosenVariant(a, 'v1')?.id).toBe('v1');
    expect(chosenVariant(a, 'nope')).toBeNull();
    const sketch = { ...doc, look: 'sketch' as const };
    expect(objectLook(a, sketch)).toBe('raw');
  });
});
