import { ShooterGame, ARENA_COLS, ARENA_ROWS } from './shooter.ts';
import type { GameId } from './engine.ts';
import { createGame, FighterGame, MazeGame, PlatformGame, RacingGame, terrain } from './games.ts';
export interface ArcadeLevel {
  id: string; game: GameId; name: string;
  maze?: string[];
  arena?: string[];
  platforms?: { x: number; y: number; w: number; h: number }[];
  coins?: { x: number; y: number }[];
  enemies?: { x: number; y: number }[];
  hills?: { x: number; y: number }[];
  pickups?: { x: number; fuel: boolean }[];
  finish?: number;
  spawns?: number[];
  duration?: number;
  rounds?: number;
  source?: { prompt?: string; inputCanvases?: string[] };
}
export function newLevel(id: GameId, n: number): ArcadeLevel {
  const g = createGame(id);
  const level: ArcadeLevel = { id: crypto.randomUUID(), game: id, name: `Level ${n}` };
  if (g instanceof MazeGame) level.maze = g.maze.slice();
  if (g instanceof PlatformGame) { level.platforms = g.platforms.map(p => ({ ...p })); level.coins = g.coins.map(({x,y}) => ({x,y})); level.enemies = g.enemies.map(({x,y}) => ({x,y})); level.finish = g.finish; }
  if (g instanceof RacingGame) { level.hills = Array.from({length: 61}, (_,i) => ({x: i * 80, y: terrain(i * 80)})); level.pickups = g.pickups.map(({x,fuel}) => ({x,fuel})); level.finish = g.finish; }
  if (g instanceof FighterGame) { level.spawns = g.starts.slice(); level.duration = 60; level.rounds = 2; }
  if (g instanceof ShooterGame) { level.arena = g.map.slice(); level.duration = 90; level.rounds = 3; }
  return level;
}
const storageKey = (id: GameId): string => `draw.play.levels.${id}`;
export function readLevels(id: GameId): ArcadeLevel[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey(id)) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data.filter((l): l is ArcadeLevel => validLevel(l, id));
  } catch { return []; }
}
function validLevel(value: unknown, id: GameId): value is ArcadeLevel {
  if (!value || typeof value !== 'object') return false;
  const l = value as ArcadeLevel;
  const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
  const points = (a: unknown): boolean => Array.isArray(a) && a.every(p => p && finite(p.x) && finite(p.y));
  if (l.game !== id || typeof l.id !== 'string' || typeof l.name !== 'string') return false;
  if (id === 'pacman' || id === 'neon') return Array.isArray(l.maze) && l.maze.length === 15 && l.maze.every(r => typeof r === 'string' && r.length === 21 && /^[#.o ]+$/.test(r));
  if (id === 'shooter') {
    if (!Array.isArray(l.arena) || l.arena.length !== ARENA_ROWS || !l.arena.every(r => typeof r === 'string' && r.length === ARENA_COLS && /^[123#.ABPD]+$/.test(r))) return false;
    const all = l.arena.join('');
    return ['P','A','B'].every(v => [...all].filter(c => c === v).length === 1) && (all.match(/D/g)?.length ?? 0) >= 1 && (all.match(/D/g)?.length ?? 0) <= 6 && l.arena.every((r,y) => /^[123#]+$/.test(y === 0 || y === ARENA_ROWS-1 ? r : r[0] + r.at(-1))) && finite(l.duration) && l.duration! >= 15 && l.duration! <= 180 && Number.isInteger(l.rounds) && l.rounds! >= 1 && l.rounds! <= 5;
  }
  if (id === 'platformer') return points(l.platforms) && l.platforms!.every(p => finite(p.w) && finite(p.h) && p.w > 0 && p.h > 0) && points(l.coins) && points(l.enemies) && finite(l.finish);
  if (id === 'racing') return points(l.hills) && l.hills!.length >= 2 && l.hills!.every((p,i,a) => i === 0 || p.x > a[i-1].x) && Array.isArray(l.pickups) && l.pickups.every(p => p && finite(p.x) && typeof p.fuel === 'boolean') && finite(l.finish);
  return Array.isArray(l.spawns) && l.spawns.length === 2 && l.spawns.every(n => finite(n) && n >= 55 && n <= 905) && finite(l.duration) && l.duration! >= 15 && l.duration! <= 180 && finite(l.rounds) && l.rounds! >= 1 && l.rounds! <= 5;
}
export function saveLevel(level: ArcadeLevel): void {
  const levels = readLevels(level.game);
  const index = levels.findIndex(l => l.id === level.id);
  if (index < 0) levels.push(level); else levels[index] = level;
  localStorage.setItem(storageKey(level.game), JSON.stringify(levels));
}
