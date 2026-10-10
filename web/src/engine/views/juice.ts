/**
 * Juice (PLAN_V2 §7.7): pre-baked ink particle textures (≤ 300 alive), screen shake (death 6 px / 250 ms, crusher
 * 4 px / 150 ms, stomp 2 px / 80 ms; off with reduced motion), the coin's 350 ms bezier flight to the HUD, confetti.
 * Hit-stop lives in the sim (counted in sim frames), so replays stay exact.
 */
import Phaser from 'phaser';
import { ART, JUICE, PERF } from '../../core/params.ts';
import type { TexBank } from '../gfx.ts';

const P = ART.palette;
const hex = (s: string): number => parseInt(s.slice(1), 16);
export const COLORS = {
  ink: hex(P.ink), red: hex(P.red), green: hex(P.green), blue: hex(P.blue), violet: hex(P.pencil_violet),
  gold: 0xffd86b, paper: 0xfffdf6, tint: hex(P.paper_tint),
};

type Kind = 'dust' | 'sparkle' | 'ring' | 'confetti' | 'splat' | 'bits' | 'puff' | 'shock' | 'flash' | 'fall';

function canvas(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) draw(ctx);
  return c;
}

/** Ink particle textures, drawn at 3× for crisp downscaling (white where they get tinted). */
function textures(bank: TexBank): Record<Kind | 'coin', string> {
  const S = 3;
  const speck = canvas(6 * S, 6 * S, (c) => {
    c.fillStyle = P.ink;
    c.beginPath();
    c.ellipse(3 * S, 3 * S, 2.2 * S, 1.7 * S, 0.4, 0, Math.PI * 2);
    c.fill();
  });
  const sparkle = canvas(10 * S, 10 * S, (c) => {
    c.fillStyle = '#ffffff';
    c.beginPath();
    const cx = 5 * S;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
      const r = (i % 2 ? 1.2 : 4.6) * S;
      if (i === 0) c.moveTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
      else c.lineTo(cx + Math.cos(a) * r, cx + Math.sin(a) * r);
    }
    c.closePath();
    c.fill();
  });
  const ring = canvas(24 * S, 24 * S, (c) => {
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2 * S;
    c.beginPath();
    c.arc(12 * S, 12 * S, 10 * S, 0, Math.PI * 2);
    c.stroke();
  });
  const confetti = canvas(10 * S, 5 * S, (c) => {
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1.6 * S;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(1 * S, 3.5 * S);
    c.quadraticCurveTo(3 * S, 0.5 * S, 5 * S, 2.5 * S);
    c.quadraticCurveTo(7 * S, 4.5 * S, 9 * S, 1.5 * S);
    c.stroke();
  });
  const splat = canvas(8 * S, 8 * S, (c) => {
    c.fillStyle = P.ink;
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = (i % 2 ? 2.2 : 3.6) * S;
      if (i === 0) c.moveTo(4 * S + Math.cos(a) * r, 4 * S + Math.sin(a) * r);
      else c.lineTo(4 * S + Math.cos(a) * r, 4 * S + Math.sin(a) * r);
    }
    c.closePath();
    c.fill();
  });
  const bits = canvas(7 * S, 5 * S, (c) => {
    c.fillStyle = P.paper_tint;
    c.strokeStyle = P.ink;
    c.lineWidth = 0.8 * S;
    c.beginPath();
    c.moveTo(0.5 * S, 1 * S);
    c.lineTo(6.5 * S, 0.5 * S);
    c.lineTo(5.5 * S, 4.5 * S);
    c.lineTo(1 * S, 4 * S);
    c.closePath();
    c.fill();
    c.stroke();
  });
  const puff = canvas(16 * S, 16 * S, (c) => {
    const g = c.createRadialGradient(8 * S, 8 * S, 0, 8 * S, 8 * S, 8 * S);
    g.addColorStop(0, 'rgba(255,253,246,0.95)');
    g.addColorStop(0.6, 'rgba(239,231,214,0.6)');
    g.addColorStop(1, 'rgba(239,231,214,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 16 * S, 16 * S);
    c.strokeStyle = 'rgba(59,54,50,0.35)';
    c.lineWidth = 0.8 * S;
    c.beginPath();
    c.arc(8 * S, 8 * S, 5.5 * S, 0.3, 4.6);
    c.stroke();
  });
  const coin = canvas(12 * S, 12 * S, (c) => {
    c.fillStyle = 'rgba(44,123,229,0.18)';
    c.strokeStyle = P.blue;
    c.lineWidth = 2.2 * S;
    c.beginPath();
    c.arc(6 * S, 6 * S, 4.6 * S, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.strokeStyle = '#FFFDF6';
    c.lineWidth = 1.3 * S;
    c.beginPath();
    c.arc(6 * S, 6 * S, 2.6 * S, 3.5, 4.3);
    c.stroke();
  });
  return {
    coin: bank.add('p_coin', coin),
    dust: bank.add('p_speck', speck), sparkle: bank.add('p_sparkle', sparkle), ring: bank.add('p_ring', ring),
    confetti: bank.add('p_confetti', confetti), splat: bank.add('p_splat', splat), bits: bank.add('p_bits', bits),
    puff: bank.add('p_puff', puff), shock: bank.add('p_shock', ring), flash: bank.add('p_flash', ring),
    fall: bank.add('p_fall', confetti),
  };
}

type Cfg = Phaser.Types.GameObjects.Particles.ParticleEmitterConfig;

const CONFETTI_TINTS = [COLORS.red, COLORS.blue, COLORS.green, COLORS.gold, COLORS.violet];

function configs(): Record<Kind, Cfg> {
  const s = 1 / 3;
  return {
    dust: { speed: { min: 18, max: 70 }, angle: { min: 200, max: 340 }, lifespan: 380, gravityY: 160, scale: { start: s * 1.1, end: s * 0.3 }, alpha: { start: 0.65, end: 0 }, maxAliveParticles: 50 },
    sparkle: { speed: { min: 40, max: 120 }, angle: { min: 0, max: 360 }, lifespan: 480, scale: { start: s * 1.1, end: 0 }, rotate: { min: 0, max: 360 }, tint: [COLORS.blue, COLORS.gold, 0xffffff], maxAliveParticles: 50 },
    ring: { speed: 0, lifespan: 380, scale: { start: s * 0.3, end: s * 1.7 }, alpha: { start: 0.9, end: 0 }, tint: COLORS.gold, maxAliveParticles: 10 },
    confetti: { speed: { min: 120, max: 330 }, angle: { min: 215, max: 325 }, gravityY: 520, lifespan: 1500, rotate: { start: 0, end: 540 }, scale: { min: s * 0.8, max: s * 1.3 }, tint: CONFETTI_TINTS, alpha: { start: 1, end: 0.2 }, maxAliveParticles: 80 },
    splat: { speed: { min: 60, max: 170 }, angle: { min: 180, max: 360 }, gravityY: 620, lifespan: 460, scale: { start: s, end: s * 0.4 }, alpha: { start: 1, end: 0 }, maxAliveParticles: 30 },
    bits: { speed: { min: 20, max: 90 }, angle: { min: 200, max: 340 }, gravityY: 700, lifespan: 750, rotate: { min: -200, max: 200 }, scale: { min: s * 0.7, max: s * 1.1 }, maxAliveParticles: 30 },
    puff: { speed: { min: 15, max: 65 }, angle: { min: 0, max: 360 }, lifespan: 520, scale: { start: s * 0.6, end: s * 1.7 }, alpha: { start: 0.75, end: 0 }, maxAliveParticles: 20 },
    shock: { speed: 0, lifespan: 300, scale: { start: s * 0.4, end: s * 2.2 }, alpha: { start: 0.8, end: 0 }, tint: COLORS.ink, maxAliveParticles: 10 },
    // the win moment: a big gold ink ring, and confetti scribbles drifting down from the top of the view
    flash: { speed: 0, lifespan: 650, scale: { start: s * 0.6, end: s * 6 }, alpha: { start: 0.85, end: 0 }, tint: COLORS.gold, maxAliveParticles: 4 },
    fall: { speed: { min: 15, max: 55 }, angle: { min: 70, max: 110 }, gravityY: 60, lifespan: 2600, rotate: { start: 0, end: 720 }, scale: { min: s * 0.7, max: s * 1.2 }, tint: CONFETTI_TINTS, alpha: { start: 1, end: 0.3 }, maxAliveParticles: 16 },
  };
}

interface Flight {
  img: Phaser.GameObjects.Image;
  from: [number, number];
  ctrl: [number, number];
  to: [number, number];
  t: number;
  done: () => void;
}

export class Juice {
  private emitters = new Map<Kind, Phaser.GameObjects.Particles.ParticleEmitter>();
  private shakes: { amp: number; dur: number; t: number }[] = [];
  private flights: Flight[] = [];
  private scene: Phaser.Scene;
  private hud: Phaser.GameObjects.Layer;
  private reduced: boolean;
  readonly tex: Record<Kind | 'coin', string>;

  constructor(scene: Phaser.Scene, bank: TexBank, world: Phaser.GameObjects.Layer, hud: Phaser.GameObjects.Layer, reduced: boolean) {
    this.scene = scene;
    this.hud = hud;
    this.reduced = reduced;
    this.tex = textures(bank);
    const cfg = configs();
    let budget = PERF.max_particles;
    for (const k of Object.keys(cfg) as Kind[]) {
      const c = { ...cfg[k], emitting: false } as Cfg;
      const max = Math.min(budget, (c.maxAliveParticles as number) ?? 30);
      budget -= max;
      c.maxAliveParticles = Math.max(1, max);
      const em = scene.add.particles(0, 0, this.tex[k], c);
      em.setDepth(80);
      world.add(em);
      this.emitters.set(k, em);
    }
  }

  burst(k: Kind, x: number, y: number, n: number): void {
    const count = this.reduced ? Math.ceil(n / 2) : n;
    if (count <= 0) return;
    this.emitters.get(k)?.explode(count, x, y);
  }

  // ---- the §7.7 table ----
  jump(x: number, y: number): void {
    this.burst('dust', x, y, JUICE.jump.dust);
  }
  land(x: number, y: number, impact: number): void {
    const [a, b] = JUICE.land.specks;
    this.burst('dust', x, y, Math.round(a + (b - a) * Math.max(0, Math.min(1, impact))));
  }
  skid(x: number, y: number): void {
    this.burst('dust', x, y, JUICE.skid.specks);
  }
  coin(x: number, y: number): void {
    this.burst('sparkle', x, y, JUICE.coin.sparkles);
  }
  bigCoin(x: number, y: number): void {
    this.burst('ring', x, y, 1);
    const n = JUICE.big_coin.ring;
    const em = this.emitters.get('sparkle');
    if (em) for (let i = 0; i < (this.reduced ? n / 2 : n); i++) {
      const a = (i / n) * Math.PI * 2;
      em.explode(1, x + Math.cos(a) * 10, y + Math.sin(a) * 10);
    }
    this.burst('confetti', x, y, JUICE.big_coin.confetti);
  }
  stomp(x: number, y: number): void {
    this.burst('splat', x, y, JUICE.stomp.splats);
    this.burst('shock', x, y, 1);
  }
  checkpoint(x: number, y: number): void {
    this.burst('sparkle', x, y - 24, JUICE.checkpoint.sparkles);
  }
  spring(x: number, y: number): void {
    this.burst('shock', x, y, JUICE.spring.rings);
  }
  crumble(x: number, y: number, wpx: number): void {
    const [a, b] = JUICE.crumble.bits;
    const em = this.emitters.get('bits');
    const n = a + Math.floor(Math.random() * (b - a + 1));
    if (em) for (let i = 0; i < (this.reduced ? n / 2 : n); i++) em.explode(1, x + Math.random() * wpx, y + 4);
  }
  door(x: number, y: number): void {
    this.burst('puff', x, y, JUICE.door.puff);
  }
  puff(x: number, y: number, n = 6): void {
    this.burst('puff', x, y, n);
  }
  goal(x: number, y: number): void {
    this.burst('confetti', x, y - 32, JUICE.goal.confetti);
  }
  /** The win flash: one big gold ring around the character (skipped with reduced motion). */
  winFlash(x: number, y: number): void {
    if (this.reduced) return;
    this.burst('flash', x, y - 14, 1);
  }
  /** A few confetti scribbles falling from the top of the view (x0 … x1 world px), for the celebration. */
  trickle(x0: number, x1: number, y: number, n = 2): void {
    if (this.reduced) return;
    const em = this.emitters.get('fall');
    if (!em) return;
    for (let i = 0; i < n; i++) em.explode(1, x0 + Math.random() * (x1 - x0), y);
  }

  shake(px: number, ms: number): void {
    if (this.reduced) return;
    this.shakes.push({ amp: px, dur: ms, t: 0 });
  }

  /** The current shake offset (logical px); UI-side randomness, never the sim's. */
  offset(): [number, number] {
    let amp = 0;
    for (const s of this.shakes) amp = Math.max(amp, s.amp * (1 - s.t / s.dur));
    if (amp <= 0.01) return [0, 0];
    const a = Math.random() * Math.PI * 2;
    return [Math.cos(a) * amp, Math.sin(a) * amp];
  }

  /** The coin flies from a screen point to the HUD (logical px) along a bezier in 350 ms. */
  fly(textureKey: string, scale: number, from: [number, number], to: [number, number], done: () => void): void {
    const img = this.scene.add.image(from[0], from[1], textureKey).setScale(scale).setDepth(5);
    this.hud.add(img);
    const ctrl: [number, number] = [(from[0] + to[0]) / 2 - 40, Math.min(from[1], to[1]) - 60];
    this.flights.push({ img, from, ctrl, to, t: 0, done });
  }

  update(dt: number): void {
    for (const s of this.shakes) s.t += dt;
    this.shakes = this.shakes.filter((s) => s.t < s.dur);
    const dur = JUICE.coin.fly_ms;
    for (const f of this.flights) {
      f.t += dt;
      const k = Math.min(1, f.t / dur);
      const e = k * k * (3 - 2 * k);
      const u = 1 - e;
      const x = u * u * f.from[0] + 2 * u * e * f.ctrl[0] + e * e * f.to[0];
      const y = u * u * f.from[1] + 2 * u * e * f.ctrl[1] + e * e * f.to[1];
      f.img.setPosition(x, y).setAlpha(0.6 + 0.4 * (1 - e));
      if (k >= 1) {
        f.img.destroy();
        f.done();
      }
    }
    this.flights = this.flights.filter((f) => f.t < dur);
  }

  clear(): void {
    for (const em of this.emitters.values()) em.killAll();
    for (const f of this.flights) f.img.destroy();
    this.flights = [];
    this.shakes = [];
  }

  destroy(): void {
    this.clear();
    for (const em of this.emitters.values()) em.destroy();
    this.emitters.clear();
  }
}
