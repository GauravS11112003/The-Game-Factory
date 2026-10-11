import { describe, expect, it } from 'vitest';
import { FighterGame, MazeGame, PlatformGame, RacingGame, MAZE, terrain } from '../games.ts';
import type { Game, Input } from '../engine.ts';
const input = (...keys: string[]): Input => ({ down: new Set(keys), pressed: new Set(keys) });
function run(g: Game, seconds: number, controls = input()): void { for (let t = 0; t < seconds; t += 1 / 120) { g.update(1 / 120, controls); controls.pressed.clear(); } }

describe('maze games', () => {
  it('every dot and ghost spawn is reachable from the player', () => {
    const game = new MazeGame(); const seen = new Set<string>(), todo = [[10, 11]];
    while (todo.length) { const [x, y] = todo.pop()!; const key = `${x},${y}`; if (seen.has(key) || game.wall(x, y)) continue; seen.add(key); todo.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]); }
    expect(MAZE.every(row => row.length === 21)).toBe(true);
    for (const key of game.pellets.keys()) expect(seen.has(key), `Unreachable pellet ${key}`).toBe(true);
    for (const ghost of game.ghosts) expect(seen.has(`${ghost.x},${ghost.y}`)).toBe(true);
  });
  it('buffers a quick direction tap until an intersection', () => {
    const game = new MazeGame(); game.update(1 / 120, { down: new Set(), pressed: new Set(['ArrowLeft']) }); run(game, .1); expect(game.player.x).toBeLessThan(10); expect(game.desired).toBe(2);
  });
  it('collects a power pellet and stops at the outside wall', () => {
    const game = new MazeGame(); game.player.x = 1; game.player.y = 1; run(game, .05, input('ArrowLeft'));
    expect(game.player.x).toBe(1); expect(game.power).toBeGreaterThan(6); expect(game.score).toBe(50);
  });
  it('only removes one life per collision and grants safe respawn time', () => {
    const game = new MazeGame(); game.invincible = 0; Object.assign(game.ghosts[0], { x: 10, y: 11 }); run(game, .01);
    expect(game.lives).toBe(2); expect(game.invincible).toBeGreaterThan(1.9); expect(game.over).toBe(false);
  });
  it('finishes after the last dot and awards the clear bonus', () => {
    const game = new MazeGame(true); game.pellets.clear(); game.pellets.set('10,11', false); run(game, .01);
    expect(game.over).toBe(true); expect(game.won).toBe(true); expect(game.score).toBe(1010);
  });
});
describe('rooftop fighter', () => {
  it('blocking reduces a kick to chip damage', () => {
    const game = new FighterGame(true); game.players[0].x = 400; game.players[1].x = 490; game.update(1 / 120, input('KeyG', 'ArrowDown'));
    expect(game.players[1].hp).toBe(98); expect(game.score).toBe(20);
  });
  it('ends the match when a player wins two rounds', () => {
    const game = new FighterGame(true); game.players[0].round = 1; game.players[0].x = 400; game.players[1].x = 490; game.players[1].hp = 10; game.update(1 / 120, input('KeyG'));
    expect(game.over).toBe(true); expect(game.won).toBe(true); expect(game.players[0].round).toBe(2);
  });
});
describe('meadow platformer', () => {
  it('holding jump produces a higher arc than a tap', () => {
    const hold = new PlatformGame(), tap = new PlatformGame(); run(hold, .3); run(tap, .3);
    run(hold, .2, input('Space')); tap.update(1 / 120, input('Space')); run(tap, .2);
    expect(hold.y).toBeLessThan(tap.y - 20);
  });
  it('loses a heart in a gap and respawns at the checkpoint', () => {
    const game = new PlatformGame(); game.checkpoint = 1570; game.x = 2200; game.y = 650; game.update(1 / 120, input());
    expect(game.lives).toBe(2); expect(game.x).toBe(1570); expect(game.invincible).toBe(2);
  });
  it('the complete default course can be cleared with movement and jumps', () => {
    const game = new PlatformGame(); let holdingJump = false;
    for (let n = 0; n < 120 * 35 && !game.over; n++) {
      const hazard = [680, 1390, 2170].some(edge => edge > game.x && edge - game.x < 90) || game.enemies.some(e => e.alive && e.x > game.x && e.x - game.x < 95) || game.platforms.some(p => p.h === 30 && game.y > p.y && game.y - p.y <= 105 && p.x > game.x && p.x - game.x < 80);
      const jump = game.grounded && hazard; if (game.grounded) holdingJump = jump;
      const controls = input('ArrowRight', 'ShiftLeft', ...(holdingJump ? ['Space'] : [])); if (!jump) controls.pressed.clear();
      game.update(1 / 120, controls);
    }
    expect(game.won, `${game.info} at ${game.x}, ${game.y}`).toBe(true);
  });
  it('awards a win on reaching the final flag', () => {
    const game = new PlatformGame(); game.x = 2940; game.update(1 / 120, input()); expect(game.won).toBe(true); expect(game.score).toBe(1500);
  });
});
describe('hill racing', () => {
  it('can drive the whole course with fuel left', () => {
    const game = new RacingGame(); run(game, 40, input('ArrowRight'));
    expect(game.won, `${game.info} at ${game.x}, angle ${game.angle}`).toBe(true); expect(game.fuel).toBeGreaterThan(0); expect(game.score).toBeGreaterThan(0);
  });
  it('supports air control after a hop', () => {
    const game = new RacingGame(); game.update(1 / 120, input('ArrowRight', 'Space')); expect(game.grounded).toBe(false); expect(game.y).toBeLessThan(terrain(game.x) - 34); run(game, .1, input('ArrowRight')); expect(game.spin).toBeLessThan(0);
  });
  it('ends a run after a sustained rollover', () => {
    const game = new RacingGame(); game.angle = Math.PI; game.flipped = 1.19; run(game, .02); expect(game.over).toBe(true); expect(game.won).toBe(false);
  });
});
