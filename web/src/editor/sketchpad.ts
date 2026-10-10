/**
 * A small vector drawing pad with its OWN palette, tools and undo (the Creature Studio canvas and its symbol cells,
 * §8.1). Strokes are vectors in cells inside a fixed view rect; a tap stamps a dot; the eraser deletes whole strokes.
 * The pad never shares state with the main editor (changing the editor's colour never changes the pad's).
 */
import type { InkColor, InkStroke } from '../core/types.gen.ts';
import { finishPoints, markerWidth, q, strokeHitDist, toStrokeArrays, type Pt } from './geom.ts';
import { paintStroke } from './paint.ts';

export interface PadView {
  x0: number;
  y0: number;
  size: number; // cells shown along the canvas width (the pad is square unless `aspect` says otherwise)
  aspect?: number; // height / width (default 1)
}

export interface PadOptions {
  px: number; // canvas backing width in px
  view: PadView;
  pen: number; // marker width in cells
  strokes?: InkStroke[];
  idPrefix: string;
  /** Draws the guide (body box, ground line) under the ink. */
  guide?: (ctx: CanvasRenderingContext2D, toPx: (x: number, y: number) => [number, number], scale: number) => void;
  onChange?: (strokes: InkStroke[]) => void;
  /** One colour only (symbol cells): every stroke takes the pad colour. */
  singleColor?: boolean;
  background?: string;
}

export class SketchPad {
  readonly canvas: HTMLCanvasElement;
  color: InkColor = 'black';
  tool: 'marker' | 'eraser' = 'marker';
  private strokes: InkStroke[];
  private undoStack: InkStroke[][] = [];
  private redoStack: InkStroke[][] = [];
  private live: Pt[] | null = null;
  private downAt = 0;
  private movedPx = 0;
  private nextId: number;
  private readonly o: PadOptions;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly H: number;

  constructor(o: PadOptions) {
    this.o = o;
    const aspect = o.view.aspect ?? 1;
    this.H = Math.round(o.px * aspect);
    this.canvas = document.createElement('canvas');
    this.canvas.width = o.px;
    this.canvas.height = this.H;
    this.canvas.className = 'pad-canvas';
    this.canvas.style.touchAction = 'none';
    this.ctx = this.canvas.getContext('2d')!;
    this.strokes = (o.strokes ?? []).map((s) => ({ ...s, pts: s.pts.map((p) => [p[0], p[1]]), w: s.w.slice() }));
    this.nextId = this.strokes.reduce((m, s) => Math.max(m, Number(new RegExp(`^${o.idPrefix}(\\d+)$`).exec(s.id)?.[1] ?? 0)), 0) + 1;
    this.bind();
    this.paint();
  }

  get value(): InkStroke[] {
    return this.strokes;
  }

  get scale(): number {
    return this.o.px / this.o.view.size;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  set(strokes: InkStroke[], record = true): void {
    if (record) {
      this.undoStack.push(this.strokes);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.strokes = strokes;
    this.paint();
    this.o.onChange?.(this.strokes);
  }

  undo(): void {
    const p = this.undoStack.pop();
    if (!p) return;
    this.redoStack.push(this.strokes);
    this.strokes = p;
    this.paint();
    this.o.onChange?.(this.strokes);
  }

  redo(): void {
    const p = this.redoStack.pop();
    if (!p) return;
    this.undoStack.push(this.strokes);
    this.strokes = p;
    this.paint();
    this.o.onChange?.(this.strokes);
  }

  clear(): void {
    if (this.strokes.length) this.set([]);
  }

  setColor(c: InkColor): void {
    this.color = c;
    this.tool = 'marker';
    if (this.o.singleColor && this.strokes.some((s) => s.color !== c)) this.set(this.strokes.map((s) => ({ ...s, color: c })));
  }

  private toCell(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const v = this.o.view;
    const aspect = v.aspect ?? 1;
    return [v.x0 + ((e.clientX - r.left) / Math.max(1, r.width)) * v.size, v.y0 + ((e.clientY - r.top) / Math.max(1, r.height)) * v.size * aspect];
  }

  private cssScale(): number {
    return this.canvas.getBoundingClientRect().width / this.o.view.size;
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const [x, y] = this.toCell(e);
      this.downAt = performance.now();
      this.movedPx = 0;
      if (this.tool === 'eraser') {
        this.eraseAt(x, y);
        this.live = null;
        return;
      }
      this.live = [{ x, y, w: this.o.pen * (markerWidth(e.pressure, e.pointerType) / 0.75) }];
      this.paint();
    });
    c.addEventListener('pointermove', (e) => {
      if (!(e.buttons & 1)) return;
      const [x, y] = this.toCell(e);
      if (this.tool === 'eraser') {
        this.eraseAt(x, y);
        return;
      }
      if (!this.live) return;
      const last = this.live[this.live.length - 1];
      const d = Math.hypot(x - last.x, y - last.y) * this.cssScale();
      if (d < 0.75) return;
      this.movedPx += d;
      this.live.push({ x, y, w: this.o.pen * (markerWidth(e.pressure, e.pointerType) / 0.75) });
      this.paint();
    });
    c.addEventListener('pointerup', () => this.finish());
    c.addEventListener('pointercancel', () => {
      this.live = null;
      this.paint();
    });
  }

  private eraseAt(x: number, y: number): void {
    const tol = Math.max(0.06, 8 / Math.max(1, this.cssScale()));
    const hit = this.strokes.filter((s) => strokeHitDist(s, x, y) <= tol);
    if (hit.length) this.set(this.strokes.filter((s) => !hit.includes(s)));
  }

  private finish(): void {
    if (!this.live) return;
    const pts = this.live;
    this.live = null;
    const tap = this.movedPx < 4 && performance.now() - this.downAt < 250;
    const id = `${this.o.idPrefix}${this.nextId++}`;
    let t = 0;
    for (const s of this.strokes) t = Math.max(t, s.t ?? 0);
    if (tap || pts.length < 2) {
      this.set([...this.strokes, {
        id, color: this.color, kind: 'dot', pts: [[q(pts[0].x), q(pts[0].y)]], w: [Math.max(0.12, this.o.pen * 1.6)], closed: true,
        sheet: 0, origin: 'kid', t: t + 1,
      }]);
      return;
    }
    const fin = finishPoints(pts.map((p) => ({ ...p })));
    if (fin.length < 2) {
      this.paint();
      return;
    }
    const arr = toStrokeArrays(fin);
    const a = fin[0];
    const b = fin[fin.length - 1];
    const closed = Math.hypot(a.x - b.x, a.y - b.y) <= this.o.pen * 1.5 && fin.length > 6;
    this.set([...this.strokes, { id, color: this.color, kind: 'line', pts: arr.pts, w: arr.w, closed, sheet: 0, origin: 'kid', t: t + 1 }]);
  }

  paint(): void {
    const ctx = this.ctx;
    const v = this.o.view;
    const P = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.o.background ?? '#FBF6EA';
    ctx.fillRect(0, 0, this.canvas.width, this.H);
    ctx.fillStyle = 'rgba(31,27,24,0.08)';
    const step = P / 4;
    if (step >= 6) for (let x = 0; x < this.canvas.width; x += step) for (let y = 0; y < this.H; y += step) ctx.fillRect(x, y, 2, 2);
    this.o.guide?.(ctx, (x, y) => [(x - v.x0) * P, (y - v.y0) * P], P);
    const opts = { scale: P, ox: v.x0, oy: v.y0, minWidthPx: 1.5 };
    for (const s of this.strokes) paintStroke(ctx, s, opts);
    if (this.live && this.live.length) {
      const lv = this.live;
      paintStroke(ctx, {
        id: 'live', color: this.color, kind: lv.length === 1 ? 'dot' : 'line', pts: lv.map((p) => [p.x, p.y]), w: lv.map((p) => p.w),
        closed: false, sheet: 0, origin: 'kid',
      }, opts);
    }
  }
}
