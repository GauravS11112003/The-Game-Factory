/**
 * The editor viewport (§6.3): pan and zoom over the 48·k × 27 strip. At 1× a cell is 16 CSS px on desktop and at least
 * 12 px on a phone; zoom is 0.5-3×. Cells ↔ CSS px conversions live here.
 */
import { CANVAS, WORLD } from '../core/params.ts';

export class View {
  /** Left/top edge of the view in cells. */
  x = 0;
  y = 0;
  zoom = 1;
  /** CSS px of the canvas. */
  w = 800;
  h = 432;
  base: number = CANVAS.cell_css_px_desktop;
  worldW: number = WORLD.screen_w;
  readonly worldH = WORLD.h;

  get scale(): number {
    return this.base * this.zoom;
  }

  get cellsW(): number {
    return this.w / this.scale;
  }

  get cellsH(): number {
    return this.h / this.scale;
  }

  resize(w: number, h: number, phone: boolean): void {
    this.w = Math.max(50, w);
    this.h = Math.max(50, h);
    // Phones: shrink the cell so all 27 rows fit when possible, never below 12 CSS px.
    this.base = phone ? Math.max(CANVAS.cell_css_px_phone_min, Math.min(CANVAS.cell_css_px_desktop, this.h / (WORLD.h + 1))) : CANVAS.cell_css_px_desktop;
    this.clamp();
  }

  toCells(px: number, py: number): [number, number] {
    return [this.x + px / this.scale, this.y + py / this.scale];
  }

  toPx(cx: number, cy: number): [number, number] {
    return [(cx - this.x) * this.scale, (cy - this.y) * this.scale];
  }

  panBy(dpx: number, dpy: number): void {
    this.x -= dpx / this.scale;
    this.y -= dpy / this.scale;
    this.clamp();
  }

  /** Zoom by factor k keeping the cell under (px, py) fixed. */
  zoomAt(k: number, px: number, py: number): void {
    const [cx, cy] = this.toCells(px, py);
    this.zoom = Math.min(CANVAS.zoom_max, Math.max(CANVAS.zoom_min, this.zoom * k));
    this.x = cx - px / this.scale;
    this.y = cy - py / this.scale;
    this.clamp();
  }

  /** Centre the view on a world x (cells). */
  centerOn(cx: number): void {
    this.x = cx - this.cellsW / 2;
    this.clamp();
  }

  /** "Fit screen": one 48 × 27 screen fills the view, around the screen the view is mostly on. */
  fitScreen(): void {
    const mid = this.x + this.cellsW / 2;
    const screen = Math.max(0, Math.min(Math.floor(this.worldW / WORLD.screen_w) - 1, Math.floor(mid / WORLD.screen_w)));
    const z = Math.min(this.w / (WORLD.screen_w + 1) / this.base, this.h / (WORLD.h + 1) / this.base);
    this.zoom = Math.min(CANVAS.zoom_max, Math.max(CANVAS.zoom_min, z));
    this.x = screen * WORLD.screen_w + WORLD.screen_w / 2 - this.cellsW / 2;
    this.y = WORLD.h / 2 - this.cellsH / 2;
    this.clamp();
  }

  clamp(): void {
    const marginL = 1.5;
    const marginR = 5; // room for the "+ Add screen" tab past the right edge
    const cw = this.cellsW;
    const ch = this.cellsH;
    if (cw >= this.worldW + marginL + marginR) this.x = (this.worldW - cw) / 2;
    else this.x = Math.min(this.worldW + marginR - cw, Math.max(-marginL, this.x));
    if (ch >= this.worldH + 2) this.y = (this.worldH - ch) / 2;
    else this.y = Math.min(this.worldH + 1 - ch, Math.max(-1, this.y));
  }
}
