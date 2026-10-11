import { describe, expect, it } from 'vitest';
import hill from '../../../../shared/studio/templates/hill_climb.json';
import platformer from '../../../../shared/studio/templates/platformer.json';
import { backdropPlacement, svgSize } from '../theme/backdrop.ts';
import { fullTheme } from '../theme/color.ts';
import { THEMES } from '../theme/presets.ts';
import {
  buildTerrain, classifyStroke, crossingsAt, decorSpots, defaultSkin, DEEP, offsetLine, pebbleSpots, resolveSkin, signedArea,
  terrainMood, worldStrokes, type Pt, type TerrainObj,
} from '../theme/terrain.ts';

const line = (id: string, pts: Pt[], o: Partial<TerrainObj> = {}, width = 14, closed = false): TerrainObj => ({
  id, x: 0, y: 0, ...o, drawing: { strokes: [{ points: pts, width, closed, color: '#5a3d1e' }] },
});
const world = { width: 3000, height: 1400 };

describe('terrain geometry', () => {
  it('puts strokes in world space (position, rotation, scale) with the physics half thickness', () => {
    const [s] = worldStrokes(line('g', [[-100, 0], [100, 0]], { x: 500, y: 300, scale: 2 }, 10));
    expect(s.pts[0]).toEqual([300, 300]);
    expect(s.pts[s.pts.length - 1]).toEqual([700, 300]);
    expect(s.r).toBe(10); // max(4, 10 / 2) × 2
    const [r] = worldStrokes(line('g', [[0, 0], [100, 0]], { rotation: 90 }));
    expect(r.pts[1][0]).toBeCloseTo(0);
    expect(r.pts[1][1]).toBeCloseTo(100);
  });

  it('offsets an open left-to-right line upward and a closed outline outward', () => {
    const up = offsetLine([[0, 100], [100, 100], [200, 100]], 7, false);
    for (const p of up) expect(p[1]).toBeCloseTo(93);
    const sq: Pt[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    for (const s of [sq, sq.slice().reverse()]) {
      const out = offsetLine(s, 5, true);
      expect(Math.abs(signedArea(out))).toBeGreaterThan(Math.abs(signedArea(s)));
    }
  });

  it('fills a ground line down past the world bottom and past the world sides it reaches', () => {
    const g = line('g', [[0, 900], [1500, 800], [3000, 950]]);
    const [p] = buildTerrain(g, world);
    expect(p.kind).toBe('ground');
    expect(p.box.maxY).toBeGreaterThanOrEqual(world.height + DEEP);
    expect(p.box.minX).toBeLessThanOrEqual(-DEEP);
    expect(p.box.maxX).toBeGreaterThanOrEqual(world.width + DEEP);
    // the visible top sits on the physics surface (line raised by r = 7)
    const ys = crossingsAt(p.runs[0], 1500, false);
    expect(Math.min(...ys)).toBeCloseTo(800 - 7, 0);
  });

  it('draws a right-to-left ground line the same as left-to-right', () => {
    const [a] = buildTerrain(line('a', [[200, 900], [1200, 900]]), world);
    const [b] = buildTerrain(line('b', [[1200, 900], [200, 900]]), world);
    expect(a.runs[0][0][0]).toBeCloseTo(b.runs[0][0][0]);
    expect(Math.min(...crossingsAt(b.runs[0], 700, false))).toBeCloseTo(893, 0);
  });

  it('classifies walls, floating slabs, closed shapes and ground', () => {
    const ground = line('ground', [[0, 1000], [3000, 1000]]);
    const ledge = line('ledge', [[800, 600], [1300, 590]]);
    const wall = line('wall', [[100, 400], [104, 900]]);
    const box = line('box', [[2000, 700], [2200, 700], [2200, 800], [2000, 800]], {}, 8, true);
    const all = [ground, ledge, wall, box].flatMap(worldStrokes);
    expect(all.map((s) => classifyStroke(s, all))).toEqual(['ground', 'slab', 'wall', 'closed']);
    const [slab] = buildTerrain(ledge, world, [ground]);
    expect(slab.kind).toBe('slab');
    expect(slab.box.maxY).toBeLessThan(720); // an island, not a pillar down to the bottom
    // alone it is ground
    expect(buildTerrain(ledge, world)[0].kind).toBe('ground');
  });

  it('gives closed shapes surface runs only on their upward faces', () => {
    const [p] = buildTerrain(line('b', [[0, 0], [200, 0], [200, 100], [0, 100]], { x: 500, y: 500 }, 8, true), world);
    expect(p.runs.length).toBeGreaterThan(0);
    for (const run of p.runs) for (const pt of run) expect(pt[1]).toBeLessThan(500);
  });

  it('turns the hill climb template ground into one ground piece and its start wall into a wall', () => {
    const sc = (hill as { scenes: { objects: TerrainObj[]; world: typeof world }[] }).scenes[0];
    const lines = sc.objects.filter((o) => (o as { physics?: { shape?: string } }).physics?.shape === 'line');
    const kinds = lines.map((o) => buildTerrain(o, sc.world, lines)[0]?.kind);
    expect(kinds).toEqual(['ground', 'wall']);
  });

  it('keeps the platformer template side walls as walls', () => {
    const sc = (platformer as { scenes: { objects: TerrainObj[]; world: typeof world }[] }).scenes[0];
    const lines = sc.objects.filter((o) => (o as { physics?: { shape?: string } }).physics?.shape === 'line');
    for (const o of lines) expect(buildTerrain(o, sc.world, lines)[0]?.kind).toBe('wall');
  });
});

describe('decorations', () => {
  const pieces = buildTerrain(line('g', [[0, 900], [1000, 900], [1200, 500], [2000, 500]]), world);

  it('are deterministic, spaced about decor_every, and skip steep slopes', () => {
    const a = decorSpots(pieces, 150, 42, 3, { minX: 0, maxX: 3000 });
    const b = decorSpots(pieces, 150, 42, 3, { minX: 0, maxX: 3000 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(6);
    for (const s of a) {
      expect(Math.abs(s.angle)).toBeLessThanOrEqual(30);
      expect(s.variant).toBeGreaterThanOrEqual(0);
      expect(s.variant).toBeLessThan(3);
      expect(s.x).toBeGreaterThanOrEqual(0);
    }
    // nothing on the 63° climb between x 1000 and 1200
    expect(a.some((s) => s.x > 1010 && s.x < 1190)).toBe(false);
    const c = decorSpots(pieces, 150, 7, 3, { minX: 0, maxX: 3000 });
    expect(c).not.toEqual(a);
  });

  it('need variants', () => {
    expect(decorSpots(pieces, 150, 1, 0)).toEqual([]);
  });

  it('pebbles agree across neighbouring windows', () => {
    const all = pebbleSpots({ minX: 0, minY: 0, maxX: 400, maxY: 400 }, 9);
    const left = pebbleSpots({ minX: 0, minY: 0, maxX: 200, maxY: 400 }, 9);
    for (const p of left.filter((q) => q.x < 150)) expect(all).toContainEqual(p);
  });
});

describe('skins', () => {
  it('make solid land for every preset theme', () => {
    for (const t of THEMES) {
      const s = defaultSkin(fullTheme(t), '#1f1b18');
      expect(s.fill.length).toBeGreaterThan(0);
      for (const c of [...s.fill, s.surface, s.edge]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.surfaceWidth).toBeGreaterThan(0);
    }
  });

  it('honour a coloured pen and the theme mood', () => {
    const grass = fullTheme({ background: { style: 'hills' } });
    expect(terrainMood(grass)).toBe('grass');
    expect(defaultSkin(grass, '#2e9e3e').surface).toBe('#2e9e3e');
    expect(defaultSkin(grass, '#8a4b20').fill[0]).not.toBe(defaultSkin(grass, '#1f1b18').fill[0]);
    expect(terrainMood(fullTheme({ background: { style: 'space' } }))).toBe('moon');
    expect(defaultSkin(fullTheme({ background: { style: 'neon_grid' } }), '#000000').glow).toBe(true);
  });

  it('resolve AI skins and fall back for bad values', () => {
    const ft = fullTheme(null);
    const s = resolveSkin({ fill: ['#112233', 'nope'] as never, surface: 'nope!', surface_width: 20, decor: [], decor_every: 10 }, ft, '#000');
    expect(s.fill).toEqual(['#112233']);
    expect(s.surface).toBe(defaultSkin(ft, '#000').surface);
    expect(s.surfaceWidth).toBe(20);
    expect(s.decorEvery).toBe(40);
    expect(resolveSkin(null, ft, '#000')).toEqual(defaultSkin(ft, '#000'));
  });
});

describe('backdrop placement', () => {
  const view = { w: 1920, h: 1080 };
  const w = { width: 12000, height: 1400 };

  it('reads SVG sizes', () => {
    expect(svgSize('<svg viewBox="0 0 2400 900"><rect/></svg>')).toEqual({ w: 2400, h: 900 });
    expect(svgSize('<svg width="40" height="20"></svg>')).toEqual({ w: 40, h: 20 });
    expect(svgSize('nope')).toBeNull();
  });

  it('sizes a layer by its share of the view height and scrolls it by depth', () => {
    const l = { w: 2400, h: 900, depth: 0.5, anchor: 'bottom' as const, tile_x: true, height: 0.5 };
    const p0 = backdropPlacement(l, w, { x: 0, y: 500, zoom: 1 }, view);
    expect(p0.h).toBeCloseTo(540);
    expect(p0.scale).toBeCloseTo(0.6);
    expect(p0.y + p0.h).toBeCloseTo(1080);
    const p1 = backdropPlacement(l, w, { x: 100, y: 500, zoom: 1 }, view);
    expect(p1.offset - p0.offset).toBeCloseTo(50);
    const far = backdropPlacement({ ...l, depth: 0 }, w, { x: 5000, y: 0, zoom: 2 }, view);
    expect(far.offset).toBe(0);
  });

  it('sinks bottom layers when the camera rises above the floor, but never leaves a gap', () => {
    const l = { w: 2400, h: 900, depth: 1, anchor: 'bottom' as const, height: 0.5 };
    const high = backdropPlacement(l, w, { x: 0, y: 0, zoom: 1 }, view);
    expect(high.y).toBeGreaterThan(1080 - high.h);
    const low = backdropPlacement(l, w, { x: 0, y: 2000, zoom: 1 }, view);
    expect(low.y + low.h).toBeCloseTo(1080);
  });

  it('centres a single picture on the world', () => {
    const l = { w: 1000, h: 500, depth: 0, anchor: 'top' as const, tile_x: false, height: 0.5 };
    const p = backdropPlacement(l, w, { x: 0, y: 0, zoom: 1 }, view);
    expect(p.repeat).toBe(false);
    expect(p.x + p.w / 2).toBeCloseTo(960);
    expect(p.y).toBe(-0);
  });
});
