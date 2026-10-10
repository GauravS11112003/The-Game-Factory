/**
 * The Creature Studio mini-stage (§8.1 "A mini-stage shows it moving with gravity against a dummy player"):
 * a 16 × 9-cell paper strip where the kid's own drawing behaves like its archetype with the real §5.7 numbers
 * (walker speed, hopper interval and hop, flyer pattern, shooter blobs, chaser sight and give-up, crusher warn, drop and
 * rise) and a pencil dummy player walks up to it and jumps on it. Stomping works unless the creature is spiky, so a
 * kid sees what "spiky" means before saving. Cells and seconds throughout; the canvas is 32 px per cell at 1×.
 */
import type { Behavior, InkStroke, RectCells } from '../core/types.gen.ts';
import { ART, DAMAGE, ENEMIES, GRIDS } from '../core/params.ts';
import { PROFILES } from '../core/sim/profiles.ts';
import { strokesBBox } from './geom.ts';
import { paintStroke } from './paint.ts';

const W = 16;
const H = 9;
const FLOOR = 8; // feet line of the floor
const CEIL = 1; // crusher home (its top)
const PX = 16; // px per cell in the physics profile
const STD = PROFILES['v2-standard'];
const G = STD.g_fall / PX; // c/s² (falling gravity; the stage keeps one gravity for readability)
const PLAYER_JUMP = STD.jump_base / PX; // c/s launch
const PLAYER_WALK = STD.walk_max / PX; // c/s
const BOUNCE = -DAMAGE.stomp.bounce_vy / PX;

/** A creature's art size in cells: the drawing's own proportions, longest side 0.75-2 cells (fit_creature, §2.4). */
export function creatureSize(strokes: readonly InkStroke[]): [number, number] {
  const bb = strokesBBox(strokes);
  if (!bb) return [1.25, 1.25];
  const w = Math.max(0.05, bb[2] - bb[0]);
  const h = Math.max(0.05, bb[3] - bb[1]);
  const long = Math.max(w, h);
  const k = long > 2 ? 2 / long : long < 0.75 ? 0.75 / long : 1;
  const r = (v: number): number => Math.max(0.5, Math.round(v * k * 16) / 16);
  return [r(w), r(h)];
}

interface Body {
  x: number; // centre
  y: number; // feet
  vx: number;
  vy: number;
  ground: boolean;
}

type CState = 'move' | 'crouch' | 'air' | 'inflate' | 'alert' | 'chase' | 'warn' | 'drop' | 'rest' | 'rise' | 'squashed' | 'idle';

export class CreatureStage {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private strokes: InkStroke[] = [];
  private bbox: RectCells | null = null;
  private size: [number, number] = [1.25, 1.25];
  private behavior: Behavior = { kind: 'enemy', archetype: 'walker' };
  private spiky = false;
  private c: Body = { x: 10, y: FLOOR, vx: 0, vy: 0, ground: true };
  private cs: CState = 'move';
  private ct = 0; // seconds in the current state
  private facing: 1 | -1 = -1;
  private chaseFor = 0;
  private blobs: { x: number; y: number; vx: number; life: number }[] = [];
  private p: Body = { x: 2, y: FLOOR, vx: PLAYER_WALK, vy: 0, ground: true };
  private ouch = 0; // seconds the dummy flashes after a hit
  private puff = 0; // seconds of the stomp puff
  private squashT = 0;
  private time = 0;
  private last = 0;
  private raf = 0;
  private running = false;

  constructor(widthPx = 512) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = widthPx;
    this.canvas.height = Math.round((widthPx * H) / W);
    this.canvas.className = 'creature-stage';
    this.ctx = this.canvas.getContext('2d')!;
  }

  set(strokes: InkStroke[], behavior: Behavior, spiky: boolean): void {
    const archChanged = this.archetype() !== archOf(behavior);
    this.strokes = strokes;
    this.bbox = strokesBBox(strokes);
    this.size = creatureSize(strokes);
    this.behavior = behavior;
    this.spiky = spiky;
    if (archChanged) this.reset();
  }

  private archetype(): string {
    return archOf(this.behavior);
  }

  private reset(): void {
    const a = this.archetype();
    this.c = { x: a === 'shooter' ? 12.5 : a === 'crusher' ? 9 : 10, y: a === 'flyer' ? 5 : a === 'crusher' ? CEIL + this.size[1] : FLOOR, vx: 0, vy: 0, ground: a !== 'flyer' };
    this.cs = a === 'crusher' ? 'idle' : 'move';
    this.ct = 0;
    this.facing = -1;
    this.blobs = [];
    this.chaseFor = 0;
    this.p = { x: 2, y: FLOOR, vx: PLAYER_WALK, vy: 0, ground: true };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      if (!this.canvas.isConnected && this.time > 0.5) {
        this.running = false;
        return;
      }
      const dt = Math.min(1 / 30, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  // ---- simulation -------------------------------------------------------------------------------------------

  private params(): Record<string, number | undefined> {
    const b = this.behavior;
    return b.kind === 'enemy' ? (b.params ?? {}) as Record<string, number | undefined> : {};
  }

  private setState(s: CState): void {
    this.cs = s;
    this.ct = 0;
  }

  private step(dt: number): void {
    this.time += dt;
    this.ct += dt;
    this.ouch = Math.max(0, this.ouch - dt);
    this.puff = Math.max(0, this.puff - dt);
    this.stepCreature(dt);
    this.stepPlayer(dt);
    this.stepBlobs(dt);
    this.contacts();
  }

  private stepCreature(dt: number): void {
    const a = this.archetype();
    const pr = this.params();
    const c = this.c;
    if (this.cs === 'squashed') {
      if (this.ct > 1.2) {
        this.reset();
      }
      return;
    }
    const half = this.size[0] / 2;
    const turnAtEdges = (): void => {
      if (c.x < 1 + half) {
        c.x = 1 + half;
        this.facing = 1;
      } else if (c.x > W - 1 - half) {
        c.x = W - 1 - half;
        this.facing = -1;
      }
    };
    switch (a) {
      case 'walker': {
        const v = pr.speed ?? ENEMIES.walker.speed;
        c.x += this.facing * v * dt;
        turnAtEdges();
        break;
      }
      case 'hopper': {
        const interval = pr.interval ?? ENEMIES.hopper.interval;
        if (this.cs === 'move' && this.ct >= Math.max(0.2, interval - ENEMIES.hopper.crouch_ms / 1000)) this.setState('crouch');
        else if (this.cs === 'crouch' && this.ct >= ENEMIES.hopper.crouch_ms / 1000) {
          this.setState('air');
          c.vy = ENEMIES.hopper.hop_vy / PX;
          c.vx = this.facing * ENEMIES.hopper.drift_cs;
          c.ground = false;
        } else if (this.cs === 'air') {
          c.vy += G * dt;
          c.x += c.vx * dt;
          c.y += c.vy * dt;
          turnAtEdges();
          if (c.y >= FLOOR) {
            c.y = FLOOR;
            c.vy = 0;
            c.ground = true;
            this.setState('move');
            if (Math.abs(this.p.x - c.x) > 0.5) this.facing = this.p.x > c.x ? 1 : -1;
          }
        }
        break;
      }
      case 'flyer': {
        const v = pr.speed ?? ENEMIES.flyer.speed;
        const range = Math.max(2, Math.min(10, pr.range ?? 6));
        const x0 = 9 - range / 2;
        const x1 = 9 + range / 2;
        c.x += this.facing * v * dt;
        if (c.x < x0) this.facing = 1;
        if (c.x > x1) this.facing = -1;
        c.y = 5 + ENEMIES.flyer.hover_bob_c * Math.sin((this.time * 2 * Math.PI) / ENEMIES.flyer.hover_period_s);
        break;
      }
      case 'shooter': {
        const interval = pr.interval ?? ENEMIES.shooter.interval;
        this.facing = this.p.x < c.x ? -1 : 1;
        if (this.cs === 'move' && this.ct >= Math.max(0.3, interval - ENEMIES.shooter.inflate_s)) this.setState('inflate');
        else if (this.cs === 'inflate' && this.ct >= ENEMIES.shooter.inflate_s) {
          const sp = pr.blob_speed ?? ENEMIES.shooter.blob_speed;
          this.blobs.push({ x: c.x + this.facing * (half + 0.2), y: c.y - this.size[1] * 0.55, vx: this.facing * sp, life: ENEMIES.shooter.blob_range[1] / sp });
          this.setState('move');
        }
        break;
      }
      case 'chaser': {
        const max = pr.speed ?? ENEMIES.chaser.speed;
        const sight = pr.sight ?? ENEMIES.chaser.sight;
        const dx = this.p.x - c.x;
        const sees = Math.abs(dx) <= sight && Math.abs(this.p.y - c.y) <= ENEMIES.chaser.sight_dy_c && Math.sign(dx) === this.facing;
        if (this.cs === 'move') {
          c.vx = this.facing * ENEMIES.chaser.patrol_cs;
          if (sees) this.setState('alert');
        } else if (this.cs === 'alert') {
          c.vx = 0;
          if (this.ct > 0.3) {
            this.setState('chase');
            this.chaseFor = 0;
          }
        } else if (this.cs === 'chase') {
          this.chaseFor += dt;
          const want = Math.sign(dx) * max;
          const acc = ENEMIES.chaser.accel / PX;
          c.vx += Math.max(-acc * dt, Math.min(acc * dt, want - c.vx));
          if (Math.abs(dx) > 0.3) this.facing = dx > 0 ? 1 : -1;
          if (this.chaseFor > ENEMIES.chaser.give_up_s || Math.abs(dx) > sight * 1.5) this.setState('move');
        }
        c.x += c.vx * dt;
        turnAtEdges();
        break;
      }
      case 'crusher': {
        const warn = pr.warn ?? ENEMIES.crusher.warn;
        const top = CEIL + this.size[1];
        if (this.cs === 'idle') {
          c.y = top;
          if (Math.abs(this.p.x - c.x) <= ENEMIES.crusher.trigger_dx_c + half) this.setState('warn');
        } else if (this.cs === 'warn') {
          if (this.ct >= warn) {
            this.setState('drop');
            c.vy = 0;
          }
        } else if (this.cs === 'drop') {
          c.vy = Math.min(ENEMIES.crusher.drop_max / PX, c.vy + (ENEMIES.crusher.drop_accel / PX) * dt);
          c.y += c.vy * dt;
          if (c.y >= FLOOR) {
            c.y = FLOOR;
            this.setState('rest');
          }
        } else if (this.cs === 'rest') {
          if (this.ct >= ENEMIES.crusher.rest_s) this.setState('rise');
        } else if (this.cs === 'rise') {
          c.y -= ENEMIES.crusher.rise_cs * dt;
          if (c.y <= top) {
            c.y = top;
            this.setState('idle');
          }
        }
        break;
      }
      default: {
        // static creature, or a non-creature behavior: a gentle idle bob (moving things slide)
        const b = this.behavior;
        if (b.kind === 'move') {
          const v = b.speed ?? GRIDS.platform_speed.enum.normal;
          const cells = Math.min(10, b.cells ?? 4);
          const horizontal = b.dir === 'left' || b.dir === 'right';
          const tt = (this.time * v) % (cells * 2);
          const off = tt < cells ? tt : cells * 2 - tt;
          if (horizontal) c.x = 9 - cells / 2 + off;
          else c.y = FLOOR - 1 - off * 0.5;
        }
        break;
      }
    }
  }

  private stepPlayer(dt: number): void {
    const p = this.p;
    const stunned = this.ouch > 0.6; // knocked back: no steering for a moment, physics still runs
    if (p.ground && !stunned) {
      p.vx = Math.sign(p.vx || 1) * PLAYER_WALK;
      if (p.x < 1.5) p.vx = PLAYER_WALK;
      if (p.x > W - 1.5) p.vx = -PLAYER_WALK;
      const a = this.archetype();
      const dx = this.c.x - p.x;
      const ahead = Math.sign(dx) === Math.sign(p.vx);
      const near = Math.abs(dx) < 2.2 + this.size[0] / 2;
      const grounded = this.c.y > FLOOR - 1.2 && this.cs !== 'squashed';
      // jump at grounded creatures (and over blobs) in front of you
      const blobAhead = this.blobs.some((b) => Math.sign(b.x - p.x) === Math.sign(p.vx) && Math.abs(b.x - p.x) < 1.6);
      if ((ahead && near && grounded && a !== 'crusher') || blobAhead) {
        p.vy = -PLAYER_JUMP;
        p.ground = false;
      }
    }
    if (!p.ground) p.vy += G * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.y >= FLOOR) {
      p.y = FLOOR;
      p.vy = 0;
      if (!p.ground && stunned) p.vx *= 0.3;
      p.ground = true;
    }
    p.x = Math.max(0.6, Math.min(W - 0.6, p.x));
  }

  private stepBlobs(dt: number): void {
    for (const b of this.blobs) {
      b.x += b.vx * dt;
      b.life -= dt;
    }
    this.blobs = this.blobs.filter((b) => b.life > 0 && b.x > 0 && b.x < W);
  }

  private creatureBox(): RectCells {
    const [w, h] = this.size;
    return [this.c.x - w / 2, this.c.y - h, this.c.x + w / 2, this.c.y];
  }

  private contacts(): void {
    if (this.cs === 'squashed' || this.ouch > 0) return;
    const p = this.p;
    const pb: RectCells = [p.x - 0.375, p.y - 1.75, p.x + 0.375, p.y];
    for (const b of this.blobs) {
      if (b.x > pb[0] && b.x < pb[2] && b.y > pb[1] && b.y < pb[3]) {
        b.life = 0;
        this.hurt();
        return;
      }
    }
    const a = this.archetype();
    if (a === 'none') return;
    const cb = this.creatureBox();
    const hit = pb[0] < cb[2] && cb[0] < pb[2] && pb[1] < cb[3] && cb[1] < pb[3];
    if (!hit) return;
    const fromAbove = p.vy > 0 && p.y - p.vy / 60 <= cb[1] + 0.35;
    const stompable = !this.spiky && a !== 'crusher' && this.behavior.kind === 'enemy';
    if (fromAbove && stompable) {
      p.vy = -BOUNCE;
      p.ground = false;
      this.setState('squashed');
      this.puff = 0.4;
      this.squashT = this.time;
    } else this.hurt();
  }

  private hurt(): void {
    this.ouch = 1.0;
    const away = this.p.x < this.c.x ? -1 : 1;
    this.p.vx = away * PLAYER_WALK;
    this.p.vy = DAMAGE.knockback.vy / PX;
    this.p.ground = false;
  }

  // ---- drawing --------------------------------------------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx;
    const S = this.canvas.width / W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = ART.themes.sketchbook.base;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // floor: a marker line with a light hatch under it
    ctx.strokeStyle = ART.palette.ink;
    ctx.lineWidth = Math.max(2, S * 0.18);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0.4 * S, FLOOR * S + 1);
    ctx.lineTo((W - 0.4) * S, FLOOR * S + 1);
    ctx.stroke();
    ctx.save();
    ctx.strokeStyle = 'rgba(31,27,24,0.18)';
    ctx.lineWidth = 1;
    for (let x = -H; x < W; x += 0.5) {
      ctx.beginPath();
      ctx.moveTo(x * S, H * S);
      ctx.lineTo((x + 1) * S, FLOOR * S + 3);
      ctx.stroke();
    }
    ctx.restore();
    if (this.archetype() === 'crusher') {
      ctx.strokeStyle = 'rgba(31,27,24,0.55)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(6 * S, CEIL * S);
      ctx.lineTo(12 * S, CEIL * S);
      ctx.stroke();
    }
    this.drawCreature(ctx, S);
    for (const b of this.blobs) {
      ctx.fillStyle = ART.palette.red;
      ctx.beginPath();
      ctx.arc(b.x * S, b.y * S, S * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawPlayer(ctx, S);
  }

  private drawCreature(ctx: CanvasRenderingContext2D, S: number): void {
    const [w, h] = this.size;
    const bb = this.bbox;
    let sx = 1;
    let sy = 1;
    let rot = 0;
    let dx = 0;
    const a = this.archetype();
    if (this.cs === 'squashed') {
      sy = 0.25;
      sx = 1.3;
    } else if (this.cs === 'crouch') {
      sy = 0.8;
      sx = 1.12;
    } else if (this.cs === 'inflate') {
      const k = 1 + 0.15 * Math.min(1, this.ct / ENEMIES.shooter.inflate_s);
      sx = k;
      sy = k;
    } else if (this.cs === 'warn') dx = Math.sin(this.time * 70) * 0.06;
    else if (a === 'walker' || (a === 'chaser' && this.cs !== 'alert')) rot = Math.sin(this.time * (a === 'chaser' && this.cs === 'chase' ? 22 : 12)) * 0.07;
    if (a === 'static') sy = 1 + Math.sin(this.time * 3) * 0.03;
    const cx = (this.c.x + dx) * S;
    const cy = this.c.y * S;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.scale(sx, sy); // the kid's drawing keeps the way it was drawn
    if (bb && this.strokes.length) {
      const bw = Math.max(0.05, bb[2] - bb[0]);
      const bh = Math.max(0.05, bb[3] - bb[1]);
      const k = Math.min(w / bw, h / bh);
      const ox = (bb[0] + bb[2]) / 2;
      const oy = bb[3];
      for (const s of this.strokes) {
        paintStroke(ctx, s, { scale: S * k, ox, oy, minWidthPx: 1.5 });
      }
    } else {
      // a blob placeholder until the kid draws
      ctx.strokeStyle = ART.palette.pencil_violet;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(0, (-h / 2) * S, (w / 2) * S, (h / 2) * S, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    if (this.spiky && this.cs !== 'squashed') {
      // little red spikes along the top: you can't stomp it
      ctx.save();
      ctx.fillStyle = ART.palette.red;
      const top = (this.c.y - h * sy) * S;
      const n = Math.max(3, Math.round(w * 3));
      for (let i = 0; i < n; i++) {
        const x0 = (this.c.x + dx - w / 2 + (w * i) / n) * S;
        const x1 = x0 + (w / n) * S;
        ctx.beginPath();
        ctx.moveTo(x0, top + 2);
        ctx.lineTo((x0 + x1) / 2, top - S * 0.28);
        ctx.lineTo(x1, top + 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    if (this.cs === 'alert') {
      ctx.save();
      ctx.fillStyle = ART.palette.red;
      ctx.font = `bold ${Math.round(S * 0.9)}px "Patrick Hand", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('!', this.c.x * S, (this.c.y - h - 0.3) * S);
      ctx.restore();
    }
    if (this.puff > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(31,27,24,0.5)';
      ctx.lineWidth = 2;
      const r = (1 - this.puff / 0.4) * S * 1.2 + S * 0.3;
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + this.squashT;
        ctx.beginPath();
        ctx.arc(this.c.x * S + Math.cos(ang) * r, (this.c.y - 0.2) * S + Math.sin(ang) * r * 0.5, S * 0.12, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, S: number): void {
    const p = this.p;
    const x = p.x * S;
    const y = p.y * S;
    const hgt = 1.75 * S;
    const blink = this.ouch > 0 && Math.floor(this.ouch * 12) % 2 === 0;
    if (blink) return;
    ctx.save();
    ctx.strokeStyle = ART.palette.pencil_violet;
    ctx.lineWidth = Math.max(1.5, S * 0.09);
    ctx.lineCap = 'round';
    const swing = p.ground ? Math.sin(this.time * 14) * 0.35 : 0.25;
    ctx.beginPath();
    ctx.arc(x, y - hgt + S * 0.27, S * 0.25, 0, Math.PI * 2);
    ctx.moveTo(x, y - hgt + S * 0.52);
    ctx.lineTo(x, y - S * 0.6);
    ctx.moveTo(x, y - S * 0.6);
    ctx.lineTo(x + Math.sin(swing) * S * 0.6, y);
    ctx.moveTo(x, y - S * 0.6);
    ctx.lineTo(x - Math.sin(swing) * S * 0.6, y);
    ctx.moveTo(x - S * 0.32, y - hgt * 0.55);
    ctx.lineTo(x + S * 0.32, y - hgt * 0.55);
    ctx.stroke();
    ctx.restore();
  }
}

function archOf(b: Behavior): string {
  if (b.kind === 'enemy') return b.archetype;
  if (b.kind === 'static') return 'static';
  return 'none';
}
