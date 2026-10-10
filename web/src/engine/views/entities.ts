/**
 * Entity views (PLAN_V2 §7.6, §7.1): the kid's own sprites, alive. Enemies waddle (±6° at 3 Hz, 1 px bob), watch
 * the player with their eyes and flash an angry outline within 4 cells; a stomp flattens them to 25% and they puff
 * away over 300 ms. Flags wave; checkpoints unfurl; saws spin; spikes shimmer 1 px; moving platforms trail speed ticks
 * above 2 c/s; crumbles shake. Designer pencil additions sketch themselves in (400 ms reveal) on first sight.
 * Every view is built behind a guard: a broken entity is switched off and reported (`entity_error`), never fatal.
 */
import Phaser from 'phaser';
import type { ArtDoc, ArtPath, ArtSprite } from '../../core/art/types.ts';
import type { EntityView, SimEvent } from '../../core/sim/types.ts';
import type { Entity, LevelV2 } from '../../core/types.gen.ts';
import { ART, HAZARDS, RIG } from '../../core/params.ts';
import { drawPaths } from '../../render/canvas_ink.ts';
import { bake, boxOf, CELL, imageOf, VIEW_W_PX } from '../gfx.ts';
import type { Baked, TexBank } from '../gfx.ts';

const BAKE_PX = 2;
const COLOR_RED = 0xe0453a;
const DEG = Math.PI / 180;

export interface EntityHost {
  scene: Phaser.Scene;
  bank: TexBank;
  doc: ArtDoc;
  layer: Phaser.GameObjects.Layer;
  reduced: boolean;
  onError(e: Entity, err: unknown): void;
}

export interface FrameCtx {
  now: number; // ms
  dt: number; // ms (scaled)
  frame: number; // sim frame
  alpha: number; // interpolation
  player: [number, number]; // px (feet)
  camX: number; // px
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wave(paths: readonly ArtPath[], poleX: number, t: number, amp: number): ArtPath[] {
  return paths.map((p) => {
    const pts = p.pts.slice();
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const d = Math.max(0, pts[i] - poleX);
      const k = Math.min(1, d / 1.2);
      pts[i + 1] += Math.sin(t * Math.PI * 2 * 1.3 - d * 2.4) * amp * k;
      pts[i] -= (1 - Math.cos(t * Math.PI * 2 * 1.3 - d * 2.4)) * amp * 0.25 * k;
    }
    return { ...p, pts };
  });
}

class EView {
  readonly e: Entity;
  readonly sprite: ArtSprite;
  readonly root: Phaser.GameObjects.Container;
  private host: EntityHost;
  private main: Phaser.GameObjects.Image | null = null;
  private mainBaked: Baked | null = null;
  private eyes: { img: Phaser.GameObjects.Image; base: [number, number] }[] = [];
  private cloth: { tex: Phaser.Textures.CanvasTexture; img: Phaser.GameObjects.Image; paths: ArtPath[]; box: [number, number, number, number]; poleX: number } | null = null;
  private balls: Phaser.GameObjects.Image[] = [];
  private ticks: Phaser.GameObjects.Graphics | null = null;
  private glow: Phaser.FX.Glow | null = null;
  private alertG: Phaser.GameObjects.Graphics | null = null;
  private morph = { dx: 0, dy: 0, t: -1, dur: 300 };
  private revealT = -1;
  private active = true;
  private deadT = -1;
  private openT = -1;
  private squashT = -1;
  private shakeUntil = 0;
  private lastWave = -1;
  private unfurl = 1;
  private readonly phase0: number;
  private lastX = NaN;
  private cheerT = -1; // the win moment: the goal flag flaps hard and bounces

  constructor(host: EntityHost, e: Entity, sprite: ArtSprite) {
    this.host = host;
    this.e = e;
    this.sprite = sprite;
    const s = host.scene;
    this.root = s.add.container(sprite.anchor[0] * CELL, sprite.anchor[1] * CELL);
    host.layer.add(this.root);
    this.phase0 = (sprite.anchor[0] * 0.37) % 1;
    const name = `e_${e.id}`;
    const isFlag = e.type === 'goal' || e.type === 'checkpoint';
    const clothPaths = isFlag ? sprite.paths.filter((p) => p.part === 'cloth') : [];
    const eyePaths = e.type === 'enemy' ? sprite.paths.filter((p) => p.part === 'eye') : [];
    const fireballs = e.type === 'firebar';
    const mainPaths = sprite.paths.filter((p) => !clothPaths.includes(p) && !eyePaths.includes(p));
    if (mainPaths.length) {
      this.mainBaked = bake(host.bank, host.doc, name, mainPaths, BAKE_PX);
      this.main = imageOf(s, this.mainBaked);
      this.root.add(this.main);
    }
    for (const p of eyePaths) {
      const b = boxOf([p]);
      const c: [number, number] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      const img = imageOf(s, bake(host.bank, host.doc, `${name}_eye`, [p], BAKE_PX * 2, c), c[0] * CELL, c[1] * CELL);
      this.root.add(img);
      this.eyes.push({ img, base: [c[0] * CELL, c[1] * CELL] });
    }
    if (clothPaths.length) {
      const poleX = 0;
      const b = boxOf(clothPaths);
      const box: [number, number, number, number] = [b[0] - 0.2, b[1] - 0.25, b[2] + 0.2, b[3] + 0.25];
      const w = (box[2] - box[0]) * CELL * BAKE_PX;
      const h = (box[3] - box[1]) * CELL * BAKE_PX;
      const tex = host.bank.canvas(`${name}_cloth`, w, h);
      if (tex) {
        const img = s.add.image(box[0] * CELL, box[1] * CELL, tex).setOrigin(0, 0).setScale(1 / BAKE_PX);
        this.root.add(img);
        this.cloth = { tex, img, paths: clothPaths, box, poleX };
        this.drawCloth(0);
      }
    }
    if (fireballs && e.type === 'firebar') {
      // a filled ink fireball (fire_core: fill + red outline)
      const ring: number[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ring.push((Math.cos(a) * HAZARDS.firebar.ball_r_px) / CELL, (Math.sin(a) * HAZARDS.firebar.ball_r_px) / CELL);
      }
      const bk = bake(host.bank, host.doc, `${name}_ball`, [{ pts: ring, closed: true, style: 'fire_core' }], BAKE_PX * 2, [0, 0]);
      for (let i = 0; i < e.balls; i++) {
        const img = imageOf(s, bk);
        this.root.add(img);
        this.balls.push(img);
      }
    }
    if (e.type === 'moving_platform') {
      this.ticks = s.add.graphics();
      this.root.add(this.ticks);
    }
    if (e.type === 'enemy' && this.main && this.main.preFX) {
      try {
        this.main.preFX.setPadding(6);
        this.glow = this.main.preFX.addGlow(0xe0453a, 3, 0, false);
        this.glow.active = false;
      } catch {
        this.glow = null;
      }
    }
    if (e.type === 'checkpoint') this.unfurl = 0.28;
    if (sprite.designer && !host.reduced) {
      this.revealT = -2; // waiting for first sight
      this.root.setAlpha(0);
    }
  }

  private drawCloth(t: number): void {
    const c = this.cloth;
    if (!c) return;
    const ctx = c.tex.context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.tex.width, c.tex.height);
    ctx.setTransform(BAKE_PX, 0, 0, BAKE_PX, -c.box[0] * CELL * BAKE_PX, -c.box[1] * CELL * BAKE_PX);
    const amp = this.host.reduced ? 0 : this.cheerT >= 0 ? 0.16 : 0.09;
    drawPaths(ctx, this.host.doc, amp ? wave(c.paths, c.poleX, t, amp) : c.paths);
    c.tex.refresh();
  }

  event(ev: SimEvent, ctx: FrameCtx): void {
    switch (ev.type) {
      case 'stomp':
        this.squashT = 0;
        break;
      case 'checkpoint':
        this.unfurl = Math.max(this.unfurl, 0.3);
        break;
      case 'spring':
        this.squashT = 0;
        break;
      case 'crumble':
        this.shakeUntil = ctx.now + ((this.e.type === 'crumble' ? this.e.delay_s : undefined) ?? HAZARDS.crumble.shake_s) * 1000;
        break;
      case 'door_open':
        this.openT = 0;
        break;
      default:
        break;
    }
  }

  update(cur: EntityView | undefined, prev: EntityView | undefined, f: FrameCtx): void {
    const e = this.e;
    let x = this.sprite.anchor[0] * CELL;
    let y = this.sprite.anchor[1] * CELL;
    if (cur && e.type !== 'spikes') {
      const p = prev ?? cur;
      x = lerp(p.x, cur.x, f.alpha) * CELL;
      y = lerp(p.y, cur.y, f.alpha) * CELL;
    }
    const st = cur?.state;
    const nowActive = cur ? cur.active : true;
    // cull rendering outside camera + 4 cells (still simulated)
    const margin = 4 * CELL + Math.max(this.mainBaked?.w ?? 32, 32);
    const visible = x > f.camX - margin && x < f.camX + VIEW_W_PX + margin;
    this.root.setVisible(visible);
    if (!visible) {
      this.active = nowActive;
      return;
    }
    let a = 1;
    let alphaK = this.revealT === -2 ? 0 : 1;
    // first sight of a designer addition: 400 ms pencil reveal
    if (this.revealT === -2 && x > f.camX - 8 && x < f.camX + VIEW_W_PX + 8) this.revealT = 0;
    if (this.revealT >= 0) {
      this.revealT += f.dt;
      const k = Math.min(1, this.revealT / ART.pencil.reveal_ms);
      alphaK = Math.min(1, k * 1.6);
      if (this.main && this.mainBaked) {
        const tex = this.main.frame;
        this.main.setCrop(0, 0, tex.width * k, tex.height);
      }
      if (k >= 1) {
        this.revealT = -1;
        this.main?.setCrop();
      }
    }
    const t = f.now / 1000 + this.phase0;
    let rot = 0;
    let sx = 1;
    let sy = 1;
    let ox = 0;
    let oy = 0;
    switch (e.type) {
      case 'enemy': {
        const moving = Number.isFinite(this.lastX) && Math.abs(x - this.lastX) > 0.05;
        this.lastX = x;
        if (moving && !this.host.reduced) {
          rot = Math.sin(t * Math.PI * 2 * RIG.enemy.waddle_hz) * RIG.enemy.waddle_deg * DEG;
          oy = -Math.abs(Math.sin(t * Math.PI * 2 * RIG.enemy.waddle_hz)) * RIG.enemy.bob_px;
        }
        const dx = f.player[0] - x;
        const dy = f.player[1] - 14 - (y - 10);
        const near = Math.hypot(dx, dy) < RIG.enemy.angry_c * CELL;
        if (this.glow) this.glow.active = near && nowActive;
        else if (this.main) {
          if (near && nowActive) this.main.setTint(0xffb0a8);
          else this.main.clearTint();
        }
        const L = Math.hypot(dx, dy) || 1;
        for (const eye of this.eyes) eye.img.setPosition(eye.base[0] + (dx / L) * RIG.idle.pupil_px, eye.base[1] + (dy / L) * RIG.idle.pupil_px);
        if (this.active && !nowActive) this.deadT = 0;
        if (nowActive) this.deadT = -1;
        if (this.deadT >= 0) {
          this.deadT += f.dt;
          const k = Math.min(1, this.deadT / RIG.enemy.puff_ms);
          sy = RIG.enemy.squash_h + (1 - RIG.enemy.squash_h) * (1 - Math.min(1, this.deadT / 60));
          sx = 1 + 0.3 * Math.min(1, this.deadT / 60);
          a = (1 - k);
          rot = 0;
        } else a = 1;
        // telegraphs (§5.7): hopper crouch, shooter inflate, chaser "!" and red eyes, crusher shake
        if (!this.host.reduced && this.deadT < 0) {
          const tt = cur?.t ?? 0;
          if (st === 'crouch') {
            sy *= 0.8;
            sx *= 1.12;
          } else if (st === 'inflate') {
            const k = 1 + 0.16 * Math.min(1, tt / 24);
            sx *= k;
            sy *= k;
          } else if (st === 'warn') ox += (Math.floor(f.now / 35) % 2 ? 1 : -1) * 1.2;
        }
        const alert = st === 'alert' || st === 'chase';
        if (alert && !this.alertG) {
          this.alertG = this.host.scene.add.graphics();
          this.root.add(this.alertG);
          const top = this.sprite.bbox[1] * CELL - 6;
          this.alertG.lineStyle(2.4, COLOR_RED, 1);
          this.alertG.lineBetween(0, top - 9, 0.6, top - 2);
          this.alertG.fillStyle(COLOR_RED, 1);
          this.alertG.fillCircle(0.8, top + 2, 1.5);
        }
        this.alertG?.setVisible(alert && nowActive);
        for (const eye of this.eyes) {
          if (alert) eye.img.setTint(COLOR_RED);
          else eye.img.clearTint();
        }
        const facing = cur?.facing ?? (e.params?.facing === 'left' ? -1 : 1);
        if (this.sprite.source === 'house' && (e.archetype === 'shooter' || e.archetype === 'chaser' || e.archetype === 'crusher')) sx *= facing;
        break;
      }
      case 'coin':
        oy = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 1.2) * 1;
        a = (nowActive ? 1 : 0);
        break;
      case 'big_coin': {
        const k = this.host.reduced ? 1 : 1 + 0.06 * Math.sin(t * Math.PI * 2 * 1.4);
        sx = k;
        sy = k;
        rot = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 0.5) * 6 * DEG;
        // held (collected, not yet banked) shows in the HUD slot, not in the world
        a = nowActive && st !== 'held' && st !== 'banked' ? 1 : 0;
        break;
      }
      case 'key':
        oy = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 0.9) * 1.5;
        a = (nowActive ? 1 : 0);
        break;
      case 'saw':
        rot = this.host.reduced ? 0 : (f.now / 1000) * Math.PI * 2 * 1.5;
        break;
      case 'spikes': {
        if (!this.host.reduced) {
          const sh = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * 1.5);
          const n = e.facing === 'up' ? [0, -1] : e.facing === 'down' ? [0, 1] : e.facing === 'left' ? [-1, 0] : [1, 0];
          ox = n[0] * sh;
          oy = n[1] * sh;
        }
        break;
      }
      case 'firebar': {
        const balls = cur?.balls;
        const p = prev?.balls;
        if (balls && balls.length) {
          // the sim's own ball centres (cells), relative to the anchor
          const ax = (cur?.x ?? this.sprite.anchor[0]) * CELL;
          const ay = (cur?.y ?? this.sprite.anchor[1]) * CELL;
          this.balls.forEach((b, i) => {
            const q = balls[Math.min(i, balls.length - 1)];
            const q0 = p && p[i] ? p[i] : q;
            b.setPosition(lerp(q0[0], q[0], f.alpha) * CELL - ax, lerp(q0[1], q[1], f.alpha) * CELL - ay);
          });
        } else {
          const ang = ((e.phase ?? 0) + (e.speed_deg_s * f.frame) / 60) * DEG;
          const sp = HAZARDS.firebar.ball_r_px * 2;
          this.balls.forEach((b, i) => b.setPosition(Math.cos(ang) * sp * i, Math.sin(ang) * sp * i));
        }
        break;
      }
      case 'moving_platform': {
        const p = prev ?? cur;
        const sp = cur && p ? (Math.abs(cur.x - p.x) + Math.abs(cur.y - p.y)) * 60 : 0;
        if (this.ticks) {
          this.ticks.clear();
          if (sp > HAZARDS.moving_platform.ticks_above_cs && !this.host.reduced) {
            const dir = cur && p ? Math.sign(cur.x - p.x) : 0;
            this.ticks.lineStyle(1.4, 0x3b3632, 0.45);
            for (let i = 0; i < 3; i++) {
              const tx = dir >= 0 ? -6 - i * 3 : e.w * CELL + 6 + i * 3;
              this.ticks.lineBetween(tx, 2 + i * 3, tx - dir * 6, 2 + i * 3);
            }
          }
        }
        break;
      }
      case 'crumble':
      case 'falling_platform':
        if ((f.now < this.shakeUntil || st === 'shake') && !this.host.reduced) ox = (Math.floor(f.now / 40) % 2 ? 1 : -1) * 1;
        a = (nowActive ? 1 : 0);
        break;
      case 'door': {
        if (this.active && !nowActive && this.openT < 0) this.openT = 0;
        if (nowActive) this.openT = -1;
        if (this.openT >= 0) {
          this.openT += f.dt;
          const k = Math.min(1, this.openT / 400);
          oy = -k * e.h * CELL * 0.85;
          a = (1 - k);
        } else a = (1);
        break;
      }
      case 'spring':
        break;
      case 'hint_arrow': {
        const a = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2) * 2;
        const d = e.dir === 'left' ? [-1, 0] : e.dir === 'right' ? [1, 0] : e.dir === 'up' ? [0, -1] : [0, 1];
        ox = d[0] * a;
        oy = d[1] * a;
        break;
      }
      case 'goal':
      case 'checkpoint': {
        const cheer = this.cheerT >= 0;
        const frame10 = Math.floor(f.now / (cheer ? 50 : 100));
        if (this.cloth && frame10 !== this.lastWave) {
          this.lastWave = frame10;
          this.drawCloth(cheer ? t * 1.8 : t);
        }
        if (cheer && !this.host.reduced) {
          this.cheerT += f.dt;
          // a happy bounce that settles over 1.2 s
          const k = Math.max(0, 1 - this.cheerT / 1200);
          sy *= 1 + 0.06 * Math.sin(this.cheerT / 70) * k;
          sx *= 1 - 0.03 * Math.sin(this.cheerT / 70) * k;
        }
        if (e.type === 'checkpoint' && this.cloth) {
          if (st === 'open' && this.unfurl < 0.3) this.unfurl = 0.3;
          if (this.unfurl < 1 && this.unfurl >= 0.3) this.unfurl = Math.min(1, this.unfurl + f.dt / 300);
          this.cloth.img.setScale(this.unfurl / BAKE_PX, (0.6 + 0.4 * this.unfurl) / BAKE_PX);
          this.cloth.img.setX(this.cloth.box[0] * CELL * this.unfurl);
        }
        break;
      }
      default:
        break;
    }
    // stomp / spring squash on the feet
    if (this.squashT >= 0 && (e.type === 'spring' || (e.type === 'enemy' && this.deadT < 0))) {
      this.squashT += f.dt;
      const k = Math.min(1, this.squashT / 250);
      const el = k >= 1 ? 1 : 1 - Math.cos(k * Math.PI * 3) * (1 - k) * 0.45;
      sy *= el;
      sx *= 2 - el;
      if (k >= 1) this.squashT = -1;
    }
    if (this.morph.t >= 0) {
      this.morph.t += f.dt;
      const k = Math.min(1, this.morph.t / this.morph.dur);
      const ease = 1 - (1 - k) * (1 - k) * (1 - k);
      ox += this.morph.dx * (1 - ease);
      oy += this.morph.dy * (1 - ease);
      if (k >= 1) this.morph.t = -1;
    }
    this.active = nowActive;
    this.root.setAlpha(a * alphaK);
    this.root.setPosition(x + ox, y + oy).setRotation(rot).setScale(sx, sy);
  }

  /** The win moment on the goal flag. */
  cheer(): void {
    this.cheerT = 0;
  }

  slideFrom(dx: number, dy: number, ms: number): void {
    this.morph = { dx, dy, t: 0, dur: ms };
  }

  sketchIn(): void {
    this.revealT = 0;
    this.root.setAlpha(0);
  }

  destroy(): void {
    this.root.destroy();
  }
}

export class EntityViews {
  private views = new Map<string, EView>();
  private host: EntityHost;
  private known = new Set<string>();
  /** Sim-spawned things with no compiled entity (shooter ink blobs): drawn as ink blobs, removed when gone. */
  private dyn = new Map<string, Phaser.GameObjects.Image>();
  private blobKey: Baked | null = null;

  constructor(host: EntityHost, level: LevelV2) {
    this.host = host;
    const byId = new Map(host.doc.sprites.map((s) => [s.id, s]));
    for (const e of level.compiled.entities) this.known.add(e.id);
    for (const e of level.compiled.entities) {
      const sp = byId.get(e.id);
      if (!sp) continue;
      try {
        this.views.set(e.id, new EView(host, e, sp));
      } catch (err) {
        host.onError(e, err);
      }
    }
  }

  get(id: string): EView | undefined {
    return this.views.get(id);
  }

  event(ev: SimEvent, f: FrameCtx): void {
    if (!ev.id) return;
    this.views.get(ev.id)?.event(ev, f);
  }

  private updateDynamic(cur: EntityView[], pm: Map<string, EntityView>, f: FrameCtx): void {
    const seen = new Set<string>();
    for (const v of cur) {
      if (this.known.has(v.id) || !v.active) continue;
      seen.add(v.id);
      let img = this.dyn.get(v.id);
      if (!img) {
        if (!this.blobKey) {
          const ring: number[] = [];
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            const r = (i % 2 ? 3.2 : 4.6) / CELL;
            ring.push(Math.cos(a) * r, Math.sin(a) * r);
          }
          this.blobKey = bake(this.host.bank, this.host.doc, 'dyn_blob', [{ pts: ring, closed: true, style: 'fire_core' }], BAKE_PX * 2);
        }
        img = imageOf(this.host.scene, this.blobKey);
        img.setTint(0x2a2320);
        this.host.layer.add(img);
        this.dyn.set(v.id, img);
      }
      const p = pm.get(v.id) ?? v;
      img.setPosition(lerp(p.x, v.x, f.alpha) * CELL, lerp(p.y, v.y, f.alpha) * CELL).setRotation(f.now / 120);
    }
    for (const [id, img] of this.dyn) {
      if (seen.has(id)) continue;
      img.destroy();
      this.dyn.delete(id);
    }
  }

  update(cur: EntityView[], prev: EntityView[], f: FrameCtx): void {
    const cm = new Map(cur.map((v) => [v.id, v]));
    const pm = new Map(prev.map((v) => [v.id, v]));
    this.updateDynamic(cur, pm, f);
    for (const [id, v] of this.views) {
      try {
        v.update(cm.get(id), pm.get(id), f);
      } catch (err) {
        this.host.onError(v.e, err);
        v.destroy();
        this.views.delete(id);
      }
    }
  }

  /** Nearest enemy or coin within 6 cells of a point (px), for the player's pupils. */
  lookTarget(px: number, py: number, cur: EntityView[]): [number, number] | null {
    let best: [number, number] | null = null;
    let bd = RIG.idle.look_c * CELL;
    for (const v of cur) {
      if (!v.active || (v.type !== 'enemy' && v.type !== 'coin' && v.type !== 'big_coin')) continue;
      const d = Math.hypot(v.x * CELL - px, v.y * CELL - py);
      if (d < bd) {
        bd = d;
        best = [v.x * CELL, v.y * CELL - (v.type === 'enemy' ? v.h * CELL * 0.5 : 0)];
      }
    }
    return best;
  }

  /** Saw proximity 0..1 for the whirr. */
  sawProximity(px: number, py: number, cur: EntityView[]): number {
    let best = 0;
    for (const v of cur) {
      if (v.type !== 'saw' || !v.active) continue;
      const d = Math.hypot(v.x * CELL - px, v.y * CELL - py) / CELL;
      best = Math.max(best, 1 - d / 10);
    }
    return Math.max(0, best);
  }

  /** The win moment: the goal flags flap and bounce. */
  cheer(): void {
    for (const v of this.views.values()) if (v.e.type === 'goal') v.cheer();
  }

  /** Swap morphs (§7.10): slide an entity's art in from where it was (px offset), or sketch it in. */
  morph(id: string, kind: 'move' | 'appear' | 'relabel', dx = 0, dy = 0, ms = 300): void {
    const v = this.views.get(id);
    if (!v) return;
    if (kind === 'move') v.slideFrom(dx, dy, ms);
    else v.sketchIn();
  }

  destroy(): void {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    for (const img of this.dyn.values()) img.destroy();
    this.dyn.clear();
  }
}

