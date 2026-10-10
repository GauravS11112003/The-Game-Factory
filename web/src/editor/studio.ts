/**
 * Character Studio (§7.11, fixes [V §2] and v1 issue 7): a 256 × 256 vector canvas with its OWN palette, tools and
 * undo (changing the main canvas colour never changes the studio colour), an onion skin of the 12 × 28 px body box
 * scaled up, and a live mini-stage where the doodle runs, jumps and lands with its rig as you draw.
 * Character strokes are stored in cells relative to the body box's top-left corner (feet at y = 1.75).
 * The mini-stage is lane E's RigPreview (the game's own RigAnimator: run, skid, jump squash, apex, land, idle, blinks),
 * with a simple local animation as the fallback.
 */
import type { InkColor, InkStroke, Rig } from '../core/types.gen.ts';
import { extractRig } from '../core/index.ts';
import { RigPreview } from '../engine/index.ts';
import { COLLISION, RIG, WORLD } from '../core/params.ts';
import { h, icon } from '../app/dom.ts';
import { t } from '../app/messages.ts';
import { finishPoints, markerWidth, q, strokeHitDist, toStrokeArrays, type Pt } from './geom.ts';
import { INK, paintStroke } from './paint.ts';

const BODY_W = COLLISION.body_px[0] / WORLD.cell_px; // 0.75
const BODY_H = COLLISION.body_px[1] / WORLD.cell_px; // 1.75
const VIEW = { x0: -1.125, y0: -1.1, size: 3 }; // cells shown by the 256 px studio canvas
const STUDIO_PX = 256;
const PEN = 0.13; // studio marker width (cells)

export interface StudioOptions {
  strokes: InkStroke[];
  canSaveToLibrary: boolean;
  onDone(strokes: InkStroke[]): void;
  onSaveToLibrary?(strokes: InkStroke[], rig: Rig | null): Promise<void>;
}

/** Legs fallback when the core's rig extraction is not available (§7.6 rule, simplified). */
function legsOf(strokes: InkStroke[]): string[] {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of strokes) for (const p of s.pts) {
    y0 = Math.min(y0, p[1]);
    y1 = Math.max(y1, p[1]);
  }
  const hgt = y1 - y0;
  if (!(hgt > 0)) return [];
  return strokes
    .filter((s) => {
      if (s.kind !== 'line' || s.pts.length < 2) return false;
      const ys = s.pts.map((p) => p[1]);
      const low = Math.max(...ys);
      const top = s.pts[ys.indexOf(Math.min(...ys))];
      const bot = s.pts[ys.indexOf(low)];
      const len = Math.hypot(bot[0] - top[0], bot[1] - top[1]);
      const off = Math.abs((Math.atan2(bot[0] - top[0], bot[1] - top[1]) * 180) / Math.PI);
      return low >= y1 - hgt * RIG.leg.bottom_frac && off <= RIG.leg.max_off_vertical_deg && len >= hgt * RIG.leg.min_len_frac;
    })
    .slice(0, RIG.leg.count[1])
    .map((s) => s.id);
}

function rigOf(strokes: InkStroke[]): Rig {
  try {
    return extractRig(strokes);
  } catch {
    const legs = legsOf(strokes);
    return { legs, arms: [], eyes: [], synth_legs: legs.length === 0, hip_y: 0.7 };
  }
}

export function openStudio(o: StudioOptions): () => void {
  let strokes: InkStroke[] = o.strokes.map((s) => ({ ...s }));
  const undo: InkStroke[][] = [];
  const redo: InkStroke[][] = [];
  let color: InkColor = 'black';
  let tool: 'marker' | 'eraser' = 'marker';
  let nextId = strokes.reduce((m, s) => Math.max(m, Number(/^c(\d+)$/.exec(s.id)?.[1] ?? 0)), 0) + 1;
  let rig: Rig = rigOf(strokes);
  let preview: RigPreview | null = null;
  try {
    preview = new RigPreview(strokes.length ? strokes : null);
  } catch (e) {
    console.warn('RigPreview unavailable; using the simple mini-stage', e);
    preview = null;
  }
  const changed = (): void => {
    rig = rigOf(strokes);
    try {
      preview?.setStrokes(strokes.length ? strokes : null);
    } catch {
      preview = null;
    }
  };

  const commit = (next: InkStroke[]): void => {
    undo.push(strokes);
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    strokes = next;
    changed();
    paint();
    syncButtons();
  };

  // ---- DOM -----------------------------------------------------------------------------------------------------
  const canvas = h('canvas', { class: 'studio-canvas', width: STUDIO_PX * 2, height: STUDIO_PX * 2 });
  const stage = h('canvas', { class: 'studio-stage', width: 512, height: 288 });
  const swatches = (['black', 'red', 'green', 'blue'] as InkColor[]).map((c) => {
    const b = h('button', { type: 'button', class: 'swatch', title: t(`color.${c}`), style: { background: INK[c] }, onclick: () => { color = c; tool = 'marker'; syncButtons(); } });
    b.dataset.color = c;
    return b;
  });
  const markerBtn = h('button', { type: 'button', class: 'tool', onclick: () => { tool = 'marker'; syncButtons(); } }, icon('marker'), t('tool.marker'));
  const eraserBtn = h('button', { type: 'button', class: 'tool', onclick: () => { tool = 'eraser'; syncButtons(); } }, icon('eraser'), t('tool.eraser'));
  const undoBtn = h('button', { type: 'button', class: 'tool', title: t('tool.undo'), onclick: () => { const p = undo.pop(); if (p) { redo.push(strokes); strokes = p; changed(); paint(); syncButtons(); } } }, icon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'tool', title: t('tool.redo'), onclick: () => { const p = redo.pop(); if (p) { undo.push(strokes); strokes = p; changed(); paint(); syncButtons(); } } }, icon('redo'));
  const clearBtn = h('button', { type: 'button', class: 'tool', onclick: () => strokes.length && commit([]) }, icon('trash'), t('studio.clear'));
  const status = h('p', { class: 'muted small' });
  const saveLib = h('button', { type: 'button', class: 'pill', disabled: !o.canSaveToLibrary }, icon('star'), t('studio.save_library'));
  const done = h('button', { type: 'button', class: 'pill primary', onclick: () => { close(); o.onDone(strokes); } }, icon('check'), t('studio.done'));
  const cancel = h('button', { type: 'button', class: 'pill', onclick: () => close() }, t('ui.cancel'));
  if (!o.canSaveToLibrary) saveLib.title = t('studio.library_needs_game');
  saveLib.onclick = async () => {
    if (!o.onSaveToLibrary || !strokes.length) return;
    saveLib.disabled = true;
    try {
      await o.onSaveToLibrary(strokes, rig);
      status.textContent = t('library.saved');
    } catch {
      status.textContent = t('error.build_failed');
    } finally {
      saveLib.disabled = false;
    }
  };

  const panel = h('div', { class: 'modal-back', role: 'dialog', 'aria-label': t('studio.title') },
    h('div', { class: 'card paper studio' },
      h('h2', { class: 'marker-underline' }, t('studio.title')),
      h('p', { class: 'muted' }, t('studio.help')),
      h('div', { class: 'studio-body' },
        h('div', { class: 'studio-left' },
          h('div', { class: 'toolrow' }, markerBtn, eraserBtn, ...swatches, undoBtn, redoBtn, clearBtn),
          canvas),
        h('div', { class: 'studio-right' }, h('h3', null, t('studio.mini_stage')), stage, status)),
      h('div', { class: 'row end' }, cancel, saveLib, done)));
  document.body.append(panel);

  function syncButtons(): void {
    markerBtn.classList.toggle('on', tool === 'marker');
    eraserBtn.classList.toggle('on', tool === 'eraser');
    for (const s of swatches) s.classList.toggle('on', tool === 'marker' && s.dataset.color === color);
    undoBtn.disabled = !undo.length;
    redoBtn.disabled = !redo.length;
  }
  syncButtons();

  // ---- studio canvas ---------------------------------------------------------------------------------------------
  const ctx = canvas.getContext('2d')!;
  const P = (canvas.width / VIEW.size);
  let live: Pt[] | null = null;
  let downAt = 0;
  let moved = 0;

  function toCell(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [VIEW.x0 + ((e.clientX - r.left) / r.width) * VIEW.size, VIEW.y0 + ((e.clientY - r.top) / r.height) * VIEW.size];
  }

  function paint(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#FBF6EA';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // dot grid every quarter cell
    ctx.fillStyle = 'rgba(31,27,24,0.08)';
    for (let x = 0; x < canvas.width; x += P / 4) for (let y = 0; y < canvas.height; y += P / 4) ctx.fillRect(x, y, 2, 2);
    // onion skin: the 12 × 28 px body box and the ground line at the feet
    const bx = (0 - VIEW.x0) * P;
    const by = (0 - VIEW.y0) * P;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = 'rgba(106,90,205,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, by, BODY_W * P, BODY_H * P);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(31,27,24,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, by + BODY_H * P);
    ctx.lineTo(canvas.width, by + BODY_H * P);
    ctx.stroke();
    ctx.restore();
    for (const s of strokes) paintStroke(ctx, s, { scale: P, ox: VIEW.x0, oy: VIEW.y0 });
    if (live && live.length) {
      paintStroke(ctx, { id: 'live', color, kind: live.length === 1 ? 'dot' : 'line', pts: live.map((p) => [p.x, p.y]), w: live.map((p) => p.w), closed: false, sheet: 0, origin: 'kid' }, { scale: P, ox: VIEW.x0, oy: VIEW.y0 });
    }
  }

  const eraseAt = (x: number, y: number): void => {
    const hit = strokes.filter((s) => strokeHitDist(s, x, y) <= 0.08);
    if (hit.length) commit(strokes.filter((s) => !hit.includes(s)));
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toCell(e);
    downAt = performance.now();
    moved = 0;
    if (tool === 'eraser') {
      eraseAt(x, y);
      live = null;
      return;
    }
    live = [{ x, y, w: PEN * (markerWidth(e.pressure, e.pointerType) / 0.75) }];
    paint();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!(e.buttons & 1)) return;
    const [x, y] = toCell(e);
    if (tool === 'eraser') {
      eraseAt(x, y);
      return;
    }
    if (!live) return;
    const last = live[live.length - 1];
    moved += Math.hypot(x - last.x, y - last.y) * (canvas.getBoundingClientRect().width / VIEW.size);
    live.push({ x, y, w: PEN * (markerWidth(e.pressure, e.pointerType) / 0.75) });
    paint();
  });
  const finish = (): void => {
    if (!live) return;
    const pts = live;
    live = null;
    const tap = moved < 4 && performance.now() - downAt < 250;
    const id = `c${nextId++}`;
    if (tap || pts.length < 2) {
      commit([...strokes, { id, color, kind: 'dot', pts: [[q(pts[0].x), q(pts[0].y)]], w: [0.2], closed: true, sheet: 0, origin: 'kid', t: nextId }]);
    } else {
      const fin = finishPoints(pts.map((p) => ({ ...p })));
      const arr = toStrokeArrays(fin);
      commit([...strokes, { id, color, kind: 'line', pts: arr.pts, w: arr.w, closed: false, sheet: 0, origin: 'kid', t: nextId }]);
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { live = null; paint(); });
  paint();

  // ---- mini-stage --------------------------------------------------------------------------------------------------
  const sctx = stage.getContext('2d')!;
  const SW = stage.width;
  const SH = stage.height;
  const floorY = SH * 0.86;
  const CELL = 44; // stage px per cell
  let x = 60;
  let facing: 1 | -1 = 1;
  let jumpT = -1; // seconds into the current jump, -1 when grounded
  let landT = 9;
  let nextJump = 1.2;
  let last = performance.now();
  let phase = 0;
  let raf = 0;
  const speed = 140; // px/s on the stage
  const JUMP_S = 0.62;
  const JUMP_H = 70;

  function stageFrame(nowMs: number): void {
    if (!panel.isConnected) {
      window.removeEventListener('keydown', onKey);
      return;
    }
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    if (preview) {
      try {
        preview.draw(stage, dt * 1000);
        raf = requestAnimationFrame(stageFrame);
        return;
      } catch (e) {
        console.warn('RigPreview draw failed; using the simple mini-stage', e);
        preview = null;
      }
    }
    x += facing * speed * dt;
    if (x > SW - 50) facing = -1;
    if (x < 50) facing = 1;
    nextJump -= dt;
    if (jumpT < 0 && nextJump <= 0) {
      jumpT = 0;
      nextJump = 1.1 + ((Math.floor(nowMs) % 7) / 10);
    }
    let y = 0;
    let sx = 1;
    let sy = 1;
    if (jumpT >= 0) {
      jumpT += dt;
      const u = jumpT / JUMP_S;
      if (u >= 1) {
        jumpT = -1;
        landT = 0;
      } else {
        y = 4 * JUMP_H * u * (1 - u);
        if (u < 0.15) {
          const k = u / 0.15;
          sx = RIG.jump_squash[0] + (1 - RIG.jump_squash[0]) * k;
          sy = RIG.jump_squash[1] + (1 - RIG.jump_squash[1]) * k;
        } else if (Math.abs(u - 0.5) < 0.1) {
          sx = RIG.apex_squash[0];
          sy = RIG.apex_squash[1];
        }
      }
    }
    if (landT < RIG.land_ms / 1000) {
      landT += dt;
      const k = Math.min(1, landT / (RIG.land_ms / 1000));
      sx = RIG.land_squash[0] + (1 - RIG.land_squash[0]) * k;
      sy = RIG.land_squash[1] + (1 - RIG.land_squash[1]) * k;
    }
    const freq = RIG.run.freq_base_hz + RIG.run.freq_per_cs * (speed / CELL);
    phase += dt * freq * Math.PI * 2;
    drawStage(y, sx, sy, jumpT >= 0);
    raf = requestAnimationFrame(stageFrame);
  }

  function drawStage(jy: number, sx: number, sy: number, airborne: boolean): void {
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.fillStyle = '#FBF6EA';
    sctx.fillRect(0, 0, SW, SH);
    sctx.strokeStyle = '#1F1B18';
    sctx.lineWidth = 4;
    sctx.lineCap = 'round';
    sctx.beginPath();
    sctx.moveTo(10, floorY + 2);
    sctx.lineTo(SW - 10, floorY + 2);
    sctx.stroke();
    sctx.fillStyle = 'rgba(31,27,24,0.08)';
    sctx.beginPath();
    sctx.ellipse(x, floorY + 3, 22 - Math.min(14, jy / 6), 4, 0, 0, Math.PI * 2);
    sctx.fill();
    const legs = new Set(rig.legs ?? []);
    const bob = airborne ? 0 : Math.abs(Math.sin(phase)) * RIG.run.bob_px * 2;
    sctx.save();
    sctx.translate(x, floorY - jy - bob);
    sctx.rotate(((RIG.run.lean_deg * Math.PI) / 180) * facing * (airborne ? 0.3 : 1));
    sctx.scale(facing * sx, sy);
    // feet = body box bottom centre
    const ox = BODY_W / 2;
    const oy = BODY_H;
    const draw = (s: InkStroke, rot = 0, pivot: [number, number] | null = null): void => {
      sctx.save();
      if (pivot && rot) {
        const px = (pivot[0] - ox) * CELL;
        const py = (pivot[1] - oy) * CELL;
        sctx.translate(px, py);
        sctx.rotate(rot);
        sctx.translate(-px, -py);
      }
      paintStroke(sctx, s, { scale: CELL, ox, oy, minWidthPx: 1.5 });
      sctx.restore();
    };
    let li = 0;
    for (const s of strokes) {
      if (legs.has(s.id)) {
        const top = s.pts.reduce((a, p) => (p[1] < a[1] ? p : a), s.pts[0]);
        const swing = airborne ? 0.12 : Math.sin(phase + (li++ % 2) * Math.PI) * ((RIG.run.leg_deg * Math.PI) / 180);
        draw(s, swing, [top[0], top[1]]);
      } else draw(s);
    }
    if (!strokes.length || rig.synth_legs) {
      // Synthesized stick legs in the kid's main ink (§7.6).
      const main = strokes[0]?.color ?? 'black';
      for (let i = 0; i < 2; i++) {
        const sw = airborne ? 0.15 : Math.sin(phase + i * Math.PI) * ((RIG.run.leg_deg * Math.PI) / 180);
        const hipX = ox + (i ? 0.14 : -0.14);
        const hipY = BODY_H * 0.72;
        const leg: InkStroke = { id: `leg${i}`, color: main, kind: 'line', pts: [[hipX, hipY], [hipX, BODY_H]], w: [0.12, 0.12], closed: false, sheet: 0, origin: 'kid' };
        draw(leg, sw, [hipX, hipY]);
      }
    }
    if (!strokes.length) {
      const ghost: InkStroke = { id: 'g', color: 'pencil', kind: 'line', pts: [[0, 0], [BODY_W, 0], [BODY_W, BODY_H * 0.72], [0, BODY_H * 0.72]], w: [0.1, 0.1, 0.1, 0.1], closed: true, sheet: 0, origin: 'kid' };
      draw(ghost);
    }
    sctx.restore();
  }
  raf = requestAnimationFrame(stageFrame);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKey);

  function close(): void {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    panel.remove();
  }
  return close;
}
