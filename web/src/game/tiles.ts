/**
 * "Ink on paper" rendering shared by the Phaser scene (as runtime textures)
 * and renderThumbnail (plain canvas 2D, no Phaser). Everything is drawn in
 * level pixels (768x432); thumbnails scale the context down.
 *
 * Fixture and seed levels have no backdrop photo, so this is what they look
 * like: black marker ground, red spikes, a green scribbled flag, blue coins.
 */
import type { Entity, Level } from '../types';
import { TILE_HAZARD, TILE_SOLID } from '../types';
import { CELL, GAME_H, GAME_W } from './constants';

export const PAPER = '#fdfcf7';
export const PAPER_DOT = '#e6e3da';
export const INK = '#1c1c1c';
export const INK_SOFT = '#4a4a4a';
export const RED = '#e53935';
export const RED_DARK = '#b71c1c';
export const GREEN = '#43a047';
export const GREEN_DARK = '#2e7d32';
export const BLUE = '#1e88e5';
export const BLUE_DARK = '#1565c0';
export const GRAY = '#9e9e9e';

/** Texture sizes used by the scene; the thumbnail uses the same drawings. */
export const GOAL_W = 24;
export const GOAL_H = 32;
export const COIN_SIZE = 12;
export const KEY_W = 20;
export const KEY_H = 14;
export const FLAG_W = 20;
export const FLAG_H = 32;
export const PLAYER_TEX_W = 32;
export const PLAYER_TEX_H = 48;
export const PAD_H = 10;
export const PUFF_SIZE = 8;

type Ctx = CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctxOf(c: HTMLCanvasElement): Ctx {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  return ctx;
}

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Deterministic wobble so doodles look hand-drawn but render identically every time. */
function wobble(i: number, amp: number): number {
  return Math.sin(i * 2.399) * amp + Math.cos(i * 1.123) * amp * 0.5;
}

function blobPath(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, amp: number): void {
  const n = 16;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = i % n;
    const r = 1 + wobble(k, amp);
    const x = cx + Math.cos(a) * rx * r;
    const y = cy + Math.sin(a) * ry * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Merge cells of one kind into rectangles: horizontal runs, then identical runs stacked vertically. */
export function mergeCells(rows: string[], ch: string): CellRect[] {
  const out: CellRect[] = [];
  let open = new Map<string, CellRect>();
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    const next = new Map<string, CellRect>();
    let x = 0;
    while (x < row.length) {
      if (row[x] !== ch) {
        x++;
        continue;
      }
      let x1 = x;
      while (x1 + 1 < row.length && row[x1 + 1] === ch) x1++;
      const w = x1 - x + 1;
      const key = `${x}:${w}`;
      const prev = open.get(key);
      if (prev) {
        prev.h += 1;
        next.set(key, prev);
      } else {
        const r = { x, y, w, h: 1 };
        out.push(r);
        next.set(key, r);
      }
      x = x1 + 1;
    }
    open = next;
  }
  return out;
}

export function drawPaper(ctx: Ctx, w: number, h: number, dots: boolean): void {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  if (!dots) return;
  ctx.fillStyle = PAPER_DOT;
  for (let y = 0; y <= h; y += CELL) {
    for (let x = 0; x <= w; x += CELL) {
      ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
    }
  }
}

export function drawSolids(ctx: Ctx, rows: string[]): void {
  ctx.fillStyle = INK;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  for (const r of mergeCells(rows, TILE_SOLID)) {
    // Overlap by half a pixel so stacked rectangles do not show paper seams.
    roundedRect(ctx, r.x * CELL - 0.5, r.y * CELL - 0.5, r.w * CELL + 1, r.h * CELL + 1, 3);
    ctx.fill();
    ctx.stroke();
  }
}

export function drawHazards(ctx: Ctx, rows: string[]): void {
  ctx.fillStyle = RED;
  ctx.strokeStyle = RED_DARK;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  const solidAt = (x: number, y: number): boolean => y >= 0 && y < rows.length && rows[y][x] === TILE_SOLID;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== TILE_HAZARD) continue;
      // Spikes point up unless they hang from a ceiling.
      const down = solidAt(x, y - 1) && !solidAt(x, y + 1);
      const px = x * CELL;
      const base = down ? y * CELL + 1 : (y + 1) * CELL - 1;
      const tip = down ? (y + 1) * CELL - 2 : y * CELL + 2;
      for (let s = 0; s < 2; s++) {
        const sx = px + s * (CELL / 2);
        ctx.beginPath();
        ctx.moveTo(sx + 0.5, base);
        ctx.lineTo(sx + CELL / 4 + wobble(x + s, 0.6), tip);
        ctx.lineTo(sx + CELL / 2 - 0.5, base);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

/** Green scribbled flag in a GOAL_W x GOAL_H box, pole at the left, base at the bottom. */
export function drawGoalFlag(ctx: Ctx): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = GREEN_DARK;
  ctx.lineWidth = 2.5;
  line(ctx, 4, GOAL_H - 1, 4, 3);
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.moveTo(5, 3);
  ctx.lineTo(GOAL_W - 2, 9.5);
  ctx.lineTo(5, 16);
  ctx.closePath();
  ctx.fill();
  // Scribble fill: a zigzag inside the triangle.
  ctx.strokeStyle = GREEN_DARK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(6, 5);
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const xEnd = 6 + (GOAL_W - 10) * (1 - Math.abs(t - 0.5) * 2) * 0.9 + 2;
    const y = 5 + t * 9;
    ctx.lineTo(i % 2 === 0 ? xEnd : 6.5, y);
  }
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = GREEN_DARK;
  ctx.beginPath();
  ctx.moveTo(5, 3);
  ctx.lineTo(GOAL_W - 2, 9.5);
  ctx.lineTo(5, 16);
  ctx.stroke();
}

/** Blue coin in a COIN_SIZE box. */
export function drawCoin(ctx: Ctx): void {
  const c = COIN_SIZE / 2;
  ctx.fillStyle = BLUE;
  ctx.strokeStyle = BLUE_DARK;
  ctx.lineWidth = 1.5;
  blobPath(ctx, c, c, c - 1.2, c - 1.2, 0.04);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c, c, c - 4, 0, Math.PI * 2);
  ctx.stroke();
}

/** Blue key, horizontal, in a KEY_W x KEY_H box. */
export function drawKey(ctx: Ctx): void {
  ctx.strokeStyle = BLUE_DARK;
  ctx.fillStyle = BLUE;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(5.5, KEY_H / 2, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.arc(5.5, KEY_H / 2, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = BLUE;
  ctx.lineWidth = 2.5;
  line(ctx, 9.5, KEY_H / 2, KEY_W - 1.5, KEY_H / 2);
  line(ctx, KEY_W - 2, KEY_H / 2, KEY_W - 2, KEY_H / 2 + 4);
  line(ctx, KEY_W - 5.5, KEY_H / 2, KEY_W - 5.5, KEY_H / 2 + 3);
}

/** Checkpoint flag in a FLAG_W x FLAG_H box; gray until reached, green afterwards. */
export function drawCheckpointFlag(ctx: Ctx, active: boolean): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = active ? GREEN_DARK : INK_SOFT;
  ctx.lineWidth = 2;
  line(ctx, 3, FLAG_H - 1, 3, 2);
  ctx.fillStyle = active ? GREEN : PAPER;
  ctx.strokeStyle = active ? GREEN_DARK : GRAY;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(4, 3);
  ctx.lineTo(FLAG_W - 2, 4.5);
  ctx.lineTo(FLAG_W - 5, 8.5);
  ctx.lineTo(FLAG_W - 2, 12.5);
  ctx.lineTo(4, 14);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  if (active) {
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = 1.5;
    line(ctx, 7, 8.5, 9.5, 11);
    line(ctx, 9.5, 11, 14, 5.5);
  }
}

/** Default player: a wobbly smiley blob with stick legs, PLAYER_TEX_W x PLAYER_TEX_H, feet on the bottom edge. */
export function drawPlayerDoodle(ctx: Ctx): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  // legs with little feet
  line(ctx, 12, 29, 10, 46);
  line(ctx, 10, 46, 6, 46.5);
  line(ctx, 20, 29, 22, 46);
  line(ctx, 22, 46, 26, 46.5);
  // arms
  line(ctx, 5, 19, 1.5, 25);
  line(ctx, 27, 19, 30.5, 25);
  // body blob
  ctx.fillStyle = '#fff6d6';
  blobPath(ctx, 16, 17, 12.5, 12.5, 0.05);
  ctx.fill();
  ctx.stroke();
  // face
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(11.5, 14, 1.8, 0, Math.PI * 2);
  ctx.arc(20.5, 14, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(10.5, 20);
  ctx.quadraticCurveTo(16, 26, 21.5, 20);
  ctx.stroke();
  // a cheek scribble
  ctx.strokeStyle = '#e57373';
  ctx.lineWidth = 1;
  line(ctx, 7.5, 19, 9.5, 18.5);
  line(ctx, 22.5, 18.5, 24.5, 19);
}

/** Ink rectangle for a moving platform without a crop. */
export function drawPlatformInk(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = INK;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  roundedRect(ctx, 0.5, 0.5, w - 1, h - 1, 4);
  ctx.fill();
  ctx.stroke();
  // light marker streak so it reads as a separate, "drawn" piece
  ctx.strokeStyle = '#6b6b6b';
  ctx.lineWidth = 1;
  line(ctx, 4, 3.5, w - 4, 3.5);
}

/** Red blob with angry eyes for an enemy without a crop. */
export function drawEnemyBlob(ctx: Ctx, w: number, h: number): void {
  ctx.lineJoin = 'round';
  ctx.fillStyle = RED;
  ctx.strokeStyle = RED_DARK;
  ctx.lineWidth = 2;
  blobPath(ctx, w / 2, h / 2 + 1, w / 2 - 2, h / 2 - 2, 0.07);
  ctx.fill();
  ctx.stroke();
  const ex = Math.max(3, w * 0.22);
  const ey = h * 0.4;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(w / 2 - ex, ey, Math.min(3.5, w / 6), 0, Math.PI * 2);
  ctx.arc(w / 2 + ex, ey, Math.min(3.5, w / 6), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(w / 2 - ex + 1, ey + 0.5, 1.4, 0, Math.PI * 2);
  ctx.arc(w / 2 + ex - 1, ey + 0.5, 1.4, 0, Math.PI * 2);
  ctx.fill();
  // angry brows and a zigzag mouth
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  line(ctx, w / 2 - ex - 3, ey - 5, w / 2 - ex + 2, ey - 3);
  line(ctx, w / 2 + ex + 3, ey - 5, w / 2 + ex - 2, ey - 3);
  ctx.beginPath();
  const my = h * 0.68;
  const mx0 = w / 2 - Math.min(8, w * 0.3);
  const mx1 = w / 2 + Math.min(8, w * 0.3);
  const teeth = 4;
  ctx.moveTo(mx0, my);
  for (let i = 1; i <= teeth; i++) {
    const x = mx0 + ((mx1 - mx0) * i) / teeth;
    ctx.lineTo(x - (mx1 - mx0) / teeth / 2, my + 3);
    ctx.lineTo(x, my);
  }
  ctx.stroke();
}

/** Door: solid ink planks with a knob, filling a w x h box. */
export function drawDoorInk(ctx: Ctx, w: number, h: number): void {
  ctx.fillStyle = INK;
  roundedRect(ctx, 0.5, 0.5, w - 1, h - 1, 3);
  ctx.fill();
  ctx.strokeStyle = '#7a7a7a';
  ctx.lineWidth = 1;
  const planks = Math.max(1, Math.round(w / 6));
  for (let i = 1; i < planks; i++) {
    const x = (w * i) / planks;
    line(ctx, x, 3, x, h - 3);
  }
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.arc(w * 0.7, h / 2, Math.min(2.5, w / 4), 0, Math.PI * 2);
  ctx.fill();
}

/** Spring doodle that sits on top of a bounce pad's solid tiles: w x PAD_H, base on the bottom edge. */
export function drawBouncePad(ctx: Ctx, w: number): void {
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const coils = Math.max(2, Math.round(w / 8));
  ctx.beginPath();
  ctx.moveTo(2, PAD_H - 1);
  for (let i = 1; i <= coils; i++) {
    const x = 2 + ((w - 4) * i) / coils;
    ctx.lineTo(x - (w - 4) / coils / 2, 3);
    ctx.lineTo(x, PAD_H - 1);
  }
  ctx.stroke();
  ctx.strokeStyle = RED;
  ctx.lineWidth = 2.5;
  line(ctx, 1, 1.5, w - 1, 1.5);
}

export function drawPuff(ctx: Ctx): void {
  ctx.fillStyle = GRAY;
  ctx.beginPath();
  ctx.arc(PUFF_SIZE / 2, PUFF_SIZE / 2, PUFF_SIZE / 2 - 0.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Full 768x432 paper backdrop with the grid's ground and spikes (no entities). */
export function renderInkBackdrop(level: Level, dots = true): HTMLCanvasElement {
  const c = makeCanvas(GAME_W, GAME_H);
  const ctx = ctxOf(c);
  drawPaper(ctx, GAME_W, GAME_H, dots);
  drawSolids(ctx, level.grid.rows);
  drawHazards(ctx, level.grid.rows);
  return c;
}

function bboxPx(e: Entity): { x: number; y: number; w: number; h: number } | null {
  if (!e.bbox) return null;
  const [x0, y0, x1, y1] = e.bbox;
  return { x: x0 * CELL, y: y0 * CELL, w: (x1 - x0 + 1) * CELL, h: (y1 - y0 + 1) * CELL };
}

function withTranslate(ctx: Ctx, x: number, y: number, draw: () => void): void {
  ctx.save();
  ctx.translate(x, y);
  draw();
  ctx.restore();
}

/** Draw every entity in level pixels; used by thumbnails (the scene uses sprites instead). */
export function drawEntitiesInk(ctx: Ctx, level: Level): void {
  for (const e of level.entities) {
    const box = bboxPx(e);
    const cx = e.x ?? null;
    const cy = e.y ?? null;
    switch (e.type) {
      case 'moving_platform':
        if (box) withTranslate(ctx, box.x, box.y, () => drawPlatformInk(ctx, box.w, box.h));
        break;
      case 'enemy':
        if (box) withTranslate(ctx, box.x, box.y, () => drawEnemyBlob(ctx, box.w, box.h));
        break;
      case 'door':
        if (box) withTranslate(ctx, box.x, box.y, () => drawDoorInk(ctx, box.w, box.h));
        break;
      case 'bounce_pad':
        if (box) withTranslate(ctx, box.x, box.y - PAD_H, () => drawBouncePad(ctx, box.w));
        break;
      case 'coin':
        if (cx !== null && cy !== null) {
          withTranslate(ctx, cx * CELL + (CELL - COIN_SIZE) / 2, cy * CELL + (CELL - COIN_SIZE) / 2, () => drawCoin(ctx));
        }
        break;
      case 'key':
        if (cx !== null && cy !== null) {
          withTranslate(ctx, cx * CELL + (CELL - KEY_W) / 2, cy * CELL + (CELL - KEY_H) / 2, () => drawKey(ctx));
        }
        break;
      case 'goal':
        if (cx !== null && cy !== null) withTranslate(ctx, cx * CELL, (cy + 1) * CELL - GOAL_H, () => drawGoalFlag(ctx));
        break;
      case 'checkpoint':
        if (cx !== null && cy !== null) {
          withTranslate(ctx, cx * CELL, (cy + 1) * CELL - FLAG_H, () => drawCheckpointFlag(ctx, false));
        }
        break;
      case 'player_start':
        if (cx !== null && cy !== null) {
          withTranslate(ctx, cx * CELL + CELL / 2 - PLAYER_TEX_W / 2, (cy + 1) * CELL - PLAYER_TEX_H, () =>
            drawPlayerDoodle(ctx),
          );
        }
        break;
    }
  }
}

/**
 * Ink-style picture of a level for feed cards, `width` px wide (16:9).
 * The grid, every entity and the default doodle at the start are drawn;
 * a custom player sprite is not (it would need an async image load).
 */
export function renderThumbnail(level: Level, width: number): HTMLCanvasElement {
  const w = Math.max(16, Math.round(width));
  const h = Math.round((w * GAME_H) / GAME_W);
  const c = makeCanvas(w, h);
  const ctx = ctxOf(c);
  const s = w / GAME_W;
  ctx.scale(s, h / GAME_H);
  drawPaper(ctx, GAME_W, GAME_H, false);
  drawSolids(ctx, level.grid.rows);
  drawHazards(ctx, level.grid.rows);
  drawEntitiesInk(ctx, level);
  return c;
}
