/**
 * v2 engine entry (lane E). P0 STUB: draws compiled tiles as boxes, entities as simple marks and the player as a
 * rectangle on a Canvas2D, with ←/→ (or A/D) panning long levels. The real engine (Phaser on the core Sim, §7) replaces
 * this file's internals behind the same API.
 */
import type { LevelV2, RectCells } from '../core/types.gen.ts';
import type { InkDoc } from '../core/types.gen.ts';
import type { GameEvent, GameHandle, MountOptions, OverlaySpec } from './types.ts';

export type { GameEvent, GameHandle, MountOptions, OverlaySpec } from './types.ts';

const CELL = 16;
const VIEW_W = 48;
const VIEW_H = 27;
const COLORS = {
  paper: '#FBF6EA', solid: '#3b3530', oneway: '#6b625a', slope: '#5a524b', lava: '#E0453A', legacy: '#b33',
  coin: '#2C7BE5', goal: '#3E9E4F', hazard: '#E0453A', enemy: '#c0392b', player: '#1F1B18', other: '#6A5ACD',
};

function decodeRow(row: string): string {
  let out = '';
  for (const m of row.matchAll(/([0-9]*)([.#=/\\abcd~X])/g)) out += m[2].repeat(m[1] ? Number(m[1]) : 1);
  return out;
}

function drawTile(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number): void {
  const px = x * CELL;
  const py = y * CELL;
  ctx.beginPath();
  switch (ch) {
    case '#':
      ctx.fillStyle = COLORS.solid;
      ctx.fillRect(px, py, CELL, CELL);
      return;
    case '=':
      ctx.fillStyle = COLORS.oneway;
      ctx.fillRect(px, py, CELL, 3);
      return;
    case '~':
      ctx.fillStyle = COLORS.lava;
      ctx.fillRect(px, py + 4, CELL, CELL - 4);
      return;
    case 'X':
      ctx.fillStyle = COLORS.legacy;
      ctx.fillRect(px, py, CELL, CELL);
      return;
  }
  // Slopes: floor height at the cell's left → right edge, px from the cell top (§2.4).
  const h: Record<string, [number, number]> = { '/': [16, 0], '\\': [0, 16], a: [16, 8], b: [8, 0], c: [0, 8], d: [8, 16] };
  const s = h[ch];
  if (!s) return;
  ctx.fillStyle = COLORS.slope;
  ctx.moveTo(px, py + s[0]);
  ctx.lineTo(px + CELL, py + s[1]);
  ctx.lineTo(px + CELL, py + CELL);
  ctx.lineTo(px, py + CELL);
  ctx.closePath();
  ctx.fill();
}

function rect(ctx: CanvasRenderingContext2D, r: RectCells, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r[0] * CELL, r[1] * CELL, (r[2] - r[0]) * CELL, (r[3] - r[1]) * CELL);
}

function drawEntities(ctx: CanvasRenderingContext2D, level: LevelV2): [number, number] {
  let start: [number, number] = [2, 22];
  for (const e of level.compiled.entities) {
    switch (e.type) {
      case 'player_start':
        start = [e.x, e.y];
        break;
      case 'coin':
      case 'big_coin':
        ctx.fillStyle = COLORS.coin;
        ctx.beginPath();
        ctx.arc(e.x * CELL, e.y * CELL, e.type === 'coin' ? 5 : 8, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'goal':
        rect(ctx, e.trigger, COLORS.goal);
        ctx.fillStyle = COLORS.goal;
        ctx.fillRect(e.x * CELL, (e.y - 5) * CELL, 3, 5 * CELL);
        break;
      case 'checkpoint':
        ctx.fillStyle = COLORS.goal;
        ctx.fillRect(e.x * CELL, (e.y - 3) * CELL, 2, 3 * CELL);
        break;
      case 'spikes': {
        ctx.fillStyle = COLORS.hazard;
        const y = e.y * CELL;
        for (let x = e.x0 * CELL + 2; x < e.x1 * CELL - 2; x += 8) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 4, e.facing === 'down' ? y + 6 : y - 6);
          ctx.lineTo(x + 8, y);
          ctx.fill();
        }
        break;
      }
      case 'enemy':
        ctx.fillStyle = COLORS.enemy;
        ctx.fillRect((e.x - e.w / 2) * CELL, (e.y - e.h) * CELL, e.w * CELL, e.h * CELL);
        break;
      default:
        ctx.strokeStyle = COLORS.other;
        ctx.strokeRect(e.x * CELL - 6, e.y * CELL - 12, 12, 12);
    }
  }
  return start;
}

/** P0 stub of mountGame (§11.3g). */
export function mountGame(el: HTMLElement, level: LevelV2, ink: InkDoc | null, o: MountOptions): GameHandle {
  void ink;
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_W * CELL;
  canvas.height = VIEW_H * CELL;
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${VIEW_W * CELL * 2}px`;
  canvas.style.background = COLORS.paper;
  canvas.dataset.role = 'game-stub';
  canvas.tabIndex = 0;
  el.replaceChildren(canvas);
  const ctx = canvas.getContext('2d')!;
  const listeners = new Map<GameEvent, ((p: unknown) => void)[]>();
  let current = level;
  let camX = 0;
  let overlays: OverlaySpec = o.overlays ?? {};
  let paused = false;

  const render = (): void => {
    const world = current.world;
    camX = Math.max(0, Math.min(camX, world.w - VIEW_W));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, -camX * CELL, 0);
    current.compiled.tiles.rows.forEach((row, y) => {
      const cells = decodeRow(row);
      for (let x = Math.floor(camX); x < Math.min(cells.length, camX + VIEW_W + 1); x++) drawTile(ctx, cells[x], x, y);
    });
    const [sx, sy] = o.startAt ?? drawEntities(ctx, current);
    ctx.fillStyle = COLORS.player; // the 12 × 28 px collision box (§5.4)
    ctx.fillRect(sx * CELL - 6, sy * CELL - 28, 12, 28);
    for (const g of overlays.editGhosts ?? []) for (const r of g.after) rect(ctx, r, COLORS.other);
    if (paused) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  };

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'ArrowRight' || ev.key === 'd') camX += 4;
    else if (ev.key === 'ArrowLeft' || ev.key === 'a') camX -= 4;
    else return;
    ev.preventDefault();
    render();
  };
  canvas.addEventListener('keydown', onKey);
  render();
  queueMicrotask(() => listeners.get('ready')?.forEach((fn) => fn({ stub: true })));

  return {
    on(ev, fn) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), fn]);
    },
    swapLevel(next) {
      current = next;
      render();
    },
    setOverlays(next) {
      overlays = next;
      render();
    },
    pause() {
      paused = true;
      render();
    },
    resume() {
      paused = false;
      render();
    },
    restart() {
      camX = 0;
      render();
    },
    replay() {
      throw new Error('replay recording lands with the real engine (lane E, P4)');
    },
    destroy() {
      canvas.removeEventListener('keydown', onKey);
      canvas.remove();
      listeners.clear();
    },
  };
}

/** P0 stub: the feed thumbnail draws the same boxes into a canvas. */
export function renderThumbnail(c: HTMLCanvasElement, level: LevelV2, ink: InkDoc | null, o?: { view?: RectCells }): void {
  void ink;
  void o;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const scale = c.width / (VIEW_W * CELL);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, VIEW_W * CELL, VIEW_H * CELL);
  level.compiled.tiles.rows.forEach((row, y) => {
    const cells = decodeRow(row);
    for (let x = 0; x < Math.min(cells.length, VIEW_W); x++) drawTile(ctx, cells[x], x, y);
  });
  drawEntities(ctx, level);
}
