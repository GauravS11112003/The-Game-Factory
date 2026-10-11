/** v7 editor look helpers (docs/v7/CONTRACTS_V7.md §5): which look plays, sized SVGs for Image drawing. */
import { describe, expect, it } from 'vitest';
import { chosenVariant, docLook, objectLook, sizedSvg } from '../editor/look.ts';
import { normalizeDoc } from '../model/types.ts';

const v = (id: string) => ({ id, svg: '<svg viewBox="0 0 10 10"></svg>', w: 10, h: 10 });

describe('editor look', () => {
  it('gives an SVG a width and height from its viewBox', () => {
    expect(sizedSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect/></svg>')).toBe('<svg width="80" height="40" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect/></svg>');
    const sized = '<svg width="5" height="6" viewBox="0 0 80 40"></svg>';
    expect(sizedSvg(sized)).toBe(sized);
    expect(sizedSvg('<svg viewBox="0 0 80 40" width="100%"></svg>')).toBe('<svg width="80" height="40" viewBox="0 0 80 40"></svg>');
    expect(sizedSvg('<svg></svg>', 12, 7)).toBe('<svg width="12" height="7"></svg>');
    expect(sizedSvg('not svg')).toBe('not svg');
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
