import { describe, expect, it } from 'vitest';
import type { Drawing, StudioTheme } from '../../core/types.gen.ts';
import { buildRecolorMap, contrast, fillFor, fullTheme, isAchromatic, mapColor, recolorFill, strokePalette } from '../theme/color.ts';
import { THEMES } from '../theme/presets.ts';

const d = (...colors: (string | [string, string])[]): Drawing => ({
  w: 10,
  h: 10,
  strokes: colors.map((c) => (Array.isArray(c)
    ? { points: [[0, 0], [5, 0], [5, 5]], color: c[0], closed: true, fill: c[1] }
    : { points: [[0, 0], [5, 5]], color: c })) as Drawing['strokes'],
});

describe('theme defaults', () => {
  it('fills every field and survives junk', () => {
    const t = fullTheme(null);
    expect(t.stroke.style).toBe('marker');
    expect(t.palette.bg).toMatch(/^#[0-9a-f]{6}$/);
    const odd = fullTheme({ palette: { bg: 'nope', ink: '#ABCDEF' }, stroke: { style: 'laser' as never, wobble: 9 } } as StudioTheme);
    expect(odd.palette.ink).toBe('#abcdef');
    expect(odd.palette.bg).toBe('#f6f1e7');
    expect(odd.stroke.style).toBe('marker');
    expect(odd.stroke.wobble).toBe(1);
  });
});

describe('recolor mapping', () => {
  const theme = fullTheme(THEMES.find((t) => t.id === 'neon_arcade')!);
  const pal = strokePalette(theme);

  it('maps distinct stroke colours to the palette in order of first use, game-wide', () => {
    const map = buildRecolorMap([d('#000000', '#FF0000'), d('#ff0000', '#0000ff', '#000000')], theme);
    expect([...map.keys()]).toEqual(['#000000', '#ff0000', '#0000ff']);
    expect(map.get('#000000')).toBe(pal[0]);
    expect(map.get('#ff0000')).toBe(pal[1]);
    expect(map.get('#0000ff')).toBe(pal[2]);
  });

  it('cycles when there are more colours than palette entries', () => {
    const many = Array.from({ length: pal.length + 2 }, (_, i) => `#${(i * 37 + 16).toString(16).padStart(2, '0')}0000`);
    const map = buildRecolorMap([d(...many)], theme);
    expect(map.get(many[pal.length])).toBe(pal[0]);
  });

  it('adds fills after strokes and keeps pale fills pale', () => {
    const map = buildRecolorMap([d(['#000000', '#ffffff'], ['#000000', '#22aa22'])], theme);
    expect(map.has('#ffffff')).toBe(false);
    expect(map.get('#22aa22')).toBe(pal[1]);
    expect(recolorFill('#ffffff', map, theme, pal[0], 1)).not.toBe(pal[1]);
  });

  it('leaves unknown colours alone', () => {
    expect(mapColor('#123456', new Map())).toBe('#123456');
    expect(mapColor('nope', null)).toBe('#1f1b18');
  });
});

describe('closed-shape fills', () => {
  const sketch = fullTheme(THEMES[0]);
  it('tints coloured pens toward the background', () => {
    const f = fillFor('#e4572e', sketch, 3);
    expect(f).not.toBe('#e4572e');
    expect(isAchromatic(f)).toBe(false);
  });
  it('gives dark pens a colourful, stable palette fill', () => {
    expect(isAchromatic(fillFor('#1f1b18', sketch, 7))).toBe(false);
    expect(fillFor('#1f1b18', sketch, 7)).toBe(fillFor('#1f1b18', sketch, 7));
  });
});

describe('presets', () => {
  it('has at least 14 themes with readable text', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(14);
    const ids = new Set(THEMES.map((t) => t.id));
    expect(ids.size).toBe(THEMES.length);
    for (const t of THEMES) {
      const f = fullTheme(t);
      expect(contrast(f.palette.bg, f.palette.text), `${t.id} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(f.palette.bg, f.palette.ink), `${t.id} ink`).toBeGreaterThanOrEqual(3);
    }
    for (const name of ['Sketchbook', 'Neon Arcade', 'Pixel Retro', 'Comic Pop', 'Chalkboard', 'Crayon Kids', 'Watercolor Dream', 'Blueprint',
      'Desert Dunes', 'Deep Space', 'Spooky Night', 'Candy', 'Jungle', 'Ocean', 'Noir Ink']) {
      expect(THEMES.some((t) => t.name === name), name).toBe(true);
    }
  });
});
