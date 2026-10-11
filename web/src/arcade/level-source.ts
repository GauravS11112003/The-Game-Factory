import { W, H, type GameId } from './engine.ts';
import { createGame, PlatformGame, RacingGame } from './games.ts';
import { newLevel, type ArcadeLevel } from './levels.ts';
import { ShooterGame } from './shooter.ts';

const COLLECTION_REQUEST = 'Create some really high quality and engaging games with colors and graphics. 5 games to start with: 1v1 fighter, pacman, super mario, hill climb racing, pacman.';
const SHOOTER_REQUEST = 'Also create a CSGO style shooter game.';
export interface LevelSourceView {
  level: ArcadeLevel;
  prompt: string | null;
  canvases: string[];
  builtIn: boolean;
}
/** Read only the selected level's provenance; unrelated idea drafts are never a level source. */
export function levelSource(id: GameId, selected: ArcadeLevel | null): LevelSourceView {
  const custom = selected?.game === id ? selected : null;
  const level = structuredClone(custom ?? { ...newLevel(id, 1), id: `${id}-original`, name: 'Original level' });
  const source = custom?.source;
  const canvases = Array.isArray(source?.inputCanvases) ? source.inputCanvases.filter(s => typeof s === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)).slice(0, 12) : [];
  return {
    level, builtIn: !custom, canvases,
    prompt: custom ? typeof source?.prompt === 'string' && source.prompt.trim() ? source.prompt : null : id === 'kart' ? 'As one of the stock games can you add game exactly like mario cart with great graphics.' : id === 'shooter' ? SHOOTER_REQUEST : COLLECTION_REQUEST,
  };
}
export function sourceSectionCount(level: ArcadeLevel): number {
  if (level.platforms) return Math.max(1, Math.min(12, Math.ceil(Math.max(level.finish ?? 0, ...level.platforms.map(p => p.x + p.w)) / W)));
  if (level.hills) return Math.max(1, Math.min(12, Math.ceil(Math.max(level.finish ?? 0, level.hills.at(-1)?.x ?? 0) / W)));
  return 1;
}
/** The level editor's actual input surface, rendered from saved geometry rather than a running game. */
export function drawLevelInput(ctx: CanvasRenderingContext2D, level: ArcadeLevel, section = 0, grid = true): void {
  const game = createGame(level.game, false, level);
  if (game instanceof PlatformGame || game instanceof RacingGame) game.camera = section * W;
  if (game instanceof ShooterGame) { game.drawBlueprint(ctx); return; }
  game.draw(ctx, 1.4);
  if (level.game === 'kart') return;
  if (!grid) return;
  ctx.save(); ctx.strokeStyle = '#ffffff24'; ctx.lineWidth = 1;
  const step = level.maze ? 30 : 40, ox = level.maze ? 165 : 0, oy = level.maze ? 58 : 0;
  for (let x = ox - step / 2; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = oy - step / 2; y < H; y += step) { ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(W, y); ctx.stroke(); }
  ctx.restore();
}
/** Capture every section at the moment the level is saved in the editor. */
export function captureLevelInputs(level: ArcadeLevel): string[] {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  return Array.from({ length: sourceSectionCount(level) }, (_, section) => {
    drawLevelInput(ctx, level, section); return canvas.toDataURL('image/png');
  });
}
