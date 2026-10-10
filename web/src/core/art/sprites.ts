/**
 * Entity art (PLAN_V2 §7.3 recipes, §7.6): the kid's own vector strokes (every `part_of` part) baked into sprites,
 * crisp, never cropped from a raster and never whitened; house doodles in pencil for designer additions (walker blob,
 * hopper frog, flyer bat, shooter cannon, chaser angry blob, crusher block, pencil flags, springs, arrows); the house
 * coin (the kid's dot is not drawn again); spikes re-based onto their host face with 9 px teeth.
 */
import type { Entity, InkStroke, SceneObject } from '../types.gen.ts';
import { RASTER } from '../params.ts';
import type { ArtPath, ArtSprite } from './types.ts';
import { cleanStroke, strokeBox, transformStrokes } from './clean.ts';
import type { CleanStroke } from './clean.ts';
import { CELL, circlePts, clamp, hash32, starPts } from './geom.ts';
import type { V } from './geom.ts';
import { extractRig } from './rig.ts';
import {
  ellipse, emitBlueLine, emitFill, emitMarker, emitPencil, inkForOrigin, inkHex, poly, PX, StyleBook,
} from './styles.ts';
import type { EmitExtra, InkFor } from './styles.ts';

export interface SpriteSource {
  obj: SceneObject | null;
  strokes: InkStroke[]; // the object's strokes plus all of its parts
  partRoles: Map<string, string>; // stroke id → role of the object it came from (pole, goal, …)
}

/** Emit one cleaned stroke in the right ink. mode 'sprite' gives closed outlines a paper fill (a solid character). */
export function emitStroke(
  out: ArtPath[], b: StyleBook, cs: CleanStroke, ink: InkFor, mode: 'sprite' | 'decor' | 'terrain' | 'sign', seed: number,
  x: EmitExtra = {},
): void {
  if (!cs.v.length) return;
  if (ink === 'blue_line') {
    emitBlueLine(out, b, cs.v, cs.closed, seed, x);
    return;
  }
  if (ink === 'pencil') {
    if (cs.dot) emitMarker(out, cs.v, true, b.pencil(inkHex(cs.color, b.theme)), x);
    else emitPencil(out, b, cs.v, cs.closed, inkHex(cs.color === 'black' ? 'pencil' : cs.color, b.theme), seed, x, mode !== 'terrain');
    return;
  }
  if (mode === 'sign') {
    const thin = cs.v.map((p) => [p[0], p[1], Math.max(2, p[2] * 0.8)] as V);
    emitMarker(out, thin, cs.closed, b.sign(), x);
    return;
  }
  if (cs.closed && !cs.dot && cs.v.length >= 3) {
    if (cs.kind === 'blob') emitFill(out, cs.v, b.blob(cs.color), x);
    else if (mode === 'sprite') emitFill(out, cs.v, b.sticker(), x);
    else if (mode === 'decor') emitFill(out, cs.v, b.wash(cs.color), x);
  }
  emitMarker(out, cs.v, cs.closed, b.marker(cs.color), x);
}

function boxOfPaths(paths: ArtPath[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths) {
    const pad = (p.w ? Math.max(...p.w) : 3) / 2 / CELL;
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      x0 = Math.min(x0, p.pts[i] - pad);
      y0 = Math.min(y0, p.pts[i + 1] - pad);
      x1 = Math.max(x1, p.pts[i] + pad);
      y1 = Math.max(y1, p.pts[i + 1] + pad);
    }
  }
  if (x0 === Infinity) return [-0.5, -0.5, 0.5, 0.5];
  const r = (v: number): number => Math.round(v * 64) / 64;
  return [r(x0), r(y0), r(x1), r(y1)];
}

function cleanAll(strokes: InkStroke[], minDotPx: number): CleanStroke[] {
  return strokes.map((s) => cleanStroke(s, { minDotPx, widthPx: [2, 9] })).filter((c) => c.v.length > 0);
}

/** Fit strokes into a local target box: uniform scale, bottom-centre (or centre) aligned. */
function fitInto(cs: CleanStroke[], box: [number, number, number, number], align: 'bottom' | 'center' | 'topleft', grow = false): CleanStroke[] {
  const [bx0, by0, bx1, by1] = strokeBox(cs);
  const bw = Math.max(1e-3, bx1 - bx0);
  const bh = Math.max(1e-3, by1 - by0);
  const tw = box[2] - box[0];
  const th = box[3] - box[1];
  let s = Math.min(tw / bw, th / bh);
  if (!grow) s = Math.min(s, 1.15);
  s = clamp(s, 0.35, 2.5);
  if (align === 'bottom') return transformStrokes(cs, (bx0 + bx1) / 2, by1, s, (box[0] + box[2]) / 2, box[3]);
  if (align === 'topleft') return transformStrokes(cs, bx0, by0, s, box[0], box[1]);
  return transformStrokes(cs, (bx0 + bx1) / 2, (by0 + by1) / 2, s, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
}

function translate(cs: CleanStroke[], dx: number, dy: number): CleanStroke[] {
  return cs.map((c) => ({ ...c, v: c.v.map((p) => [p[0] + dx, p[1] + dy, p[2]] as V) }));
}

// ---- house doodles (local cells) ---------------------------------------------------------------------

interface Doodle {
  lines: { v: V[]; closed: boolean; color: string; part?: ArtPath['part']; fill?: 'sticker' | 'blob' | 'none' }[];
}

const W = 2.6; // house doodle line width (px)

function eyePair(cx: number, cy: number, dx: number, r: number): Doodle['lines'] {
  return [
    { v: [[cx - dx, cy, r * CELL]], closed: true, color: 'black', part: 'eye' },
    { v: [[cx + dx, cy, r * CELL]], closed: true, color: 'black', part: 'eye' },
  ];
}

function houseEnemy(arch: string, w: number, h: number, spiky: boolean): Doodle {
  const lines: Doodle['lines'] = [];
  const hw = w / 2;
  switch (arch) {
    case 'hopper': {
      lines.push({ v: ellipse(0, -h * 0.38, hw * 0.98, h * 0.36, 22, W), closed: true, color: 'green', fill: 'sticker' });
      lines.push({ v: ellipse(-hw * 0.42, -h * 0.74, hw * 0.26, h * 0.2, 12, W), closed: true, color: 'green', fill: 'sticker' });
      lines.push({ v: ellipse(hw * 0.42, -h * 0.74, hw * 0.26, h * 0.2, 12, W), closed: true, color: 'green', fill: 'sticker' });
      lines.push(...eyePair(0, -h * 0.74, hw * 0.42, 0.11));
      lines.push({ v: poly([[-hw * 0.9, -h * 0.12], [-hw * 1.05, -h * 0.02], [-hw * 0.7, 0]], W), closed: false, color: 'green' });
      lines.push({ v: poly([[hw * 0.9, -h * 0.12], [hw * 1.05, -h * 0.02], [hw * 0.7, 0]], W), closed: false, color: 'green' });
      lines.push({ v: poly([[-hw * 0.35, -h * 0.4], [0, -h * 0.32], [hw * 0.35, -h * 0.4]], 2), closed: false, color: 'black' });
      break;
    }
    case 'flyer': {
      const cy = -h * 0.5;
      const r = Math.min(hw, h / 2) * 0.55;
      lines.push({ v: ellipse(0, cy, r, r * 0.95, 16, W), closed: true, color: 'black', fill: 'blob' });
      lines.push({ v: poly([[-r * 0.9, cy - r * 0.2], [-hw * 1.05, cy - h * 0.42], [-hw * 0.75, cy - h * 0.05], [-hw * 1.1, cy + h * 0.02], [-r * 0.95, cy + r * 0.3]], W), closed: false, color: 'black' });
      lines.push({ v: poly([[r * 0.9, cy - r * 0.2], [hw * 1.05, cy - h * 0.42], [hw * 0.75, cy - h * 0.05], [hw * 1.1, cy + h * 0.02], [r * 0.95, cy + r * 0.3]], W), closed: false, color: 'black' });
      lines.push({ v: [[-r * 0.38, cy - r * 0.15, 3.4]], closed: true, color: 'red', part: 'eye' });
      lines.push({ v: [[r * 0.38, cy - r * 0.15, 3.4]], closed: true, color: 'red', part: 'eye' });
      break;
    }
    case 'shooter': {
      lines.push({ v: poly([[-hw * 0.8, 0], [-hw * 0.8, -h * 0.62], [hw * 0.55, -h * 0.62], [hw * 0.55, 0]], W), closed: true, color: 'black', fill: 'sticker' });
      lines.push({ v: poly([[hw * 0.1, -h * 0.5], [hw * 1.05, -h * 0.72], [hw * 1.05, -h * 0.95], [hw * 0.05, -h * 0.78]], W), closed: true, color: 'black', fill: 'blob' });
      lines.push({ v: ellipse(-hw * 0.1, -h * 0.18, h * 0.16, h * 0.16, 12, W), closed: true, color: 'black', fill: 'sticker' });
      lines.push(...eyePair(-hw * 0.25, -h * 0.42, hw * 0.18, 0.09));
      break;
    }
    case 'chaser': {
      lines.push({ v: ellipse(0, -h * 0.47, hw * 0.95, h * 0.46, 22, W, 0.04), closed: true, color: 'red', fill: 'sticker' });
      lines.push(...eyePair(0, -h * 0.58, hw * 0.32, 0.12));
      lines.push({ v: poly([[-hw * 0.62, -h * 0.82], [-hw * 0.12, -h * 0.68]], W), closed: false, color: 'black' });
      lines.push({ v: poly([[hw * 0.62, -h * 0.82], [hw * 0.12, -h * 0.68]], W), closed: false, color: 'black' });
      lines.push({ v: poly([[-hw * 0.45, -h * 0.3], [-hw * 0.22, -h * 0.38], [0, -h * 0.3], [hw * 0.22, -h * 0.38], [hw * 0.45, -h * 0.3]], 2), closed: false, color: 'black' });
      lines.push({ v: poly([[-hw * 0.35, -h * 0.05], [-hw * 0.4, 0]], W), closed: false, color: 'red' });
      lines.push({ v: poly([[hw * 0.35, -h * 0.05], [hw * 0.4, 0]], W), closed: false, color: 'red' });
      break;
    }
    case 'crusher': {
      lines.push({ v: poly([[-hw, -h], [hw, -h], [hw, -h * 0.18], [-hw, -h * 0.18]], 3.2), closed: true, color: 'black', fill: 'sticker' });
      const teeth: [number, number][] = [];
      const n = Math.max(3, Math.round(w * 3));
      for (let i = 0; i <= n; i++) teeth.push([-hw + (w * i) / n, i % 2 ? 0 : -h * 0.18]);
      lines.push({ v: poly(teeth, 2.2), closed: false, color: 'black' });
      lines.push(...eyePair(0, -h * 0.62, hw * 0.4, 0.12));
      lines.push({ v: poly([[-hw * 0.7, -h * 0.85], [-hw * 0.15, -h * 0.72]], W), closed: false, color: 'black' });
      lines.push({ v: poly([[hw * 0.7, -h * 0.85], [hw * 0.15, -h * 0.72]], W), closed: false, color: 'black' });
      break;
    }
    default: {
      // walker blob (also the Faithful "static" monster without art)
      lines.push({ v: ellipse(0, -h * 0.5, hw * 0.95, h * 0.45, 22, W, 0.05), closed: true, color: 'black', fill: 'sticker' });
      lines.push(...eyePair(0, -h * 0.62, hw * 0.3, 0.1));
      lines.push({ v: poly([[-hw * 0.4, -h * 0.08], [-hw * 0.45, 0], [-hw * 0.15, 0]], W), closed: false, color: 'black' });
      lines.push({ v: poly([[hw * 0.4, -h * 0.08], [hw * 0.45, 0], [hw * 0.15, 0]], W), closed: false, color: 'black' });
    }
  }
  if (spiky) {
    const n = Math.max(3, Math.round(w * 2.5));
    const top = -h * 0.92;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 2 * n; i++) pts.push([-hw * 0.8 + (1.6 * hw * i) / (2 * n), i % 2 ? top - 0.32 : top + 0.05]);
    lines.push({ v: poly(pts, 2), closed: false, color: 'red' });
  }
  return { lines };
}

function houseFlag(poleH: number, clothW: number, clothH: number): Doodle {
  const top = -poleH;
  return {
    lines: [
      { v: poly([[0, 0], [0, top]], 3), closed: false, color: 'black', part: 'pole' },
      {
        v: poly([[0, top], [clothW * 0.5, top + clothH * 0.12], [clothW, top + clothH * 0.05], [clothW * 0.92, top + clothH * 0.55], [clothW, top + clothH], [clothW * 0.5, top + clothH * 0.9], [0, top + clothH]], W),
        closed: true, color: 'green', part: 'cloth', fill: 'blob',
      },
    ],
  };
}

function houseSpring(w: number): Doodle {
  const hw = w / 2;
  const coil: [number, number][] = [];
  const n = 6;
  for (let i = 0; i <= n; i++) coil.push([i % 2 ? hw * 0.55 : -hw * 0.55, -0.12 - (0.6 * i) / n]);
  return {
    lines: [
      { v: poly([[-hw * 0.85, -0.04], [hw * 0.85, -0.04]], 3), closed: false, color: 'black', part: 'base' },
      { v: poly(coil, 2.4), closed: false, color: 'black', part: 'coil' },
      { v: poly([[-hw * 0.9, -0.78], [hw * 0.9, -0.78]], 3.4), closed: false, color: 'red', part: 'coil' },
    ],
  };
}

function houseKey(): Doodle {
  return {
    lines: [
      { v: ellipse(-0.3, 0, 0.22, 0.22, 14, 2.6), closed: true, color: 'blue', fill: 'sticker' },
      { v: poly([[-0.08, 0], [0.48, 0]], 2.6), closed: false, color: 'blue' },
      { v: poly([[0.3, 0], [0.3, 0.2]], 2.4), closed: false, color: 'blue' },
      { v: poly([[0.44, 0], [0.44, 0.24]], 2.4), closed: false, color: 'blue' },
    ],
  };
}

function houseDoor(w: number, h: number): Doodle {
  const lines: Doodle['lines'] = [
    { v: poly([[0.06, h], [0.06, 0.06], [w - 0.06, 0.06], [w - 0.06, h]], 3), closed: false, color: 'black', fill: 'none' },
  ];
  for (let i = 1; i < Math.max(2, Math.round(w * 3)); i++) {
    const x = (w * i) / Math.max(2, Math.round(w * 3));
    lines.push({ v: poly([[x, 0.2], [x, h - 0.1]], 1.3), closed: false, color: 'black' });
  }
  lines.push({ v: [[w * 0.72, h * 0.55, 4]], closed: true, color: 'black' });
  return { lines };
}

function houseArrow(dir: string): Doodle {
  const L = 0.75;
  const pts: [number, number][] = [[-L, 0], [L, 0]];
  const head: [number, number][] = [[L - 0.38, -0.3], [L, 0], [L - 0.38, 0.3]];
  const rot = (p: [number, number]): [number, number] => {
    switch (dir) {
      case 'left':
        return [-p[0], p[1]];
      case 'up':
        return [p[1], -p[0]];
      case 'down':
        return [p[1], p[0]];
      default:
        return p;
    }
  };
  return {
    lines: [
      { v: poly(pts.map(rot), 3), closed: false, color: 'pencil' },
      { v: poly(head.map(rot), 3), closed: false, color: 'pencil' },
    ],
  };
}

function housePlatform(type: string, w: number): Doodle {
  const lines: Doodle['lines'] = [{ v: poly([[0.05, 0.16], [w - 0.05, 0.16]], 5), closed: false, color: 'black' }];
  if (type === 'moving_platform') {
    for (let x = 0.4; x < w - 0.2; x += 0.75) lines.push({ v: poly([[x, 0.45], [x + 0.3, 0.45]], 1.4), closed: false, color: 'black' });
  } else if (type === 'crumble') {
    for (let x = 0.5; x < w - 0.3; x += 0.9)
      lines.push({ v: poly([[x, 0.05], [x + 0.08, 0.2], [x - 0.04, 0.32], [x + 0.06, 0.48]], 1.3), closed: false, color: 'black' });
  } else {
    for (let x = w / 2 - 0.4; x <= w / 2 + 0.45; x += 0.8)
      lines.push({ v: poly([[x - 0.12, 0.42], [x, 0.58], [x + 0.12, 0.42]], 1.4), closed: false, color: 'black' });
  }
  return { lines };
}

function emitDoodle(out: ArtPath[], b: StyleBook, d: Doodle, ink: InkFor, seed: number, x: EmitExtra = {}): void {
  d.lines.forEach((l, i) => {
    const extra = { ...x, ...(l.part ? { part: l.part } : {}) };
    const isDot = l.v.length === 1;
    if (ink === 'pencil') {
      const hex = inkHex(l.color === 'black' ? 'pencil' : l.color, b.theme);
      if (isDot) emitMarker(out, l.v, true, b.pencil(hex), extra);
      else {
        if (l.closed && l.fill !== 'none') emitFill(out, l.v, l.fill === 'blob' ? b.pencilFill(hex) : b.sticker(), extra);
        emitPencil(out, b, l.v, l.closed, hex, seed + i * 7, extra, false);
      }
      return;
    }
    if (l.closed && !isDot && l.fill === 'blob') emitFill(out, l.v, b.blob(l.color), extra);
    if (l.closed && !isDot && l.fill === 'sticker') emitFill(out, l.v, b.sticker(), extra);
    emitMarker(out, l.v, l.closed, b.marker(l.color), extra);
  });
}

// ---- per-type builders --------------------------------------------------------------------------------

/**
 * The sprite anchor. Spikes on a top/bottom face run x0..x1 along x at the face line y; on a left/right face the
 * face is vertical: x0..x1 is the vertical extent and y the face's x (lane A's sim/world.ts convention).
 */
export function anchorOf(e: Entity): [number, number] {
  if (e.type === 'spikes') {
    const vertical = e.facing === 'left' || e.facing === 'right';
    return vertical ? [e.y, (e.x0 + e.x1) / 2] : [(e.x0 + e.x1) / 2, e.y];
  }
  return [e.x, e.y];
}

function houseCoin(out: ArtPath[], b: StyleBook, designer: boolean, seed: number): void {
  const r = RASTER.coin_diam_px / 2 / CELL;
  const ring = circlePts(0, 0, r, 20);
  out.push({ pts: ring, closed: true, style: 'coin_fill' });
  if (designer) {
    const v: V[] = [];
    for (let i = 0; i < ring.length; i += 2) v.push([ring[i], ring[i + 1], 2.4]);
    emitPencil(out, b, v, true, inkHex('blue', b.theme), seed, {}, false);
  } else out.push({ pts: ring, closed: true, style: 'coin_ring' });
  const shine: number[] = [];
  for (let a = 200; a <= 250; a += 10) shine.push(Math.cos((a * Math.PI) / 180) * r * 0.55, Math.sin((a * Math.PI) / 180) * r * 0.55);
  out.push({ pts: shine, closed: false, style: 'coin_shine', part: 'shine' });
}

function spikeTeeth(e: Extract<Entity, { type: 'spikes' }>, src: CleanStroke[], designer: boolean, b: StyleBook, seed: number): ArtPath[] {
  const out: ArtPath[] = [];
  const [ax, ay] = anchorOf(e);
  // face frame: u along the face, n away from the host
  const vertical = e.facing === 'left' || e.facing === 'right';
  const n: [number, number] = e.facing === 'up' ? [0, -1] : e.facing === 'down' ? [0, 1] : e.facing === 'left' ? [-1, 0] : [1, 0];
  const u: [number, number] = vertical ? [0, 1] : [1, 0];
  // face extent in local cells (relative to the anchor)
  let s0: number;
  let s1: number;
  let base: [number, number];
  if (!vertical) {
    s0 = e.x0 - ax;
    s1 = e.x1 - ax;
    base = [0, 0];
  } else {
    s0 = Math.min(e.x0, e.x1) - ay;
    s1 = Math.max(e.x0, e.x1) - ay;
    base = [0, 0];
  }
  const inset = RASTER.spike_end_inset_px / CELL / 2;
  s0 += inset;
  s1 -= inset;
  // the kid's zigzag peaks projected onto the face
  let tips: number[] = [];
  const pts: [number, number][] = [];
  for (const c of src) for (const p of c.v) pts.push([p[0] - ax, p[1] - ay]);
  if (pts.length >= 5) {
    const along = pts.map((p) => (p[0] - base[0]) * u[0] + (p[1] - base[1]) * u[1]);
    const out_ = pts.map((p) => (p[0] - base[0]) * n[0] + (p[1] - base[1]) * n[1]);
    const lo = Math.min(...out_);
    const hi = Math.max(...out_);
    const prom = (hi - lo) * 0.45;
    if (hi - lo > 0.12) {
      for (let i = 1; i < pts.length - 1; i++) {
        if (out_[i] >= out_[i - 1] && out_[i] > out_[i + 1] && out_[i] - lo >= prom) {
          const s = clamp(along[i], s0 + 0.12, s1 - 0.12);
          if (!tips.length || Math.abs(s - tips[tips.length - 1]) > 0.22) tips.push(s);
        }
      }
    }
  }
  let toothPx: number = RASTER.spike_art_teeth_px;
  if (tips.length < 2) {
    toothPx = RASTER.spike_art_teeth_straight_px;
    const L = (s1 - s0) * CELL;
    const count = Math.max(1, Math.round(L / 8));
    tips = [];
    for (let i = 0; i < count; i++) tips.push(s0 + ((i + 0.5) * (s1 - s0)) / count);
  }
  tips.sort((p, q) => p - q);
  const at = (s: number, t: number): [number, number] => [base[0] + u[0] * s + n[0] * t, base[1] + u[1] * s + n[1] * t];
  const h = toothPx / CELL;
  const poly_: number[] = [];
  const push = (p: [number, number]): void => {
    poly_.push(Math.round(p[0] * 64) / 64, Math.round(p[1] * 64) / 64);
  };
  push(at(s0, 0));
  for (let i = 0; i < tips.length; i++) {
    const left = i === 0 ? s0 : (tips[i - 1] + tips[i]) / 2;
    const right = i === tips.length - 1 ? s1 : (tips[i] + tips[i + 1]) / 2;
    if (i > 0) push(at(left, 0));
    push(at(tips[i], h));
    if (i === tips.length - 1) push(at(right, 0));
  }
  out.push({ pts: poly_, closed: true, style: designer ? 'spike_pencil_fill' : 'spike_fill' });
  if (designer) {
    const v: V[] = [];
    for (let i = 0; i + 1 < poly_.length; i += 2) v.push([poly_[i], poly_[i + 1], 3]);
    emitMarker(out, v, true, b.darkOutline());
    emitPencil(out, b, v, true, inkHex('red', b.theme), seed, {}, false);
  } else out.push({ pts: poly_, closed: true, style: 'spike_outline' });
  return out;
}

function splitPole(cs: CleanStroke[], roles: Map<string, string>): { pole: CleanStroke[]; cloth: CleanStroke[] } {
  const pole: CleanStroke[] = [];
  const cloth: CleanStroke[] = [];
  for (const c of cs) {
    const role = roles.get(c.id);
    const [x0, y0, x1, y1] = strokeBox([c]);
    const tallThin = !c.closed && y1 - y0 > 1.2 && (x1 - x0) < (y1 - y0) * 0.3;
    if (role === 'pole' || (role !== 'goal' && role !== 'checkpoint' && tallThin) || (role === undefined && tallThin)) pole.push(c);
    else cloth.push(c);
  }
  if (!pole.length) {
    // the tallest thin stroke is the pole, if any
    const cand = cloth.filter((c) => {
      const [x0, y0, x1, y1] = strokeBox([c]);
      return !c.closed && y1 - y0 > 1 && x1 - x0 < (y1 - y0) * 0.35;
    });
    if (cand.length) {
      pole.push(cand[0]);
      cloth.splice(cloth.indexOf(cand[0]), 1);
    }
  }
  return { pole, cloth };
}

/** Build the sprite of one compiled entity, or null when it has no art (player start). */
export function buildSprite(e: Entity, src: SpriteSource, b: StyleBook, seed: number): ArtSprite | null {
  if (e.type === 'player_start') return null;
  const anchor = anchorOf(e);
  const designer = e.origin === 'designer' || src.obj?.origin === 'designer';
  const ink: InkFor = designer ? 'pencil' : inkForOrigin(src.obj?.origin ?? e.origin ?? 'kid');
  const houseInk: InkFor = designer ? 'pencil' : ink === 'blue_line' ? 'blue_line' : 'marker';
  const sd = (seed ^ hash32(e.id)) >>> 0;
  const kid = cleanAll(src.strokes, 3.5);
  const local = translate(kid, -anchor[0], -anchor[1]);
  const paths: ArtPath[] = [];
  let eyes: [number, number][] = [];
  const hasKid = local.length > 0 && e.type !== 'coin';
  const objIds = src.obj ? [src.obj.id, ...(src.obj.rel.parts ?? [])] : [];

  const emitKid = (cs: CleanStroke[], eyeIds: Set<string> = new Set(), partOf?: (c: CleanStroke) => ArtPath['part']): void => {
    cs.forEach((c, i) => {
      const part = eyeIds.has(c.id) ? 'eye' : partOf?.(c);
      emitStroke(paths, b, c, ink, 'sprite', sd + i * 13, { object_id: src.obj?.id, ...(part ? { part } : {}) });
      if (part === 'eye') {
        let x = 0;
        let y = 0;
        for (const p of c.v) {
          x += p[0];
          y += p[1];
        }
        eyes.push([x / c.v.length, y / c.v.length]);
      }
    });
  };

  switch (e.type) {
    case 'enemy': {
      const box: [number, number, number, number] = [-e.w / 2, -e.h, e.w / 2, 0];
      if (hasKid) {
        // the drawing keeps its own size (the hurtbox is inset, which is forgiving); only a drawing larger than
        // the 2 × 2-cell creature bound shrinks, and one smaller than its hitbox grows to cover it
        const [bx0, by0, bx1, by1] = strokeBox(local);
        const bw = Math.max(1e-3, bx1 - bx0);
        const bh = Math.max(1e-3, by1 - by0);
        let sc = 1;
        if (bw > 2.25 || bh > 2.25) sc = Math.min(2.25 / bw, 2.25 / bh);
        else if (bw < e.w * 0.9 && bh < e.h * 0.9) sc = Math.min(e.w / bw, e.h / bh);
        const fitted = transformStrokes(local, (bx0 + bx1) / 2, by1, sc, (box[0] + box[2]) / 2, box[3]);
        const rig = extractRig(src.strokes);
        emitKid(fitted, new Set(rig.eyes ?? []));
      } else {
        emitDoodle(paths, b, houseEnemy(e.archetype, e.w, e.h, !!e.spiky), houseInk, sd);
        eyes = [];
        for (const p of paths) if (p.part === 'eye') eyes.push([p.pts[0], p.pts[1]]);
      }
      break;
    }
    case 'coin':
      houseCoin(paths, b, designer, sd);
      break;
    case 'big_coin':
      if (hasKid) emitKid(fitInto(local, [-0.65, -0.65, 0.65, 0.65], 'center', true));
      else if (houseInk === 'pencil') {
        const s = starPts(0, 0, 0.62, 0.46);
        const v: V[] = [];
        for (let i = 0; i + 1 < s.length; i += 2) v.push([s[i], s[i + 1], 2.6]);
        paths.push({ pts: s, closed: true, style: 'star_fill' });
        emitPencil(paths, b, v, true, inkHex('blue', b.theme), sd, {}, false);
      } else {
        const s = starPts(0, 0, 0.62, 0.46);
        paths.push({ pts: s, closed: true, style: 'star_fill' });
        const v: V[] = [];
        for (let i = 0; i + 1 < s.length; i += 2) v.push([s[i], s[i + 1], 2.4]);
        emitMarker(paths, v, true, b.marker('blue'));
      }
      break;
    case 'checkpoint':
    case 'goal': {
      const poleH = e.type === 'goal' ? Math.max(2.5, e.y - e.trigger[1]) : 2.4;
      const clothW = e.type === 'goal' ? clamp(e.trigger[2] - e.x, 1.1, 2.2) : 1.1;
      if (hasKid) {
        const { pole, cloth } = splitPole(local, src.partRoles);
        let dx = 0;
        let dy = 0;
        if (pole.length) {
          // the pole's lowest ink edge sits on the feet line, centred on the entity x
          const [px0, , px1, py1] = strokeBox(pole);
          dx = -(px0 + px1) / 2;
          dy = -py1;
        } else if (cloth.length) {
          // no pole drawn: the kid's flag stands on a plain pole (scenery), cloth hoisted at the trigger top
          const [cx0, cy0] = strokeBox(cloth);
          dx = -cx0;
          dy = -poleH - cy0;
          emitMarker(paths, poly([[0, 0], [0, -poleH]], 3), false, ink === 'pencil' ? b.pencil(inkHex('pencil', b.theme)) : b.marker('black'), { part: 'pole' });
        }
        emitKid(translate(pole, dx, dy), new Set(), () => 'pole');
        emitKid(translate(cloth, dx, dy), new Set(), () => 'cloth');
      } else emitDoodle(paths, b, houseFlag(poleH, clothW, Math.min(1.3, poleH * 0.4)), houseInk, sd);
      break;
    }
    case 'spikes':
      paths.push(...spikeTeeth(e, src.strokes.length ? cleanAll(src.strokes, 3) : [], designer, b, sd));
      break;
    case 'spring': {
      const w = e.w ?? 1;
      if (hasKid) emitKid(fitInto(local, [-w / 2, -0.9, w / 2, 0], 'bottom', true), new Set(), () => 'coil');
      else {
        const d = houseSpring(w);
        // side springs: rotate the up-spring so "up" points along dir (y-down frame)
        if (e.dir === 'right') for (const l of d.lines) l.v = l.v.map((p) => [-p[1], p[0], p[2]] as V);
        if (e.dir === 'left') for (const l of d.lines) l.v = l.v.map((p) => [p[1], -p[0], p[2]] as V);
        emitDoodle(paths, b, d, houseInk, sd);
      }
      break;
    }
    case 'saw': {
      const r = e.r;
      if (hasKid) emitKid(fitInto(local, [-r, -r, r, r], 'center', true));
      else {
        const teeth = starPts(0, 0, r, 0.78, 10, 0);
        paths.push({ pts: teeth, closed: true, style: 'spike_fill' });
        const v: V[] = [];
        for (let i = 0; i + 1 < teeth.length; i += 2) v.push([teeth[i], teeth[i + 1], 2.6]);
        if (houseInk === 'pencil') {
          emitMarker(paths, v, true, b.darkOutline());
          emitPencil(paths, b, v, true, inkHex('red', b.theme), sd, {}, false);
        } else emitMarker(paths, v, true, b.marker('red'));
        const hub: V[] = ellipse(0, 0, r * 0.25, r * 0.25, 12, 2.4);
        emitFill(paths, hub, b.sticker());
        emitMarker(paths, hub, true, b.marker('black'));
      }
      break;
    }
    case 'firebar': {
      const hub: V[] = ellipse(0, 0, 0.3, 0.3, 14, 2.8);
      emitFill(paths, hub, b.blob('black'), { part: 'base' });
      emitMarker(paths, hub, true, b.marker('black'), { part: 'base' });
      break;
    }
    case 'key':
      if (hasKid) emitKid(fitInto(local, [-0.7, -0.5, 0.7, 0.5], 'center'));
      else emitDoodle(paths, b, houseKey(), houseInk, sd);
      break;
    case 'door': {
      if (hasKid) {
        paths.push({ pts: [0, 0, e.w, 0, e.w, e.h, 0, e.h], closed: true, style: 'ground_tint' });
        emitKid(fitInto(local, [0, 0, e.w, e.h], 'topleft', true));
      } else {
        paths.push({ pts: [0, 0, e.w, 0, e.w, e.h, 0, e.h], closed: true, style: 'ground_tint' });
        emitDoodle(paths, b, houseDoor(e.w, e.h), houseInk, sd);
      }
      break;
    }
    case 'moving_platform':
    case 'crumble':
    case 'falling_platform': {
      if (hasKid) {
        // top edge of the drawn platform onto the platform's top (the one-row AABB of §2.4)
        const [bx0, by0] = strokeBox(local);
        emitKid(translate(local, -bx0, -by0));
        if (e.type === 'crumble') emitDoodle(paths, b, { lines: housePlatform('crumble', e.w).lines.slice(1) }, houseInk, sd);
      } else emitDoodle(paths, b, housePlatform(e.type, e.w), houseInk, sd);
      break;
    }
    case 'hint_arrow':
      emitDoodle(paths, b, houseArrow(e.dir), 'pencil', sd);
      break;
    default:
      if (hasKid) emitKid(local);
      else return null;
  }
  if (!paths.length) return null;
  return {
    id: e.id, type: e.type, source: hasKid ? 'kid' : 'house', designer, anchor: [anchor[0], anchor[1]],
    bbox: boxOfPaths(paths), paths, eyes, object_ids: objIds,
  };
}

export { boxOfPaths, cleanAll, fitInto, PX };
