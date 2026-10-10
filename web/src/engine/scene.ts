/**
 * The v2 play scene (PLAN_V2 §5.2, §6.2, §7.4-7.9). Phaser only renders: the core Sim steps at a fixed 60 Hz
 * (real time accumulated, rendering interpolated between the last two states so 120 Hz screens stay smooth),
 * Arcade bodies are never used.
 *
 * Cameras (all origin 0, zoom = render scale r, so physics stays in logical px):
 *   bg   paper + skin backdrop + far/mid parallax  (no boil)
 *   ink  decoration, terrain chunks, entities  (InkBoilFX)
 *   skin generated pictures (skinned entities, static object pictures): crisp, no boil
 *   act  player, ghosts, particles, foreground, overlays (in-scene, so they follow the level)
 *   hud  plates, ghost edge markers; no zoom change, no shake
 *
 * Skins (docs/v3 "Skin on levels") are cosmetic: a swap that only changes the level's `skin` (or setSkin) re-skins
 * in place, replacing just the pictures that changed, and never restarts the sim.
 *
 * The win moment (§7.9): the canvas plays 0.5× slow motion for 400 ms with a 1.1 zoom, 60 confetti scribbles, a gold
 * ink flash and the goal jingle; the music fades out, the flag flaps, the stopped clock pops gold and the character
 * hops with its arms up while confetti keeps drifting down. Then exactly one 'win' payload goes to the app, whose
 * single results card takes over. Race ghosts keep running in real time so you see them come in.
 */
import Phaser from 'phaser';
import type { ArtDoc, ArtPath } from '../core/art/types.ts';
import { buildArt, characterOf } from '../core/art/artdoc.ts';
import { layerWidth } from '../core/art/parallax.ts';
import { decodeGrid, isFloor, at as tileAt } from '../core/art/terrain.ts';
import { CORE_VERSION, encodeReplay, levelHash, profileHash } from '../core/index.ts';
import type { CameraState, Sim, SimEvent, SimSnapshot, SimView } from '../core/sim/types.ts';
import { PROFILES } from '../core/sim/profiles.ts';
import type { CellXY, GameRules, InkDoc, LevelInk, LevelV2, Morph, RectCells, Replay, Theme } from '../core/types.gen.ts';
import { ART, CAMERA, DAMAGE, PERF, RIG, SCORING, SIM } from '../core/params.ts';
import type { Mixer, MusicTheme } from '../audio/index.ts';
import { INK_BOIL_KEY, InkBoilFX, registerInkBoil } from '../render/boil_fx.ts';
import { paperBase, paperTile, vignetteCanvas } from '../render/paper.ts';
import type { Chrome } from './chrome.ts';
import { loadHandFont as loadHudFont } from '../render/fonts.ts';
import { bake, boxOf, CELL, ChunkLayer, imageOf, screenRect, TexBank, VIEW_H_PX, VIEW_W_PX } from './gfx.ts';
import type { Input } from './input.ts';
import { deriveMorphs } from './morphs.ts';
import { makeSim, makeStaticSim } from './simhost.ts';
import type { SimHost } from './simhost.ts';
import type { GameEvent, MountOptions, OverlaySpec, ScreenRect } from './types.ts';
import { EntityViews } from './views/entities.ts';
import type { FrameCtx } from './views/entities.ts';
import { Ghosts } from './views/ghosts.ts';
import type { GhostResult } from './views/ghosts.ts';
import { Underlay, underlaySheets } from './views/underlay.ts';
import { Hud } from './views/hud.ts';
import { Juice } from './views/juice.ts';
import { LavaView } from './views/lava.ts';
import { Overlays } from './views/overlays.ts';
import { PlayerSprite } from './views/player.ts';
import { SkinView } from './views/skin.ts';
import type { SkinChange } from './views/skin.ts';
import { objectArtBox, sameExceptSkin, withSkin } from '../core/art/skin.ts';
import type { LevelSkin } from '../core/types.gen.ts';

const STEP_MS = 1000 / SIM.hz;
/** Input bit 32 = RESTART (die now, cause "restart"): recorded in the replay like any input (docs/v2/requests/E-1.md). */
export const RESTART_BIT = 32;
const MAX_STEPS = 6;
const INK_IDS = ['decoration', 'signs', 'terrain'];

export interface SceneDeps {
  level: LevelV2;
  ink: InkDoc | LevelInk | null;
  mount: MountOptions;
  /** The paper theme (the game's rules or the theme picker win over the level's snapshot). */
  theme: Theme;
  /** Whether this level plays its music loop (rules.music, MountOptions.music). */
  music: boolean;
  r: number;
  reduced: boolean;
  emit(ev: GameEvent, p: unknown): void;
  input: Input | null;
  mixer: Mixer | null;
  chrome: Chrome | null;
}

type Pending = { level: LevelV2; morphs: Morph[] } | null;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class PlayScene extends Phaser.Scene {
  private d: SceneDeps;
  private level: LevelV2;
  private r: number;
  private bank!: TexBank;
  private doc!: ArtDoc;
  private host!: SimHost;
  private sim!: Sim;
  private prev!: SimView;
  private cur!: SimView;
  private camPrev!: CameraState;
  private camCur!: CameraState;
  private acc = 0;
  private rec = new Uint8Array(60 * 60 * 2);
  private recN = 0;
  private firstInput: number | null = null;
  private paused = false;
  private won = false;
  private winAt = -1;
  private winFrame = 0;
  private winEmitted = false;
  private rewound = 0;
  private camShown = 0;
  private gliding = false;
  private zoomK = 1;
  private boilFrame = 0;
  private boil: InkBoilFX | null = null;
  private lowFpsMs = 0;
  private pending: Pending = null;
  private cp: { snap: SimSnapshot; recN: number; first: number | null } | null = null;
  private lastSkid = -99;
  private lastSkidSound = 0;
  private musicWanted = false;
  private audioArmed = false;
  private vmax = 168;
  private overlaySpec: OverlaySpec = {};
  private destroyed = false;
  private lastNow = 0;
  private restartReq = false;
  private theme: Theme;
  private ghostAcc = 0; // real-time accumulator for ghosts after the player's win
  private trickleAt = 0; // next confetti trickle of the celebration
  private ghostResults: GhostResult[] = [];

  // display
  private lBg!: Phaser.GameObjects.Layer;
  private lInk!: Phaser.GameObjects.Layer;
  private lSkin!: Phaser.GameObjects.Layer;
  private lAct!: Phaser.GameObjects.Layer;
  private lHudX!: Phaser.GameObjects.Layer; // HUD-camera extras that survive HUD rebuilds (ghost edge markers)
  private camBg!: Phaser.Cameras.Scene2D.Camera;
  private camInk!: Phaser.Cameras.Scene2D.Camera;
  private camSkin!: Phaser.Cameras.Scene2D.Camera;
  private camAct!: Phaser.Cameras.Scene2D.Camera;
  private camHud!: Phaser.Cameras.Scene2D.Camera;
  private paper!: Phaser.GameObjects.TileSprite;
  private paperKey = '';
  private vignette!: Phaser.GameObjects.Image;
  private margin: Phaser.GameObjects.Graphics | null = null;
  private inkChunks!: ChunkLayer;
  private farChunks!: ChunkLayer;
  private midChunks!: ChunkLayer;
  private fgChunks!: ChunkLayer;
  private clouds: { img: Phaser.GameObjects.Image; x: number; w: number }[] = [];
  private cloudSpan = 0;
  private entities!: EntityViews;
  private lava!: LavaView;
  private player!: PlayerSprite;
  private ghosts: Ghosts | null = null;
  private juice!: Juice;
  private hud!: Hud;
  private overlays!: Overlays;
  private morphTemps: { img: Phaser.GameObjects.Image; t: number; dur: number; kind: 'move' | 'appear' | 'vanish'; dx: number; dy: number; x: number; y: number }[] = [];
  private morphDone: (() => void) | null = null;
  private debugG: Phaser.GameObjects.Graphics | null = null;
  private underlay: Underlay | null = null;
  private skin!: SkinView;
  private morphExclude: ReadonlySet<string> | undefined;

  constructor(d: SceneDeps) {
    super({ key: 'dal-play' });
    this.d = d;
    this.level = d.level;
    this.r = d.r;
    this.theme = d.theme;
  }

  // ---- setup ------------------------------------------------------------------------------------

  private art(level: LevelV2): ArtDoc {
    try {
      return buildArt(level, this.d.ink ?? level.ink ?? null, { seed: 1, theme: this.theme });
    } catch (e) {
      console.warn('art from ink failed, tracing the tiles', e);
      return buildArt(level, null, { seed: 1, theme: this.theme });
    }
  }

  /** Make a layer visible to exactly one camera. */
  private route(layer: Phaser.GameObjects.Layer, cam: Phaser.Cameras.Scene2D.Camera): void {
    for (const c of [this.camBg, this.camInk, this.camSkin, this.camAct, this.camHud]) if (c !== cam) c.ignore(layer);
  }

  /** The drawing the art comes from (the mount's ink, else the level's own). */
  private inkSrc(): InkDoc | LevelInk | null {
    return this.d.ink ?? this.level.ink ?? null;
  }

  create(): void {
    const level = this.level;
    this.bank = new TexBank(this, 'g_');
    this.doc = this.art(level);
    const prof = PROFILES[level.rules.physics_profile ?? 'v2-standard'] ?? PROFILES['v2-standard'];
    this.vmax = prof.run_max ?? prof.walk_max;
    this.lBg = this.add.layer().setDepth(0);
    this.lInk = this.add.layer().setDepth(40);
    this.lSkin = this.add.layer().setDepth(55);
    this.lAct = this.add.layer().setDepth(70);
    this.lHudX = this.add.layer().setDepth(1001);
    // the level's skin first: the ink chunks, entity views and the player are built knowing which pictures are ready
    this.skin = new SkinView({ scene: this, bank: this.bank, world: this.lSkin, bg: this.lBg, reduced: this.d.reduced, changed: (c) => this.onSkinChanged(c) });
    this.skin.set(level, this.inkSrc(), this.doc, { notify: false, pop: false });
    this.buildBackground();
    this.buildWorld();
    this.juice = new Juice(this, this.bank, this.lAct, this.hud.layer, this.d.reduced);
    this.overlays = new Overlays(this, this.lAct);
    this.setOverlays(this.d.mount.overlays ?? {});

    // cameras
    const W = VIEW_W_PX * this.r;
    const H = VIEW_H_PX * this.r;
    this.camBg = this.cameras.main;
    this.camBg.setSize(W, H).setOrigin(0, 0).setZoom(this.r).setBackgroundColor(paperBase(this.doc.theme));
    this.camInk = this.cameras.add(0, 0, W, H).setOrigin(0, 0).setZoom(this.r);
    this.camSkin = this.cameras.add(0, 0, W, H).setOrigin(0, 0).setZoom(this.r);
    this.camAct = this.cameras.add(0, 0, W, H).setOrigin(0, 0).setZoom(this.r);
    this.camHud = this.cameras.add(0, 0, W, H).setOrigin(0, 0).setZoom(this.r);
    this.route(this.lBg, this.camBg);
    this.route(this.lInk, this.camInk);
    this.route(this.lSkin, this.camSkin);
    this.route(this.lAct, this.camAct);
    this.route(this.hud.layer, this.camHud);
    this.route(this.lHudX, this.camHud);
    this.setupBoil();
    this.applySkinLook();
    // "my original sketch" underlay (paper levels), off unless asked for
    this.underlay = new Underlay(this, this.lBg, this.bank, underlaySheets(level));
    const ul = this.d.mount.underlay;
    if (ul) this.underlay.set(true);

    this.newSim(this.d.mount.startAt);
    if (!this.host.real) this.hud.setNote('Look around with ← and →');
    this.camShown = this.camCur.x * CELL;

    // audio: armed on the first input; the preview stays silent until the player actually plays
    const mixer = this.d.mixer;
    if (mixer) {
      const mode = this.d.mount.mode;
      this.musicWanted = this.d.music && (mode === 'play' || mode === 'test');
      if (mode === 'preview') mixer.setSessionMuted(true);
    }
    this.d.input?.on((a) => this.onAction(a));
    void loadHudFont().then((ok) => {
      if (ok && !this.destroyed) this.hud.refreshFont();
    });
    if (this.d.mount.debug) {
      this.debugG = this.add.graphics().setDepth(99);
      this.lAct.add(this.debugG);
    }
    this.d.emit('ready', { sim: this.host.real ? 'core' : 'static', reason: this.host.reason ?? null, render_scale: this.r, boil: !!this.boil, mode: this.d.mount.mode, theme: this.theme, underlay: this.underlay?.available ?? false });
  }

  private buildBackground(): void {
    const doc = this.doc;
    const r = this.r;
    this.paperKey = this.bank.add('paper', paperTile(doc.theme, r));
    this.paper = this.add.tileSprite(0, 0, VIEW_W_PX * r, VIEW_H_PX * r, this.paperKey).setOrigin(0, 0).setScale(1 / r).setScrollFactor(0).setDepth(0);
    this.lBg.add(this.paper);
    this.vignette = this.add.image(0, 0, this.bank.add('vignette', vignetteCanvas())).setOrigin(0, 0).setDisplaySize(VIEW_W_PX, VIEW_H_PX).setScrollFactor(0).setDepth(1);
    this.lBg.add(this.vignette);
    if (doc.theme === 'notebook') {
      this.margin = this.add.graphics().setDepth(2);
      this.margin.lineStyle(1.5, 0xe0453a, 0.45);
      this.margin.lineBetween(40, 0, 40, VIEW_H_PX);
      this.lBg.add(this.margin);
    }
    const w = this.level.world.w;
    const pr = Math.min(r, 1); // parallax is soft graphite: 1× textures keep memory low
    this.farChunks = new ChunkLayer(this, this.lBg, this.bank, { doc, ids: ['far'], scroll: ART.parallax.far, r: pr, lru: 3, depth: ART.depths.far, widthPx: layerWidth(w, ART.parallax.far) * CELL });
    this.midChunks = new ChunkLayer(this, this.lBg, this.bank, { doc, ids: ['mid'], scroll: ART.parallax.mid, r: pr, lru: 3, depth: ART.depths.mid, widthPx: layerWidth(w, ART.parallax.mid) * CELL });
    this.buildClouds();
  }

  /** Clouds: one small texture each, drifting at 2 px/s (rebuilt on theme and level swaps). */
  private buildClouds(): void {
    for (const c of this.clouds) c.img.destroy();
    this.clouds = [];
    const doc = this.doc;
    const cl = doc.layers.find((l) => l.id === 'clouds');
    this.cloudSpan = layerWidth(this.level.world.w, ART.parallax.far) * CELL;
    for (const p of cl?.paths ?? []) {
      const b = boxOf([p]);
      const bk = bake(this.bank, doc, 'cloud', [p], Math.max(1, this.r), [b[0], b[1]], b);
      const img = imageOf(this, bk, b[0] * CELL, b[1] * CELL).setScrollFactor(ART.parallax.far, 1).setDepth(ART.depths.far + 1);
      this.lBg.add(img);
      this.clouds.push({ img, x: b[0] * CELL, w: (b[2] - b[0]) * CELL });
    }
  }

  private buildWorld(): void {
    const doc = this.doc;
    const level = this.level;
    const r = this.r;
    this.inkChunks = new ChunkLayer(this, this.lInk, this.bank, { doc: this.skin.inkDoc(doc), ids: INK_IDS, scroll: 1, r, lru: PERF.chunk_lru, depth: ART.depths.terrain, widthPx: level.world.w * CELL });
    this.fgChunks = new ChunkLayer(this, this.lAct, this.bank, { doc, ids: ['foreground'], scroll: ART.parallax.fg, r, lru: 2, depth: ART.depths.foreground, widthPx: layerWidth(level.world.w, ART.parallax.fg) * CELL });
    this.entities = this.makeEntities(level);
    this.lava = new LavaView(this, this.lInk, doc.lava, this.d.reduced);
    this.buildPlayer();
    if (!this.hud) this.hud = new Hud(this, this.bank, level, { r, rightReserve: this.d.chrome?.reserve ?? 0 });
  }

  /** The player's sprite from the current ArtDoc (rebuilt on theme swaps; the sim state is untouched). */
  private buildPlayer(): void {
    const wasHidden = this.player?.isHidden ?? false;
    this.player?.destroy();
    // the character's skin picture when it has one ready, else the kid's drawing
    const src = this.skin?.playerSource() ?? { kind: 'vector' as const, doc: this.doc, art: this.doc.player };
    try {
      this.player = new PlayerSprite(this, this.bank, src, { name: 'p' });
    } catch (e) {
      if (src.kind !== 'raster') throw e;
      console.warn('character picture failed; drawing the character', e);
      this.player = new PlayerSprite(this, this.bank, { kind: 'vector', doc: this.doc, art: this.doc.player }, { name: 'p' });
    }
    this.player.root.setDepth(ART.depths.player);
    this.player.shards.container.setDepth(ART.depths.player + 1);
    this.lAct.add([this.player.root, this.player.shards.container]);
    if (wasHidden) this.player.hide();
  }

  private makeEntities(level: LevelV2): EntityViews {
    return new EntityViews({
      scene: this, bank: this.bank, doc: this.doc, layer: this.lInk, reduced: this.d.reduced,
      onError: (e, err) => this.entityError(e.id, e.type, (e as { x?: number }).x ?? 0, err),
      skinFor: (e) => this.skin?.entityTex(e.id) ?? null,
      skinLayer: this.lSkin,
    }, level);
  }

  /** Ghosts for the current level: race in play / test, free (looping, camera-followed) in the preview. */
  private buildGhosts(): void {
    this.ghosts?.destroy();
    this.ghosts = null;
    const specs = this.d.mount.ghosts ?? [];
    if (!specs.length || !this.host?.real) return;
    const mode = this.d.mount.mode;
    this.ghosts = new Ghosts(this, this.bank, this.doc, this.level, specs, { world: this.lAct, hud: this.lHudX }, this.r, characterOf(this.d.ink, this.level), {
      sync: mode === 'preview' ? 'free' : 'race',
      onFinish: (g, beforePlayer) => {
        // a rival reaching the goal ahead of you gets a soft pencil chime (never the bot, never in the preview)
        if (beforePlayer && g.kind !== 'bot' && (mode === 'play' || mode === 'test')) this.d.mixer?.play('ghost_finish');
      },
    });
    // a rebuilt set catches up to the player's clock on the next step
    if (this.firstInput !== null) this.ghosts.advance(this.sim.frame, this.firstInput, this.lastNow);
  }

  private setupBoil(): void {
    if (this.d.reduced || this.boil) return;
    if (!registerInkBoil(this.game)) return;
    try {
      this.camInk.setPostPipeline(INK_BOIL_KEY);
      const p = this.camInk.getPostPipeline(INK_BOIL_KEY);
      this.boil = (Array.isArray(p) ? p[0] : p) as InkBoilFX;
      if (this.boil) this.boil.ampPx = ART.boil.amp_px;
    } catch (e) {
      console.warn('boil unavailable', e);
      this.boil = null;
    }
  }

  private disableBoil(): void {
    if (!this.boil) return;
    this.camInk.resetPostPipeline();
    this.boil = null;
  }

  private newSim(startAt?: CellXY): void {
    this.host = makeSim(this.level, startAt ? { startAt } : {});
    this.sim = this.host.sim;
    this.prev = this.cur = this.sim.view();
    this.camPrev = this.camCur = this.sim.camera();
    this.recN = 0;
    this.firstInput = null;
    this.won = false;
    this.winAt = -1;
    this.winEmitted = false;
    this.acc = 0;
    this.cp = null;
    this.rewound = 0;
    this.zoomK = 1;
    this.ghostAcc = 0;
    this.ghostResults = [];
    this.player.show();
    this.player.shards.clear();
    this.player.reset(this.cur.player.facing);
    this.hud?.uncelebrate();
    this.buildGhosts();
  }

  // ---- loop --------------------------------------------------------------------------------------

  override update(time: number, delta: number): void {
    if (this.destroyed) return;
    const now = time;
    this.lastNow = now;
    const real = Math.min(delta, 100);
    // boil auto-degrades when fps < 50 for 2 s
    if (this.boil) {
      this.lowFpsMs = delta > 1000 / PERF.boil_auto_degrade_fps ? this.lowFpsMs + delta : 0;
      if (this.lowFpsMs > PERF.boil_auto_degrade_s * 1000) this.disableBoil();
    }
    const slow = this.winAt >= 0 && now < this.winAt + CAMERA.win.ms ? CAMERA.win.slowmo : 1;
    const dt = real * slow;
    this.d.input?.pollGamepad();
    if (!this.paused && !this.won) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= STEP_MS && n < MAX_STEPS) {
        this.stepOnce(now);
        this.acc -= STEP_MS;
        n++;
        if (this.won) break;
      }
      if (n >= MAX_STEPS) this.acc = 0;
    }
    if (this.won && !this.paused) this.celebrate(now, dt);
    if (this.won && !this.winEmitted && now >= this.winAt + CAMERA.win.ms) {
      this.winEmitted = true;
      this.d.emit('win', this.winPayload());
      if (this.pending) this.applyPending();
    }
    const a = this.paused || this.won ? 1 : Math.min(1, this.acc / STEP_MS);
    this.renderFrame(a, this.paused ? 0 : dt, now);
  }

  private stepOnce(now: number): void {
    const input = this.d.input;
    let bits = input ? input.bits() : 0;
    const wantKill = this.restartReq;
    this.restartReq = false;
    if (wantKill) bits |= RESTART_BIT;
    const frame = this.sim.frame;
    if (this.firstInput === null && bits !== 0) this.firstInput = frame;
    this.record(bits);
    this.prev = this.cur;
    this.camPrev = this.camCur;
    let events: SimEvent[] = [];
    try {
      events = this.sim.step(bits);
      this.cur = this.sim.view();
      this.camCur = this.sim.camera();
    } catch (e) {
      console.error('sim step failed', e);
      this.d.emit('entity_error', { id: 'sim', type: 'sim', thing: 'game', where: 'here', message_key: 'error.entity', args: { thing: 'game', where: 'here' } });
      this.host = { sim: makeStaticSim(this.level), real: false, reason: String(e) };
      this.sim = this.host.sim;
      this.prev = this.cur = this.sim.view();
      this.camPrev = this.camCur = this.sim.camera();
      return;
    }
    if (wantKill && !events.some((e) => e.type === 'death')) {
      // the sim ignored RESTART: undo that frame's bit and rewind instead (a ghost-free, verifiable fallback)
      this.rec[this.recN - 1] &= ~RESTART_BIT;
      this.rewindToCheckpoint();
      return;
    }
    this.ghosts?.advance(this.sim.frame, this.firstInput, now);
    for (const ev of events) this.onSimEvent(ev, now);
    if (this.cur.won && !this.won) this.onWin(now, this.sim.frame);
    if (this.sim.frame % ART.boil.every_f === 0) this.boilFrame = (this.boilFrame + 1) % ART.boil.frames;
  }

  private record(bits: number): void {
    if (this.recN >= this.rec.length) {
      const n = new Uint8Array(this.rec.length * 2);
      n.set(this.rec);
      this.rec = n;
    }
    this.rec[this.recN++] = bits;
  }

  private px(ev: SimEvent): [number, number] {
    return [(ev.x ?? this.cur.player.x) * CELL, (ev.y ?? this.cur.player.y) * CELL];
  }

  private frameCtx(now: number, dt: number, a: number): FrameCtx {
    const p = this.cur.player;
    return { now, dt, frame: this.sim.frame, alpha: a, player: [p.x * CELL, p.y * CELL], camX: this.camShown };
  }

  private onSimEvent(ev: SimEvent, now: number): void {
    const m = this.d.mixer;
    const [x, y] = this.px(ev);
    const fc = this.frameCtx(now, 0, 1);
    switch (ev.type) {
      case 'jump':
      case 'double_jump':
        this.juice.jump(x, y);
        this.player.jump();
        m?.play(ev.type);
        break;
      case 'land': {
        const impact = Math.abs(ev.vy ?? this.prev.player.vy) / RIG.land_ref_vy;
        this.juice.land(x, y, impact);
        this.player.land(impact);
        m?.play('land', { impact });
        break;
      }
      case 'skid':
        if (this.sim.frame - this.lastSkid >= 4) {
          this.lastSkid = this.sim.frame;
          this.juice.skid(x, y);
        }
        if (now - this.lastSkidSound > 180) {
          this.lastSkidSound = now;
          m?.play('skid');
        }
        break;
      case 'coin': {
        this.juice.coin(x, y);
        m?.play('coin');
        const from: [number, number] = [x - this.camShown, y];
        this.juice.fly(this.juice.tex.coin, 1 / 3, from, this.hud.coinTarget(), () => this.hud.pulseCoins());
        this.d.emit('coin', { id: ev.id, x: ev.x, y: ev.y, frame: ev.frame, coins: this.cur.coins });
        break;
      }
      case 'big_coin':
        this.juice.bigCoin(x, y);
        m?.play('big_coin');
        this.d.emit('big_coin', { id: ev.id, x: ev.x, y: ev.y, frame: ev.frame, held: this.cur.big_coins_held });
        break;
      case 'big_coin_banked':
        this.hud.pulseCoins();
        break;
      case 'stomp':
        this.juice.stomp(x, y);
        this.juice.shake(CAMERA.shake.stomp[0], CAMERA.shake.stomp[1]);
        m?.play('stomp', { chain: ev.chain ?? 1 });
        this.vibrate();
        break;
      case 'hit':
        this.juice.shake(3, 120);
        this.juice.puff(x, y - 14, 4);
        m?.play('land', { impact: 1.2 });
        break;
      case 'death': {
        const p = this.cur.player;
        this.juice.shake(CAMERA.shake.death[0], CAMERA.shake.death[1]);
        m?.play('death');
        this.vibrate();
        this.player.hide();
        this.player.shards.burst(p.x * CELL, p.y * CELL, p.facing);
        this.d.emit('die', { cause: ev.cause ?? 'hazard', x: ev.x ?? p.x, y: ev.y ?? p.y, frame: ev.frame, segment: this.cur.checkpoint ?? 'start' });
        break;
      }
      case 'respawn': {
        const p = this.cur.player;
        this.player.reset(p.facing);
        this.player.shards.gather(p.x * CELL, p.y * CELL);
        if (!this.player.shards.active) this.player.show();
        if (this.pending) this.applyPending();
        break;
      }
      case 'checkpoint':
        this.juice.checkpoint(x, y);
        m?.play('checkpoint');
        try {
          this.cp = { snap: this.sim.snapshot(), recN: this.recN, first: this.firstInput };
        } catch {
          this.cp = null;
        }
        this.d.emit('checkpoint', { id: ev.id, x: ev.x, y: ev.y, frame: ev.frame });
        break;
      case 'spring':
        this.juice.spring(x, y);
        m?.play('spring');
        break;
      case 'crumble': {
        const v = this.cur.entities.find((e) => e.id === ev.id);
        this.juice.crumble(v ? v.x * CELL : x, v ? v.y * CELL : y, v ? v.w * CELL : 32);
        m?.play('crumble');
        break;
      }
      case 'door_open':
        this.juice.door(x, y);
        m?.play('door');
        break;
      case 'key':
        this.juice.coin(x, y);
        m?.play('coin', { pitch: 7 });
        break;
      case 'lose':
      case 'game_over':
        // the sim restarts the level itself (clock and deaths kept); the engine only marks the moment
        m?.play('death');
        this.juice.shake(4, 200);
        m?.setTempo(1);
        break;
      case 'crusher_land':
        this.juice.shake(CAMERA.shake.crusher[0], CAMERA.shake.crusher[1]);
        this.juice.land(x, y, 1);
        break;
      case 'bonk':
        this.juice.skid(x, y - 28);
        m?.play('land', { impact: 0.3 });
        break;
      case 'hop':
      case 'drop_through':
        this.juice.jump(x, y);
        break;
      case 'shoot':
        this.juice.puff(x, y - 8, 4);
        m?.play('skid');
        break;
      case 'falling':
        this.juice.crumble(x, y, 32);
        break;
      case 'life':
        m?.play('checkpoint');
        break;
      case 'timer_warn':
        m?.setTempo(1 + SCORING.timer_music_speedup);
        break;
      case 'entity_error':
        this.entityError(ev.id ?? '?', 'entity', ev.x ?? 0, ev.cause);
        break;
      default:
        break;
    }
    this.entities.event(ev, fc);
  }

  private vibrate(): void {
    try {
      if (!this.d.reduced && typeof navigator.vibrate === 'function') navigator.vibrate(SIM.vibrate_ms);
    } catch {
      /* not supported */
    }
  }

  private entityError(id: string, type: string, x: number, err: unknown): void {
    console.warn('entity switched off', id, err);
    const where = `square ${Math.round(x)}`;
    this.d.emit('entity_error', { id, type, thing: type, where, message_key: 'error.entity', args: { thing: type, where } });
  }

  private onWin(now: number, frame: number): void {
    this.won = true;
    this.winAt = now;
    this.winFrame = frame;
    this.trickleAt = now + 250;
    const goal = this.level.compiled.entities.find((e) => e.type === 'goal');
    const gx = (goal ? goal.x : this.cur.player.x) * CELL;
    const gy = (goal ? goal.y : this.cur.player.y) * CELL;
    const p = this.cur.player;
    this.juice.goal(gx, gy);
    this.juice.winFlash(p.x * CELL, p.y * CELL);
    this.entities.cheer();
    this.hud.celebrate();
    this.ghosts?.playerFinished();
    // the loop bows out and the jingle plays alone (a pending 'safe' swap applies after the win moment)
    const m = this.d.mixer;
    if (m) {
      m.music(false, { fadeMs: 350 });
      m.setTempo(1);
      m.play('goal');
      // you got there before a rival's ghost: a short sting after the jingle
      const rivals = (this.ghosts?.results() ?? []).filter((g) => g.kind !== 'bot');
      if (rivals.length && rivals.some((g) => !g.finished)) this.time.delayedCall(950, () => this.d.mixer?.play('beat'));
    }
  }

  /** After the win: confetti keeps drifting down for 2.4 s and race ghosts keep running in real time. */
  private celebrate(now: number, dt: number): void {
    if (now >= this.trickleAt && now < this.winAt + 2400) {
      this.trickleAt = now + 300;
      const x0 = this.camShown;
      this.juice.trickle(x0 + 20, x0 + VIEW_W_PX - 20, -8, 2);
    }
    if (!this.ghosts || !this.host.real) return;
    this.ghostAcc += dt;
    let n = 0;
    while (this.ghostAcc >= STEP_MS && n < MAX_STEPS) {
      this.ghostAcc -= STEP_MS;
      n++;
    }
    if (n) this.ghosts.tick(n, this.sim.frame, this.firstInput, now);
  }

  private winPayload(): unknown {
    const first = this.firstInput ?? 0;
    const frames = this.winFrame;
    const clock = this.cur.clock_frames ?? frames - first;
    const time_ms = this.cur.time_ms ?? Math.round((clock * 1000) / SIM.hz);
    // the race ghosts at the moment you crossed the line (ghosts still running count as not finished yet)
    this.ghostResults = this.ghosts?.results() ?? [];
    return {
      frames,
      time_ms,
      deaths: this.cur.deaths,
      coins: this.cur.coins,
      big_coins_banked: this.cur.big_coins_banked,
      replay: this.replay(),
      rewound: this.rewound,
      ghosts: this.ghostResults.map((g) => ({ ...g, beat: !g.finished || (g.time_ms !== null && time_ms < g.time_ms) })),
    };
  }

  replay(): Replay {
    const lv = this.level;
    let hash = lv.meta?.level_hash ?? '';
    if (!hash) {
      try {
        hash = levelHash(lv);
      } catch {
        hash = '';
      }
    }
    const pid = lv.rules.physics_profile ?? 'v2-standard';
    return {
      v: 1, core: CORE_VERSION, profile_hash: lv.rules.profile_hash ?? profileHash(pid), level_id: lv.id, level_version: lv.version,
      level_hash: hash, frames: this.recN, input: this.encodeInputs(),
    };
  }

  private encodeInputs(): string {
    const raw = this.rec.subarray(0, this.recN);
    try {
      return encodeReplay(raw);
    } catch {
      // a codec without the RESTART bit yet: drop it (that run will not verify; E-1 asks for the wider mask)
      return encodeReplay(raw.map((b) => b & 0x1f));
    }
  }

  // ---- rendering ---------------------------------------------------------------------------------

  private renderFrame(a: number, dt: number, now: number): void {
    // "Watch the bot": in the preview the camera follows the free ghost until the kid takes the controls
    const ghostCam = this.d.mount.mode === 'preview' && this.firstInput === null && this.ghosts?.hasFree ? this.ghosts.camera(a) : null;
    const target = (ghostCam ? ghostCam.x : lerp(this.camPrev.x, this.camCur.x, a)) * CELL;
    // a respawn teleport glides (≤ 300 ms) instead of cutting
    if (!this.gliding && Math.abs(target - this.camShown) > 3 * CELL) this.gliding = true;
    if (this.gliding && dt > 0) {
      this.camShown += (target - this.camShown) * (1 - Math.exp(-dt / (CAMERA.respawn_glide_ms / 4)));
      if (Math.abs(target - this.camShown) < 0.5) this.gliding = false;
    } else {
      this.camShown = target;
      this.gliding = false;
    }
    // win zoom 1.1 about the player
    if (this.winAt >= 0 && !this.d.reduced) {
      const k = Math.min(1, (now - this.winAt) / CAMERA.win.ms);
      this.zoomK = 1 + (CAMERA.win.zoom - 1) * (1 - (1 - k) * (1 - k));
    } else this.zoomK = 1;
    const p0 = this.prev.player;
    const p1 = this.cur.player;
    const px = lerp(p0.x, p1.x, a) * CELL;
    const py = lerp(p0.y, p1.y, a) * CELL;
    const [sx, sy] = this.juice.offset();
    const z = this.r * this.zoomK;
    const scrollX = px - (px - this.camShown) / this.zoomK + sx;
    const scrollY = py - py / this.zoomK + sy;
    for (const c of [this.camBg, this.camInk, this.camSkin, this.camAct]) {
      c.setZoom(z);
      c.setScroll(scrollX, scrollY);
    }
    // paper scrolls with the world (its dot grid is the cell grid)
    this.paper.tilePositionX = scrollX * this.r;
    // skin pictures that finished loading land here (before the ink chunks, which may drop the ink they replace)
    this.skin.update(scrollX, now);
    this.inkChunks.update(scrollX);
    this.farChunks.update(scrollX);
    this.midChunks.update(scrollX);
    this.fgChunks.update(scrollX);
    if (!this.d.reduced && this.cloudSpan > 0) {
      const drift = (now / 1000) * ART.parallax.cloud_drift_px_s;
      for (const c of this.clouds) {
        let x = c.x + drift;
        x = ((x % (this.cloudSpan + c.w)) + this.cloudSpan + c.w) % (this.cloudSpan + c.w) - c.w;
        c.img.setX(x);
      }
    }
    if (this.boil) {
      this.boil.boilFrame = this.boilFrame;
      this.boil.renderScale = z;
      this.boil.scrollPx = scrollX;
    }
    // hit-stop (counted in sim frames) freezes the character and entity animation, never the particles
    const adt = (p1.hitstop_f ?? 0) > 0 ? 0 : dt;
    const fc = this.frameCtx(now, adt, a);
    fc.camX = this.camShown;
    this.entities.update(this.cur.entities, this.prev.entities, fc);
    this.lava.update(now, dt, this.camShown);
    // player
    // the sim left the dead state without a respawn event: reassemble where the player now stands
    const sh = this.player.shards;
    if (sh.bursting && sh.elapsed > DAMAGE.death.total_ms && p1.state !== 'dead' && p1.state !== 'respawn') sh.gather(px, py);
    const dead = p1.state === 'dead' || this.player.shards.active;
    if (!this.player.shards.update(dt) && !dead && this.player.isHidden) this.player.show();
    if (!this.player.isHidden) {
      const look = this.entities.lookTarget(px, py - 20, this.cur.entities);
      this.player.pose({ x: px / CELL, y: py / CELL, vx: p1.vx, vy: p1.vy, facing: p1.facing, onGround: p1.on_ground, state: this.won ? 'win' : p1.state, invuln: p1.invulnerable_f }, adt, now, look, this.vmax);
    }
    this.ghosts?.render(a, dt, now, this.camShown);
    this.juice.update(dt);
    this.overlays.update(now);
    this.updateMorphs(dt);
    const clockFrames = !this.host.real ? 0 : this.cur.clock_frames ?? (this.firstInput === null ? 0 : (this.won ? this.winFrame : this.sim.frame) - this.firstInput);
    this.hud.update(this.cur, clockFrames, now, dt, this.camShown, this.level.world.w, this.ghosts?.dots() ?? []);
    if (this.d.mixer && this.audioArmed) this.d.mixer.setSaw(this.entities.sawProximity(px, py - 14, this.cur.entities));
    if (this.debugG) this.drawDebug();
  }

  private drawDebug(): void {
    const g = this.debugG!;
    g.clear();
    const grid = decodeGrid(this.level);
    g.fillStyle(0x2c7be5, 0.35);
    const c0 = Math.max(0, Math.floor(this.camShown / CELL) - 1);
    for (let r = 0; r < grid.h; r++)
      for (let c = c0; c < Math.min(grid.w, c0 + 50); c++) {
        const ch = tileAt(grid, c, r);
        if (ch === '#') g.fillRect(c * CELL, r * CELL, CELL, CELL);
        else if (ch === '=') g.fillRect(c * CELL, r * CELL, CELL, 3);
      }
    const p = this.cur.player;
    g.lineStyle(1, 0xe0453a, 1);
    g.strokeRect(p.x * CELL - 6, p.y * CELL - 28, 12, 28);
    g.lineStyle(1, 0xf08a24, 1);
    g.strokeRect(p.x * CELL - 4, p.y * CELL - 22, 8, 22);
  }

  // ---- actions and API ---------------------------------------------------------------------------

  private onAction(a: 'pause' | 'restart' | 'mute' | 'any'): void {
    const m = this.d.mixer;
    if (a === 'any') {
      if (m && !this.audioArmed) {
        this.audioArmed = true;
        m.resume();
        if (this.d.mount.mode === 'preview') m.setSessionMuted(false);
        this.startMusic();
      }
      return;
    }
    if (a === 'pause') this.paused ? this.resumeGame() : this.pauseGame();
    else if (a === 'restart') this.restart('checkpoint');
    else if (a === 'mute') this.toggleMute();
  }

  toggleMute(): void {
    const m = this.d.mixer;
    if (!m) return;
    m.resume();
    m.setMuted(!m.muted);
    this.d.chrome?.setMuted(m.muted);
  }

  pauseGame(): void {
    if (this.paused) return;
    this.paused = true;
    this.hud?.setPaused(true);
    this.d.chrome?.setPaused(true);
    this.d.mixer?.music(false, { fadeMs: 200 });
    if (this.pending) this.applyPending();
  }

  resumeGame(): void {
    if (!this.paused) return;
    this.paused = false;
    this.hud?.setPaused(false);
    this.d.chrome?.setPaused(false);
    if (!this.won) this.startMusic();
  }

  restart(from: 'start' | 'checkpoint' = 'start'): void {
    if (!this.sim) return;
    this.d.mixer?.setTempo(1);
    if (from === 'checkpoint' && !this.won && this.host.real) {
      // already dying: the death sequence will respawn at the checkpoint anyway
      if (this.cur.player.state === 'dead' || this.cur.player.state === 'respawn' || this.player.shards.active) return;
      // a recorded death: the RESTART input bit goes into the replay; a sim that does not know it yet is detected
      // after the step and the engine falls back to rewinding (rewindToCheckpoint)
      this.restartReq = true;
      if (this.paused) this.resumeGame();
      return;
    }
    this.fullRestart();
  }

  /** Fallback when the sim has no "die now": rewind to the checkpoint snapshot, else restart the level. */
  private rewindToCheckpoint(): void {
    if (this.cp) {
      // no sim-side "die now" yet: rewind to the checkpoint snapshot; the replay stays verifiable
      // (inputs are truncated to the snapshot frame) and the win payload reports `rewound`.
      try {
        this.sim.restore(this.cp.snap);
        this.prev = this.cur = this.sim.view();
        this.camPrev = this.camCur = this.sim.camera();
        this.recN = this.cp.recN;
        this.firstInput = this.cp.first;
        this.rewound++;
        this.player.shards.clear();
        this.player.show();
        this.player.reset(this.cur.player.facing);
        this.buildGhosts(); // ghosts can't step back: rebuild and catch up to the rewound clock
        return;
      } catch {
        /* fall through to a full restart */
      }
    }
    this.fullRestart();
  }

  private fullRestart(): void {
    const wasWon = this.won;
    this.entities.destroy();
    this.entities = this.makeEntities(this.level);
    this.juice.clear();
    this.newSim(this.d.mount.startAt);
    this.camShown = this.camCur.x * CELL;
    if (this.paused) this.resumeGame();
    // the loop faded out at the goal: bring it back for the next try
    else if (wasWon) this.startMusic();
  }

  private startMusic(): void {
    if (!this.audioArmed || !this.d.mixer) return;
    if (!(this.musicWanted || this.d.mount.mode === 'preview') || !this.d.music) return;
    this.d.mixer.music(true, { theme: this.theme as MusicTheme, seed: this.level.id });
  }

  setOverlays(o: OverlaySpec): void {
    this.overlaySpec = o;
    this.overlays?.set(o, decodeGrid(this.level));
  }

  swapLevel(level: LevelV2, o: { morphs?: Morph[]; when?: 'now' | 'safe' } = {}): void {
    const playing = (this.d.mount.mode === 'play' || this.d.mount.mode === 'test') && !this.paused && !this.won && this.firstInput !== null;
    // only the skin (or fields the engine never reads) changed: re-skin in place, the run goes on
    if (this.pending && sameExceptSkin(this.pending.level, level)) {
      this.pending = { level, morphs: this.pending.morphs };
      if ((o.when ?? 'now') === 'now' || !playing) this.applyPending();
      else this.reskin(withSkin(this.level, level.skin ?? null));
      return;
    }
    if (!this.pending && sameExceptSkin(this.level, level)) {
      this.reskin(level);
      return;
    }
    // no morphs given: derive them (moved pieces slide, added ones sketch in, removed ones erase)
    const morphs = o.morphs ?? deriveMorphs(this.level, level);
    if ((o.when ?? 'now') === 'safe' && playing) {
      this.pending = { level, morphs };
      return;
    }
    this.pending = null; // an immediate swap supersedes a deferred one (it would otherwise bring the older level back)
    this.applySwap(level, morphs);
  }

  private applyPending(): void {
    const p = this.pending;
    this.pending = null;
    if (p) this.applySwap(p.level, p.morphs);
  }

  private applySwap(level: LevelV2, morphs: Morph[]): void {
    const oldDoc = this.doc;
    const oldLevel = this.level;
    const wasWon = this.won;
    // keep the player where they stand if they were playing and the new level still has floor there
    let startAt: CellXY | undefined = this.d.mount.startAt;
    const p = this.cur.player;
    if (this.firstInput !== null && p.on_ground && p.state !== 'dead') {
      const g = decodeGrid(level);
      if (isFloor(tileAt(g, Math.floor(p.x), Math.round(p.y)))) startAt = [p.x, p.y];
    }
    this.level = level;
    this.doc = this.art(level);
    const sc = this.skin.set(level, this.inkSrc(), this.doc, { notify: false, pop: false });
    const reduced = this.d.reduced;
    const moving = morphs.filter((m) => m.kind === 'move' || m.kind === 'relabel' || m.kind === 'appear');
    const entityIds = new Set(level.compiled.entities.map((e) => e.id));
    const terrainMorph = new Set(moving.filter((m) => !entityIds.has(m.object_id)).map((m) => m.object_id));
    this.morphExclude = reduced || !terrainMorph.size ? undefined : terrainMorph;
    this.inkChunks.setDoc(this.skin.inkDoc(this.doc), this.morphExclude);
    this.inkChunks.setWidth(level.world.w * CELL);
    this.fgChunks.setDoc(this.doc);
    this.fgChunks.setWidth(layerWidth(level.world.w, ART.parallax.fg) * CELL);
    if (oldDoc.theme !== this.doc.theme) this.rebuildPaper();
    if (oldLevel.id !== level.id || oldDoc.theme !== this.doc.theme || oldLevel.world.w !== level.world.w) {
      this.farChunks.setDoc(this.doc);
      this.midChunks.setDoc(this.doc);
      this.farChunks.setWidth(layerWidth(level.world.w, ART.parallax.far) * CELL);
      this.midChunks.setWidth(layerWidth(level.world.w, ART.parallax.mid) * CELL);
      this.buildClouds();
    }
    if (JSON.stringify(underlaySheets(oldLevel)) !== JSON.stringify(underlaySheets(level))) {
      const on = this.underlay?.on ?? false;
      this.underlay?.destroy();
      this.underlay = new Underlay(this, this.lBg, this.bank, underlaySheets(level));
      if (on) this.underlay.set(true);
    }
    this.entities.destroy();
    this.entities = this.makeEntities(level);
    if (sc.player) this.buildPlayer();
    this.lava.destroy();
    this.lava = new LavaView(this, this.lInk, this.doc.lava, reduced);
    this.hud.destroy();
    this.hud = new Hud(this, this.bank, level, { r: this.r, rightReserve: this.d.chrome?.reserve ?? 0 });
    this.route(this.hud.layer, this.camHud);
    if (this.paused) this.hud.setPaused(true);
    if (!reduced) this.startMorphs(oldDoc, morphs, terrainMorph, entityIds);
    this.newSim(startAt);
    if (!this.host.real) this.hud.setNote('Look around with ← and →');
    this.overlays.set(this.overlaySpec, decodeGrid(level));
    this.applySkinLook();
    this.skin.gc();
    if (wasWon && !this.paused) this.startMusic(); // the loop faded at the goal: the next level brings it back
  }

  // ---- skin ---------------------------------------------------------------------------------------------------

  /** A level that differs only in its skin: the pictures that changed are replaced in place; the sim keeps running. */
  private reskin(level: LevelV2): void {
    this.level = level;
    if (!this.skin || !this.doc) return;
    this.skin.set(level, this.inkSrc(), this.doc, { notify: true, pop: !this.d.reduced });
  }

  /** Apply a skin to the level being shown (GameHandle.setSkin); a pending swap gets it too. */
  setSkin(skin: LevelSkin | null): void {
    if (this.pending) this.pending = { level: withSkin(this.pending.level, skin), morphs: this.pending.morphs };
    this.reskin(withSkin(this.level, skin));
  }

  /** A live skin change (setSkin, a skin-only swap, a picture that finished loading): update just those views. */
  private onSkinChanged(c: SkinChange): void {
    if (this.destroyed) return;
    for (const id of c.entities) this.entities.reskin(id, this.skin.entityTex(id), c.pop);
    if (c.player) {
      const facing = this.cur?.player.facing ?? 1;
      this.buildPlayer();
      this.player.reset(facing);
      if (c.pop && !this.d.reduced && !this.player.isHidden) this.player.land(0.9); // lands with a squash
    }
    if (c.hidden) this.inkChunks.setDoc(this.skin.inkDoc(this.doc), this.morphExclude);
    if (c.backdrop || c.credit) this.applySkinLook();
  }

  /** The backdrop replaces the paper's graphite parallax (hills, clouds, the notebook margin); the credit pill. */
  private applySkinLook(): void {
    if (!this.skin) return;
    const on = this.skin.backdropOn;
    this.farChunks?.setAlpha(on ? 0 : 1);
    this.midChunks?.setAlpha(on ? 0 : 1);
    for (const c of this.clouds) c.img.setVisible(!on);
    this.margin?.setVisible(!on);
    this.d.chrome?.setCredit(this.skin.credit);
  }

  /**
   * Where a level object is on screen right now, in CSS px of the viewport (for the creative fly-in to aim at):
   * an entity id or a scene object id (moving things where they are this frame), or 'player'. Null when unknown.
   */
  objectScreenRect(id: string): ScreenRect | null {
    if (this.destroyed || !this.camInk || !this.doc) return null;
    let box: [number, number, number, number] | null = null;
    const playerBox = (): [number, number, number, number] => {
      const p = this.cur.player;
      const b = this.skin.placementOf('player')?.box ?? this.doc.player.bbox;
      return [(p.x + b[0]) * CELL, (p.y + b[1]) * CELL, (p.x + b[2]) * CELL, (p.y + Math.min(0, b[3])) * CELL];
    };
    if (id === 'player') box = playerBox();
    else {
      box = this.entities.worldBox(id);
      if (!box) {
        const pl = this.skin.placementOf(id);
        if (pl?.target.kind === 'player') box = playerBox();
        else if (pl?.target.kind === 'entity') box = this.entities.worldBox(pl.target.id);
        else if (pl) box = [pl.box[0] * CELL, pl.box[1] * CELL, pl.box[2] * CELL, pl.box[3] * CELL];
      }
      if (!box) {
        const objs = this.level.objects ?? [];
        const byId = new Map(objs.map((x) => [x.id, x]));
        const obj = byId.get(id);
        if (obj) {
          const ids = [id, ...(obj.rel?.parts ?? []), ...objs.filter((x) => x.rel?.part_of === id).map((x) => x.id)];
          const b = objectArtBox(this.doc, ids, byId);
          if (b) box = [b[0] * CELL, b[1] * CELL, b[2] * CELL, b[3] * CELL];
        }
      }
    }
    return box ? this.toScreen(box) : null;
  }

  /** A world rect (cells) on screen now, viewport CSS px. */
  worldToScreen(r: RectCells): ScreenRect | null {
    if (this.destroyed || !this.camInk) return null;
    return this.toScreen([r[0] * CELL, r[1] * CELL, r[2] * CELL, r[3] * CELL]);
  }

  /** World px → viewport CSS px through the world cameras (scroll, render scale, win zoom) and the canvas fit. */
  private toScreen(box: [number, number, number, number]): ScreenRect | null {
    const canvas = this.game.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(canvas.width > 0)) return null;
    const cam = this.camInk;
    const k = (cam.zoom * rect.width) / canvas.width;
    return screenRect(rect.left + (box[0] - cam.scrollX) * k, rect.top + (box[1] - cam.scrollY) * k, (box[2] - box[0]) * k, (box[3] - box[1]) * k);
  }

  private pathsOf(doc: ArtDoc, id: string): ArtPath[] {
    const out: ArtPath[] = [];
    for (const l of doc.layers) {
      if (!INK_IDS.includes(String(l.id))) continue;
      for (const p of l.paths) if (p.object_id === id) out.push(p);
    }
    return out;
  }

  private startMorphs(oldDoc: ArtDoc, morphs: Morph[], terrainMorph: Set<string>, entityIds: Set<string>): void {
    for (const t of this.morphTemps) t.img.destroy();
    this.morphTemps = [];
    for (const m of morphs) {
      const dx = (m.from[0] - m.to[0]) * CELL;
      const dy = (m.from[1] - m.to[1]) * CELL;
      if (entityIds.has(m.object_id)) {
        if (m.kind === 'move') this.entities.morph(m.object_id, 'move', dx, dy, 300);
        else if (m.kind === 'appear') this.entities.morph(m.object_id, 'appear');
        continue;
      }
      if (m.kind === 'vanish') {
        const sp = oldDoc.sprites.find((s) => s.id === m.object_id);
        const paths = sp ? sp.paths : this.pathsOf(oldDoc, m.object_id);
        if (!paths.length) continue;
        const bk = bake(this.bank, oldDoc, `vanish_${m.object_id}`, paths, Math.min(2, this.r), [0, 0]);
        const ox = sp ? sp.anchor[0] * CELL : 0;
        const oy = sp ? sp.anchor[1] * CELL : 0;
        const img = imageOf(this, bk, ox, oy).setDepth(ART.depths.terrain + 2);
        this.lInk.add(img);
        this.morphTemps.push({ img, t: 0, dur: 320, kind: 'vanish', dx: 0, dy: 0, x: ox, y: oy });
        continue;
      }
      if (!terrainMorph.has(m.object_id)) continue;
      const paths = this.pathsOf(this.skin.inkDoc(this.doc), m.object_id);
      if (!paths.length) continue;
      const bk = bake(this.bank, this.doc, `morph_${m.object_id}`, paths, Math.min(2, this.r));
      const img = imageOf(this, bk, 0, 0).setDepth(ART.depths.terrain + 1);
      this.lInk.add(img);
      this.morphTemps.push({ img, t: 0, dur: m.kind === 'appear' ? ART.pencil.reveal_ms : 300, kind: m.kind === 'appear' ? 'appear' : 'move', dx: m.kind === 'move' ? dx : 0, dy: m.kind === 'move' ? dy : 0, x: 0, y: 0 });
    }
    this.morphDone = terrainMorph.size
      ? () => {
          this.morphExclude = undefined;
          this.inkChunks.setDoc(this.skin.inkDoc(this.doc));
        }
      : null;
  }

  private updateMorphs(dt: number): void {
    if (!this.morphTemps.length) return;
    let live = 0;
    for (const t of this.morphTemps) {
      if (!t.img.active) continue;
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      if (t.kind === 'move') t.img.setPosition(t.x + t.dx * (1 - e), t.y + t.dy * (1 - e));
      else if (t.kind === 'appear') {
        const f = t.img.frame;
        t.img.setCrop(0, 0, f.width * k, f.height).setAlpha(Math.min(1, k * 1.6));
      } else t.img.setAlpha(1 - e).setScale(t.img.scaleX * (1 - 0.002 * dt), t.img.scaleY * (1 - 0.002 * dt));
      if (k < 1) live++;
    }
    if (live === 0) {
      this.morphDone?.();
      this.morphDone = null;
      for (const t of this.morphTemps) t.img.destroy();
      this.morphTemps = [];
    }
  }

  /** The paper tile for the current theme and render scale (theme swaps and rescales). */
  private rebuildPaper(): void {
    const r = this.r;
    const key = this.bank.add('paper', paperTile(this.doc.theme, r));
    this.paper.destroy();
    this.paper = this.add.tileSprite(0, 0, VIEW_W_PX * r, VIEW_H_PX * r, key).setOrigin(0, 0).setScale(1 / r).setScrollFactor(0).setDepth(0);
    this.lBg.add(this.paper);
    this.bank.remove(this.paperKey);
    this.paperKey = key;
    this.camBg.setBackgroundColor(paperBase(this.doc.theme));
    this.margin?.destroy();
    this.margin = null;
    if (this.doc.theme === 'notebook') {
      this.margin = this.add.graphics().setDepth(2);
      this.margin.lineStyle(1.5, 0xe0453a, 0.45);
      this.margin.lineBetween(40, 0, 40, VIEW_H_PX);
      this.lBg.add(this.margin);
    }
  }

  // ---- theme, music, underlay, snapshot ------------------------------------------------------------

  /**
   * Swap the paper theme in place (the theme picker, §8.2): the paper, every ink chunk, parallax, clouds, sprites, the
   * player and ghosts are re-drawn for the new theme (kraft lightens ink 8%) and the music loop changes key; the sim
   * keeps running untouched, so a theme change never costs a run.
   */
  setTheme(theme: Theme): void {
    if (theme === this.theme || !this.camBg) return;
    this.theme = theme;
    this.doc = this.art(this.level);
    this.skin.set(this.level, this.inkSrc(), this.doc, { notify: false, pop: false });
    this.inkChunks.setDoc(this.skin.inkDoc(this.doc), this.morphExclude);
    this.fgChunks.setDoc(this.doc);
    this.farChunks.setDoc(this.doc);
    this.midChunks.setDoc(this.doc);
    this.buildClouds();
    this.rebuildPaper();
    this.entities.destroy();
    this.entities = this.makeEntities(this.level);
    this.lava.destroy();
    this.lava = new LavaView(this, this.lInk, this.doc.lava, this.d.reduced);
    this.buildPlayer();
    if (this.ghosts) this.buildGhosts();
    this.applySkinLook();
    this.skin.gc();
    this.d.chrome?.setTheme(theme);
    if (this.d.mixer?.musicPlaying) this.startMusic();
  }

  /** Rules-level change that needs no rebuild: the theme and the music loop (physics changes need a new level). */
  setRules(rules: Partial<GameRules>): void {
    if (rules.theme) this.setTheme(rules.theme);
    if (rules.music !== undefined) this.setMusic(rules.music);
  }

  /** The level's music loop on or off (rules / mount option; the player's own ♪ setting still applies). */
  setMusic(on: boolean): void {
    this.d.music = on;
    const mode = this.d.mount.mode;
    this.musicWanted = on && (mode === 'play' || mode === 'test');
    this.d.chrome?.setMusicAvailable(on);
    if (!on) this.d.mixer?.music(false, { fadeMs: 250 });
    else if (!this.paused && !this.won) this.startMusic();
  }

  /** The player's own music setting (the ♪ button): persisted, independent of mute. */
  toggleMusicSetting(): void {
    const m = this.d.mixer;
    if (!m) return;
    m.resume();
    m.setMusicEnabled(!m.musicEnabled);
    this.d.chrome?.setMusicOn(m.musicEnabled);
    if (m.musicEnabled && !this.paused && !this.won) this.startMusic();
  }

  /** "My original sketch" underlay at 15% (paper levels). Returns false when the level has no sheet photos. */
  setUnderlay(on: boolean): boolean {
    if (!this.underlay) return false;
    this.underlay.set(on);
    return this.underlay.available;
  }

  /**
   * The current frame as a PNG (the win moment for a share card): the canvas as shown, optionally without the HUD
   * plates. Resolves null when the renderer can't read back (it never throws).
   */
  snapshot(o: { hud?: boolean } = {}): Promise<Blob | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (b: Blob | null): void => {
        if (done) return;
        done = true;
        if (o.hud === false) {
          this.hud?.layer.setVisible(true);
          this.lHudX?.setVisible(true);
        }
        resolve(b);
      };
      setTimeout(() => finish(null), 1500);
      try {
        if (o.hud === false) {
          this.hud?.layer.setVisible(false);
          this.lHudX?.setVisible(false);
        }
        this.game.renderer.snapshot((img) => {
          if (!(img instanceof HTMLImageElement)) return finish(null);
          const go = (): void => {
            try {
              const c = document.createElement('canvas');
              c.width = img.naturalWidth || img.width;
              c.height = img.naturalHeight || img.height;
              const ctx = c.getContext('2d');
              if (!ctx) return finish(null);
              ctx.drawImage(img, 0, 0);
              c.toBlob((b) => finish(b), 'image/png');
            } catch {
              finish(null);
            }
          };
          if (img.complete && img.naturalWidth) go();
          else {
            img.onload = go;
            img.onerror = () => finish(null);
          }
        });
      } catch {
        finish(null);
      }
    });
  }

  /** The ghosts' live status (labels, finished, times). */
  get ghostStatus(): GhostResult[] {
    return this.ghosts?.results() ?? this.ghostResults;
  }

  /** Render scale change (debounced resize): re-rasterize at the new r without restarting the scene. */
  setRenderScale(r: number): void {
    if (r === this.r || !this.camBg) return;
    this.r = r;
    const W = VIEW_W_PX * r;
    const H = VIEW_H_PX * r;
    this.scale.setGameSize(W, H);
    for (const c of [this.camBg, this.camInk, this.camSkin, this.camAct, this.camHud]) c.setSize(W, H).setZoom(r);
    // paper tile at the new scale
    this.rebuildPaper();
    this.inkChunks.setScale(r);
    this.fgChunks.setScale(r);
    this.hud.setResolution(r);
    this.buildClouds();
    this.applySkinLook();
  }

  get frameNow(): number {
    return this.lastNow;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  shutdownAll(): void {
    this.destroyed = true;
    this.d.mixer?.music(false, { fadeMs: 0 });
    this.underlay?.destroy();
    this.ghosts?.destroy();
    this.skin?.destroy();
  }
}
