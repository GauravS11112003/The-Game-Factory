/**
 * The Studio canvas (docs/v6/CONTRACTS_V6.md §6): the world rendered live with the theme, smooth pan / zoom (wheel,
 * pinch, space-drag, middle mouse, hand tool), and the tools: pen, line, rectangle, circle, eraser, select (click,
 * shift-click, marquee, move, rotate and scale handles) — plus a floating selection bar and a right-click menu.
 */
import type { Stroke } from '../../core/types.gen.ts';
import { h } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import {
  boxContains, cleanPath, drawOrder, ellipsePoints, localToWorld, pickObject, pointsBox, rectPoints, selectionBox, snapAngle, squareFrom,
  strokeAt, worldBox, worldCorners, type Box,
} from '../model/doc.ts';
import type { SObj, Vec } from '../model/types.ts';
import { BitmapCache, drawBackground, isDark } from './render.ts';
import { sicon } from './icons.ts';
import type { Studio } from './studio.ts';
import { menu, type MenuItem } from './ui.ts';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; id: number }
  | { kind: 'draw'; points: Vec[]; id: number }
  | { kind: 'shape'; tool: 'line' | 'rect' | 'circle'; a: Vec; b: Vec; id: number }
  | { kind: 'erase'; key: string; id: number }
  | { kind: 'move'; start: Vec; ids: string[]; origin: Map<string, Vec>; moved: boolean; key: string; id: number; sx: number; sy: number }
  | { kind: 'marquee'; a: Vec; b: Vec; add: boolean; base: string[]; id: number }
  | { kind: 'scale'; objId: string; center: Vec; startDist: number; orig: number; key: string; id: number }
  | { kind: 'rotate'; objId: string; center: Vec; startAngle: number; orig: number; key: string; id: number }
  | { kind: 'pinch'; d0: number; m0: Vec; view0: { x: number; y: number; zoom: number } };

const SEL = '#2c7be5';
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

export class StudioCanvas {
  readonly el: HTMLDivElement;
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private selBar: HTMLDivElement;
  private zoomLabel: HTMLButtonElement;
  view = { x: 0, y: 0, zoom: 1 };
  private w = 0;
  private h = 0;
  private dpr = 1;
  private cache = new BitmapCache();
  private raf = 0;
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private hover: string | null = null;
  private cursorWorld: Vec | null = null;
  private space = false;
  private ro: ResizeObserver;
  private fitted = false;
  private lastDims = '';
  /** The maker panned or zoomed since the last fit (then resizes keep their view). */
  private userMoved = false;
  private offs: (() => void)[] = [];
  /** Called after the view moved (bubbles reposition). */
  onView: (() => void) | null = null;

  constructor(private readonly studio: Studio) {
    this.cv = h('canvas', { class: 'st-cv', 'aria-label': t('studio.canvas.label'), tabindex: '0' });
    this.ctx = this.cv.getContext('2d')!;
    this.selBar = h('div', { class: 'st-selbar', role: 'toolbar', 'aria-label': t('studio.sel.toolbar') });
    this.zoomLabel = h('button', { type: 'button', class: 'st-zoom-pct', title: t('studio.canvas.zoom_reset'), onclick: () => this.zoomTo(1) }, '100%');
    const zoomBar = h('div', { class: 'st-zoombar' },
      h('button', { type: 'button', class: 'st-ibtn', title: t('studio.canvas.zoom_out'), 'aria-label': t('studio.canvas.zoom_out'), onclick: () => this.zoomBy(1 / 1.25) }, sicon('zoomout')),
      this.zoomLabel,
      h('button', { type: 'button', class: 'st-ibtn', title: t('studio.canvas.zoom_in'), 'aria-label': t('studio.canvas.zoom_in'), onclick: () => this.zoomBy(1.25) }, sicon('zoomin')),
      h('button', { type: 'button', class: 'st-ibtn', title: t('studio.canvas.fit'), 'aria-label': t('studio.canvas.fit'), onclick: () => this.fit(true) }, sicon('fit')));
    this.el = h('div', { class: 'st-canvas' }, this.cv, this.selBar, zoomBar);

    this.cv.addEventListener('pointerdown', (e) => this.down(e));
    this.cv.addEventListener('pointermove', (e) => this.move(e));
    this.cv.addEventListener('pointerup', (e) => this.up(e));
    this.cv.addEventListener('pointercancel', (e) => this.up(e, true));
    this.cv.addEventListener('pointerleave', () => { this.cursorWorld = null; if (!this.drag) { this.hover = null; this.request(); } });
    this.cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.cv.addEventListener('contextmenu', (e) => this.context(e));
    this.cv.addEventListener('dblclick', (e) => this.dbl(e));
    const kd = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !this.space && !isTyping(e)) {
        this.space = true;
        this.updateCursor();
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent): void => {
      if (e.code === 'Space') { this.space = false; this.updateCursor(); }
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    this.offs.push(() => window.removeEventListener('keydown', kd), () => window.removeEventListener('keyup', ku));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.offs.push(studio.on((c) => {
      if (c.kind === 'scene') { this.fitted = false; this.fit(false); }
      if (c.kind === 'doc' && !c.quiet) {
        const w = this.studio.scene.world;
        if (this.lastDims && this.lastDims !== `${this.studio.sceneId}:${w.width}x${w.height}`) this.fit(true);
      }
      if (c.kind === 'selection' || c.kind === 'doc') this.renderSelBar();
      if (c.kind === 'tool' || c.kind === 'pick') this.updateCursor();
      this.request();
    }));
    this.updateCursor();
    this.renderSelBar();
  }

  // ---- view ----

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.cv.width = Math.round(this.w * this.dpr);
    this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = `${this.w}px`;
    this.cv.style.height = `${this.h}px`;
    if ((!this.fitted || !this.userMoved) && this.w > 10) this.fit(false);
    this.request();
  }

  /** Fit the world in view (with room for the floating rail and bars). */
  fit(animate = true): void {
    if (this.w < 10) return;
    const world = this.studio.scene.world;
    // phones have the rail along the bottom; wider screens have it on the left
    const phone = window.innerWidth <= 760;
    const padX = phone ? 16 : 76;
    const padY = phone ? 72 : 64;
    const fitW = (this.w - padX * 2) / world.width;
    const fitH = (this.h - padY * 2) / world.height;
    let zoom = Math.max(MIN_ZOOM, Math.min(2, fitW, fitH));
    let target = { zoom, x: world.width / 2 - this.w / 2 / zoom, y: world.height / 2 - this.h / 2 / zoom };
    // long worlds (racers, runners): fit the height and show the start, not a thin strip of the whole thing
    const aspect = world.width / world.height;
    if (aspect > 3 && fitH > fitW * 2.2) {
      zoom = Math.max(MIN_ZOOM, Math.min(2, fitH));
      target = { zoom, x: -padX / zoom, y: world.height / 2 - this.h / 2 / zoom };
    } else if (aspect < 1 / 3 && fitW > fitH * 2.2) {
      zoom = Math.max(MIN_ZOOM, Math.min(2, fitW));
      target = { zoom, x: world.width / 2 - this.w / 2 / zoom, y: world.height - (this.h - padY) / zoom };
    }
    this.lastDims = `${this.studio.sceneId}:${world.width}x${world.height}`;
    this.userMoved = false;
    this.fitted = true;
    this.animateTo(target, animate);
  }

  zoomTo(z: number): void {
    this.userMoved = true;
    const c = this.screenToWorld(this.w / 2, this.h / 2);
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    this.animateTo({ zoom, x: c[0] - this.w / 2 / zoom, y: c[1] - this.h / 2 / zoom }, true);
  }

  zoomBy(f: number): void {
    this.zoomTo(this.view.zoom * f);
  }

  private anim = 0;
  private animateTo(target: { x: number; y: number; zoom: number }, animate: boolean): void {
    cancelAnimationFrame(this.anim);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.view = { ...target };
      this.viewChanged();
      return;
    }
    const from = { ...this.view };
    const t0 = performance.now();
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / 220);
      const e = 1 - (1 - k) ** 3;
      // interpolate zoom geometrically so the motion feels even
      const zoom = from.zoom * (target.zoom / from.zoom) ** e;
      this.view = { zoom, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      this.viewChanged();
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  private viewChanged(): void {
    this.zoomLabel.textContent = `${Math.round(this.view.zoom * 100)}%`;
    this.request();
    this.onView?.();
  }

  screenToWorld(sx: number, sy: number): Vec {
    return [sx / this.view.zoom + this.view.x, sy / this.view.zoom + this.view.y];
  }

  worldToScreen(p: Vec): Vec {
    return [(p[0] - this.view.x) * this.view.zoom, (p[1] - this.view.y) * this.view.zoom];
  }

  /** An object's box on screen (client px), for bubbles anchored to it. */
  objectClientBox(id: string): DOMRect | null {
    const o = this.studio.object(id);
    if (!o) return null;
    const pts = worldCorners(o).map((p) => this.worldToScreen(p));
    const b = pointsBox(pts)!;
    const r = this.cv.getBoundingClientRect();
    return new DOMRect(r.left + b.minX, r.top + b.minY, b.maxX - b.minX, b.maxY - b.minY);
  }

  /** The canvas host rect in client px. */
  rect(): DOMRect {
    return this.el.getBoundingClientRect();
  }

  // ---- rendering ----

  request(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render(): void {
    const { ctx, dpr } = this;
    const z = this.view.zoom;
    const sc = this.studio.scene;
    const world = sc.world;
    const theme = this.studio.doc.theme;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const deskDark = isDark(theme.palette?.bg);
    ctx.fillStyle = deskDark ? '#24222b' : '#ece6da';
    ctx.fillRect(0, 0, this.w, this.h);

    // the world sheet with a soft shadow
    const [wx, wy] = this.worldToScreen([0, 0]);
    const ww = world.width * z;
    const wh = world.height * z;
    ctx.save();
    ctx.shadowColor = 'rgba(31,27,24,0.16)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = theme.palette?.bg ?? '#f6f1e7';
    ctx.fillRect(wx, wy, ww, wh);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(wx, wy, ww, wh);
    ctx.clip();
    ctx.translate(-this.view.x * z, -this.view.y * z);
    ctx.scale(z, z);
    drawBackground(ctx, theme, world, { x: this.view.x, y: this.view.y, zoom: z, width: this.w, height: this.h });
    ctx.restore();
    ctx.strokeStyle = deskDark ? 'rgba(255,255,255,0.12)' : 'rgba(31,27,24,0.12)';
    ctx.lineWidth = 1;
    ctx.strokeRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1);

    // objects
    const ink = theme.palette?.ink ?? '#1f1b18';
    const ids = new Set<string>();
    for (const o of drawOrder(sc.objects)) {
      ids.add(o.id);
      const alpha = o.hidden ? 0.35 : o.template ? 0.6 : 1;
      const [sx, sy] = this.worldToScreen([o.x, o.y]);
      const reach = (Math.max(o.drawing.w, o.drawing.h) * o.scale * z) / 2 + 60;
      if (sx < -reach || sy < -reach || sx > this.w + reach || sy > this.h + reach) continue;
      if (o.drawing.strokes.length) {
        const bmp = this.cache.get(o, theme, z * o.scale * dpr);
        if (!bmp) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(sx, sy);
        ctx.rotate((o.rotation * Math.PI) / 180);
        const k = (z * o.scale) / bmp.bucket;
        ctx.scale(k, k);
        ctx.drawImage(bmp.canvas, -bmp.canvas.width / 2, -bmp.canvas.height / 2);
        ctx.restore();
      } else if (o.drawing.w > 0 || o.drawing.h > 0) {
        this.drawBoxObject(o, deskDark || isDark(theme.palette?.bg) ? '#ffffff' : ink);
      }
      if (o.template && z > 0.25) this.badge(o, t('studio.canvas.template'));
      else if (o.hidden && z > 0.25) this.badge(o, t('studio.canvas.hidden'));
    }
    this.cache.prune(ids);

    // pending group, hover, selection
    const pend = this.studio.pending ? this.studio.object(this.studio.pending.id) : null;
    if (pend) this.outline(pend, 'rgba(228,87,46,0.75)', [5, 4], 6);
    const pick = this.studio.pick;
    if (this.hover && !this.studio.selection.includes(this.hover) && !this.drag) {
      const o = this.studio.object(this.hover);
      if (o) this.outline(o, pick ? '#e4572e' : SEL, pick ? [] : [], pick ? 4 : 2, pick ? 2.5 : 1.5);
    }
    const sel = this.studio.selected;
    for (const o of sel) this.drawJoints(o);
    if (sel.length === 1 && !pick) {
      this.outline(sel[0], SEL, [], 2, 1.5);
      if (!this.drag || this.drag.kind === 'scale' || this.drag.kind === 'rotate') this.handles(sel[0]);
    } else if (sel.length > 1) {
      for (const o of sel) this.outline(o, SEL, [4, 3], 2, 1.2);
      const b = selectionBox(sel);
      if (b) this.boxOutline(b, SEL, 6);
    }

    // previews
    const d = this.drag;
    if (d?.kind === 'draw' && d.points.length) {
      ctx.save();
      ctx.strokeStyle = this.studio.color;
      ctx.fillStyle = this.studio.color;
      ctx.lineWidth = this.studio.width * z * (theme.stroke?.width_scale ?? 1);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      d.points.forEach((p, i) => { const [x, y] = this.worldToScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (d.points.length === 1) {
        const [x, y] = this.worldToScreen(d.points[0]);
        ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.stroke();
      ctx.restore();
    } else if (d?.kind === 'shape') {
      const s = this.shapeStroke(d);
      if (s) {
        ctx.save();
        ctx.strokeStyle = this.studio.color;
        ctx.lineWidth = this.studio.width * z * (theme.stroke?.width_scale ?? 1);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        s.points.forEach((p, i) => { const [x, y] = this.worldToScreen(p as Vec); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        if (s.closed) ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    } else if (d?.kind === 'marquee') {
      const a = this.worldToScreen(d.a);
      const b = this.worldToScreen(d.b);
      ctx.save();
      ctx.fillStyle = 'rgba(44,123,229,0.08)';
      ctx.strokeStyle = SEL;
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.strokeRect(Math.min(a[0], b[0]) + 0.5, Math.min(a[1], b[1]) + 0.5, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.restore();
    }
    // eraser cursor
    if (this.studio.tool === 'eraser' && this.cursorWorld && !this.space) {
      const [x, y] = this.worldToScreen(this.cursorWorld);
      ctx.save();
      ctx.strokeStyle = deskDark ? '#fff' : '#1f1b18';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    this.placeSelBar();
  }

  private outline(o: SObj, color: string, dash: number[], pad: number, width = 1.5): void {
    const { ctx } = this;
    const z = this.view.zoom;
    const hw = (o.drawing.w * o.scale * z) / 2 + pad;
    const hh = (o.drawing.h * o.scale * z) / 2 + pad;
    const [sx, sy] = this.worldToScreen([o.x, o.y]);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((o.rotation * Math.PI) / 180);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
  }

  private boxOutline(b: Box, color: string, pad: number): void {
    const a = this.worldToScreen([b.minX, b.minY]);
    const c = this.worldToScreen([b.maxX, b.maxY]);
    this.ctx.save();
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(a[0] - pad, a[1] - pad, c[0] - a[0] + pad * 2, c[1] - a[1] + pad * 2);
    this.ctx.restore();
  }

  private drawBoxObject(o: SObj, ink: string): void {
    const { ctx } = this;
    const z = this.view.zoom;
    const hw = (o.drawing.w * o.scale * z) / 2;
    const hh = (o.drawing.h * o.scale * z) / 2;
    const [sx, sy] = this.worldToScreen([o.x, o.y]);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate((o.rotation * Math.PI) / 180);
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = 'rgba(44,123,229,0.06)';
    ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
    ctx.strokeStyle = ink;
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    if (z * Math.min(o.drawing.w, o.drawing.h) > 26) {
      ctx.setLineDash([]);
      ctx.fillStyle = ink;
      ctx.font = `600 ${Math.max(10, Math.min(15, 12 * Math.sqrt(z)))}px 'Atkinson Hyperlegible', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(o.name || (o.kind !== 'thing' ? o.kind : t('studio.canvas.zone')), 0, 0, hw * 2 - 8);
    }
    ctx.restore();
  }

  private badge(o: SObj, text: string): void {
    const b = worldBox(o);
    const [x, y] = this.worldToScreen([b.minX, b.minY]);
    const { ctx } = this;
    ctx.save();
    ctx.font = "700 10px 'Atkinson Hyperlegible', system-ui, sans-serif";
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(31,27,24,0.78)';
    roundRect(ctx, x, y - 18, w, 15, 5);
    ctx.fill();
    ctx.fillStyle = '#fffdf6';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y - 10.5);
    ctx.restore();
  }

  private drawJoints(o: SObj): void {
    const { ctx } = this;
    for (const j of o.joints) {
      const other = this.studio.object(j.to);
      const a = this.worldToScreen(localToWorld(o, (j.at ?? [0, 0]) as Vec));
      ctx.save();
      ctx.strokeStyle = '#e4572e';
      ctx.fillStyle = '#e4572e';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      if (other) {
        const b = this.worldToScreen(localToWorld(other, (j.to_at ?? [0, 0]) as Vec));
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(b[0], b[1], 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(a[0], a[1], 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private handlePoints(o: SObj): { corners: Vec[]; rot: Vec; top: Vec } {
    const z = this.view.zoom;
    const hw = (o.drawing.w * o.scale * z) / 2 + 2;
    const hh = (o.drawing.h * o.scale * z) / 2 + 2;
    const [sx, sy] = this.worldToScreen([o.x, o.y]);
    const c = Math.cos((o.rotation * Math.PI) / 180);
    const s = Math.sin((o.rotation * Math.PI) / 180);
    const tr = (x: number, y: number): Vec => [sx + x * c - y * s, sy + x * s + y * c];
    return { corners: [tr(-hw, -hh), tr(hw, -hh), tr(hw, hh), tr(-hw, hh)], rot: tr(0, -hh - 26), top: tr(0, -hh) };
  }

  private handles(o: SObj): void {
    const { ctx } = this;
    const hp = this.handlePoints(o);
    ctx.save();
    ctx.strokeStyle = SEL;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(hp.top[0], hp.top[1]);
    ctx.lineTo(hp.rot[0], hp.rot[1]);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(hp.rot[0], hp.rot[1], 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    for (const [x, y] of hp.corners) {
      ctx.beginPath();
      roundRect(ctx, x - 5, y - 5, 10, 10, 2.5);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private handleAt(sx: number, sy: number): 'rotate' | 'scale' | null {
    const sel = this.studio.selected;
    if (sel.length !== 1) return null;
    const hp = this.handlePoints(sel[0]);
    if (Math.hypot(sx - hp.rot[0], sy - hp.rot[1]) <= 10) return 'rotate';
    if (hp.corners.some(([x, y]) => Math.abs(sx - x) <= 8 && Math.abs(sy - y) <= 8)) return 'scale';
    return null;
  }

  // ---- selection bar ----

  private renderSelBar(): void {
    const sel = this.studio.selected;
    const s = this.studio;
    const b = (ico: string, label: string, run: () => void, cls = ''): HTMLButtonElement =>
      h('button', { type: 'button', class: `st-ibtn${cls ? ` ${cls}` : ''}`, title: label, 'aria-label': label, onclick: (e: MouseEvent) => { e.stopPropagation(); run(); } }, sicon(ico));
    if (!sel.length) {
      this.selBar.replaceChildren();
      this.selBar.hidden = true;
      return;
    }
    const kids: HTMLElement[] = [];
    if (sel.length > 1) kids.push(h('button', { type: 'button', class: 'st-selbar-txt', title: t('studio.sel.merge_help'), onclick: () => s.mergeSelection() }, sicon('merge'), t('studio.sel.merge')));
    if (sel.length === 1 && sel[0].drawing.strokes.length > 1) kids.push(h('button', { type: 'button', class: 'st-selbar-txt', title: t('studio.sel.split_help'), onclick: () => s.splitSelection() }, sicon('split'), t('studio.sel.split')));
    kids.push(b('copy', t('studio.sel.duplicate'), () => s.duplicateSelection()), b('up', t('studio.sel.forward'), () => s.shiftLayer(1)), b('dn', t('studio.sel.back'), () => s.shiftLayer(-1)), b('trash', t('studio.sel.delete'), () => s.deleteSelection(), 'danger'));
    this.selBar.replaceChildren(...kids);
    this.selBar.hidden = false;
    this.placeSelBar();
  }

  private placeSelBar(): void {
    if (this.selBar.hidden) return;
    const sel = this.studio.selected;
    const b = selectionBox(sel);
    if (!b || (this.drag && this.drag.kind !== 'pinch' && this.drag.kind !== 'pan') || this.studio.pick) {
      this.selBar.style.opacity = '0';
      this.selBar.style.pointerEvents = 'none';
      return;
    }
    const a = this.worldToScreen([b.minX, b.minY]);
    const c = this.worldToScreen([b.maxX, b.maxY]);
    const bw = this.selBar.offsetWidth || 160;
    let x = (a[0] + c[0]) / 2 - bw / 2;
    let y = a[1] - 54 - (sel.length === 1 ? 26 : 0);
    if (y < 56) y = c[1] + 14;
    x = Math.max(8, Math.min(this.w - bw - 8, x));
    y = Math.max(8, Math.min(this.h - 48, y));
    this.selBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.selBar.style.opacity = '1';
    this.selBar.style.pointerEvents = '';
  }

  // ---- input ----

  private local(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private updateCursor(): void {
    const tool = this.studio.tool;
    let c = 'default';
    if (this.studio.pick) c = 'crosshair';
    else if (this.space || tool === 'hand') c = this.drag?.kind === 'pan' ? 'grabbing' : 'grab';
    else if (tool === 'pen' || tool === 'line' || tool === 'rect' || tool === 'circle') c = 'crosshair';
    else if (tool === 'eraser') c = 'none';
    else if (tool === 'select' && this.hover) c = 'move';
    this.cv.style.cursor = c;
    this.el.dataset.tool = tool;
  }

  private down(e: PointerEvent): void {
    this.cv.focus({ preventScroll: true });
    const [sx, sy] = this.local(e);
    this.pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    try { this.cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length === 2) {
      // a second finger: pinch / pan, and the half-drawn stroke is dropped
      const [p, q] = touches;
      this.drag = { kind: 'pinch', d0: Math.hypot(p.x - q.x, p.y - q.y), m0: [(p.x + q.x) / 2, (p.y + q.y) / 2], view0: { ...this.view } };
      this.request();
      return;
    }
    if (this.drag) return;
    const w = this.screenToWorld(sx, sy);
    const s = this.studio;
    if (e.button === 1 || this.space || (s.tool === 'hand' && e.button === 0)) {
      e.preventDefault();
      this.drag = { kind: 'pan', sx, sy, vx: this.view.x, vy: this.view.y, id: e.pointerId };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    const tol = 6 / this.view.zoom;
    if (s.pick) {
      const o = pickObject(s.scene.objects, w, tol);
      if (o) s.completePick(o.id);
      return;
    }
    switch (s.tool) {
      case 'pen':
        this.drag = { kind: 'draw', points: [w], id: e.pointerId };
        break;
      case 'line':
      case 'rect':
      case 'circle':
        this.drag = { kind: 'shape', tool: s.tool, a: w, b: w, id: e.pointerId };
        break;
      case 'eraser':
        this.drag = { kind: 'erase', key: `erase:${Date.now()}`, id: e.pointerId };
        this.eraseAt(w);
        break;
      case 'select': {
        const handle = this.handleAt(sx, sy);
        const sel = s.selected;
        if (handle && sel.length === 1) {
          const o = sel[0];
          const center: Vec = [o.x, o.y];
          if (handle === 'scale') this.drag = { kind: 'scale', objId: o.id, center, startDist: Math.max(1, Math.hypot(w[0] - center[0], w[1] - center[1])), orig: o.scale, key: `scale:${o.id}:${Date.now()}`, id: e.pointerId };
          else this.drag = { kind: 'rotate', objId: o.id, center, startAngle: Math.atan2(w[1] - center[1], w[0] - center[0]), orig: o.rotation, key: `rot:${o.id}:${Date.now()}`, id: e.pointerId };
          break;
        }
        const hit = pickObject(s.scene.objects, w, tol);
        if (hit) {
          let ids = s.selection;
          if (e.shiftKey) ids = ids.includes(hit.id) ? ids.filter((x) => x !== hit.id) : [...ids, hit.id];
          else if (!ids.includes(hit.id)) ids = [hit.id];
          s.select(ids);
          if (!ids.includes(hit.id)) break;
          const origin = new Map<string, Vec>(s.selected.map((o) => [o.id, [o.x, o.y]]));
          this.drag = { kind: 'move', start: w, ids: [...origin.keys()], origin, moved: false, key: `move:${Date.now()}`, id: e.pointerId, sx, sy };
        } else {
          this.drag = { kind: 'marquee', a: w, b: w, add: e.shiftKey, base: e.shiftKey ? s.selection : [], id: e.pointerId };
          if (!e.shiftKey) s.select([]);
        }
        break;
      }
      default:
        break;
    }
    this.request();
  }

  private move(e: PointerEvent): void {
    const [sx, sy] = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: sx, y: sy, type: e.pointerType });
    const w = this.screenToWorld(sx, sy);
    this.cursorWorld = w;
    const d = this.drag;
    const s = this.studio;
    if (!d) {
      if (s.tool === 'select' || s.pick || s.tool === 'eraser') {
        const o = pickObject(s.scene.objects, w, 6 / this.view.zoom);
        const id = o?.id ?? null;
        if (id !== this.hover) { this.hover = id; this.updateCursor(); }
        if (s.tool === 'select' && !s.pick) {
          const hd = this.handleAt(sx, sy);
          this.cv.style.cursor = hd === 'rotate' ? 'grab' : hd === 'scale' ? 'nwse-resize' : this.hover ? 'move' : 'default';
        }
      }
      if (s.tool === 'eraser') this.request();
      return;
    }
    switch (d.kind) {
      case 'pinch': {
        this.userMoved = true;
        const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
        if (touches.length < 2) return;
        const [p, q] = touches;
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const mid: Vec = [(p.x + q.x) / 2, (p.y + q.y) / 2];
        const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, d.view0.zoom * (dist / Math.max(1, d.d0))));
        const anchor: Vec = [d.m0[0] / d.view0.zoom + d.view0.x, d.m0[1] / d.view0.zoom + d.view0.y];
        this.view = { zoom, x: anchor[0] - mid[0] / zoom, y: anchor[1] - mid[1] / zoom };
        this.viewChanged();
        return;
      }
      case 'pan':
        this.userMoved = true;
        this.view = { ...this.view, x: d.vx - (sx - d.sx) / this.view.zoom, y: d.vy - (sy - d.sy) / this.view.zoom };
        this.viewChanged();
        return;
      case 'draw': {
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
        for (const ev of evs.length ? evs : [e]) {
          const [lx, ly] = this.local(ev);
          d.points.push(this.screenToWorld(lx, ly));
        }
        break;
      }
      case 'shape':
        d.b = w;
        if (e.shiftKey) d.b = d.tool === 'line' ? snapAngle(d.a, w) : squareFrom(d.a, w);
        break;
      case 'erase':
        this.eraseAt(w);
        break;
      case 'move': {
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
        d.moved = true;
        let dx = w[0] - d.start[0];
        let dy = w[1] - d.start[1];
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        s.apply(d.ids.map((id) => {
          const o = d.origin.get(id)!;
          return { action: 'update_object', target: id, data: { x: Math.round((o[0] + dx) * 10) / 10, y: Math.round((o[1] + dy) * 10) / 10 } };
        }), { label: 'move', coalesce: d.key, quiet: true });
        break;
      }
      case 'marquee': {
        d.b = w;
        const box = pointsBox([d.a, d.b])!;
        const inside = s.scene.objects.filter((o) => boxContains(box, worldBox(o))).map((o) => o.id);
        s.select([...new Set([...d.base, ...inside])]);
        break;
      }
      case 'scale': {
        const dist = Math.hypot(w[0] - d.center[0], w[1] - d.center[1]);
        const scale = Math.max(0.05, Math.min(20, Math.round(d.orig * (dist / d.startDist) * 100) / 100));
        s.apply([{ action: 'update_object', target: d.objId, data: { scale } }], { label: 'scale', coalesce: d.key, quiet: true });
        break;
      }
      case 'rotate': {
        const ang = Math.atan2(w[1] - d.center[1], w[0] - d.center[0]);
        let rot = d.orig + ((ang - d.startAngle) * 180) / Math.PI;
        rot = e.shiftKey ? Math.round(rot / 15) * 15 : Math.round(rot);
        rot = ((rot % 360) + 540) % 360 - 180;
        s.apply([{ action: 'update_object', target: d.objId, data: { rotation: rot } }], { label: 'rotate', coalesce: d.key, quiet: true });
        break;
      }
    }
    this.request();
  }

  private up(e: PointerEvent, cancel = false): void {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'pinch') {
      if (this.pointers.size === 0) this.drag = null;
      return;
    }
    if (d.id !== e.pointerId) return;
    this.drag = null;
    const s = this.studio;
    if (!cancel) {
      if (d.kind === 'draw' && d.points.length) {
        const pts = cleanPath(d.points, this.view.zoom);
        s.addStroke({ points: pts as Stroke['points'], color: s.color, width: s.width });
      } else if (d.kind === 'shape') {
        const st = this.shapeStroke(d);
        if (st) s.addStroke(st);
      }
    }
    if (d.kind === 'move' || d.kind === 'scale' || d.kind === 'rotate' || d.kind === 'erase') {
      s.seal();
      s.emit({ kind: 'doc' });
    }
    this.updateCursor();
    this.request();
  }

  private shapeStroke(d: { tool: 'line' | 'rect' | 'circle'; a: Vec; b: Vec }): Stroke | null {
    const sz = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * this.view.zoom;
    if (sz < 4) return null;
    const s = this.studio;
    if (d.tool === 'line') return { points: [d.a, d.b].map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) as Stroke['points'], color: s.color, width: s.width };
    const pts = d.tool === 'rect' ? rectPoints(d.a, d.b) : ellipsePoints(d.a, d.b, 48);
    return { points: pts as Stroke['points'], color: s.color, width: s.width, closed: true };
  }

  private eraseAt(w: Vec): void {
    const s = this.studio;
    const tol = 9 / this.view.zoom;
    const scope = s.selection.length ? s.selected : s.pending && s.object(s.pending.id) ? [s.object(s.pending.id)!] : s.scene.objects;
    // the selected / pending object first, then anything under the eraser
    const order = [...drawOrder(scope).reverse(), ...drawOrder(s.scene.objects).reverse()];
    for (const o of order) {
      const i = strokeAt(o, w, tol);
      if (i >= 0) {
        s.eraseStroke(o.id, i, this.drag?.kind === 'erase' ? this.drag.key : `erase:${Date.now()}`);
        return;
      }
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.userMoved = true;
    const [sx, sy] = this.local(e);
    if (e.shiftKey && !e.ctrlKey) {
      this.view = { ...this.view, x: this.view.x + (e.deltaY || e.deltaX) / this.view.zoom };
      this.viewChanged();
      return;
    }
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const f = Math.exp((-e.deltaY * scale * (e.ctrlKey ? 0.012 : 0.0018)));
    const before = this.screenToWorld(sx, sy);
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.view.zoom * f));
    cancelAnimationFrame(this.anim);
    this.view = { zoom, x: before[0] - sx / zoom, y: before[1] - sy / zoom };
    this.viewChanged();
  }

  private dbl(e: MouseEvent): void {
    const s = this.studio;
    if (s.tool !== 'select') return;
    const [sx, sy] = this.local(e);
    const o = pickObject(s.scene.objects, this.screenToWorld(sx, sy), 6 / this.view.zoom);
    if (!o) this.fit(true);
  }

  private context(e: MouseEvent): void {
    e.preventDefault();
    const s = this.studio;
    const [sx, sy] = this.local(e);
    const o = pickObject(s.scene.objects, this.screenToWorld(sx, sy), 6 / this.view.zoom);
    if (o && !s.selection.includes(o.id)) s.select([o.id]);
    const sel = s.selected;
    const anchor = h('div', { class: 'st-ctx-anchor', style: `left:${e.clientX}px;top:${e.clientY}px` });
    document.body.append(anchor);
    const items: MenuItem[] = [];
    if (sel.length) {
      items.push({ label: t('studio.sel.duplicate'), sub: 'Ctrl+D', icon: 'copy', onPick: () => s.duplicateSelection() });
      if (sel.length > 1) items.push({ label: t('studio.sel.merge'), sub: 'Ctrl+G', icon: 'merge', onPick: () => s.mergeSelection() });
      if (sel.length === 1 && sel[0].drawing.strokes.length > 1) items.push({ label: t('studio.sel.split'), sub: 'Ctrl+Shift+G', icon: 'split', onPick: () => s.splitSelection() });
      items.push({ label: t('studio.sel.forward'), sub: ']', icon: 'up', onPick: () => s.shiftLayer(1) });
      items.push({ label: t('studio.sel.back'), sub: '[', icon: 'dn', onPick: () => s.shiftLayer(-1) });
      items.push({ label: t('studio.sel.delete'), sub: 'Del', icon: 'trash', danger: true, onPick: () => s.deleteSelection() });
    } else {
      items.push({ label: t('studio.canvas.fit'), sub: 'Shift+1', icon: 'fit', onPick: () => this.fit(true) });
      items.push({ label: t('studio.canvas.select_all'), sub: 'Ctrl+A', icon: 'cursor', onPick: () => s.select(s.scene.objects.map((x) => x.id)) });
    }
    menu(anchor, items, { onClose: () => anchor.remove() });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.anim);
    this.ro.disconnect();
    for (const f of this.offs) f();
    this.cache.clear();
  }

  /** Re-render every object bitmap (after a theme change). */
  invalidate(): void {
    this.cache.clear();
    this.request();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
