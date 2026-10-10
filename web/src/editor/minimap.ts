/**
 * The screens minimap (§6.3): thumbnails of every screen at the bottom with the viewport box; tap or drag to jump.
 */
import { WORLD } from '../core/params.ts';
import type { EditorDocData } from './doc.ts';
import { PARENT_GRAY, paintStroke } from './paint.ts';
import type { View } from './view.ts';

const GAP = 6; // px between screen thumbnails

export class Minimap {
  readonly el: HTMLCanvasElement;
  private dragging = false;
  private layout = { scale: 1, x0: 0, y0: 2 };

  constructor(private view: View, private getDoc: () => EditorDocData, private locked: (origin: string) => boolean, private onJump: () => void) {
    this.el = document.createElement('canvas');
    this.el.className = 'minimap';
    this.el.setAttribute('aria-label', 'screens');
    this.el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      this.jump(e);
    });
    this.el.addEventListener('pointermove', (e) => this.dragging && this.jump(e));
    this.el.addEventListener('pointerup', () => (this.dragging = false));
    this.el.addEventListener('pointercancel', () => (this.dragging = false));
  }

  private jump(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    const px = e.clientX - r.left;
    const { scale, x0 } = this.layout;
    // Undo the per-screen gaps.
    const per = WORLD.screen_w * scale + GAP;
    const k = Math.max(0, Math.min(this.getDoc().screens - 1, Math.floor((px - x0) / per)));
    const within = Math.max(0, Math.min(WORLD.screen_w, (px - x0 - k * per) / scale));
    this.view.centerOn(k * WORLD.screen_w + within);
    this.onJump();
  }

  draw(): void {
    const doc = this.getDoc();
    const cssW = this.el.clientWidth || 300;
    const cssH = this.el.clientHeight || 56;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.el.width !== Math.round(cssW * dpr) || this.el.height !== Math.round(cssH * dpr)) {
      this.el.width = Math.round(cssW * dpr);
      this.el.height = Math.round(cssH * dpr);
    }
    const ctx = this.el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const k = doc.screens;
    const scale = Math.min((cssH - 4) / WORLD.h, (cssW - GAP * (k - 1) - 4) / (WORLD.screen_w * k));
    const totalW = WORLD.screen_w * k * scale + GAP * (k - 1);
    const x0 = Math.max(2, (cssW - totalW) / 2);
    const y0 = (cssH - WORLD.h * scale) / 2;
    this.layout = { scale, x0, y0 };
    for (let i = 0; i < k; i++) {
      const sx = x0 + i * (WORLD.screen_w * scale + GAP);
      ctx.fillStyle = '#FBF6EA';
      ctx.strokeStyle = 'rgba(31,27,24,0.5)';
      ctx.lineWidth = 1;
      ctx.fillRect(sx, y0, WORLD.screen_w * scale, WORLD.h * scale);
      ctx.strokeRect(sx + 0.5, y0 + 0.5, WORLD.screen_w * scale - 1, WORLD.h * scale - 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, y0, WORLD.screen_w * scale, WORLD.h * scale);
      ctx.clip();
      for (const s of doc.strokes) {
        paintStroke(ctx, s, {
          scale, ox: i * WORLD.screen_w - (sx - 0) / scale, oy: -y0 / scale, minWidthPx: 0.8,
          color: this.locked(s.origin) ? PARENT_GRAY : undefined,
        });
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(31,27,24,0.55)';
      ctx.font = '10px "Patrick Hand", system-ui, sans-serif';
      ctx.fillText(String(i + 1), sx + 3, y0 + 10);
    }
    // Viewport box (it may span a gap between screens).
    const v = this.view;
    const toMini = (cx: number): number => {
      const i = Math.max(0, Math.min(k - 1, Math.floor(cx / WORLD.screen_w)));
      const within = Math.max(0, Math.min(WORLD.screen_w, cx - i * WORLD.screen_w));
      return x0 + i * (WORLD.screen_w * scale + GAP) + within * scale;
    };
    const a = toMini(Math.max(0, v.x));
    const b = toMini(Math.min(WORLD.screen_w * k, v.x + v.cellsW));
    const top = y0 + Math.max(0, v.y) * scale;
    const bot = y0 + Math.min(WORLD.h, v.y + v.cellsH) * scale;
    ctx.strokeStyle = '#6A5ACD';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(106,90,205,0.12)';
    ctx.fillRect(a, top, Math.max(4, b - a), bot - top);
    ctx.strokeRect(a, top, Math.max(4, b - a), bot - top);
  }
}
