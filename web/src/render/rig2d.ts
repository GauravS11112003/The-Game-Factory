/**
 * The rig on a plain 2D canvas (PLAN_V2 §7.6, §7.11 Character Studio "a live mini-stage where the doodle runs, jumps
 * and lands with its rig as you draw"): the same RigAnimator poses the engine uses, drawn without Phaser, so the
 * Studio, the share cards and the game show one drawing moving the same way.
 * - drawCharacter: one pose of an ArtPlayer at a feet point (legs and arms swing about their pivots, the body skews
 *   with the jelly sway and walk wobble, eyes ride the face and blink).
 * - RigPreview: a self-running mini-stage (idle, run, jump, land, skid and turn, back again) for any strokes.
 */
import type { InkStroke, Theme } from '../core/types.gen.ts';
import type { ArtDoc, ArtPath, ArtPlayer } from '../core/art/types.ts';
import { RigAnimator, shearAt } from '../core/art/anim.ts';
import type { RigPose, RigState } from '../core/art/anim.ts';
import { buildPlayerArt } from '../core/art/player.ts';
import { baseStyles, StyleBook } from '../core/art/styles.ts';
import type { InkFor } from '../core/art/styles.ts';
import { ART, RIG } from '../core/params.ts';
import { drawPaths } from './canvas_ink.ts';
import { paintPaper } from './paper.ts';

const CELL = 16;

interface Groups {
  body: ArtPath[];
  legs: { paths: ArtPath[]; pivot: [number, number]; side: number }[];
  arms: { paths: ArtPath[]; pivot: [number, number]; side: number }[];
  eyes: { paths: ArtPath[]; c: [number, number] }[];
  heightPx: number;
  swing: boolean;
}

function group(art: ArtPlayer): Groups {
  const body: ArtPath[] = [];
  const legMap = new Map<string, { paths: ArtPath[]; pivot: [number, number]; side: number }>();
  const armMap = new Map<string, { paths: ArtPath[]; pivot: [number, number]; side: number }>();
  const eyeMap = new Map<string, { paths: ArtPath[]; c: [number, number] }>();
  let minY = 0;
  for (const p of art.paths) {
    for (let i = 1; i < p.pts.length; i += 2) minY = Math.min(minY, p.pts[i]);
    if ((p.part === 'leg' || p.part === 'arm') && p.pivot) {
      const m = p.part === 'leg' ? legMap : armMap;
      const k = `${p.pivot[0]},${p.pivot[1]}`;
      const g = m.get(k) ?? { paths: [], pivot: p.pivot, side: 0 };
      g.paths.push(p);
      m.set(k, g);
    } else if (p.part === 'eye') {
      let ex = 0;
      let ey = 0;
      const n = p.pts.length / 2;
      for (let i = 0; i < p.pts.length; i += 2) {
        ex += p.pts[i];
        ey += p.pts[i + 1];
      }
      const c: [number, number] = [ex / n, ey / n];
      const k = `${Math.round(c[0] * 64)},${Math.round(c[1] * 64)}`;
      const g = eyeMap.get(k) ?? { paths: [], c };
      g.paths.push(p);
      eyeMap.set(k, g);
    } else body.push(p);
  }
  const legs = [...legMap.values()];
  legs.forEach((l, i) => (l.side = i % 2 ? 1 : -1));
  const arms = [...armMap.values()];
  for (const a of arms) a.side = a.pivot[0] >= 0 ? 1 : -1;
  return { body, legs, arms, eyes: [...eyeMap.values()], heightPx: Math.max(8, -minY * CELL), swing: legs.length + arms.length > 0 };
}

const cache = new WeakMap<ArtPlayer, Groups>();
function groupsOf(art: ArtPlayer): Groups {
  let g = cache.get(art);
  if (!g) {
    g = group(art);
    cache.set(art, g);
  }
  return g;
}

/** True when the drawing has legs or arms the rig can swing (else it is animated as one drawing). */
export function hasSwingParts(art: ArtPlayer): boolean {
  return groupsOf(art).swing;
}

/**
 * Draw one pose of the character with its feet at (x, y) in the context's current units (logical px when the
 * transform maps logical px). `scale` multiplies the whole figure.
 */
export function drawCharacter(ctx: CanvasRenderingContext2D, doc: ArtDoc, art: ArtPlayer, pose: RigPose, x: number, y: number, scale = 1): void {
  const g = groupsOf(art);
  const H = g.heightPx;
  ctx.save();
  ctx.translate(x, y + pose.hop * scale);
  ctx.scale(scale, scale);
  ctx.rotate(pose.rot);
  ctx.scale(pose.flip * pose.sx, pose.sy);
  // legs about their hips
  for (const l of g.legs) {
    const px = l.pivot[0] * CELL;
    const py = l.pivot[1] * CELL;
    ctx.save();
    ctx.translate(px + shearAt(pose, -py, H) * 0.6, py + pose.bob * 0.3);
    ctx.rotate((pose.legBase + pose.legSwing) * l.side);
    drawPaths(ctx, doc, l.paths, { dx: -px, dy: -py });
    ctx.restore();
  }
  // the body, skewed: x' = x + shear·(height / H), the same linear sway the engine's bands approximate
  ctx.save();
  ctx.translate(0, pose.bob);
  ctx.transform(1, 0, -pose.shear / H, 1, 0, 0);
  drawPaths(ctx, doc, g.body);
  ctx.restore();
  for (const a of g.arms) {
    const px = a.pivot[0] * CELL;
    const py = a.pivot[1] * CELL;
    ctx.save();
    ctx.translate(px + shearAt(pose, -py, H), py + pose.bob);
    ctx.rotate((pose.armBase - pose.armSwing) * a.side);
    drawPaths(ctx, doc, a.paths, { dx: -px, dy: -py });
    ctx.restore();
  }
  for (const e of g.eyes) {
    const cx = e.c[0] * CELL;
    const cy = e.c[1] * CELL;
    ctx.save();
    ctx.translate(cx + shearAt(pose, -cy, H) + pose.eye[0], cy + pose.bob + pose.eye[1]);
    if (pose.blink) ctx.scale(1, 0.15);
    drawPaths(ctx, doc, e.paths, { dx: -cx, dy: -cy });
    ctx.restore();
  }
  ctx.restore();
}

/** A still pose (e.g. a share card's mid-jump hero shot): state + velocity, no history. */
export function stillPose(art: ArtPlayer, o: { state?: RigState; vx?: number; vy?: number; facing?: 1 | -1; onGround?: boolean } = {}): RigPose {
  const a = new RigAnimator(7, { parts: hasSwingParts(art), heightPx: groupsOf(art).heightPx });
  a.face(o.facing ?? 1);
  const state = o.state ?? 'idle';
  return a.update({ dt: 16, now: 1000, vx: o.vx ?? 0, vy: o.vy ?? 0, facing: o.facing ?? 1, onGround: o.onGround ?? (state !== 'jump' && state !== 'fall'), state, vmax: 168 });
}

// ---- the Studio's mini-stage ------------------------------------------------------------------------

type Phase = 'idle' | 'run' | 'jump' | 'skid';

/**
 * A self-running mini-stage for a character drawing: paper, a marker ground line and the character idling, running
 * across, jumping a little gap, landing, skidding and turning — driven by the same RigAnimator as the game, with the
 * v2-standard numbers (walk 96 → run 168 px/s, jump 330 px/s, gravity 1100 px/s²).
 */
export class RigPreview {
  private doc: ArtDoc;
  private art: ArtPlayer;
  private anim: RigAnimator;
  private x = 0; // px from the stage's left
  private y = 0; // px above the ground (≤ 0 is up)
  private vx = 0;
  private vy = 0;
  private facing: 1 | -1 = 1;
  private phase: Phase = 'idle';
  private phaseT = 0;
  private jumped = false;
  private t = 0;
  private theme: Theme;
  private ink: InkFor | undefined;

  constructor(strokes: InkStroke[] | null, o: { theme?: Theme; ink?: InkFor; seed?: number } = {}) {
    this.theme = o.theme ?? 'sketchbook';
    this.ink = o.ink;
    const b = new StyleBook(this.theme);
    baseStyles(b);
    this.art = buildPlayerArt(strokes, b, o.seed ?? 1, this.ink ? { ink: this.ink } : {});
    this.doc = this.docFor(b);
    this.anim = new RigAnimator(o.seed ?? 1, { parts: hasSwingParts(this.art), heightPx: groupsOf(this.art).heightPx });
  }

  private docFor(b: StyleBook): ArtDoc {
    return {
      v: 1, level_id: 'rig-preview', theme: this.theme, seed: 1, world: { cell: 16, screens: 1, w: 48, h: 27 }, boilFrame: 0,
      styles: b.styles, layers: [], sprites: [], player: this.art, lava: [],
      stats: { align_max_px: 0, uncovered_tops: 0, traced_runs: 0, strokes_without_object: 0 },
    };
  }

  /** New strokes (the kid drew more): the animation carries on with the new drawing. */
  setStrokes(strokes: InkStroke[] | null): void {
    const b = new StyleBook(this.theme);
    baseStyles(b);
    this.art = buildPlayerArt(strokes, b, 1, this.ink ? { ink: this.ink } : {});
    this.doc = this.docFor(b);
    this.anim = new RigAnimator(1, { parts: hasSwingParts(this.art), heightPx: groupsOf(this.art).heightPx });
    this.anim.face(this.facing);
  }

  private step(dt: number, stageW: number): RigState {
    const s = dt / 1000;
    this.phaseT += dt;
    const left = 40;
    const right = stageW - 40;
    const run = 168;
    switch (this.phase) {
      case 'idle':
        this.vx *= Math.max(0, 1 - 12 * s);
        if (this.phaseT > 1400) {
          this.phase = 'run';
          this.phaseT = 0;
          this.jumped = false;
        }
        break;
      case 'run': {
        const target = this.facing * run;
        const acc = Math.abs(this.vx) < 96 ? 1000 : 300;
        this.vx += Math.sign(target - this.vx) * Math.min(Math.abs(target - this.vx), acc * s);
        const mid = (left + right) / 2;
        if (!this.jumped && ((this.facing > 0 && this.x > mid - 30) || (this.facing < 0 && this.x < mid + 30))) {
          this.jumped = true;
          this.phase = 'jump';
          this.vy = -(330 + 0.25 * Math.abs(this.vx));
          this.anim.jump();
        }
        if ((this.facing > 0 && this.x > right - 30) || (this.facing < 0 && this.x < left + 30)) {
          this.phase = 'skid';
          this.phaseT = 0;
        }
        break;
      }
      case 'jump':
        this.vy += (this.vy < 0 ? 1100 : 1700) * s;
        if (this.y >= 0 && this.vy > 0) {
          this.anim.land(Math.abs(this.vy) / RIG.land_ref_vy);
          this.y = 0;
          this.vy = 0;
          this.phase = 'run';
        }
        break;
      case 'skid':
        this.vx -= Math.sign(this.vx) * Math.min(Math.abs(this.vx), 2400 * s);
        if (Math.abs(this.vx) < 4) {
          this.vx = 0;
          this.facing = this.facing > 0 ? -1 : 1;
          this.phase = 'idle';
          this.phaseT = 600; // a shorter rest after turning
        }
        break;
    }
    this.x += this.vx * s;
    this.y += this.vy * s;
    this.x = Math.max(left - 10, Math.min(right + 10, this.x));
    const onGround = this.phase !== 'jump';
    if (this.phase === 'skid') return 'skid';
    if (!onGround) return this.vy < 0 ? 'jump' : 'fall';
    return Math.abs(this.vx) > 6 ? 'run' : 'idle';
  }

  /** Advance dt ms and draw the stage into the canvas (any size). */
  draw(c: HTMLCanvasElement, dt: number): void {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // the stage is 240 × 120 logical px, scaled to fit
    const LW = 240;
    const LH = 120;
    const k = Math.min(c.width / LW, c.height / LH);
    if (this.x === 0) this.x = 60;
    const d = Math.min(50, Math.max(0, dt));
    this.t += d;
    const state = this.step(d, LW);
    const pose = this.anim.update({ dt: d, now: this.t, vx: this.vx, vy: this.vy, facing: this.facing, onGround: this.phase !== 'jump', state, vmax: 168 });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, (c.width - LW * k) / 2, (c.height - LH * k) / 2);
    paintPaper(ctx, this.theme, 0, 0, LW, LH, k);
    // the ground: a marker line with the little gap the character hops over
    const gy = LH - 22;
    ctx.strokeStyle = ART.palette.ink;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(10, gy + 2);
    ctx.lineTo(LW / 2 - 14, gy + 2);
    ctx.moveTo(LW / 2 + 14, gy + 2);
    ctx.lineTo(LW - 10, gy + 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(59,54,50,0.18)';
    ctx.fillRect(10, gy + 4, LW / 2 - 24, 14);
    ctx.fillRect(LW / 2 + 14, gy + 4, LW / 2 - 24, 14);
    drawCharacter(ctx, this.doc, this.art, pose, this.x, gy + this.y, 1);
  }
}
