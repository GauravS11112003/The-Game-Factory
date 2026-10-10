/**
 * Editor canvas renderer (§6.3, §7.11): paper with a dot grid every cell, perforated screen boundaries labelled 1..k,
 * the kid's vector ink, selection, the live stroke, lasso and eraser, and the live hints: reach halo, role chips,
 * too-far markers, snap ghosts, a pulsing unreachable goal, key → door links and the "play from here" flag.
 */
import type { CellXY, InkColor, InkStroke, RectCells } from '../core/types.gen.ts';
import { ART, PERCEPTION, WORLD } from '../core/params.ts';
import type { HintsResult } from '../app/core_types.ts';
import { roleChip, t } from '../app/messages.ts';
import type { EditorDocData } from './doc.ts';
import { bindingTag, opensOf } from './chips.ts';
import { strokeBBox, strokesBBox, type Pt } from './geom.ts';
import { INK, PARENT_GRAY, paintStroke } from './paint.ts';
import type { View } from './view.ts';

export interface RenderState {
  view: View;
  doc: EditorDocData;
  locked(s: InkStroke): boolean;
  selection: ReadonlySet<string>;
  live: { pts: Pt[]; color: InkColor; straight: boolean; flash: number } | null;
  lasso: { x: number; y: number }[] | null;
  eraser: { x: number; y: number; r: number } | null;
  dragOffset: [number, number] | null;
  stampGhost: { strokes: InkStroke[] } | null;
  hints: HintsResult | null;
  hintsOn: boolean;
  /** Role chips visible until a time (ms, performance.now()); selected objects always show theirs. */
  chipUntil: ReadonlyMap<string, number>;
  highlight: ReadonlySet<string>;
  pick: 'door' | 'start' | null;
  /** The start the build computed, shown as a faint draggable flag until the kid places their own. */
  flagGhost: CellXY | null;
  /** Remix: what changed vs the parent (new and moved ink outlined in pencil, removed parent ink as a dashed ghost). */
  changes?: { added: ReadonlySet<string>; moved: ReadonlySet<string>; removed: readonly InkStroke[] } | null;
  now: number;
  font: string;
}

const PAPER = ART.themes.sketchbook.base;
const OUTSIDE = '#E9E0CC';
const GRID = 'rgba(31,27,24,0.16)';
const PENCIL = ART.palette.pencil_violet;

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A paper label with a marker outline; dotted outline when unsure. */
function chip(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, o: { dotted?: boolean; color?: string; pin?: boolean; font: string; fill?: string }): void {
  ctx.save();
  ctx.font = o.font;
  const label = o.pin ? `📌 ${text}` : text;
  const w = ctx.measureText(label).width + 12;
  const h = 18;
  const px = Math.round(x);
  const py = Math.round(y - h);
  roundRect(ctx, px, py, w, h, 9);
  ctx.fillStyle = o.fill ?? 'rgba(255,253,246,0.94)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = o.color ?? ART.palette.ink;
  if (o.dotted) ctx.setLineDash([2, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = o.color ?? ART.palette.ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px + 6, py + h / 2 + 1);
  ctx.restore();
}

function dashedLine(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], color: string, width = 2, dash = [6, 5]): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.restore();
}

function arrowHead(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], color: string, size = 8): void {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(b[0], b[1]);
  ctx.lineTo(b[0] - size * Math.cos(ang - 0.45), b[1] - size * Math.sin(ang - 0.45));
  ctx.lineTo(b[0] - size * Math.cos(ang + 0.45), b[1] - size * Math.sin(ang + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function render(ctx: CanvasRenderingContext2D, st: RenderState): void {
  const v = st.view;
  const S = v.scale;
  const P = (x: number, y: number): [number, number] => v.toPx(x, y);
  const W = WORLD.screen_w * st.doc.screens;
  const H = WORLD.h;
  ctx.save();
  ctx.fillStyle = OUTSIDE;
  ctx.fillRect(0, 0, v.w, v.h);

  // ---- paper, grid, screen boundaries -----------------------------------------------------------------------
  const [wx0, wy0] = P(0, 0);
  const [wx1, wy1] = P(W, H);
  ctx.fillStyle = PAPER;
  ctx.fillRect(wx0, wy0, wx1 - wx0, wy1 - wy0);
  ctx.strokeStyle = 'rgba(31,27,24,0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(wx0, wy0, wx1 - wx0, wy1 - wy0);

  const cx0 = Math.max(0, Math.floor(v.x));
  const cx1 = Math.min(W, Math.ceil(v.x + v.cellsW));
  const cy0 = Math.max(0, Math.floor(v.y));
  const cy1 = Math.min(H, Math.ceil(v.y + v.cellsH));
  if (S >= 7) {
    ctx.fillStyle = GRID;
    const r = S >= 14 ? 1.1 : 0.8;
    for (let y = Math.max(1, cy0); y <= cy1 && y < H; y++) {
      for (let x = Math.max(1, cx0); x <= cx1 && x < W; x++) {
        const [px, py] = P(x, y);
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
      }
    }
  }
  ctx.save();
  ctx.font = st.font.replace(/\d+px/, `${Math.round(Math.max(12, Math.min(22, S * 1.1)))}px`);
  for (let k = 0; k < st.doc.screens; k++) {
    const [sx] = P(k * WORLD.screen_w, 0);
    if (k > 0) dashedLine(ctx, [sx, wy0], [sx, wy1], 'rgba(31,27,24,0.38)', 1.5, [3, 6]);
    ctx.fillStyle = 'rgba(31,27,24,0.42)';
    ctx.fillText(String(k + 1), sx + 6, wy0 + Math.max(14, S * 1.2));
  }
  ctx.restore();

  // ---- reach halo ---------------------------------------------------------------------------------------------
  const h = st.hintsOn ? st.hints : null;
  if (h) {
    ctx.fillStyle = 'rgba(62,158,79,0.17)';
    for (const [x, y] of h.reach) {
      if (x + 1 < v.x || x > v.x + v.cellsW) continue;
      const [px, py] = P(x, y - 1);
      roundRect(ctx, px + 1, py + 1, S - 2, S - 2, Math.min(5, S / 4));
      ctx.fill();
    }
  }

  // ---- ink -----------------------------------------------------------------------------------------------------
  const sel = st.selection;
  const goal = h && !h.solvable ? new Set(h.goalStrokes) : null;
  const pulse = 0.5 + 0.5 * Math.sin(st.now / 220);
  const vis = (b: RectCells): boolean => b[2] >= v.x - 1 && b[0] <= v.x + v.cellsW + 1;
  for (const s0 of st.doc.strokes) {
    const s = st.dragOffset && sel.has(s0.id) ? shift(s0, st.dragOffset) : s0;
    const bb = strokeBBox(s);
    if (!vis(bb)) continue;
    const opts = { scale: S, ox: v.x, oy: v.y };
    if (goal?.has(s.id)) paintStroke(ctx, widen(s, 0.5 + 0.35 * pulse), { ...opts, color: '#F2C94C', alpha: 0.45 + 0.35 * pulse });
    if (sel.has(s.id) || st.highlight.has(s.id)) paintStroke(ctx, widen(s, 0.45), { ...opts, color: PENCIL, alpha: 0.35 });
    if (st.locked(s)) paintStroke(ctx, s, { ...opts, color: PARENT_GRAY });
    else paintStroke(ctx, s, { ...opts, alpha: s.origin === 'draft' ? 0.9 : 1 });
  }

  // ---- remix changes (§6.5): new and moved ink in pencil boxes, removed parent ink as a dashed gray ghost ----------
  if (st.changes) {
    const c = st.changes;
    ctx.save();
    ctx.setLineDash([Math.max(3, S * 0.3), Math.max(3, S * 0.3)]);
    for (const s of c.removed) if (vis(strokeBBox(s))) paintStroke(ctx, s, { scale: S, ox: v.x, oy: v.y, color: PARENT_GRAY, alpha: 0.5 });
    ctx.restore();
    const boxes = (ids: ReadonlySet<string>): RectCells[] => mergeBoxes(st.doc.strokes.filter((s) => ids.has(s.id)).map(strokeBBox));
    for (const [ids, label, dashed] of [[c.added, 'remix.new', false], [c.moved, 'remix.moved', true]] as const) {
      for (const b of boxes(ids)) {
        if (!vis(b)) continue;
        const [x0, y0] = P(b[0] - 0.25, b[1] - 0.25);
        const [x1, y1] = P(b[2] + 0.25, b[3] + 0.25);
        ctx.save();
        ctx.strokeStyle = PENCIL;
        ctx.lineWidth = 2;
        if (dashed) ctx.setLineDash([6, 4]);
        roundRect(ctx, x0, y0, x1 - x0, y1 - y0, Math.min(10, S / 2));
        ctx.stroke();
        ctx.restore();
        chip(ctx, t(label), x0, y0 - 3, { color: PENCIL, font: st.font });
      }
    }
  }

  // ---- snap ghosts and too-far markers ---------------------------------------------------------------------------
  if (h) {
    for (const g of h.snaps) {
      const [ax, ay] = P(g.to[0], g.to[1]);
      const [bx, by] = P(g.to[2], g.to[3]);
      ctx.save();
      ctx.strokeStyle = g.kind === 'spikes' ? ART.palette.red : ART.palette.ink;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      if (g.kind === 'spikes') {
        const teeth = Math.max(1, Math.round((g.to[2] - g.to[0]) * 2));
        const up = g.facing !== 'down';
        ctx.beginPath();
        for (let i = 0; i <= teeth; i++) {
          const x = ax + ((bx - ax) * i) / teeth;
          const y = i % 2 ? (up ? ay : by) : up ? by : ay;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.stroke();
      } else ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.restore();
      const from = P((g.from[0] + g.from[2]) / 2, g.from[3]);
      const to = P((g.to[0] + g.to[2]) / 2, g.to[3]);
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) > 6) {
        dashedLine(ctx, from, to, 'rgba(106,90,205,0.8)', 1.5, [3, 3]);
        arrowHead(ctx, from, to, 'rgba(106,90,205,0.9)', 6);
      }
    }
    for (const m of h.tooFar) {
      const a = P(m.from[0], m.from[1] - 0.5);
      const b = P(m.to[0], m.to[1] - 0.5);
      const col = m.blocking ? ART.palette.red : '#D9822B';
      dashedLine(ctx, a, b, col, 2.5, [7, 5]);
      arrowHead(ctx, a, b, col, 9);
      const label = t(m.label === 'needs_run_up' ? 'hint.needs_run_up' : 'hint.too_far');
      chip(ctx, label, (a[0] + b[0]) / 2 - 30, Math.min(a[1], b[1]) - 6, { color: col, font: st.font });
    }
  }

  // ---- key → door links ---------------------------------------------------------------------------------------
  const links = new Map<string, InkStroke[]>();
  for (const s of st.doc.strokes) {
    const door = opensOf(s);
    if (door) links.set(door, [...(links.get(door) ?? []), s]);
  }
  for (const [door, keys] of links) {
    const d = st.doc.strokes.find((x) => x.id === door);
    const kb = strokesBBox(keys);
    if (!d || !kb) continue;
    const db = strokeBBox(d);
    const a = P((kb[0] + kb[2]) / 2, kb[1]);
    const b = P((db[0] + db[2]) / 2, db[1]);
    const mid: [number, number] = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 30];
    ctx.save();
    ctx.strokeStyle = 'rgba(44,123,229,0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(mid[0], mid[1], b[0], b[1]);
    ctx.stroke();
    ctx.restore();
    arrowHead(ctx, mid, b, 'rgba(44,123,229,0.9)', 8);
  }

  // ---- live stroke, lasso, eraser, stamp ghost ---------------------------------------------------------------------
  if (st.live && st.live.pts.length) {
    const lv = st.live;
    const s: InkStroke = {
      id: 'live', color: lv.color, kind: lv.pts.length === 1 ? 'dot' : 'line', pts: lv.pts.map((p) => [p.x, p.y]), w: lv.pts.map((p) => p.w),
      closed: false, sheet: 0, origin: 'kid',
    };
    if (lv.straight && lv.flash > 0) paintStroke(ctx, widen(s, 0.5), { scale: S, ox: v.x, oy: v.y, color: PENCIL, alpha: 0.4 * lv.flash });
    paintStroke(ctx, s, { scale: S, ox: v.x, oy: v.y, color: INK[lv.color] });
  }
  if (st.lasso && st.lasso.length > 1) {
    ctx.save();
    ctx.strokeStyle = PENCIL;
    ctx.fillStyle = 'rgba(106,90,205,0.08)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    st.lasso.forEach((p, i) => {
      const [x, y] = P(p.x, p.y);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  if (st.stampGhost) for (const s of st.stampGhost.strokes) paintStroke(ctx, s, { scale: S, ox: v.x, oy: v.y, alpha: 0.45 });
  if (st.eraser) {
    const [x, y] = P(st.eraser.x, st.eraser.y);
    ctx.save();
    ctx.strokeStyle = 'rgba(31,27,24,0.7)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, st.eraser.r * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---- chips: roles (fade after 2 s; always on selected objects) and kid bindings (always) ----------------------
  if (h) {
    for (const o of h.objects) {
      if (!o.bbox || o.partOf) continue;
      const until = st.chipUntil.get(o.id) ?? 0;
      const selected = o.strokes.some((id) => sel.has(id));
      if (!selected && until <= st.now) continue;
      if (!vis(o.bbox)) continue;
      const fade = selected ? 1 : Math.min(1, (until - st.now) / 500);
      ctx.save();
      ctx.globalAlpha = fade;
      const [x, y] = P(o.bbox[0], o.bbox[1]);
      chip(ctx, roleChip(o.role), x, y - 3, { dotted: o.conf < PERCEPTION.ask_conf, pin: o.pinned, font: st.font });
      ctx.restore();
    }
  }
  const tagged: { tag: string; x: number; y: number }[] = [];
  for (const s of st.doc.strokes) {
    const tag = bindingTag(s);
    if (!tag) continue;
    const bb = strokeBBox(s);
    if (!vis(bb)) continue;
    // One tag per bound object: strokes of the same object sit together.
    if (tagged.some((g) => g.tag === tag && Math.abs(g.x - bb[0]) < 3 && Math.abs(g.y - bb[3]) < 3)) continue;
    tagged.push({ tag, x: bb[0], y: bb[3] });
    const [x, y] = P(bb[0], bb[3]);
    chip(ctx, tag, x, y + 20, { color: PENCIL, font: st.font, pin: true });
  }

  // ---- play-from-here flag --------------------------------------------------------------------------------------
  if (st.doc.startAt) drawPlayerFlag(ctx, P(st.doc.startAt[0], st.doc.startAt[1]), S, st.font);
  else if (st.flagGhost) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    drawPlayerFlag(ctx, P(st.flagGhost[0], st.flagGhost[1]), S, st.font);
    ctx.restore();
  }

  if (st.pick) {
    chip(ctx, t(st.pick === 'door' ? 'editor.pick_door' : 'editor.pick_start'), 12, v.h - 12, { color: PENCIL, font: st.font, fill: '#FFFDF6' });
  }
  ctx.restore();
}

export function drawPlayerFlag(ctx: CanvasRenderingContext2D, at: [number, number], S: number, font: string): void {
  const [x, y] = at;
  const hpx = Math.max(26, S * 2.2);
  ctx.save();
  ctx.strokeStyle = PENCIL;
  ctx.fillStyle = PENCIL;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - hpx);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 1, y - hpx);
  ctx.lineTo(x + hpx * 0.6, y - hpx * 0.8);
  ctx.lineTo(x + 1, y - hpx * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = font.replace(/\d+px/, '11px');
  ctx.fillText('▶', x + 3, y - hpx * 0.72);
  ctx.beginPath();
  ctx.ellipse(x, y, 6, 2.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(106,90,205,0.35)';
  ctx.fill();
  ctx.restore();
}

/** Hit area of the play-from-here flag (CSS px around its pole). */
export function flagHit(at: CellXY, view: View, px: number, py: number): boolean {
  const [x, y] = view.toPx(at[0], at[1]);
  const hpx = Math.max(26, view.scale * 2.2);
  // Only the flag head is a handle, so drawing ground under the start never grabs the flag.
  return px >= x - 6 && px <= x + hpx * 0.7 && py >= y - hpx - 6 && py <= y - hpx * 0.5;
}

function shift(s: InkStroke, d: [number, number]): InkStroke {
  return { ...s, pts: s.pts.map((p) => [p[0] + d[0], p[1] + d[1]] as CellXY) };
}

function widen(s: InkStroke, by: number): InkStroke {
  return { ...s, kind: s.kind === 'blob' ? 'line' : s.kind, closed: s.closed || s.kind === 'blob', w: s.w.map((w) => w + by) };
}


/** Merge boxes that touch (within half a cell) so a remixed object gets one outline. */
function mergeBoxes(input: RectCells[]): RectCells[] {
  const out: RectCells[] = [];
  for (const b0 of input) {
    let b: RectCells = [b0[0], b0[1], b0[2], b0[3]];
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = out.length - 1; i >= 0; i--) {
        const o = out[i];
        if (o[0] - 0.5 <= b[2] && b[0] - 0.5 <= o[2] && o[1] - 0.5 <= b[3] && b[1] - 0.5 <= o[3]) {
          b = [Math.min(b[0], o[0]), Math.min(b[1], o[1]), Math.max(b[2], o[2]), Math.max(b[3], o[3])];
          out.splice(i, 1);
          merged = true;
        }
      }
    }
    out.push(b);
  }
  return out;
}
