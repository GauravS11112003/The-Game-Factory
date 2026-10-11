export type GameId = 'fighter' | 'pacman' | 'platformer' | 'racing' | 'neon' | 'shooter';
export interface Input { down: Set<string>; pressed: Set<string>; look?: { x: number; y: number } }
export interface GameState { score: number; info: string; over: boolean; won: boolean }
export interface Game extends GameState {
  update(dt: number, input: Input): void;
  draw(ctx: CanvasRenderingContext2D, time: number): void;
}
export const W = 960, H = 540;
export function rect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, r = 0): void {
  c.fillStyle = color; c.beginPath(); c.roundRect(x, y, w, h, r); c.fill();
}
export function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
}
export function line(c: CanvasRenderingContext2D, points: number[][], color: string, width = 2): void {
  c.strokeStyle = color; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); c.stroke();
}
export function label(c: CanvasRenderingContext2D, str: string, x: number, y: number, size = 18, color = '#fff', align: CanvasTextAlign = 'left'): void {
  c.fillStyle = color; c.font = `800 ${size}px "Arial", sans-serif`; c.textAlign = align; c.fillText(str, x, y);
}
export function gradient(c: CanvasRenderingContext2D, a: string, b: string): void {
  const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, a); g.addColorStop(1, b); c.fillStyle = g; c.fillRect(0, 0, W, H);
}
export function star(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  c.fillStyle = color; c.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, s = i % 2 ? r * .45 : r; const px = x + Math.cos(a) * s, py = y + Math.sin(a) * s; i ? c.lineTo(px, py) : c.moveTo(px, py); } c.closePath(); c.fill();
}
export const held = (i: Input, ...keys: string[]): boolean => keys.some(k => i.down.has(k));
export const tapped = (i: Input, ...keys: string[]): boolean => keys.some(k => i.pressed.has(k));
export function cloud(c: CanvasRenderingContext2D, x: number, y: number, s = 1): void {
  c.save(); c.translate(x, y); c.scale(s, s); circle(c, 0, 0, 22, '#fff'); circle(c, 28, -12, 30, '#fff'); circle(c, 58, 0, 22, '#fff'); rect(c, -8, 0, 70, 20, '#fff', 10); c.restore();
}
export class Particles {
  items: { x: number; y: number; vx: number; vy: number; life: number; color: string }[] = [];
  burst(x: number, y: number, color: string, n = 16): void {
    for (let i = 0; i < n; i++) { const a = i * Math.PI * 2 / n; this.items.push({ x, y, vx: Math.cos(a) * (80 + Math.random() * 130), vy: Math.sin(a) * 180, life: .7, color }); }
  }
  update(dt: number): void { this.items = this.items.filter(p => (p.life -= dt) > 0); for (const p of this.items) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 350 * dt; } }
  draw(c: CanvasRenderingContext2D): void { for (const p of this.items) { c.globalAlpha = Math.min(1, p.life * 3); rect(c, p.x, p.y, 5, 5, p.color, 2); } c.globalAlpha = 1; }
}
