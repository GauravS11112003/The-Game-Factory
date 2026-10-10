/**
 * The player's art from one drawing (PLAN_V2 §7.6): the kid's character strokes (or the house doodle) normalized so
 * the feet centre is (0, 0) and the body fits the 32 × 48 world-px sprite box, tagged by rig part with pivots, so the
 * engine can swing legs and arms. Synthesized stick legs use the kid's main ink colour.
 */
import type { InkColor, InkStroke, Rig } from '../types.gen.ts';
import type { ArtPath, ArtPlayer } from './types.ts';
import { cleanStroke, strokeBox, transformStrokes } from './clean.ts';
import type { CleanStroke } from './clean.ts';
import { CELL, clamp, hash32 } from './geom.ts';
import type { V } from './geom.ts';
import { extractRig } from './rig.ts';
import { boxOfPaths, emitStroke } from './sprites.ts';
import { inkForOrigin, inkHex, StyleBook } from './styles.ts';
import type { InkFor } from './styles.ts';

const TARGET_H = 30 / CELL; // body height ≈ the 28 px collision box + 2 px
const MAX_W = 32 / CELL;

/** The house character: a round ink blob with eyes, stick arms and legs (only when the kid drew none). */
export function houseCharacter(): InkStroke[] {
  const body: [number, number][] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const k = 1 + 0.04 * Math.sin(a * 3 + 0.7);
    body.push([Math.cos(a) * 0.5 * k, -1.32 + Math.sin(a) * 0.55 * k]);
  }
  const s = (id: string, kind: InkStroke['kind'], pts: [number, number][], w: number, closed: boolean, color: InkColor = 'black'): InkStroke => ({
    id, color, kind, pts, w: pts.map(() => w), closed, sheet: 0, origin: 'kid',
  });
  return [
    s('h_body', 'line', body, 0.17, true),
    s('h_eye_l', 'dot', [[-0.16, -1.46]], 0.15, true),
    s('h_eye_r', 'dot', [[0.16, -1.46]], 0.15, true),
    s('h_mouth', 'line', [[-0.12, -1.16], [0, -1.1], [0.12, -1.16]], 0.09, false),
    s('h_arm_l', 'line', [[-0.48, -1.22], [-0.78, -0.98]], 0.15, false),
    s('h_arm_r', 'line', [[0.48, -1.22], [0.78, -0.98]], 0.15, false),
    s('h_leg_l', 'line', [[-0.18, -0.8], [-0.24, 0]], 0.17, false),
    s('h_leg_r', 'line', [[0.18, -0.8], [0.24, 0]], 0.17, false),
  ];
}

function mainColor(strokes: InkStroke[]): InkColor {
  const n = new Map<InkColor, number>();
  for (const s of strokes) n.set(s.color, (n.get(s.color) ?? 0) + s.pts.length);
  let best: InkColor = 'black';
  let bn = -1;
  for (const [c, k] of n)
    if (k > bn) {
      bn = k;
      best = c;
    }
  return best;
}

function endNearest(c: CleanStroke, x: number, y: number): [number, number] {
  const a = c.v[0];
  const b = c.v[c.v.length - 1];
  return Math.hypot(a[0] - x, a[1] - y) <= Math.hypot(b[0] - x, b[1] - y) ? [a[0], a[1]] : [b[0], b[1]];
}

export interface PlayerArtOptions {
  /** Force an ink: 'pencil' draws a pencil copy (ghosts: §8.4 "a 45%-alpha pencil copy of the runner's character"). */
  ink?: InkFor;
}

export function buildPlayerArt(strokes: InkStroke[] | null | undefined, b: StyleBook, seed: number, o: PlayerArtOptions = {}): ArtPlayer {
  const kid = (strokes ?? []).filter((s) => s.pts.length > 0);
  const source: 'kid' | 'house' = kid.length ? 'kid' : 'house';
  const src = kid.length ? kid : houseCharacter();
  const rig: Rig = extractRig(src);
  const legIds = new Set(rig.legs ?? []);
  const armIds = new Set(rig.arms ?? []);
  const eyeIds = new Set(rig.eyes ?? []);
  const color = mainColor(src);
  let cs = src.map((s) => cleanStroke(s, { minDotPx: 2.5, widthPx: [1.5, 9] })).filter((c) => c.v.length > 0);

  // normalize: feet centre at (0, 0), height ≈ 30 px, width ≤ 32 px; with synthesized legs the body takes 75%
  const [x0, y0, x1, y1] = strokeBox(cs);
  const bw = Math.max(1e-3, x1 - x0);
  const bh = Math.max(1e-3, y1 - y0);
  const synth = !!rig.synth_legs;
  const bodyH = synth ? TARGET_H * 0.74 : TARGET_H;
  const s = Math.min(bodyH / bh, MAX_W / bw);
  const legTop = synth ? -TARGET_H * 0.26 : 0;
  cs = transformStrokes(cs, (x0 + x1) / 2, y1, s, 0, legTop);
  // widths of a tiny sprite read as marker: 1.6-5 px
  cs = cs.map((c) => ({ ...c, v: c.v.map((p) => [p[0], p[1], c.dot ? clamp(p[2], 2.5, 6) : clamp(p[2], 1.6, 5)] as V) }));

  const [, by0, , by1] = strokeBox(cs);
  const cx = 0;
  const cy = (by0 + by1) / 2;
  const paths: ArtPath[] = [];
  const eyes: [number, number][] = [];
  const ink = o.ink ?? inkForOrigin(src[0]?.origin ?? 'kid');
  const sd = (seed ^ hash32('player')) >>> 0;
  cs.forEach((c, i) => {
    let part: ArtPath['part'] = 'body';
    let pivot: [number, number] | undefined;
    if (legIds.has(c.id)) {
      part = 'leg';
      const top = c.v.reduce((m, p) => (p[1] < m[1] ? p : m), c.v[0]);
      pivot = [top[0], top[1]];
    } else if (armIds.has(c.id)) {
      part = 'arm';
      pivot = endNearest(c, cx, cy);
    } else if (eyeIds.has(c.id)) {
      part = 'eye';
      let ex = 0;
      let ey = 0;
      for (const p of c.v) {
        ex += p[0];
        ey += p[1];
      }
      eyes.push([ex / c.v.length, ey / c.v.length]);
    }
    emitStroke(paths, b, c, ink, 'sprite', sd + i, { part, ...(pivot ? { pivot } : {}) });
  });
  if (synth) {
    // two stick legs from the body's bottom to the feet line, in the kid's main ink colour
    const hipY = legTop - 0.04;
    for (const sx of [-1, 1]) {
      const hx = sx * Math.min(0.24, (bw * s) / 4);
      const v: V[] = [[hx, hipY, 3], [hx + sx * 0.05, -0.02, 3]];
      const legStyle = ink === 'pencil' ? b.pencil(inkHex(color === 'black' ? 'pencil' : color, b.theme)) : b.marker(color);
      paths.push({ pts: v.flatMap((p) => [Math.round(p[0] * 64) / 64, Math.round(p[1] * 64) / 64]), w: ink === 'pencil' ? [2, 2] : [3, 3], closed: false, style: legStyle, part: 'leg', pivot: [hx, hipY] });
    }
  }
  return { source, rig, paths, bbox: boxOfPaths(paths), eyes, color: inkHex(color, b.theme) };
}
