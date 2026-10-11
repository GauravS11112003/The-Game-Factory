/**
 * PlayerView (PLAN_V2 §7.6): the character's own drawing, alive. Driven only by sim state, so ghosts animate
 * identically. The pose math is the core's pure RigAnimator (core/art/anim.ts: run, skid, jump squash, apex, land
 * stretch, idle breathing and bob, seeded blinks, pupils, the 60 ms turn, the win hop); this view applies it:
 * - legs and arms the rig found swing about their hips and shoulders;
 * - the body is cut into horizontal bands that shear with the jelly sway and the walk wobble, so even one stiff
 *   drawing bends like ink on paper (eyes and arms ride the band at their height);
 * - a one-drawing character (a raster sprite, or a drawing with nothing to swing) waddles as a whole instead;
 * - v4 flipped gravity: the character hangs upside down from its feet, turning over through flat in 220 ms.
 * Death: the sprite is cut into 12-16 precomputed Voronoi shards that fly with gravity and spin; respawn plays it in
 * reverse.
 */
import Phaser from 'phaser';
import type { ArtDoc, ArtPath, ArtPlayer } from '../../core/art/types.ts';
import { RigAnimator, shearAt } from '../../core/art/anim.ts';
import { voronoiCells, rng, hash32 } from '../../core/art/geom.ts';
import type { RectCells } from '../../core/types.gen.ts';
import { COLLISION, DAMAGE, RIG } from '../../core/params.ts';
import { bakePaths } from '../../render/canvas_ink.ts';
import { bake, boxOf, CELL, imageOf } from '../gfx.ts';
import type { Baked, TexBank } from '../gfx.ts';

const PX = 4; // sprites are rendered from vectors at 4× and displayed with LINEAR filtering
const BANDS = 8; // body bands for the shear

export interface PlayerPose {
  x: number; // cells, feet centre
  y: number;
  vx: number; // px/s
  vy: number;
  facing: 1 | -1;
  onGround: boolean;
  state: 'idle' | 'run' | 'skid' | 'jump' | 'fall' | 'dead' | 'respawn' | 'win';
  invuln: number;
  /** v4 gravity sign: at −1 the character hangs upside down from its feet (it walks along ceilings). */
  gravity?: 1 | -1;
}

const FLIP_MS = 220; // the turn-over when gravity flips (the drawing squashes through flat, like a card)
/**
 * The sim's body box height (px). PlayerView.y is the bottom of that box in both gravities, so upside down the
 * feet touch the ceiling at y − BODY_PX: the drawing hangs from there (and turns over about the box's middle).
 */
export const BODY_PX = COLLISION.body_px[1];

/** What the character is drawn from: the ArtDoc vectors (tagged by rig part), or one raster drawing. */
export type CharacterSource =
  | { kind: 'vector'; doc: ArtDoc; art: ArtPlayer }
  | {
      kind: 'raster';
      canvas: HTMLCanvasElement;
      /** The feet centre inside the canvas (canvas px). */
      feet: [number, number];
      /** Canvas px per logical px (the drawing is shown at 1/px). */
      px: number;
    };

interface Part {
  img: Phaser.GameObjects.Image;
  kind: 'leg' | 'arm' | 'eye';
  side: number; // -1 / 1 alternating phase
  base: [number, number]; // px, local
  upPx: number; // height of the pivot above the feet (px)
}

interface Band {
  img: Phaser.GameObjects.Image;
  upPx: number; // the band's mid height above the feet (px)
}

export class PlayerSprite {
  readonly root: Phaser.GameObjects.Container;
  readonly shards: Shards;
  private parts: Part[] = [];
  private bands: Band[] = [];
  private anim: RigAnimator;
  private hidden = false;
  private hasEyes = false;
  private heightPx = 30;
  private baseAlpha: number;
  private reduced: boolean;
  // the shown gravity sign eases from gFrom to gTo over FLIP_MS (gT 0..1)
  private gFrom = 1;
  private gTo: 1 | -1 = 1;
  private gT = 1;

  constructor(scene: Phaser.Scene, bank: TexBank, src: CharacterSource, o: { name: string; alpha?: number; tint?: number; seed?: number; reduced?: boolean }) {
    this.root = scene.add.container(0, 0);
    this.baseAlpha = o.alpha ?? 1;
    this.reduced = !!o.reduced;
    let swingable = false;
    if (src.kind === 'vector') {
      const { doc, art } = src;
      const box = boxOf(art.paths);
      this.heightPx = Math.max(8, -box[1] * CELL);
      const groups = new Map<string, { kind: 'body' | 'leg' | 'arm' | 'eye'; paths: ArtPath[]; pivot: [number, number] }>();
      for (const p of art.paths) {
        const kind = p.part === 'leg' ? 'leg' : p.part === 'arm' ? 'arm' : p.part === 'eye' ? 'eye' : 'body';
        let key: string = kind;
        let pivot: [number, number] = [0, 0];
        if ((kind === 'leg' || kind === 'arm') && p.pivot) {
          key = `${kind}:${p.pivot[0]},${p.pivot[1]}`;
          pivot = p.pivot;
        } else if (kind === 'eye') {
          let ex = 0;
          let ey = 0;
          const n = p.pts.length / 2;
          for (let i = 0; i < p.pts.length; i += 2) {
            ex += p.pts[i];
            ey += p.pts[i + 1];
          }
          pivot = [ex / n, ey / n];
          key = `eye:${Math.round(pivot[0] * 64)},${Math.round(pivot[1] * 64)}`;
        }
        const g = groups.get(key) ?? { kind, paths: [], pivot };
        g.paths.push(p);
        groups.set(key, g);
      }
      let legI = 0;
      for (const kind of ['leg', 'body', 'arm', 'eye'] as const) {
        for (const [key, g] of groups) {
          if (g.kind !== kind) continue;
          if (kind === 'body') {
            this.addBands(scene, bake(bank, doc, `pl_${o.name}_body`, g.paths, PX), o.tint);
            continue;
          }
          const b = bake(bank, doc, `pl_${o.name}_${key}`, g.paths, PX, g.pivot);
          const img = imageOf(scene, b, g.pivot[0] * CELL, g.pivot[1] * CELL);
          if (o.tint !== undefined) img.setTint(o.tint);
          this.root.add(img);
          // legs alternate (rig legs are sorted left to right); arms take the side they hang on
          const side = kind === 'leg' ? (legI++ % 2 ? 1 : -1) : kind === 'arm' ? (g.pivot[0] >= 0 ? 1 : -1) : 0;
          this.parts.push({ img, kind, side, base: [g.pivot[0] * CELL, g.pivot[1] * CELL], upPx: -g.pivot[1] * CELL });
          if (kind === 'leg' || kind === 'arm') swingable = true;
          if (kind === 'eye') this.hasEyes = true;
        }
      }
      this.shards = new Shards(scene, bank, shardSourceVector(doc, art), o.name, this.baseAlpha, o.tint);
    } else {
      const key = bank.add(`pl_${o.name}_raster`, src.canvas);
      const w = src.canvas.width / src.px;
      const h = src.canvas.height / src.px;
      const baked: Baked = { key, px: src.px, w, h, ox: src.feet[0] / src.canvas.width, oy: src.feet[1] / src.canvas.height };
      this.heightPx = Math.max(8, src.feet[1] / src.px);
      this.addBands(scene, baked, o.tint);
      this.shards = new Shards(scene, bank, shardSourceRaster(src), o.name, this.baseAlpha, o.tint);
    }
    this.anim = new RigAnimator(hash32(`${o.name}:${o.seed ?? 1}`), { parts: swingable, heightPx: this.heightPx });
    this.root.setAlpha(this.baseAlpha);
  }

  /** The body as horizontal bands of one texture (crop), so the shear can bend it without re-rasterizing. */
  private addBands(scene: Phaser.Scene, b: Baked, tint?: number): void {
    const tex = scene.textures.get(b.key);
    const fw = tex.source[0]?.width ?? Math.ceil(b.w * b.px);
    const fh = tex.source[0]?.height ?? Math.ceil(b.h * b.px);
    const n = fh < BANDS * 6 ? 1 : BANDS;
    for (let i = 0; i < n; i++) {
      const y0 = Math.floor((i * fh) / n);
      const y1 = i === n - 1 ? fh : Math.floor(((i + 1) * fh) / n) + 1; // 1 px overlap hides seams
      const img = imageOf(scene, b);
      if (n > 1) img.setCrop(0, y0, fw, y1 - y0);
      if (tint !== undefined) img.setTint(tint);
      this.root.add(img);
      // band mid height above the feet, logical px (texture rows are measured from the top; the origin is the feet)
      const midLogical = ((y0 + y1) / 2) / b.px - b.oy * b.h;
      this.bands.push({ img, upPx: -midLogical });
    }
  }

  jump(): void {
    this.anim.jump();
  }

  land(impact: number): void {
    this.anim.land(impact);
  }

  /** Snap without the turn animation and forget motion (spawn, respawn, rewind); gravity is the right way up again. */
  reset(facing: 1 | -1): void {
    this.anim.reset();
    this.anim.face(facing);
    this.gFrom = 1;
    this.gTo = 1;
    this.gT = 1;
  }

  /** The gravity sign as shown now (−1 … 1, through 0 mid-flip). */
  private gravityShown(target: 1 | -1, dt: number): number {
    if (target !== this.gTo) {
      this.gFrom = this.gravityNow();
      this.gTo = target;
      this.gT = this.reduced ? 1 : 0;
    }
    if (this.gT < 1) this.gT = Math.min(1, this.gT + dt / FLIP_MS);
    return this.gravityNow();
  }

  private gravityNow(): number {
    const k = this.gT;
    const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
    return this.gFrom + (this.gTo - this.gFrom) * e;
  }

  /** True while the character is (or is turning) upside down. */
  get upsideDown(): boolean {
    return this.gTo === -1;
  }

  hide(): void {
    this.hidden = true;
    this.root.setVisible(false);
  }

  show(): void {
    this.hidden = false;
    this.root.setVisible(true);
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  get height(): number {
    return this.heightPx;
  }

  setAlpha(a: number): void {
    this.baseAlpha = a;
    this.root.setAlpha(a);
  }

  /** Pose from (interpolated) sim state; dt in ms of scaled real time (0 freezes), now in ms; look in world px. */
  pose(p: PlayerPose, dt: number, now: number, look: [number, number] | null, vmax: number): void {
    // upside down (v4 gravity −1): the whole rig mirrors about the feet line, so the drawing hangs from its feet;
    // a flip turns it over through flat. The animator works in "the player's own up", so vy flips with it.
    const g = this.gravityShown(p.gravity === -1 ? -1 : 1, dt);
    const gs = g < 0 ? -1 : 1;
    const feetY = p.y * CELL - ((1 - g) / 2) * BODY_PX;
    const headX = p.x * CELL;
    const headY = feetY - this.heightPx * 0.7 * gs;
    const pose = this.anim.update({
      dt, now, vx: p.vx, vy: p.vy * gs, facing: p.facing, onGround: p.onGround, state: p.state, vmax,
      look: look ? [look[0] - headX, (look[1] - headY) * gs] : null,
    });
    this.root.setPosition(p.x * CELL, feetY + pose.hop * gs);
    this.root.setScale(pose.flip * pose.sx, pose.sy * (Math.abs(g) < 0.08 ? 0.08 * gs : g));
    this.root.setRotation(pose.rot * gs);
    const H = this.heightPx;
    for (const b of this.bands) b.img.setPosition(shearAt(pose, b.upPx, H), pose.bob);
    for (const part of this.parts) {
      const dx = shearAt(pose, part.upPx, H);
      switch (part.kind) {
        case 'leg':
          part.img.setRotation((pose.legBase + pose.legSwing) * part.side);
          part.img.setPosition(part.base[0] + dx * 0.6, part.base[1] + pose.bob * 0.3);
          break;
        case 'arm':
          // raised = rotated outward-up; swings against the legs
          part.img.setRotation((pose.armBase - pose.armSwing) * part.side);
          part.img.setPosition(part.base[0] + dx, part.base[1] + pose.bob);
          break;
        case 'eye':
          part.img.setPosition(part.base[0] + dx + pose.eye[0], part.base[1] + pose.bob + pose.eye[1]);
          part.img.setScale(1 / PX, ((this.hasEyes && pose.blink ? 0.15 : 1)) / PX);
          break;
      }
    }
    // invulnerable blink
    if (!this.hidden) this.root.setVisible(p.invuln <= 0 || Math.floor(now / 70) % 2 === 0);
  }

  destroy(): void {
    this.shards.destroy();
    this.root.destroy();
  }
}

// ---- shards ---------------------------------------------------------------------------------------

/** A full-sprite canvas plus its box (local cells, feet at 0,0): what the shards are cut from. */
export interface ShardSource {
  canvas: HTMLCanvasElement;
  box: RectCells;
  px: number; // canvas px per logical px
  pad: number; // logical px of padding around the box inside the canvas
}

function shardSourceVector(doc: ArtDoc, art: ArtPlayer): ShardSource {
  const box = boxOf(art.paths);
  const px = 2;
  const pad = 2;
  return { canvas: bakePaths(doc, art.paths, box, px, pad).canvas, box, px, pad };
}

function shardSourceRaster(src: { canvas: HTMLCanvasElement; feet: [number, number]; px: number }): ShardSource {
  const c = src.canvas;
  const box: RectCells = [-src.feet[0] / src.px / CELL, -src.feet[1] / src.px / CELL, (c.width - src.feet[0]) / src.px / CELL, (c.height - src.feet[1]) / src.px / CELL];
  // re-draw at 2 canvas px per logical px with the 2 px pad the shard cutter expects
  const px = 2;
  const pad = 2;
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.ceil(((box[2] - box[0]) * CELL + pad * 2) * px));
  out.height = Math.max(2, Math.ceil(((box[3] - box[1]) * CELL + pad * 2) * px));
  const ctx = out.getContext('2d');
  if (ctx) ctx.drawImage(c, pad * px, pad * px, (c.width / src.px) * px, (c.height / src.px) * px);
  return { canvas: out, box, px, pad };
}

interface Shard {
  img: Phaser.GameObjects.Image;
  rest: [number, number]; // px, local (feet frame)
  pos: [number, number]; // px, world
  vel: [number, number];
  spin: number;
  rot: number;
  scatter: [number, number]; // final offset from the death point (for the reverse)
}

/** The character's ink cut into 12-16 precomputed Voronoi shards. */
export class Shards {
  private scene: Phaser.Scene;
  private items: { key: string; ox: number; oy: number; rest: [number, number] }[] = [];
  private live: Shard[] = [];
  private mode: 'idle' | 'burst' | 'gather' = 'idle';
  private t = 0;
  private from: [number, number] = [0, 0];
  private to: [number, number] = [0, 0];
  private alpha: number;
  private tint: number | undefined;
  private r: () => number;
  private scale: number;
  container: Phaser.GameObjects.Container;

  constructor(scene: Phaser.Scene, bank: TexBank, src: ShardSource, name: string, alpha: number, tint?: number) {
    this.scene = scene;
    this.alpha = alpha;
    this.tint = tint;
    this.container = scene.add.container(0, 0);
    this.r = rng(hash32(`shards:${name}`));
    const { box, px, pad } = src;
    this.scale = 1 / px;
    const full = src.canvas;
    const [mn, mx] = RIG.shards;
    const n = mn + Math.floor(this.r() * (mx - mn + 1));
    const seeds: [number, number][] = [];
    for (let i = 0; i < n; i++) seeds.push([box[0] + this.r() * (box[2] - box[0]), box[1] + this.r() * (box[3] - box[1])]);
    const cells = voronoiCells(seeds, box);
    cells.forEach((poly, i) => {
      if (poly.length < 6) return;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let cx = 0;
      let cy = 0;
      for (let k = 0; k < poly.length; k += 2) {
        x0 = Math.min(x0, poly[k]);
        y0 = Math.min(y0, poly[k + 1]);
        x1 = Math.max(x1, poly[k]);
        y1 = Math.max(y1, poly[k + 1]);
        cx += poly[k];
        cy += poly[k + 1];
      }
      cx /= poly.length / 2;
      cy /= poly.length / 2;
      const c = document.createElement('canvas');
      const toPx = (v: number, o: number): number => ((v - o) * CELL) * px;
      c.width = Math.max(2, Math.ceil(toPx(x1, x0)) + 2);
      c.height = Math.max(2, Math.ceil(toPx(y1, y0)) + 2);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.beginPath();
      for (let k = 0; k < poly.length; k += 2) {
        const X = toPx(poly[k], x0) + 1;
        const Y = toPx(poly[k + 1], y0) + 1;
        if (k === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      }
      ctx.closePath();
      ctx.clip();
      // the full canvas has local box[0], box[1] at (pad·px, pad·px)
      ctx.drawImage(full, -((x0 - box[0]) * CELL + pad) * px + 1, -((y0 - box[1]) * CELL + pad) * px + 1);
      const key = bank.add(`shard_${name}_${i}`, c);
      this.items.push({ key, ox: ((cx - x0) * CELL * px + 1) / c.width, oy: ((cy - y0) * CELL * px + 1) / c.height, rest: [cx * CELL, cy * CELL] });
    });
  }

  get active(): boolean {
    return this.mode !== 'idle';
  }

  get bursting(): boolean {
    return this.mode === 'burst';
  }

  /** ms since the current burst / gather started. */
  get elapsed(): number {
    return this.t;
  }

  /** Shatter at the feet point (px). */
  burst(x: number, y: number, facing: number): void {
    this.clear();
    this.mode = 'burst';
    this.t = 0;
    this.from = [x, y];
    for (const it of this.items) {
      const img = this.scene.add.image(x + it.rest[0] * facing, y + it.rest[1], it.key).setOrigin(it.ox, it.oy).setScale(facing * this.scale, this.scale).setAlpha(this.alpha);
      if (this.tint !== undefined) img.setTint(this.tint);
      this.container.add(img);
      const dx = it.rest[0] * facing;
      const dy = it.rest[1] + 14;
      const L = Math.hypot(dx, dy) || 1;
      const sp = 60 + this.r() * 110;
      this.live.push({
        img, rest: [it.rest[0] * facing, it.rest[1]], pos: [x + it.rest[0] * facing, y + it.rest[1]],
        vel: [(dx / L) * sp + (this.r() - 0.5) * 40, (dy / L) * sp * 0.6 - 140 - this.r() * 120],
        spin: (this.r() - 0.5) * 14, rot: 0, scatter: [0, 0],
      });
    }
  }

  /** Reassemble at the respawn feet point (px): the burst played in reverse. */
  gather(x: number, y: number): void {
    if (!this.live.length) return;
    this.mode = 'gather';
    this.t = 0;
    this.to = [x, y];
    for (const s of this.live) {
      s.scatter = [s.pos[0] - this.from[0], s.pos[1] - this.from[1]];
      s.img.setAlpha(this.alpha);
    }
  }

  /** dt ms; returns true while animating. */
  update(dt: number): boolean {
    if (this.mode === 'idle') return false;
    this.t += dt;
    const s = dt / 1000;
    if (this.mode === 'burst') {
      const fadeStart = DAMAGE.death.shatter_ms;
      for (const sh of this.live) {
        sh.vel[1] += 900 * s;
        sh.pos[0] += sh.vel[0] * s;
        sh.pos[1] += sh.vel[1] * s;
        sh.rot += sh.spin * s;
        sh.img.setPosition(sh.pos[0], sh.pos[1]).setRotation(sh.rot);
        if (this.t > fadeStart) sh.img.setAlpha(this.alpha * Math.max(0.25, 1 - (this.t - fadeStart) / 400));
      }
      if (this.t > 1600) this.clear();
      return true;
    }
    const k = Math.min(1, this.t / DAMAGE.death.reassemble_ms);
    const e = 1 - (1 - k) * (1 - k) * (1 - k);
    for (const sh of this.live) {
      const sx = this.to[0] + sh.scatter[0] * (1 - e) + sh.rest[0] * e;
      const sy = this.to[1] + sh.scatter[1] * (1 - e) + sh.rest[1] * e;
      sh.img.setPosition(sx, sy).setRotation(sh.rot * (1 - e)).setAlpha(this.alpha * (0.4 + 0.6 * e));
    }
    if (k >= 1) {
      this.clear();
      return false;
    }
    return true;
  }

  clear(): void {
    for (const s of this.live) s.img.destroy();
    this.live = [];
    this.mode = 'idle';
  }

  destroy(): void {
    this.clear();
    this.container.destroy();
  }
}
