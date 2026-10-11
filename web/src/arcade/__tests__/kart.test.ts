import { afterEach, describe, expect, it, vi } from 'vitest';
import { KartGame, KART_THEMES, type KartTheme } from '../kart.ts';
import { createGame } from '../games.ts';
import { GAMES } from '../catalog.ts';
import { newLevel, readLevels, saveLevel } from '../levels.ts';
import { levelSource } from '../level-source.ts';
import type { Input } from '../engine.ts';

const input = (...keys: string[]): Input => ({ down: new Set(keys), pressed: new Set() });
function run(game: KartGame, seconds: number, controls = input()): void {
  for (let n = 0; n < Math.ceil(seconds * 120); n++) { game.update(1 / 120, controls); controls.pressed.clear(); }
}
function active(theme: KartTheme = 'coast', laps = 3): KartGame { const game = new KartGame(theme, laps); game.countdown = 0; return game; }
afterEach(() => vi.unstubAllGlobals());

describe('Pocket Kart Grand Prix', () => {
  it('is a stock racing game with keyboard and touch controls', () => {
    const entry = GAMES.find(g => g.id === 'kart')!;
    expect(entry.category).toBe('Racing'); expect(entry.touch.map(t => t.key)).toContain('ShiftLeft');
    expect(createGame('kart')).toBeInstanceOf(KartGame);
    expect(levelSource('kart', null).prompt).toContain('mario cart');
  });
  it('holds every racer at the grid until the countdown ends', () => {
    const game = new KartGame(), starts = game.rivals.map(r => r.distance);
    run(game, 2.5, input('ArrowUp')); expect(game.distance).toBe(0); expect(game.rivals.map(r => r.distance)).toEqual(starts);
    run(game, 1.5, input('ArrowUp')); expect(game.distance).toBeGreaterThan(1000); expect(game.soundEvents).toContain('go');
  });
  it('accelerates, brakes, steers, and slows on the grass', () => {
    const road = active(), grass = active(); road.rivals = []; grass.rivals = []; grass.lane = 1.5;
    run(road, 2, input('KeyW')); run(grass, 2, input('KeyW'));
    expect(road.speed).toBeGreaterThan(grass.speed * 2);
    const previousSpeed = road.speed; run(road, .3, input('KeyS', 'KeyD'));
    expect(road.speed).toBeLessThan(previousSpeed); expect(road.lane).toBeGreaterThan(0);
  });
  it('rewards a charged drift on release but never an uncharged tap', () => {
    const game = active(); game.speed = 5600; game.rivals = [];
    run(game, .7, input('ArrowUp', 'ArrowRight', 'ShiftLeft'));
    expect(game.drifting).toBe(true); expect(game.boost).toBe(0);
    game.update(1 / 120, input('ArrowUp')); expect(game.boost).toBeGreaterThan(.9); expect(game.score).toBe(50);
    const tap = active(); tap.speed = 5600; run(tap, .1, input('ArrowUp', 'ArrowRight', 'ShiftLeft')); tap.update(1 / 120, input()); expect(tap.boost).toBe(0);
  });
  it('collects a crossed item box once per lap even at boost speed', () => {
    const game = active(); game.rivals = []; game.lane = 0; game.distance = 36 * 200 - 20; game.speed = 8000; game.boost = 2;
    game.update(.01, input('ArrowUp')); expect(game.item).not.toBeNull(); expect(game.score).toBe(50);
    game.distance = 36 * 200 - 20; game.item = null; game.update(.01, input('ArrowUp')); expect(game.item).toBeNull();
    game.distance = game.length + 36 * 200 - 20; game.update(.01, input('ArrowUp')); expect(game.item).not.toBeNull();
  });
  it('uses a collected item only once and the pulse targets the next racer', () => {
    const game = active(); game.item = 'pulse'; game.distance = 2000; game.rivals[0].distance = 2800; game.rivals[1].distance = 2200;
    const controls = input(); controls.pressed.add('Space'); game.update(1 / 120, controls);
    expect(game.item).toBeNull(); expect(game.rivals[1].stun).toBeGreaterThan(2); expect(game.rivals[0].stun).toBe(0);
    const score = game.score; game.update(1 / 120, controls); expect(game.score).toBe(score);
  });
  it('shields protect from hits and a collision grants recovery time', () => {
    const game = active(); game.speed = 5600; game.shield = 2; game.hit(); expect(game.stun).toBe(0);
    game.shield = 0; game.coins = 5; game.hit(); expect(game.coins).toBe(3); expect(game.stun).toBeGreaterThan(0);
    game.hit(); expect(game.coins).toBe(3);
  });
  it('a slip pod catches a following rival and expires after one hit', () => {
    const game = active(); game.distance = 2000; game.lane = 0; game.item = 'trap'; game.useItem();
    game.rivals[0].distance = 1490; game.rivals[0].lane = 0; game.update(1 / 120, input());
    expect(game.rivals[0].stun).toBe(2); expect(game.traps[0].life).toBe(0); expect(game.score).toBe(100);
  });
  it.each(Object.keys(KART_THEMES) as KartTheme[])('allows a complete %s race to be won with steering and gas', theme => {
    const game = active(theme);
    for (let n = 0; n < 120 * 130 && !game.over; n++) {
      const turn = game.lane > .07 ? 'ArrowLeft' : game.lane < -.07 ? 'ArrowRight' : '';
      const controls = input('ArrowUp', ...(turn ? [turn] : [])); if (game.item) controls.pressed.add('Space');
      game.update(1 / 120, controls);
    }
    expect(game.over, game.info).toBe(true); expect(game.won, game.info).toBe(true); expect(game.finishPosition).toBe(1);
    const score = game.score; run(game, 1, input('ArrowUp')); expect(game.score).toBe(score);
  });
  it('counts actual finished rivals at the finish rather than wrapped visual positions', () => {
    const game = active('coast', 1); game.distance = game.length - 10; game.speed = 5600;
    game.rivals[0].distance = game.length; game.rivals[0].finishTime = 20;
    game.elapsed = 23; game.update(.01, input('ArrowUp'));
    expect(game.over).toBe(true); expect(game.won).toBe(false); expect(game.finishPosition).toBe(2); expect(game.info).toContain('2nd place');
  });
  it('saves circuit and lap settings, rejecting damaged race data', () => {
    const data = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    const level = newLevel('kart', 1); level.kartTheme = 'alpine'; level.kartLaps = 1; saveLevel(level);
    const restored = createGame('kart', false, readLevels('kart')[0]) as KartGame;
    expect(restored.theme).toBe('alpine'); expect(restored.laps).toBe(1);
    data.set('draw.play.levels.kart', JSON.stringify([level, { ...level, kartLaps: 0 }, { ...level, kartTheme: 'unknown' }]));
    expect(readLevels('kart')).toHaveLength(1);
  });
});
