import { describe, expect, it } from 'vitest';
import { levelSource, sourceSectionCount } from '../level-source.ts';
import { newLevel } from '../levels.ts';

describe('selected level creation inputs', () => {
  it('shows the original requests for built-in levels without inventing a source drawing', () => {
    const pacman = levelSource('pacman', null), shooter = levelSource('shooter', null);
    expect(pacman.prompt).toContain('5 games to start with');
    expect(shooter.prompt).toBe('Also create a CSGO style shooter game.');
    expect(pacman.level.maze).toHaveLength(15); expect(pacman.canvases).toEqual([]);
    expect(pacman.builtIn).toBe(true);
  });
  it('changes prompt and canvas with the selected level and protects the saved source from mutations', () => {
    const a = newLevel('pacman', 1), b = newLevel('pacman', 2);
    a.source = { prompt: 'First maze', inputCanvases: ['data:image/png;base64,aGVsbG8='] };
    b.source = { prompt: 'Second maze', inputCanvases: ['data:image/png;base64,d29ybGQ='] };
    const first = levelSource('pacman', a), second = levelSource('pacman', b);
    expect(first.prompt).toBe('First maze'); expect(second.prompt).toBe('Second maze');
    expect(first.canvases).not.toEqual(second.canvases);
    first.level.maze![0] = 'changed'; expect(a.maze![0]).not.toBe('changed');
  });
  it('leaves missing provenance missing and rejects external images as input canvases', () => {
    const custom = newLevel('pacman', 1);
    expect(levelSource('pacman', custom).prompt).toBeNull();
    custom.source = { inputCanvases: ['https://example.com/image.png', 'broken'] };
    expect(levelSource('pacman', custom).canvases).toEqual([]);
    expect(levelSource('pacman', custom).builtIn).toBe(false);
    expect(levelSource('shooter', custom).builtIn).toBe(true);
  });
  it('includes every section of a level rather than showing only its first screen', () => {
    const platform = newLevel('platformer', 1); platform.platforms = [{ x: 0, y: 400, w: 960, h: 40 }, { x: 3300, y: 350, w: 200, h: 30 }]; platform.finish = 3350;
    expect(sourceSectionCount(platform)).toBe(4);
    const racing = newLevel('racing', 1); expect(sourceSectionCount(racing)).toBe(5);
  });
});
