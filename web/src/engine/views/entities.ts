/**
 * Entity views (PLAN_V2 §7.6, §7.1): the kid's own sprites, alive. Enemies waddle (±6° at 3 Hz, 1 px bob), watch
 * the player with their eyes and flash an angry outline within 4 cells; a stomp flattens them to 25% and they puff
 * away over 300 ms. Flags wave; checkpoints unfurl; saws spin; spikes shimmer 1 px; moving platforms trail speed ticks
 * above 2 c/s; crumbles shake. Designer pencil additions sketch themselves in (400 ms reveal) on first sight.
 * Every view is built behind a guard: a broken entity is switched off and reported (`entity_error`), never fatal.
 *
 * v4 (docs/v4/CONTRACTS_V4.md §5): portals swirl in their pair's colour and whirl when used; zones animate their
 * effect (wind streaks and conveyor chevrons toward `dir`, rolling water, ice glints, floating dots, mud bubbles);
 * pickups bob and vanish while `used`, popping back on respawn; npcs breathe under a "…" hint that hides while they
 * talk. Hidden entities are not drawn: one a rule shows or hides fades instead of playing its type's "gone". While
 * enemies are frozen they turn ice-blue and stand still.
 *
 * Skins (docs/v3 "Skin on levels"): an entity with a generated picture swaps its ink for that picture (on the skin
 * layer, outside the ink boil) and keeps every bit of juice: waddle, squash and stretch, the stomp puff, door slides,
 * the goal's cheer; a skinned enemy also mirrors when it turns around (drawn the way it faced at spawn).
 */
import Phaser from 'phaser';
import type { ArtDoc, ArtPath, ArtSprite } from '../../core/art/types.ts';
import { hash32, rng } from '../../core/art/geom.ts';
import { ZONE_LOOK } from '../../core/art/v4art.ts';
import type { EntityView, SimEvent } from '../../core/sim/types.ts';
import type { Dir4, Entity, LevelV2, RectCells } from '../../core/types.gen.ts';
import { ART, HAZARDS, RIG } from '../../core/params.ts';
import { drawPaths } from '../../render/canvas_ink.ts';
import { bake, boxOf, CELL, imageOf, VIEW_W_PX } from '../gfx.ts';
import type { Baked, TexBank } from '../gfx.ts';
import { COLORS, ICE } from './juice.ts';

const BAKE_PX = 2;
const COLOR_RED = 0xe0453a;
const DEG = Math.PI / 180;
/** v4 entity types: hidden (inactive) means not drawn, whatever the reason. */
const V4_TYPES = new Set(['portal', 'zone', 'pickup', 'npc']);
const SHOW_MS = 180; // a rule showing or hiding an entity fades it over this

const hexNum = (s: string): number => parseInt(s.slice(1), 16);
const wrap = (v: number, n: number): number => ((v % n) + n) % n;

function dirVec(d: Dir4 | undefined): [number, number] {
  return d === 'left' ? [-1, 0] : d === 'up' ? [0, -1] : d === 'down' ? [0, 1] : [1, 0];
}

export interface EntityHost {
  scene: Phaser.Scene;
  bank: TexBank;
  doc: ArtDoc;
  layer: Phaser.GameObjects.Layer;
  reduced: boolean;
  onError(e: Entity, err: unknown): void;
  /** The entity's skin picture (origin = the sprite anchor), or null for its ink. */
  skinFor?(e: Entity): Baked | null;
  /** Where skinned entities live (a camera without the ink boil); defaults to `layer`. */
  skinLayer?: Phaser.GameObjects.Layer;
  /** v4: entities a rule shows or hides (or that start hidden): inactive = faded out, never "dead" or "open". */
  toggleable?: ReadonlySet<string>;
}

export interface FrameCtx {
  now: number; // ms
  dt: number; // ms (scaled)
  frame: number; // sim frame
  alpha: number; // interpolation
  player: [number, number]; // px (feet)
  camX: number; // px
  /** v4: enemies are frozen (effects.freeze_f ≠ 0): they tint ice-blue and stop waddling. */
  frozen?: boolean;
  /** v4: who the speech bubble belongs to (an npc hides its "…" hint while it talks). */
  sayTarget?: string | null;
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
  private skin: Baked | null = null; // the generated picture standing in for the ink
  private inkKeys: string[] = []; // textures this view baked from ink (dropped when a picture replaces them)
  private face0 = 0; // a skinned enemy's facing at spawn (the way its picture is drawn)
  private faceNow = 0;
  private popAt = -1; // ms the "just arrived" pop started; -2 = on the next frame
  // ---- v4 ----
  private readonly toggleable: boolean; // shown / hidden by a rule: fades instead of its type's "gone"
  private showK: number; // 0..1, the fade of a hidden / shown entity
  private wasFrozen = false;
  private wasUsed = false; // a pickup that was collected (comes back with a pop)
  private spinA = 0; // a portal's swirl angle
  private spinBoost = 0; // a portal just used: it whirls faster for a moment
  private fx: Phaser.GameObjects.Graphics | null = null; // a zone's moving glyphs
  private motes: { a: number; b: number; c: number }[] = [];
  private hint: Phaser.GameObjects.Graphics | null = null; // an npc's "…" bubble
  private hintK = 0.6;
  private readonly inkBox: RectCells; // the drawn body without the engine-animated bits (zone glyph, npc bubble)

  constructor(host: EntityHost, e: Entity, sprite: ArtSprite, skin: Baked | null = null) {
    this.host = host;
    this.e = e;
    this.sprite = sprite;
    const s = host.scene;
    this.root = s.add.container(sprite.anchor[0] * CELL, sprite.anchor[1] * CELL);
    this.phase0 = (sprite.anchor[0] * 0.37) % 1;
    this.toggleable = !!host.toggleable?.has(e.id);
    this.showK = e.hidden ? 0 : 1;
    const body = sprite.paths.filter((p) => p.part !== 'shine');
    this.inkBox = body.length && body.length < sprite.paths.length ? boxOf(body) : sprite.bbox;
    const name = `e_${e.id}`;
    const fireballs = e.type === 'firebar';
    this.buildLook(skin);
    this.placeRoot();
    if (e.type === 'zone' && !host.reduced) {
      this.fx = s.add.graphics();
      this.root.add(this.fx);
      const r = rng(hash32(`zone:${e.id}`));
      const n = Math.max(4, Math.min(14, Math.round((e.w * e.h) / 2)));
      for (let i = 0; i < n; i++) this.motes.push({ a: r(), b: r(), c: (i + 0.2 + r() * 0.6) / n });
    }
    if (e.type === 'npc') {
      this.hint = s.add.graphics();
      this.root.add(this.hint);
      this.drawHint();
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
    if (e.type === 'checkpoint') this.unfurl = 0.28;
    if (sprite.designer && !host.reduced) {
      this.revealT = -2; // waiting for first sight
      this.root.setAlpha(0);
    }
  }

  /** The look: the generated picture, or the kid's ink (main body, watching eyes, waving cloth). Bottom of the root. */
  private buildLook(skin: Baked | null): void {
    const host = this.host;
    const s = host.scene;
    const e = this.e;
    const sprite = this.sprite;
    const name = `e_${e.id}`;
    let at = 0;
    this.skin = skin;
    if (skin) {
      this.mainBaked = skin;
      this.main = imageOf(s, skin);
      this.root.addAt(this.main, at++);
    } else {
      const isFlag = e.type === 'goal' || e.type === 'checkpoint';
      const clothPaths = isFlag ? sprite.paths.filter((p) => p.part === 'cloth') : [];
      const eyePaths = e.type === 'enemy' ? sprite.paths.filter((p) => p.part === 'eye') : [];
      // v4: a zone's glyph and an npc's "…" bubble move, so the engine draws them itself (a still glyph when reduced)
      const animated = (e.type === 'zone' && !host.reduced) || e.type === 'npc';
      const shinePaths = animated ? sprite.paths.filter((p) => p.part === 'shine') : [];
      const mainPaths = sprite.paths.filter((p) => !clothPaths.includes(p) && !eyePaths.includes(p) && !shinePaths.includes(p));
      if (mainPaths.length) {
        this.mainBaked = bake(host.bank, host.doc, name, mainPaths, BAKE_PX);
        this.inkKeys.push(this.mainBaked.key);
        this.main = imageOf(s, this.mainBaked);
        this.root.addAt(this.main, at++);
      }
      for (const p of eyePaths) {
        const b = boxOf([p]);
        const c: [number, number] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
        const bk = bake(host.bank, host.doc, `${name}_eye`, [p], BAKE_PX * 2, c);
        this.inkKeys.push(bk.key);
        const img = imageOf(s, bk, c[0] * CELL, c[1] * CELL);
        this.root.addAt(img, at++);
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
          this.inkKeys.push(tex.key);
          const img = s.add.image(box[0] * CELL, box[1] * CELL, tex).setOrigin(0, 0).setScale(1 / BAKE_PX);
          this.root.addAt(img, at++);
          this.cloth = { tex, img, paths: clothPaths, box, poleX };
          this.drawCloth(0);
        }
      }
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
  }

  private clearLook(): void {
    this.main?.destroy();
    this.main = null;
    this.mainBaked = null;
    this.glow = null;
    for (const eye of this.eyes) eye.img.destroy();
    this.eyes = [];
    this.cloth?.img.destroy();
    this.cloth = null;
    for (const k of this.inkKeys) this.host.bank.remove(k);
    this.inkKeys = [];
  }

  /** Skinned views live on the skin layer (no ink boil), above the static pictures; ink views stay on the ink layer. */
  private placeRoot(): void {
    const layer = this.skin && this.host.skinLayer ? this.host.skinLayer : this.host.layer;
    layer.add(this.root);
    this.root.setDepth(this.skin ? ART.depths.entities : 0);
  }

  /** Swap the look in place (a fly-in landing, a picture that finished loading); the entity's state is untouched. */
  setSkin(skin: Baked | null, pop: boolean): void {
    if ((skin?.key ?? null) === (this.skin?.key ?? null)) return;
    this.clearLook();
    this.buildLook(skin);
    this.placeRoot();
    if (this.revealT >= 0) this.revealT = -1;
    if (this.revealT === -1 && this.main) this.main.setCrop();
    if (pop && skin && !this.host.reduced) this.popAt = -2;
  }

  get skinned(): boolean {
    return !!this.skin;
  }

  /** World px box of what is drawn, at the view's current position (rotation and squash ignored). */
  worldBox(): [number, number, number, number] {
    const x = this.root.x;
    const y = this.root.y;
    if (this.mainBaked && this.skin) {
      const b = this.mainBaked;
      return [x - b.ox * b.w, y - b.oy * b.h, x + (1 - b.ox) * b.w, y + (1 - b.oy) * b.h];
    }
    const bb = this.inkBox;
    return [x + bb[0] * CELL, y + bb[1] * CELL, x + bb[2] * CELL, y + bb[3] * CELL];
  }

  /** True while drawn (a hidden v4 entity, a collected pickup are not). */
  get shown(): boolean {
    return this.root.visible && this.root.alpha > 0.05;
  }

  /** The npc's "…" bubble, just above its head (a hint that touching it talks). */
  private drawHint(): void {
    const g = this.hint;
    if (!g || this.e.type !== 'npc') return;
    const h = Math.max(1, Math.min(4, this.e.h ?? 1.8));
    const w = Math.max(0.8, Math.min(3, this.e.w ?? 1.2));
    const top = Math.min(-h, this.inkBox[1]) * CELL;
    const x0 = w * 0.2 * CELL;
    const y0 = top - 15;
    g.clear();
    g.fillStyle(COLORS.paper, 0.96);
    g.lineStyle(1.8, COLORS.ink, 1);
    g.fillRoundedRect(x0, y0, 19, 11, 4);
    g.strokeRoundedRect(x0, y0, 19, 11, 4);
    g.fillTriangle(x0 + 4, y0 + 10, x0 + 9, y0 + 10, x0 + 2, y0 + 15);
    g.lineBetween(x0 + 4, y0 + 11, x0 + 2, y0 + 15);
    g.lineBetween(x0 + 2, y0 + 15, x0 + 9, y0 + 11);
    g.fillStyle(COLORS.ink, 1);
    for (let k = 0; k < 3; k++) g.fillCircle(x0 + 5 + k * 4.5, y0 + 5.5, 1.3);
  }

  /** A zone's moving glyphs (local px, box 0..w × 0..h): the effect at a glance, toward its `dir`. */
  private drawZone(t: number): void {
    const g = this.fx;
    if (!g || this.e.type !== 'zone') return;
    const e = this.e;
    const W = e.w * CELL;
    const H = e.h * CELL;
    const str = Math.max(0.3, Math.min(3, e.strength ?? 1));
    const col = hexNum((ZONE_LOOK[e.effect] ?? ZONE_LOOK.wind).line);
    const [dx, dy] = dirVec(e.dir);
    g.clear();
    switch (e.effect) {
      case 'wind': {
        // streaks blowing through toward dir
        const span = dx ? W : H;
        for (const m of this.motes) {
          const along = wrap(m.a * span + t * 80 * str, span);
          const L = 9 + 9 * m.b;
          const x = dx ? (dx > 0 ? along : W - along) : m.c * W;
          const y = dx ? m.c * H : dy > 0 ? along : H - along;
          const fade = Math.max(0, Math.min(1, along / 14, (span - along) / 14));
          g.lineStyle(1.6, col, 0.6 * fade);
          g.lineBetween(x - dx * L, y - dy * L, x, y);
        }
        break;
      }
      case 'conveyor': {
        // chevrons marching along the middle of the strip
        const span = dx ? W : H;
        const step = 14;
        const off = wrap(t * 40 * str, step);
        g.lineStyle(2.2, col, 0.5);
        for (let s = off - step; s < span + step; s += step) {
          const a = dx > 0 || dy > 0 ? s : span - s;
          if (a < 3 || a > span - 3) continue;
          const cx = dx ? a : W / 2;
          const cy = dx ? H / 2 : a;
          const q = 4;
          g.lineBetween(cx - dx * q - dy * q, cy - dy * q - dx * q, cx, cy);
          g.lineBetween(cx - dx * q + dy * q, cy - dy * q + dx * q, cx, cy);
        }
        break;
      }
      case 'water': {
        // two waves rolling along the surface, bubbles rising
        g.lineStyle(1.6, col, 0.55);
        for (const [yy, ph] of [[3, 0], [9, 1.7]] as const) {
          if (yy > H - 2) continue;
          g.beginPath();
          for (let x = 2; x <= W - 2; x += 5) {
            const y = yy + Math.sin(x / 11 + t * 2.4 + ph) * 1.6;
            if (x === 2) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.strokePath();
        }
        for (const m of this.motes) {
          const y = H - wrap(m.a * H + t * 16, H);
          if (y < 12) continue;
          g.lineStyle(1.2, col, 0.45);
          g.strokeCircle(m.c * W + Math.sin(t * 2 + m.b * 6) * 2, y, 1.4 + m.b * 1.4);
        }
        break;
      }
      case 'ice':
        // glints that twinkle on and off
        for (const m of this.motes) {
          const k = Math.max(0, Math.sin(t * 2.6 + m.a * 6.28));
          if (k < 0.05) continue;
          const s = 1.5 + 3 * k;
          const x = m.c * W;
          const y = 3 + m.b * (H - 6);
          g.lineStyle(1.4, col, 0.8 * k);
          g.lineBetween(x - s, y, x + s, y);
          g.lineBetween(x, y - s, x, y + s);
        }
        break;
      case 'low_gravity':
        // dots floating slowly up
        for (const m of this.motes) {
          const y = H - wrap(m.a * H + t * 10, H);
          const fade = Math.max(0, Math.min(1, y / 10, (H - y) / 10));
          g.fillStyle(col, 0.45 * fade);
          g.fillCircle(m.c * W + Math.sin(t * 0.9 + m.b * 6) * 3, y, 1.2 + m.b * 1.6);
        }
        break;
      case 'slow':
        // mud bubbles that swell and pop
        for (const m of this.motes) {
          const ph = wrap(t * 0.5 + m.a, 1);
          g.lineStyle(1.3, col, 0.55 * (1 - ph));
          g.strokeCircle(m.c * W, H - 3 - m.b * Math.min(H * 0.6, 20), 1 + ph * 4);
        }
        break;
      default:
        break;
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
        if (this.skin && !this.host.reduced) this.popAt = -2; // a picture has no cloth to unfurl: it hops instead
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
      default: {
        // v4 events (the core's SimEvent union may not list them yet)
        const t = ev.type as string;
        if ((t === 'portal' || t === 'teleport') && this.e.type === 'portal') {
          this.spinBoost = 1;
          if (!this.host.reduced) this.popAt = -2;
        }
        break;
      }
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
    const nowActive = cur ? cur.active : !e.hidden;
    // v4: a hidden entity is not drawn; one a rule shows or hides fades, and its type's own "gone" (a stomp puff, a
    // door sliding open) never plays for it
    const ruleVis = this.toggleable || V4_TYPES.has(e.type);
    const alive = this.toggleable ? true : nowActive;
    // cull rendering outside camera + 4 cells (still simulated)
    const margin = 4 * CELL + Math.max(this.mainBaked?.w ?? 32, 32);
    const visible = x > f.camX - margin && x < f.camX + VIEW_W_PX + margin;
    this.root.setVisible(visible);
    if (!visible) {
      this.active = alive;
      if (ruleVis) this.showK = nowActive ? 1 : 0;
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
        const x0 = this.lastX;
        const moving = Number.isFinite(x0) && Math.abs(x - x0) > 0.05;
        this.lastX = x;
        // v4 freeze_enemies: ice-blue and still (contact still hurts)
        const frozen = !!f.frozen && alive;
        if (moving && !frozen && !this.host.reduced) {
          rot = Math.sin(t * Math.PI * 2 * RIG.enemy.waddle_hz) * RIG.enemy.waddle_deg * DEG;
          oy = -Math.abs(Math.sin(t * Math.PI * 2 * RIG.enemy.waddle_hz)) * RIG.enemy.bob_px;
        }
        const dx = f.player[0] - x;
        const dy = f.player[1] - 14 - (y - 10);
        const near = Math.hypot(dx, dy) < RIG.enemy.angry_c * CELL;
        if (frozen) {
          if (this.glow) this.glow.active = false;
          this.main?.setTint(ICE);
        } else if (this.glow) {
          this.glow.active = near && alive;
          if (this.wasFrozen) this.main?.clearTint();
        } else if (this.main) {
          if (near && alive) this.main.setTint(0xffb0a8);
          else this.main.clearTint();
        }
        this.wasFrozen = frozen;
        const L = Math.hypot(dx, dy) || 1;
        for (const eye of this.eyes) eye.img.setPosition(eye.base[0] + (dx / L) * RIG.idle.pupil_px, eye.base[1] + (dy / L) * RIG.idle.pupil_px);
        if (this.active && !alive) this.deadT = 0;
        if (alive) this.deadT = -1;
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
        this.alertG?.setVisible(alert && alive);
        for (const eye of this.eyes) {
          if (alert) eye.img.setTint(COLOR_RED);
          else eye.img.clearTint();
        }
        const facing = cur?.facing ?? (e.params?.facing === 'left' ? -1 : 1);
        if (this.skin) {
          // the picture is drawn the way the enemy faced at spawn: mirror it whenever it walks the other way
          const f = cur?.facing ?? (moving ? (x > x0 ? 1 : -1) : 0);
          if (f) {
            if (!this.face0) this.face0 = f;
            this.faceNow = f;
          }
          if (this.face0 && this.faceNow) sx *= this.faceNow * this.face0;
        } else if (this.sprite.source === 'house' && (e.archetype === 'shooter' || e.archetype === 'chaser' || e.archetype === 'crusher')) sx *= facing;
        break;
      }
      case 'coin':
        oy = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 1.2) * 1;
        a = (alive ? 1 : 0);
        break;
      case 'big_coin': {
        const k = this.host.reduced ? 1 : 1 + 0.06 * Math.sin(t * Math.PI * 2 * 1.4);
        sx = k;
        sy = k;
        rot = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 0.5) * 6 * DEG;
        // held (collected, not yet banked) shows in the HUD slot, not in the world
        a = alive && st !== 'held' && st !== 'banked' ? 1 : 0;
        break;
      }
      case 'key':
        oy = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 0.9) * 1.5;
        a = (alive ? 1 : 0);
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
        a = (alive ? 1 : 0);
        break;
      case 'door': {
        if (this.active && !alive && this.openT < 0) this.openT = 0;
        if (alive) this.openT = -1;
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
      // ---- v4 ----
      case 'portal': {
        // the house swirl turns slowly; a portal just used whirls (a kid's own drawing only rocks, then whirls)
        this.spinBoost = Math.max(0, this.spinBoost - f.dt / 700);
        if (!this.host.reduced) {
          const base = this.sprite.source === 'house' ? 0.45 : 0;
          this.spinA += (f.dt / 1000) * Math.PI * 2 * (base + 2.2 * this.spinBoost * this.spinBoost);
          rot = this.spinA + (base ? 0 : Math.sin(t * Math.PI * 2 * 0.7) * 6 * DEG);
          const k = 1 + 0.04 * Math.sin(t * Math.PI * 2 * 1.2);
          sx = k;
          sy = k;
        }
        // cooling down after a trip: a little faded
        if (st === 'used') a = 0.6;
        break;
      }
      case 'zone':
        if (this.fx) {
          this.drawZone(f.now / 1000 + this.phase0 * 10);
          // the player inside ('used'): the motion shows a little stronger
          this.fx.setAlpha(st === 'used' ? 1 : 0.75);
        }
        break;
      case 'pickup': {
        oy = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 1.1) * 1.5;
        rot = this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 0.6) * 5 * DEG;
        // collected: gone until it respawns, then it pops back in
        const used = st === 'used';
        if (this.wasUsed && !used && nowActive && !this.host.reduced) this.popAt = -2;
        this.wasUsed = used;
        a = used ? 0 : 1;
        break;
      }
      case 'npc': {
        if (!this.host.reduced) {
          const br = 1 + 0.025 * Math.sin(t * Math.PI * 2 * 0.6);
          sy *= br;
          sx *= 2 - br;
        }
        if (this.hint) {
          // the "…" hint: brighter when you are close, gone while it talks
          const talking = f.sayTarget === e.id;
          const near = Math.hypot(f.player[0] - x, f.player[1] - y) < 5 * CELL;
          const want = talking ? 0 : near ? 1 : 0.55;
          const step = this.host.reduced ? 1 : f.dt / 200;
          this.hintK = want > this.hintK ? Math.min(want, this.hintK + step) : Math.max(want, this.hintK - step);
          this.hint.setAlpha(this.hintK).setY(this.host.reduced ? 0 : Math.sin(t * Math.PI * 2 * 0.8) * 1.5);
        }
        break;
      }
      default:
        break;
    }
    // v4: shown / hidden (a toggle rule, an entity that starts hidden, any hidden v4 entity) fades in and out
    if (ruleVis) {
      const want = nowActive ? 1 : 0;
      const step = this.host.reduced ? 1 : f.dt / SHOW_MS;
      this.showK = want > this.showK ? Math.min(want, this.showK + step) : Math.max(want, this.showK - step);
      a *= this.showK;
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
    // a picture that just arrived (fly-in) lands with a little bounce, in real time (also while paused)
    if (this.popAt !== -1) {
      if (this.popAt === -2) this.popAt = f.now;
      const k = Math.min(1, (f.now - this.popAt) / 280);
      const b = 1 + 0.2 * Math.sin(k * Math.PI) * (1 - k * 0.5);
      sx *= b;
      sy *= b;
      if (k >= 1) this.popAt = -1;
    }
    if (this.morph.t >= 0) {
      this.morph.t += f.dt;
      const k = Math.min(1, this.morph.t / this.morph.dur);
      const ease = 1 - (1 - k) * (1 - k) * (1 - k);
      ox += this.morph.dx * (1 - ease);
      oy += this.morph.dy * (1 - ease);
      if (k >= 1) this.morph.t = -1;
    }
    this.active = alive;
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
        this.views.set(e.id, new EView(host, e, sp, host.skinFor?.(e) ?? null));
      } catch (err) {
        host.onError(e, err);
      }
    }
  }

  get(id: string): EView | undefined {
    return this.views.get(id);
  }

  /** Swap one entity's look for its skin picture (null = back to the kid's ink) without rebuilding anything else. */
  reskin(id: string, skin: Baked | null, pop: boolean): void {
    const v = this.views.get(id);
    if (!v) return;
    try {
      v.setSkin(skin, pop);
    } catch (err) {
      console.warn('entity reskin failed; keeping its drawing', id, err);
      try {
        v.setSkin(null, false);
      } catch {
        this.host.onError(v.e, err);
        v.destroy();
        this.views.delete(id);
      }
    }
  }

  /** World px box of an entity (by its id, or by a scene object it draws) where it is now. */
  worldBox(id: string): [number, number, number, number] | null {
    let v = this.views.get(id);
    if (!v) {
      for (const x of this.views.values()) {
        if (x.sprite.object_ids.includes(id)) {
          v = x;
          break;
        }
      }
    }
    return v ? v.worldBox() : null;
  }

  /** World px centre of an entity's drawing where it is now (juice for v4 events), or null when unknown. */
  centre(id: string): [number, number] | null {
    const b = this.worldBox(id);
    return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
  }

  /** Visible enemies' centres (world px): the freeze glints. */
  enemyCentres(): [number, number][] {
    const out: [number, number][] = [];
    for (const v of this.views.values()) {
      if (v.e.type !== 'enemy' || !v.shown) continue;
      const b = v.worldBox();
      out.push([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    }
    return out;
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
      if (!v.active || (v.type !== 'enemy' && v.type !== 'coin' && v.type !== 'big_coin' && v.type !== 'pickup') || v.state === 'used') continue;
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

