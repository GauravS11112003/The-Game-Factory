/**
 * Ghosts (PLAN_V2 §8.4, §7.10 "Watch the bot"): up to 3 deterministic input replays (your PB, the leader, the
 * challenger, or the bot), each run by its own core Sim and drawn with the same PlayerView, so ghosts animate exactly
 * like the player. Each is a 45%-alpha pencil copy of the runner's own character: the runner's strokes when given,
 * else the runner's sprite PNG (pencilized), else the level's character; the bot is graphite-violet pencil.
 *
 * Sync:
 * - race (play / test): a ghost's clock starts with yours. It waits at the start until your first input, then runs in
 *   lockstep with your sim frames from its own first input, so crossing the goal together means the same time on the
 *   speedrun clock. After you win, ghosts keep running in real time so you see them come in behind you.
 * - free (preview, "Watch the bot"): the ghost runs at 1× from the mount, loops after it finishes, and the camera
 *   follows it until the kid takes the controls.
 * A ghost's death shatters and gathers like the player's; at the goal it pins a pencil tag with its time. Off-screen
 * ghosts show an edge marker with their distance. Replays made on another version of the level are skipped.
 */
import Phaser from 'phaser';
import type { ArtDoc } from '../../core/art/types.ts';
import { buildPlayerArt } from '../../core/art/player.ts';
import { baseStyles, StyleBook } from '../../core/art/styles.ts';
import { decodeReplay, levelHash } from '../../core/index.ts';
import type { CameraState, Sim, SimEvent, SimView } from '../../core/sim/types.ts';
import type { InkStroke, LevelV2, Replay } from '../../core/types.gen.ts';
import { PROFILES } from '../../core/sim/profiles.ts';
import { ART, RIG, RUNS, SIM } from '../../core/params.ts';
import { loadImage, pencilize } from '../../render/pencilize.ts';
import { fmtClock } from '../../render/text.ts';
import type { GhostKind, GhostOption, GhostResult } from '../types.ts';
import { makeSim } from '../simhost.ts';
import { PlayerSprite } from './player.ts';
import type { CharacterSource } from './player.ts';
import type { TexBank } from '../gfx.ts';
import { CELL, VIEW_H_PX, VIEW_W_PX } from '../gfx.ts';
import { HUD_FONT } from './hud.ts';

export type { GhostKind, GhostResult } from '../types.ts';
export type GhostSpec = GhostOption;

const MAX_CATCHUP = 240; // sim steps per render frame when a ghost catches up (its idle lead, a rewind)
const LINGER_MS = 2000; // a finished ghost stands at the goal, then fades to a faint pencil mark
const FADED_ALPHA = 0.18;
const LOOP_GAP_MS = 1500; // a free ghost (the bot) runs again after this pause
const DEG = Math.PI / 180;

const LABEL_COLORS: Record<GhostKind, string> = {
  bot: ART.palette.pencil_violet, pb: '#3B3632', you: '#3B3632', leader: ART.palette.blue, challenger: '#B8322A', other: '#3B3632',
};

function kindOf(g: GhostSpec): GhostKind {
  if (g.kind) return g.kind;
  return /\bbot\b/i.test(g.label) ? 'bot' : 'other';
}

function firstInput(input: Uint8Array): number {
  for (let i = 0; i < input.length; i++) if (input[i] !== 0) return i;
  return 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clockMsOf(v: SimView, fallbackFrames: number): number {
  if (typeof v.time_ms === 'number') return v.time_ms;
  const f = v.clock_frames ?? fallbackFrames;
  return Math.round((f * 1000) / SIM.hz);
}

interface Layers {
  world: Phaser.GameObjects.Layer; // the in-scene actor layer (follows the camera)
  hud: Phaser.GameObjects.Layer; // the HUD camera's layer (edge markers)
}

class Ghost {
  readonly kind: GhostKind;
  readonly sync: 'race' | 'free';
  readonly label: string;
  private scene: Phaser.Scene;
  private bank: TexBank;
  private doc: ArtDoc;
  private level: LevelV2;
  private layers: Layers;
  private r: number;
  private i: number;
  private sim!: Sim;
  private input: Uint8Array;
  readonly first: number;
  private prev!: SimView;
  private cur!: SimView;
  private camPrev!: CameraState;
  private camCur!: CameraState;
  private view: PlayerSprite;
  private labelText: Phaser.GameObjects.Text;
  private tag: Phaser.GameObjects.Container | null = null;
  private edge: { c: Phaser.GameObjects.Container; t: Phaser.GameObjects.Text; arrow: Phaser.GameObjects.Graphics; side: number; text: string } | null = null;
  private ended = false; // finished, ran out of inputs, or its sim failed
  private endedAt = -1;
  finished = false;
  finishMs: number | null = null;
  freeFrames = 0;
  private stepped = 0; // steps taken in the last advance (for interpolation)
  private vmax: number;
  private destroyed = false;

  constructor(scene: Phaser.Scene, bank: TexBank, doc: ArtDoc, level: LevelV2, g: GhostSpec, layers: Layers, i: number, r: number, fallbackStrokes: InkStroke[] | null, sync: 'race' | 'free') {
    this.scene = scene;
    this.bank = bank;
    this.doc = doc;
    this.level = level;
    this.layers = layers;
    this.r = r;
    this.i = i;
    this.kind = kindOf(g);
    this.sync = g.sync ?? sync;
    this.label = g.label;
    this.input = decodeReplay(g.replay.input);
    this.first = firstInput(this.input);
    const prof = PROFILES[level.rules.physics_profile ?? 'v2-standard'] ?? PROFILES['v2-standard'];
    this.vmax = prof.run_max ?? prof.walk_max;
    this.resetSim();
    this.view = this.makeView(this.vectorSource(g.strokes ?? fallbackStrokes));
    this.labelText = scene.add.text(0, 0, g.label, { fontFamily: HUD_FONT, fontSize: '12px', color: LABEL_COLORS[this.kind], resolution: r }).setOrigin(0.5, 1).setAlpha(0.85).setDepth(ART.depths.player - 1);
    layers.world.add(this.labelText);
    // the runner's own sprite (a PNG) replaces the stand-in once it has loaded and been pencilized
    if (!g.strokes && g.sprite_url) void this.loadSprite(g.sprite_url);
  }

  private resetSim(): void {
    this.sim = makeSim(this.level).sim;
    this.prev = this.cur = this.sim.view();
    this.camPrev = this.camCur = this.sim.camera();
    this.ended = false;
    this.endedAt = -1;
    this.finished = false;
    this.finishMs = null;
    this.freeFrames = 0;
  }

  private vectorSource(strokes: InkStroke[] | null): CharacterSource {
    const b = new StyleBook(this.doc.theme);
    baseStyles(b);
    // the bot is all graphite-violet pencil; a runner keeps their own colours in pencil
    const src = strokes && this.kind === 'bot' ? strokes.map((s) => ({ ...s, color: 'pencil' as const })) : strokes;
    const art = buildPlayerArt(src, b, 77 + this.i, { ink: 'pencil' });
    const gdoc: ArtDoc = { ...this.doc, styles: { ...this.doc.styles, ...b.styles } };
    return { kind: 'vector', doc: gdoc, art };
  }

  private makeView(src: CharacterSource): PlayerSprite {
    const v = new PlayerSprite(this.scene, this.bank, src, { name: `ghost${this.i}`, alpha: RUNS.ghost_alpha, seed: this.i + 11 });
    v.root.setDepth(ART.depths.player - 1);
    v.shards.container.setDepth(ART.depths.player - 1);
    this.layers.world.add([v.root, v.shards.container]);
    return v;
  }

  private async loadSprite(url: string): Promise<void> {
    const img = await loadImage(url);
    if (!img || this.destroyed) return;
    const ps = pencilize(img, { color: this.kind === 'bot' ? ART.palette.pencil_violet : '#4B3F8F', keepHue: this.kind === 'bot' ? 0 : 0.45 });
    if (!ps || this.destroyed) return;
    const old = this.view;
    try {
      this.view = this.makeView({ kind: 'raster', canvas: ps.canvas, feet: ps.feet, px: ps.px });
      old.destroy();
    } catch (e) {
      console.warn('ghost sprite skipped', this.label, e);
    }
  }

  /** The frame this ghost should be at, given the player's frame and first input (race) or its own clock (free). */
  target(playerFrame: number, playerFirst: number | null, extra: number): number {
    if (this.sync === 'free') return this.freeFrames;
    if (playerFirst === null) return 0;
    return this.first + (playerFrame - playerFirst) + extra;
  }

  /** Step toward the target frame (≤ MAX_CATCHUP per call); returns the sim events of those steps. */
  advanceTo(target: number, now: number): SimEvent[] {
    const out: SimEvent[] = [];
    this.stepped = 0;
    if (this.ended) {
      this.prev = this.cur;
      this.camPrev = this.camCur;
      return out;
    }
    const start = this.cur;
    const camStart = this.camCur;
    while (this.sim.frame < target && this.stepped < MAX_CATCHUP) {
      const f = this.sim.frame;
      const bits = f < this.input.length ? this.input[f] : 0;
      try {
        const ev = this.sim.step(bits);
        for (const e of ev) out.push(e);
        this.cur = this.sim.view();
        this.camCur = this.sim.camera();
      } catch {
        this.end(now);
        break;
      }
      this.stepped++;
      if (this.cur.won && !this.finished) {
        this.finished = true;
        this.finishMs = clockMsOf(this.cur, f + 1 - this.first);
        this.end(now);
        break;
      }
      if (f >= this.input.length + 1) {
        // the replay ran out before the goal (an abandoned run)
        this.end(now);
        break;
      }
    }
    // interpolate across one step; a catch-up jump draws the newest state directly
    if (this.stepped === 1) {
      this.prev = start;
      this.camPrev = camStart;
    } else {
      // no step (waiting for your first input, or ended) or a catch-up: draw the newest state as is
      this.prev = this.cur;
      this.camPrev = this.camCur;
    }
    return out;
  }

  private end(now: number): void {
    this.ended = true;
    this.endedAt = now;
  }

  /** Death and respawn shards, jump / land squash, the finish tag. Big catch-up batches skip the juice. */
  events(evs: SimEvent[], quiet: boolean): void {
    for (const ev of evs) {
      const p = this.cur.player;
      switch (ev.type) {
        case 'death':
          if (quiet) break;
          this.view.hide();
          this.view.shards.burst((ev.x ?? p.x) * CELL, (ev.y ?? p.y) * CELL, p.facing);
          break;
        case 'respawn':
          if (quiet) break;
          this.view.shards.gather(p.x * CELL, p.y * CELL);
          this.view.reset(p.facing);
          break;
        case 'jump':
        case 'double_jump':
          if (!quiet) this.view.jump();
          break;
        case 'land':
          if (!quiet) this.view.land(Math.abs(ev.vy ?? this.prev.player.vy) / RIG.land_ref_vy);
          break;
        default:
          break;
      }
    }
    if (this.finished && !this.tag) this.pinTag();
  }

  /** A pencil tag at the goal: "Maya 0:41.20". */
  private pinTag(): void {
    const p = this.cur.player;
    const text = `${this.label} ${fmtClock(this.finishMs ?? 0)}`;
    const c = this.scene.add.container(p.x * CELL, p.y * CELL - this.view.height - 26).setDepth(ART.depths.player - 1);
    const t = this.scene.add.text(0, 0, text, { fontFamily: HUD_FONT, fontSize: '12px', color: LABEL_COLORS[this.kind], resolution: this.r }).setOrigin(0.5);
    const w = t.width + 14;
    const g = this.scene.add.graphics();
    g.fillStyle(0xfffdf6, 0.85);
    g.fillRoundedRect(-w / 2, -9, w, 18, 6);
    g.lineStyle(1.2, Phaser.Display.Color.HexStringToColor(LABEL_COLORS[this.kind]).color, 0.8);
    g.strokeRoundedRect(-w / 2, -9, w, 18, 6);
    // the tag's string to the flag
    g.lineBetween(0, 9, 0, 18);
    c.add([g, t]);
    c.setRotation(-2 * DEG * (this.i % 2 ? -1 : 1)).setAlpha(0);
    this.layers.world.add(c);
    this.tag = c;
  }

  /** A free ghost that has ended loops back to its start after a pause. */
  maybeLoop(now: number): void {
    if (!this.ended || this.sync !== 'free' || this.endedAt < 0) return;
    if (now - this.endedAt < (this.finished ? LINGER_MS : 0) + LOOP_GAP_MS) return;
    this.resetSim();
    this.view.shards.clear();
    this.view.show();
    this.view.reset(1);
    this.view.setAlpha(RUNS.ghost_alpha);
    this.tag?.destroy();
    this.tag = null;
  }

  render(a: number, dt: number, now: number, camX: number): void {
    const p = this.prev.player;
    const c = this.cur.player;
    const k = this.stepped > 1 ? 1 : a;
    const x = lerp(p.x, c.x, k);
    const y = lerp(p.y, c.y, k);
    const dead = c.state === 'dead';
    // a finished ghost stands at the goal, then fades to a faint pencil mark
    let alpha: number = RUNS.ghost_alpha;
    if (this.ended && this.endedAt >= 0) {
      const since = now - this.endedAt;
      if (!this.finished) alpha = RUNS.ghost_alpha * Math.max(0, 1 - since / 600); // abandoned: fade away
      else if (since > LINGER_MS) alpha = Math.max(FADED_ALPHA, RUNS.ghost_alpha * (1 - (since - LINGER_MS) / 800));
    }
    this.view.setAlpha(alpha);
    const shardsBusy = this.view.shards.update(dt);
    const hidden = dead || alpha <= 0.01 || (shardsBusy && c.state === 'respawn');
    if (hidden) this.view.hide();
    else if (this.view.isHidden && !shardsBusy) this.view.show();
    this.labelText.setVisible(!hidden && !this.finished);
    if (!this.view.isHidden) {
      this.view.pose({ x, y, vx: c.vx, vy: c.vy, facing: c.facing, onGround: c.on_ground, state: this.finished ? 'win' : c.state, invuln: 0 }, dt, now, null, this.vmax);
      this.labelText.setPosition(x * CELL, y * CELL - this.view.height - 6).setAlpha(Math.min(0.85, alpha * 2));
    }
    if (this.tag) this.tag.setAlpha(Math.min(1, this.tag.alpha + dt / 250));
    this.renderEdge(x, y, camX, hidden || this.finished || alpha < 0.2);
  }

  /** Off-screen marker at the view edge: "◀ Maya 12" (cells away). */
  private renderEdge(x: number, y: number, camX: number, off: boolean): void {
    const sx = x * CELL - camX;
    const side = off ? 0 : sx < -4 ? -1 : sx > VIEW_W_PX + 4 ? 1 : 0;
    if (!side) {
      this.edge?.c.setVisible(false);
      return;
    }
    if (!this.edge) {
      const c = this.scene.add.container(0, 0);
      const arrow = this.scene.add.graphics();
      const t = this.scene.add.text(0, 0, '', { fontFamily: HUD_FONT, fontSize: '13px', color: LABEL_COLORS[this.kind], resolution: this.r }).setOrigin(0.5);
      c.add([arrow, t]);
      this.layers.hud.add(c);
      this.edge = { c, t, arrow, side: 0, text: '' };
    }
    const e = this.edge;
    const dist = Math.max(1, Math.round(side < 0 ? -sx / CELL : (sx - VIEW_W_PX) / CELL));
    const text = `${this.label} ${dist}`;
    if (text !== e.text || side !== e.side) {
      e.text = text;
      e.t.setText(text);
      const w = e.t.width + 26;
      e.arrow.clear();
      e.arrow.fillStyle(0xfffdf6, 0.85);
      e.arrow.fillRoundedRect(-w / 2, -10, w, 20, 8);
      const col = Phaser.Display.Color.HexStringToColor(LABEL_COLORS[this.kind]).color;
      e.arrow.lineStyle(1.4, col, 0.9);
      e.arrow.strokeRoundedRect(-w / 2, -10, w, 20, 8);
      e.arrow.fillStyle(col, 0.9);
      const ax = side < 0 ? -w / 2 + 8 : w / 2 - 8;
      e.arrow.fillTriangle(ax + side * 4, 0, ax - side * 3, -5, ax - side * 3, 5);
      e.t.setX(-side * 4);
      e.side = side;
    }
    const w = e.t.width + 26;
    const hx = side < 0 ? 6 + w / 2 : VIEW_W_PX - 6 - w / 2;
    const hy = Math.max(60 + this.i * 24, Math.min(VIEW_H_PX - 26, y * CELL - 22));
    e.c.setPosition(hx, hy).setVisible(true).setAlpha(0.9);
  }

  camera(a: number): CameraState {
    return { ...this.camCur, x: lerp(this.camPrev.x, this.camCur.x, this.stepped > 1 ? 1 : a) };
  }

  /** Where the ghost is now (cells) and its label colour, for the minimap; null when gone. */
  dot(): { x: number; y: number; color: number } | null {
    if (this.ended && !this.finished) return null;
    const c = this.cur.player;
    return { x: c.x, y: c.y, color: Phaser.Display.Color.HexStringToColor(LABEL_COLORS[this.kind]).color };
  }

  get lastSteps(): number {
    return this.stepped;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  result(): GhostResult {
    return { label: this.label, kind: this.kind, finished: this.finished, time_ms: this.finishMs, deaths: this.cur.deaths };
  }

  destroy(): void {
    this.destroyed = true;
    this.view.destroy();
    this.labelText.destroy();
    this.tag?.destroy();
    this.edge?.c.destroy();
  }
}

/** True when a replay was recorded on this exact level (gameplay hash), or carries no hash to compare. */
export function replayFits(level: LevelV2, replay: Replay): boolean {
  const want = replay.level_hash ?? '';
  if (!want) return true;
  let have = level.meta?.level_hash ?? '';
  if (!have) {
    try {
      have = levelHash(level);
    } catch {
      return true;
    }
  }
  return !have || have === want;
}

export interface GhostsOptions {
  /** Default sync for specs that don't name one: 'race' in play/test, 'free' in the preview. */
  sync: 'race' | 'free';
  /** Called once per ghost when it reaches the goal (e.g. a soft chime when a rival beats you to it). */
  onFinish?(g: GhostResult, beforePlayer: boolean): void;
}

export class Ghosts {
  private list: Ghost[] = [];
  private extra = 0; // race ghosts: frames run in real time after the player's win
  private o: GhostsOptions;
  private announced = new Set<Ghost>();
  private playerDone = false;

  constructor(scene: Phaser.Scene, bank: TexBank, doc: ArtDoc, level: LevelV2, specs: GhostSpec[], layers: Layers, r: number, fallbackStrokes: InkStroke[] | null, o: GhostsOptions) {
    this.o = o;
    let i = 0;
    for (const g of specs) {
      if (this.list.length >= RUNS.max_ghosts) break;
      if (!g?.replay?.input) continue;
      if (kindOf(g) !== 'bot' && !replayFits(level, g.replay)) {
        console.info('ghost skipped: recorded on another version of this level', g.label);
        continue;
      }
      try {
        this.list.push(new Ghost(scene, bank, doc, level, g, layers, i++, r, fallbackStrokes, o.sync));
      } catch (e) {
        console.warn('ghost skipped', g.label, e);
      }
    }
  }

  get size(): number {
    return this.list.length;
  }

  /** After each player sim step: race ghosts follow the player's clock, free ghosts their own. */
  advance(playerFrame: number, playerFirst: number | null, now: number): void {
    for (const g of this.list) {
      if (g.sync === 'free') g.freeFrames++;
      const evs = g.advanceTo(g.target(playerFrame, playerFirst, this.extra), now);
      g.events(evs, g.lastSteps > 4);
      this.announce(g);
    }
  }

  /** Real-time steps with the player's sim stopped (after the win, or the static stand-in). */
  tick(frames: number, playerFrame: number, playerFirst: number | null, now: number): void {
    this.extra += frames;
    for (const g of this.list) {
      if (g.sync === 'free') g.freeFrames += frames;
      const evs = g.advanceTo(g.target(playerFrame, playerFirst ?? playerFrame, this.extra), now);
      g.events(evs, g.lastSteps > 4);
      this.announce(g);
    }
  }

  /** The player reached the goal: ghosts that finish after this came in behind. */
  playerFinished(): void {
    this.playerDone = true;
  }

  private announce(g: Ghost): void {
    if (!g.finished || this.announced.has(g)) return;
    this.announced.add(g);
    this.o.onFinish?.(g.result(), !this.playerDone);
  }

  render(a: number, dt: number, now: number, camX: number): void {
    for (const g of this.list) {
      g.maybeLoop(now);
      g.render(a, dt, now, camX);
      if (!g.isEnded) this.announced.delete(g);
    }
  }

  /** The camera of the first free ghost (the preview follows the bot), interpolated. */
  camera(a: number): CameraState | null {
    const g = this.list.find((x) => x.sync === 'free');
    return g ? g.camera(a) : null;
  }

  get hasFree(): boolean {
    return this.list.some((g) => g.sync === 'free');
  }

  results(): GhostResult[] {
    return this.list.map((g) => g.result());
  }

  /** Minimap dots of the ghosts still on the course. */
  dots(): { x: number; y: number; color: number }[] {
    const out: { x: number; y: number; color: number }[] = [];
    for (const g of this.list) {
      const d = g.dot();
      if (d) out.push(d);
    }
    return out;
  }

  destroy(): void {
    for (const g of this.list) g.destroy();
    this.list = [];
  }
}
