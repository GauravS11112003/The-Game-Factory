/**
 * Canvas2D chrome in the game's paper-and-ink language (PLAN_V2 §7.9 "paper cards with tape corners, marker
 * underlines and marker-outlined pills"): rounded paper plates with a marker outline, tape strips, rubber stamps, ink
 * drops and a wobbly marker underline. Used by the share cards and the theme swatches.
 */
import { ART } from '../core/params.ts';
import { HAND_FONT } from './fonts.ts';

type Ctx = CanvasRenderingContext2D;
const P = ART.palette;

export function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
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

/** A paper plate (cream fill, 2 px marker outline, slight rotation) centred at (cx, cy); draw() paints its content. */
export function plate(ctx: Ctx, cx: number, cy: number, w: number, h: number, o: { rotDeg?: number; k?: number; fill?: string; alpha?: number; shadow?: boolean } = {}, draw?: () => void): void {
  const k = o.k ?? 1;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(((o.rotDeg ?? 0) * Math.PI) / 180);
  if (o.shadow !== false) {
    ctx.fillStyle = 'rgba(31,27,24,0.18)';
    roundRectPath(ctx, -w / 2 + 2 * k, -h / 2 + 3 * k, w, h, 10 * k);
    ctx.fill();
  }
  ctx.globalAlpha = o.alpha ?? 0.96;
  ctx.fillStyle = o.fill ?? '#FFFDF6';
  roundRectPath(ctx, -w / 2, -h / 2, w, h, 10 * k);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 2 * k;
  ctx.lineJoin = 'round';
  roundRectPath(ctx, -w / 2, -h / 2, w, h, 10 * k);
  ctx.stroke();
  draw?.();
  ctx.restore();
}

/** A strip of masking tape across a corner (x, y = the strip centre). */
export function tape(ctx: Ctx, x: number, y: number, w: number, h: number, rotDeg: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rotDeg * Math.PI) / 180);
  ctx.fillStyle = 'rgba(233,214,170,0.82)';
  ctx.beginPath();
  // torn ends: small zigzags
  const n = 5;
  ctx.moveTo(-w / 2, -h / 2);
  ctx.lineTo(w / 2, -h / 2);
  for (let i = 1; i <= n; i++) ctx.lineTo(w / 2 + (i % 2 ? -1.5 : 0.5), -h / 2 + (h * i) / n);
  ctx.lineTo(-w / 2, h / 2);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(-w / 2 + (i % 2 ? 1.5 : -0.5), -h / 2 + (h * i) / n);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,120,70,0.25)';
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.restore();
}

/** A rubber stamp: a red double ring with the word, rotated, slightly uneven ink. */
export function stamp(ctx: Ctx, cx: number, cy: number, r: number, word: string, o: { rotDeg?: number; color?: string; earned?: boolean } = {}): void {
  const color = o.color ?? P.red;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(((o.rotDeg ?? -8) * Math.PI) / 180);
  ctx.globalAlpha = o.earned === false ? 0.22 : 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, r * 0.09);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 0.04);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = color;
  let size = r * 0.5;
  ctx.font = `${size}px ${HAND_FONT}`;
  while (ctx.measureText(word).width > r * 1.5 && size > 6) {
    size -= 1;
    ctx.font = `${size}px ${HAND_FONT}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(word, 0, r * 0.04);
  // worn ink: a few paper-coloured nicks
  ctx.globalCompositeOperation = 'destination-out';
  ctx.globalAlpha = 0.35;
  let s = 0x9e3779b9 ^ word.length;
  for (let i = 0; i < 9; i++) {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + i) >>> 0;
    const a = (s / 4294967296) * Math.PI * 2;
    const d = r * (0.3 + ((s >>> 8) % 70) / 100);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** An ink drop (difficulty: 0-5 drops for the score, §7.10). */
export function inkDrop(ctx: Ctx, cx: number, cy: number, s: number, full: boolean): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(s * 0.55, -s * 0.25, s * 0.75, s * 0.2, s * 0.62, s * 0.5);
  ctx.arc(0, s * 0.42, s * 0.62, 0.15, Math.PI - 0.15);
  ctx.bezierCurveTo(-s * 0.75, s * 0.2, -s * 0.55, -s * 0.25, 0, -s);
  ctx.closePath();
  ctx.fillStyle = full ? P.ink : 'rgba(255,253,246,0.9)';
  ctx.fill();
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.stroke();
  if (full) {
    ctx.strokeStyle = 'rgba(255,253,246,0.8)';
    ctx.lineWidth = Math.max(0.8, s * 0.1);
    ctx.beginPath();
    ctx.arc(-s * 0.18, s * 0.38, s * 0.28, Math.PI * 0.9, Math.PI * 1.35);
    ctx.stroke();
  }
  ctx.restore();
}

/** A wobbly marker underline from x0 to x1 at y. */
export function underline(ctx: Ctx, x0: number, x1: number, y: number, k: number, color: string = P.blue): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * k;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  const n = Math.max(3, Math.round((x1 - x0) / (14 * k)));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const yy = y + Math.sin(i * 1.7) * 1.1 * k + (i / n) * 1.5 * k;
    if (i === 0) ctx.moveTo(x, yy);
    else ctx.lineTo(x, yy);
  }
  ctx.stroke();
  ctx.restore();
}

/** Fit text to a max width by shrinking the font (returns the size used). */
export function fitText(ctx: Ctx, text: string, maxW: number, size: number, minSize: number, weight = ''): number {
  let s = size;
  ctx.font = `${weight}${s}px ${HAND_FONT}`;
  while (s > minSize && ctx.measureText(text).width > maxW) {
    s -= 1;
    ctx.font = `${weight}${s}px ${HAND_FONT}`;
  }
  return s;
}

/** Cut a string to fit maxW at the current font, with an ellipsis. */
export function clipText(ctx: Ctx, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** The skull doodle used for deaths (HUD, cards). */
export function skull(ctx: Ctx, cx: number, cy: number, s: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = '#FFFDF6';
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = Math.max(1.2, s * 0.22);
  ctx.beginPath();
  ctx.arc(0, -s * 0.15, s * 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillRect(-s * 0.48, s * 0.3, s * 0.96, s * 0.5);
  ctx.strokeRect(-s * 0.48, s * 0.3, s * 0.96, s * 0.5);
  ctx.fillStyle = P.ink;
  ctx.beginPath();
  ctx.arc(-s * 0.32, -s * 0.25, s * 0.22, 0, Math.PI * 2);
  ctx.arc(s * 0.32, -s * 0.25, s * 0.22, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The house coin (blue ring + shine). */
export function coinIcon(ctx: Ctx, cx: number, cy: number, r: number): void {
  ctx.save();
  ctx.fillStyle = 'rgba(44,123,229,0.18)';
  ctx.strokeStyle = P.blue;
  ctx.lineWidth = Math.max(1.4, r * 0.3);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#FFFDF6';
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.56, 3.5, 4.3);
  ctx.stroke();
  ctx.restore();
}

/** A five-point star (big coins). */
export function starIcon(ctx: Ctx, cx: number, cy: number, r: number, filled = true): void {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * 0.46 : r;
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = filled ? '#FFD86B' : 'rgba(255,253,246,0.9)';
  ctx.fill();
  ctx.strokeStyle = filled ? P.blue : 'rgba(31,27,24,0.45)';
  ctx.lineWidth = Math.max(1.2, r * 0.18);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
