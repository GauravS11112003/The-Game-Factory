/**
 * HUD plates (PLAN_V2 §7.9, §5.9, §6.2): paper rounded rectangles with a 2 px marker outline and ±1° rotation, on
 * their own camera (no zoom, no shake). Left: coins + 3 big-coin slots (pulsing until banked). Centre: the clock
 * m:ss.cc (+ the timer ring that pulses in the last 10 s). Right: deaths (skull doodle), hearts and lives when
 * enabled. The minimap strip (1 px per cell: terrain, goal, checkpoints, player dot) appears for levels > 1 screen.
 * Mute / restart / pause are DOM buttons beside it (engine/chrome.ts) so they stay accessible.
 */
import Phaser from 'phaser';
import type { SimView } from '../../core/sim/types.ts';
import type { LevelV2 } from '../../core/types.gen.ts';
import { CAMERA, SCORING, UI } from '../../core/params.ts';
import { decodeGrid } from '../../core/art/terrain.ts';
import { COLORS } from './juice.ts';
import { VIEW_H_PX, VIEW_W_PX } from '../gfx.ts';
import type { TexBank } from '../gfx.ts';

export const HUD_FONT = '"Patrick Hand", "Comic Sans MS", "Chalkboard SE", "Marker Felt", "Segoe Print", system-ui, sans-serif';
const DEG = Math.PI / 180;
const PLATE_H = 30;
const TOP = 8;

export function clock(frames: number): string {
  const cs = Math.floor((Math.max(0, frames) * 100) / 60);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function plate(scene: Phaser.Scene, x: number, w: number, rotDeg: number): { c: Phaser.GameObjects.Container; g: Phaser.GameObjects.Graphics } {
  const c = scene.add.container(x + w / 2, TOP + PLATE_H / 2);
  const g = scene.add.graphics();
  g.fillStyle(COLORS.paper, 0.95);
  g.fillRoundedRect(-w / 2, -PLATE_H / 2, w, PLATE_H, 9);
  g.lineStyle(UI.hud_outline_px, COLORS.ink, 1);
  g.strokeRoundedRect(-w / 2, -PLATE_H / 2, w, PLATE_H, 9);
  c.add(g);
  c.setRotation(rotDeg * DEG);
  return { c, g };
}

function starPoints(cx: number, cy: number, r: number, inner = 0.46): Phaser.Math.Vector2[] {
  const out: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 ? r * inner : r;
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    out.push(new Phaser.Math.Vector2(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
  }
  return out;
}

function heartPoints(cx: number, cy: number, s: number): Phaser.Math.Vector2[] {
  const out: Phaser.Math.Vector2[] = [];
  for (let i = 0; i < 24; i++) {
    const t = (i / 24) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    out.push(new Phaser.Math.Vector2(cx + (x * s) / 16, cy + (y * s) / 16));
  }
  return out;
}

export class Hud {
  readonly layer: Phaser.GameObjects.Layer;
  private scene: Phaser.Scene;
  private texts: Phaser.GameObjects.Text[] = [];
  private coinText: Phaser.GameObjects.Text;
  private clockText: Phaser.GameObjects.Text;
  private deathText: Phaser.GameObjects.Text | null = null;
  private livesText: Phaser.GameObjects.Text | null = null;
  private slots: Phaser.GameObjects.Graphics[] = [];
  private nBig: number;
  private hearts: Phaser.GameObjects.Graphics | null = null;
  private heartMax: number;
  private ring: Phaser.GameObjects.Graphics | null = null;
  private timerTotal: number | null = null;
  private miniDot: Phaser.GameObjects.Graphics | null = null;
  private miniX = 0;
  private miniW = 0;
  private coinPlate: Phaser.GameObjects.Container;
  private coinPulse = 0;
  private clockPlate: Phaser.GameObjects.Container;
  private clockGlow: Phaser.GameObjects.Graphics;
  private celebrateT = -1;
  private pausedC: Phaser.GameObjects.Container | null = null;
  private note: Phaser.GameObjects.Container | null = null;
  private r: number;
  private lastCoins = -1;
  private lastDeaths = -1;
  private lastClock = '';
  readonly coinIcon: [number, number];

  constructor(scene: Phaser.Scene, bank: TexBank, level: LevelV2, o: { r: number; rightReserve: number }) {
    this.scene = scene;
    this.r = o.r;
    this.layer = scene.add.layer();
    this.layer.setDepth(1000);
    const txt = (x: number, y: number, s: string, size = 19, origin: [number, number] = [0, 0.5]): Phaser.GameObjects.Text => {
      const t = scene.add.text(x, y, s, { fontFamily: HUD_FONT, fontSize: `${size}px`, color: '#1F1B18', resolution: o.r }).setOrigin(origin[0], origin[1]);
      this.texts.push(t);
      return t;
    };
    this.nBig = Math.min(3, level.compiled.entities.filter((e) => e.type === 'big_coin').length);
    // left: coins + big-coin slots
    const lw = 76 + this.nBig * 22;
    const left = plate(scene, 8, lw, -1);
    const icon = scene.add.graphics();
    icon.fillStyle(COLORS.blue, 0.18);
    icon.fillCircle(-lw / 2 + 17, 0, 7);
    icon.lineStyle(2.2, COLORS.blue, 1);
    icon.strokeCircle(-lw / 2 + 17, 0, 7);
    icon.lineStyle(1.4, 0xffffff, 0.95);
    icon.beginPath();
    icon.arc(-lw / 2 + 17, 0, 4, 3.5, 4.3);
    icon.strokePath();
    left.c.add(icon);
    this.coinText = txt(-lw / 2 + 29, 0, '0');
    left.c.add(this.coinText);
    for (let i = 0; i < this.nBig; i++) {
      const g = scene.add.graphics();
      g.setPosition(-lw / 2 + 70 + i * 22, 0);
      left.c.add(g);
      this.slots.push(g);
    }
    this.coinPlate = left.c;
    this.coinIcon = [8 + 17, TOP + PLATE_H / 2];
    // centre: the clock (and the timer ring)
    const cw = 108;
    const centre = plate(scene, VIEW_W_PX / 2 - cw / 2, cw, 0.8);
    // the win moment: the stopped clock's plate glows gold and pops (celebrate())
    this.clockGlow = scene.add.graphics();
    this.clockGlow.fillStyle(COLORS.gold, 0.55);
    this.clockGlow.fillRoundedRect(-cw / 2 + 3, -PLATE_H / 2 + 3, cw - 6, PLATE_H - 6, 7);
    this.clockGlow.setAlpha(0);
    centre.c.addAt(this.clockGlow, 1);
    this.clockText = txt(8, 0, '0:00.00', 20, [0.5, 0.5]);
    centre.c.add(this.clockText);
    this.clockPlate = centre.c;
    this.ring = scene.add.graphics();
    this.ring.setPosition(-cw / 2 + 15, 0);
    centre.c.add(this.ring);
    // right: deaths, hearts, lives
    this.heartMax = level.rules.hearts ?? 1;
    const hasLives = level.rules.lives !== undefined && level.rules.lives !== 'off';
    const rw = 70 + (this.heartMax > 1 ? this.heartMax * 18 + 6 : 0) + (hasLives ? 44 : 0);
    const rx = VIEW_W_PX - 8 - o.rightReserve - rw;
    const right = plate(scene, rx, rw, -0.7);
    const skull = scene.add.graphics();
    const sx = -rw / 2 + 17;
    skull.fillStyle(COLORS.paper, 1);
    skull.lineStyle(2, COLORS.ink, 1);
    skull.fillCircle(sx, -1.5, 7.5);
    skull.strokeCircle(sx, -1.5, 7.5);
    skull.fillRect(sx - 4.5, 3, 9, 5);
    skull.strokeRect(sx - 4.5, 3, 9, 5);
    skull.fillStyle(COLORS.ink, 1);
    skull.fillCircle(sx - 3, -2.5, 2);
    skull.fillCircle(sx + 3, -2.5, 2);
    skull.lineStyle(1.2, COLORS.ink, 1);
    skull.lineBetween(sx - 1.5, 4, sx - 1.5, 8);
    skull.lineBetween(sx + 1.5, 4, sx + 1.5, 8);
    right.c.add(skull);
    this.deathText = txt(sx + 13, 0, '0');
    right.c.add(this.deathText);
    let cursor = sx + 42;
    if (this.heartMax > 1) {
      this.hearts = scene.add.graphics();
      this.hearts.setPosition(cursor, 0);
      right.c.add(this.hearts);
      cursor += this.heartMax * 18 + 6;
    }
    if (hasLives) {
      const g = scene.add.graphics();
      g.fillStyle(COLORS.red, 1);
      g.fillPoints(heartPoints(cursor + 6, 0, 7), true);
      right.c.add(g);
      this.livesText = txt(cursor + 15, 0, '×' + String(level.rules.lives));
      right.c.add(this.livesText);
    }
    const plates = [left.c, centre.c, right.c];
    // minimap strip for levels longer than one screen
    if (level.world.screens > 1) {
      const g = decodeGrid(level);
      const w = level.world.w;
      const s = Math.max(1, Math.round(o.r));
      const c = document.createElement('canvas');
      c.width = w * s + 4 * s;
      c.height = 27 * s + 4 * s;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.fillStyle = 'rgba(255,253,246,0.92)';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.strokeStyle = '#1F1B18';
        ctx.lineWidth = s;
        ctx.strokeRect(s / 2, s / 2, c.width - s, c.height - s);
        for (let rr = 0; rr < g.h; rr++)
          for (let cc = 0; cc < w; cc++) {
            const ch = g.rows[rr][cc];
            if (ch === '.') continue;
            ctx.fillStyle = ch === '~' || ch === 'X' ? '#E0453A' : ch === '=' ? 'rgba(59,54,50,0.45)' : 'rgba(59,54,50,0.7)';
            ctx.fillRect((cc + 2) * s, (rr + 2) * s, s, s);
          }
        for (const e of level.compiled.entities) {
          if (e.type !== 'goal' && e.type !== 'checkpoint') continue;
          ctx.fillStyle = e.type === 'goal' ? '#3E9E4F' : 'rgba(62,158,79,0.7)';
          ctx.fillRect((Math.floor(e.x) + 2) * s - s / 2, (Math.floor(e.y) - 4 + 2) * s, e.type === 'goal' ? 2 * s : s, 4 * s);
        }
      }
      const key = bank.add('minimap', c);
      this.miniW = c.width / s;
      this.miniX = VIEW_W_PX - 8 - this.miniW;
      const img = scene.add.image(this.miniX, TOP + PLATE_H + 6, key).setOrigin(0, 0).setScale(1 / s);
      this.layer.add(img);
      this.miniDot = scene.add.graphics();
      this.layer.add(this.miniDot);
    }
    for (const p of plates) this.layer.add(p);
  }

  /** HUD point (logical px) the coin flies to. */
  coinTarget(): [number, number] {
    return this.coinIcon;
  }

  pulseCoins(): void {
    this.coinPulse = 1;
  }

  /** The win: the stopped clock pops and glows gold (the results card shows the time next). */
  celebrate(): void {
    this.celebrateT = 0;
  }

  /** Back to a plain clock (restart). */
  uncelebrate(): void {
    this.celebrateT = -1;
    this.clockGlow.setAlpha(0);
    this.clockPlate.setScale(1);
  }

  setTimerTotal(frames: number | null): void {
    this.timerTotal = frames;
  }

  /** A small plate at the bottom centre (null hides it). */
  setNote(text: string | null): void {
    this.note?.destroy();
    this.note = null;
    if (!text) return;
    const w = Math.max(160, text.length * 8.6 + 24);
    const c = this.scene.add.container(VIEW_W_PX / 2, VIEW_H_PX - 24);
    const g = this.scene.add.graphics();
    g.fillStyle(COLORS.paper, 0.95);
    g.fillRoundedRect(-w / 2, -14, w, 28, 9);
    g.lineStyle(2, COLORS.ink, 1);
    g.strokeRoundedRect(-w / 2, -14, w, 28, 9);
    const t = this.scene.add.text(0, 0, text, { fontFamily: HUD_FONT, fontSize: '17px', color: '#1F1B18', resolution: this.r }).setOrigin(0.5);
    this.texts.push(t);
    c.add([g, t]);
    c.setRotation(0.6 * DEG);
    this.layer.add(c);
    this.note = c;
  }

  setPaused(p: boolean, label = 'Paused', hint = 'Press Esc to keep playing'): void {
    if (!p) {
      this.pausedC?.destroy();
      this.pausedC = null;
      return;
    }
    if (this.pausedC) return;
    const c = this.scene.add.container(0, 0);
    const dim = this.scene.add.rectangle(0, 0, VIEW_W_PX, VIEW_H_PX, 0x1f1b18, 0.28).setOrigin(0, 0);
    const pl = plate(this.scene, VIEW_W_PX / 2 - 120, 240, -0.8);
    pl.c.y = VIEW_H_PX / 2;
    pl.g.clear();
    pl.g.fillStyle(COLORS.paper, 0.97);
    pl.g.fillRoundedRect(-120, -34, 240, 68, 12);
    pl.g.lineStyle(2, COLORS.ink, 1);
    pl.g.strokeRoundedRect(-120, -34, 240, 68, 12);
    const t1 = this.scene.add.text(0, -10, label, { fontFamily: HUD_FONT, fontSize: '28px', color: '#1F1B18', resolution: this.r }).setOrigin(0.5);
    const t2 = this.scene.add.text(0, 18, hint, { fontFamily: HUD_FONT, fontSize: '15px', color: '#5a524b', resolution: this.r }).setOrigin(0.5);
    this.texts.push(t1, t2);
    pl.c.add([t1, t2]);
    c.add([dim, pl.c]);
    this.layer.add(c);
    this.pausedC = c;
  }

  setResolution(r: number): void {
    this.r = r;
    for (const t of this.texts) if (t.active) t.setResolution(r);
  }

  /** Re-render the texts once the bundled font has loaded. */
  refreshFont(): void {
    for (const t of this.texts) if (t.active) t.setFontFamily(HUD_FONT);
  }

  update(v: SimView, clockFrames: number, now: number, dt: number, camX: number, worldW: number, ghosts: { x: number; y: number; color: number }[] = []): void {
    if (v.coins !== this.lastCoins) {
      this.lastCoins = v.coins;
      this.coinText.setText(String(v.coins));
    }
    if (this.coinPulse > 0) {
      this.coinPulse = Math.max(0, this.coinPulse - dt / 220);
      const k = 1 + 0.12 * Math.sin(this.coinPulse * Math.PI);
      this.coinPlate.setScale(k);
    }
    if (this.celebrateT >= 0) {
      this.celebrateT += dt;
      const t = this.celebrateT / 1000;
      // a quick pop (1 → 1.22 → 1.06) then a slow breathing glow
      const pop = t < 0.18 ? 1 + 0.22 * (t / 0.18) : t < 0.45 ? 1.22 - 0.16 * ((t - 0.18) / 0.27) : 1.06 + 0.02 * Math.sin(t * Math.PI * 2 * 0.8);
      this.clockPlate.setScale(pop);
      this.clockGlow.setAlpha(Math.min(1, t * 4) * (0.75 + 0.25 * Math.sin(t * Math.PI * 2 * 1.2)));
    }
    const ck = clock(clockFrames);
    if (ck !== this.lastClock) {
      this.lastClock = ck;
      this.clockText.setText(ck);
    }
    // big-coin slots: outline = missing, pulsing gold = held (not yet banked), solid gold = banked
    const banked = v.big_coins_banked;
    const held = v.big_coins_held;
    this.slots.forEach((g, i) => {
      g.clear();
      const pulse = 1 + 0.14 * Math.sin((now / 1000) * Math.PI * 4);
      if (i < banked) {
        g.fillStyle(COLORS.gold, 1);
        g.fillPoints(starPoints(0, 0, 8), true);
        g.lineStyle(1.8, COLORS.blue, 1);
        g.strokePoints(starPoints(0, 0, 8), true);
      } else if (i < banked + held) {
        g.fillStyle(COLORS.gold, 0.75);
        g.fillPoints(starPoints(0, 0, 8 * pulse), true);
        g.lineStyle(1.8, COLORS.blue, 1);
        g.strokePoints(starPoints(0, 0, 8 * pulse), true);
      } else {
        g.lineStyle(1.6, COLORS.ink, 0.45);
        g.strokePoints(starPoints(0, 0, 8), true);
      }
    });
    if (this.deathText && v.deaths !== this.lastDeaths) {
      this.lastDeaths = v.deaths;
      this.deathText.setText(String(v.deaths));
    }
    if (this.hearts) {
      this.hearts.clear();
      for (let i = 0; i < this.heartMax; i++) {
        const full = i < v.hearts;
        this.hearts.fillStyle(full ? COLORS.red : COLORS.paper, 1);
        this.hearts.fillPoints(heartPoints(i * 18 + 6, 0, 7), true);
        this.hearts.lineStyle(1.6, COLORS.ink, 1);
        this.hearts.strokePoints(heartPoints(i * 18 + 6, 0, 7), true);
      }
    }
    if (this.livesText && v.lives !== null) this.livesText.setText('×' + String(v.lives));
    if (this.ring) {
      this.ring.clear();
      const left = v.timer_frames_left;
      if (left !== null && left !== undefined) {
        const total = Math.max(left, this.timerTotal ?? left);
        this.timerTotal = total;
        const f = total > 0 ? left / total : 0;
        const warn = left <= SCORING.timer_warn_s * 60;
        const k = warn ? 1 + 0.12 * Math.max(0, Math.sin((now / 1000) * Math.PI * 4)) : 1;
        this.ring.setScale(k);
        this.ring.lineStyle(2, COLORS.ink, 0.25);
        this.ring.strokeCircle(0, 0, 9);
        this.ring.lineStyle(3, warn ? COLORS.red : COLORS.green, 1);
        this.ring.beginPath();
        this.ring.arc(0, 0, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f, false);
        this.ring.strokePath();
      }
    }
    if (this.miniDot) {
      this.miniDot.clear();
      const s = this.miniW / (worldW + 4);
      const y0 = TOP + PLATE_H + 6;
      this.miniDot.lineStyle(1, COLORS.blue, 0.8);
      this.miniDot.strokeRect(this.miniX + (camX / 16 + 2) * s, y0 + 1, CAMERA.view_w_c * s, 27 + 2);
      // ghosts as small pencil dots under the player's red one
      for (const g of ghosts) {
        this.miniDot.fillStyle(g.color, 0.75);
        this.miniDot.fillCircle(this.miniX + (g.x + 2) * s, y0 + (g.y + 2) - 1, 1.3);
      }
      this.miniDot.fillStyle(COLORS.red, 1);
      this.miniDot.fillCircle(this.miniX + (v.player.x + 2) * s, y0 + (v.player.y + 2) - 1, 1.6);
    }
  }

  destroy(): void {
    this.layer.destroy();
  }
}
