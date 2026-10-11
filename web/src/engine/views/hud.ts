/**
 * HUD plates (PLAN_V2 §7.9, §5.9, §6.2): paper rounded rectangles with a 2 px marker outline and ±1° rotation, on
 * their own camera (no zoom, no shake). Left: coins + 3 big-coin slots (pulsing until banked). Centre: the clock
 * m:ss.cc (+ the timer ring that pulses in the last 10 s). Right: deaths (skull doodle), hearts and lives when
 * enabled. The minimap strip (1 px per cell: terrain, goal, checkpoints, player dot) appears for levels > 1 screen.
 * Mute / restart / pause are DOM buttons beside it (engine/chrome.ts) so they stay accessible.
 * v4 (docs/v4/CONTRACTS_V4.md §4.2) adds a second row: the score (when a rule uses it) and the rule counters as small
 * labelled chips on the left, and the timed effects (speed, jump, gravity, reversed controls, frozen enemies, flipped
 * gravity) as rings that empty as they run out, under the clock.
 */
import Phaser from 'phaser';
import type { SimView } from '../../core/sim/types.ts';
import type { LevelV2 } from '../../core/types.gen.ts';
import { CAMERA, SCORING, UI } from '../../core/params.ts';
import { decodeGrid } from '../../core/art/terrain.ts';
import { msg } from '../../render/text.ts';
import { levelUsesScore, v4Of } from '../v4.ts';
import { counterChips, EffectClock, layoutRow } from './hudmodel.ts';
import type { EffectChip, EffectKind } from './hudmodel.ts';
import { COLORS, ICE } from './juice.ts';
import { VIEW_H_PX, VIEW_W_PX } from '../gfx.ts';
import type { TexBank } from '../gfx.ts';

export const HUD_FONT = '"Patrick Hand", "Comic Sans MS", "Chalkboard SE", "Marker Felt", "Segoe Print", system-ui, sans-serif';
const DEG = Math.PI / 180;
const PLATE_H = 30;
const TOP = 8;
// the v4 row under the plates
const ROW_Y = TOP + PLATE_H + 20; // chip centre line
const CHIP_H = 24;
const RING_R = 11;
const RING_STEP = 28;
const ORANGE = 0xf08a24;

const EFFECT_COLOR: Record<EffectKind, number> = {
  speed: ORANGE, jump: COLORS.green, gravity: COLORS.violet, reverse: COLORS.red, freeze: COLORS.blue, flip: COLORS.violet,
};

interface Chip {
  c: Phaser.GameObjects.Container;
  g: Phaser.GameObjects.Graphics;
  t: Phaser.GameObjects.Text;
  w: number;
  key: string;
}

/** An effect's little glyph, drawn in its colour about (x, y). */
function effectIcon(g: Phaser.GameObjects.Graphics, kind: EffectKind, x: number, y: number): void {
  const c = EFFECT_COLOR[kind];
  g.lineStyle(2, c, 1);
  const arrow = (x0: number, y0: number, x1: number, y1: number): void => {
    g.lineBetween(x0, y0, x1, y1);
    const a = Math.atan2(y1 - y0, x1 - x0);
    g.lineBetween(x1, y1, x1 - Math.cos(a - 0.6) * 3.6, y1 - Math.sin(a - 0.6) * 3.6);
    g.lineBetween(x1, y1, x1 - Math.cos(a + 0.6) * 3.6, y1 - Math.sin(a + 0.6) * 3.6);
  };
  switch (kind) {
    case 'speed':
      for (const dx of [-3, 2]) {
        g.lineBetween(x + dx - 2, y - 4, x + dx + 2, y);
        g.lineBetween(x + dx + 2, y, x + dx - 2, y + 4);
      }
      break;
    case 'jump':
      arrow(x, y + 4, x, y - 5);
      g.lineBetween(x - 4, y + 5, x + 4, y + 5);
      break;
    case 'gravity':
      g.fillStyle(c, 1);
      g.fillCircle(x, y - 3.5, 2.8);
      arrow(x, y, x, y + 5.5);
      break;
    case 'reverse':
      arrow(x - 5, y - 2.5, x + 5, y - 2.5);
      arrow(x + 5, y + 2.5, x - 5, y + 2.5);
      break;
    case 'freeze':
      g.lineStyle(1.8, c, 1);
      for (let k = 0; k < 3; k++) {
        const a = (k * Math.PI) / 3 + Math.PI / 2;
        g.lineBetween(x - Math.cos(a) * 5.5, y - Math.sin(a) * 5.5, x + Math.cos(a) * 5.5, y + Math.sin(a) * 5.5);
      }
      break;
    case 'flip':
      arrow(x, y + 1, x, y - 5.5);
      arrow(x, y - 1, x, y + 5.5);
      break;
  }
}

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
  // v4 row
  private scoreOn: boolean;
  private chips: Chip[] = [];
  private chipPulse = new Map<string, number>();
  private effects: Phaser.GameObjects.Graphics;
  private effectClock = new EffectClock();
  private effectsDrawn = false;

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
    // v4 row: chips appear as the sim reports a score or counters; effect rings under the clock
    this.scoreOn = levelUsesScore(level);
    this.effects = scene.add.graphics();
    this.layer.add(this.effects);
  }

  // ---- v4 row ----------------------------------------------------------------------------------------------------

  /** A small paper chip (score, a counter) whose text and width follow its value. */
  private chip(key: string): Chip {
    const have = this.chips.find((c) => c.key === key);
    if (have) return have;
    const c = this.scene.add.container(0, ROW_Y).setRotation((this.chips.length % 2 ? 0.8 : -0.8) * DEG);
    const g = this.scene.add.graphics();
    const t = this.scene.add.text(0, 0, '', { fontFamily: HUD_FONT, fontSize: '16px', color: '#1F1B18', resolution: this.r }).setOrigin(0.5, 0.5);
    this.texts.push(t);
    c.add([g, t]);
    this.layer.add(c);
    const chip = { c, g, t, w: 0, key };
    this.chips.push(chip);
    return chip;
  }

  private setChip(ch: Chip, text: string): void {
    if (ch.t.text !== text) ch.t.setText(text);
    const w = Math.ceil(ch.t.width) + 20;
    if (w === ch.w) return;
    ch.w = w;
    ch.g.clear();
    ch.g.fillStyle(COLORS.paper, 0.95);
    ch.g.fillRoundedRect(-w / 2, -CHIP_H / 2, w, CHIP_H, 8);
    ch.g.lineStyle(UI.hud_outline_px, COLORS.ink, 1);
    ch.g.strokeRoundedRect(-w / 2, -CHIP_H / 2, w, CHIP_H, 8);
  }

  /** The score chip pops (a `score` event); a counter's chip pops when its value changes. */
  pulseScore(): void {
    this.chipPulse.set('score', 1);
  }

  private updateRow(v: SimView, dt: number): void {
    const x = v4Of(v);
    const want: { key: string; text: string; n: number }[] = [];
    if (this.scoreOn || x.score !== 0) want.push({ key: 'score', text: msg('hud.score', { n: x.score }, 'Score {n}'), n: x.score });
    for (const c of counterChips(x.counters)) want.push({ key: `c:${c.name}`, text: msg('hud.counter', { name: c.name, n: c.n }, '{name}: {n}'), n: c.n });
    const shown = want.map((w) => {
      const ch = this.chip(w.key);
      if (w.key !== 'score' && ch.t.text && ch.t.text !== w.text) this.chipPulse.set(w.key, 1);
      this.setChip(ch, w.text);
      return ch;
    });
    // left-aligned under the coins, clear of the effect rings under the clock (and of the minimap on the right)
    const maxX = VIEW_W_PX / 2 - RING_STEP * 3 - 8;
    const xs = layoutRow(shown.map((c) => c.w), 8, 6, maxX);
    for (const ch of this.chips) {
      const i = shown.indexOf(ch);
      const on = i >= 0 && i < xs.length;
      ch.c.setVisible(on);
      if (!on) continue;
      ch.c.setX(xs[i] + ch.w / 2);
      const p = this.chipPulse.get(ch.key) ?? 0;
      if (p > 0) {
        const left = Math.max(0, p - dt / 220);
        this.chipPulse.set(ch.key, left);
        ch.c.setScale(1 + 0.14 * Math.sin(left * Math.PI));
      }
    }
    this.drawEffects(this.effectClock.update(x.effects, x.gravity));
  }

  /** Effect rings centred under the clock: the coloured arc empties as the effect runs out (dashed = until respawn). */
  private drawEffects(list: EffectChip[]): void {
    const g = this.effects;
    if (!list.length) {
      if (this.effectsDrawn) g.clear();
      this.effectsDrawn = false;
      return;
    }
    this.effectsDrawn = true;
    g.clear();
    const x0 = VIEW_W_PX / 2 - ((list.length - 1) * RING_STEP) / 2;
    list.forEach((e, i) => {
      const cx = x0 + i * RING_STEP;
      const c = EFFECT_COLOR[e.kind];
      g.fillStyle(e.kind === 'freeze' ? ICE : COLORS.paper, e.kind === 'freeze' ? 0.55 : 0.95);
      g.fillCircle(cx, ROW_Y, RING_R);
      g.lineStyle(1.4, COLORS.ink, 0.35);
      g.strokeCircle(cx, ROW_Y, RING_R);
      g.lineStyle(2.8, c, 1);
      if (e.forever) {
        for (let k = 0; k < 8; k++) {
          g.beginPath();
          g.arc(cx, ROW_Y, RING_R, (k / 8) * Math.PI * 2, (k / 8) * Math.PI * 2 + 0.45, false);
          g.strokePath();
        }
      } else {
        g.beginPath();
        g.arc(cx, ROW_Y, RING_R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, e.frac), false);
        g.strokePath();
      }
      effectIcon(g, e.kind, cx, ROW_Y);
    });
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
    this.updateRow(v, dt);
  }

  destroy(): void {
    this.layer.destroy();
  }
}
