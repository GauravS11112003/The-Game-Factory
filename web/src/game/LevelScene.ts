/**
 * Phaser scene that plays one Level (PLAN.md section 10, "Engine details").
 *
 * Backdrop: the rectified drawing when source.backdrop_url is set, otherwise
 * the grid rendered as ink on paper (tiles.ts). Collision: a blank 48x27x16
 * tilemap with a runtime 3-tile tileset; tile 1 collides, tile 2 (hazard)
 * only has a tile-index callback that kills, fired through an overlap with
 * the layer. Behaviors are built from entities; rules are registered once on
 * the RuleBus. Death respawns at the last checkpoint after a 300 ms shake;
 * win is the goal overlap.
 */
import Phaser from 'phaser';
import type { Entity, Level } from '../types';
import { TILE_HAZARD, TILE_SOLID } from '../types';
import { solve } from '../solver/solve';
import { CELL, GAME_H, GAME_W, GRID_H, GRID_W } from './constants';
import { BouncePad } from './behaviors/BouncePad';
import { Checkpoint } from './behaviors/Checkpoint';
import { Door, Key } from './behaviors/KeyDoor';
import { MovingPlatform } from './behaviors/MovingPlatform';
import { Patroller } from './behaviors/Patroller';
import { Timer } from './behaviors/Timer';
import type { Behavior } from './behaviors/types';
import { Hud } from './hud';
import { Player } from './Player';
import { RuleBus, parseAction, parseTimerRule, type RuleAction } from './rules';
import * as ink from './tiles';
import type { TouchControls } from './touch';

export type GameEvent = 'win' | 'die' | 'coin' | 'ready';

export interface SceneDeps {
  level: Level;
  debug: boolean;
  assetBase: string;
  touch: TouchControls | null;
  emit: (event: GameEvent, payload?: unknown) => void;
}

type DrawFn = (ctx: CanvasRenderingContext2D) => void;

const ABSOLUTE_URL = /^(?:[a-z]+:)?\/\//i;

export class LevelScene extends Phaser.Scene {
  static readonly KEY = 'level';

  readonly level: Level;
  readonly assetBase: string;
  readonly touch: TouchControls | null;
  debug: boolean;

  rules = new RuleBus();
  player!: Player;
  layer!: Phaser.Tilemaps.TilemapLayer;
  hud!: Hud;
  coins = 0;
  totalCoins = 0;
  deaths = 0;
  won = false;
  dying = false;

  private readonly emitExternal: SceneDeps['emit'];
  private behaviors: Behavior[] = [];
  private readonly doors = new Map<string, Door>();
  private timer: Timer | null = null;
  private respawn = { x: 1, y: GRID_H - 2 };
  private startedAt = 0;
  private goalImage: Phaser.GameObjects.Image | null = null;
  private solverOverlay: Phaser.GameObjects.Graphics | null = null;

  constructor(deps: SceneDeps) {
    super(LevelScene.KEY);
    this.level = deps.level;
    this.assetBase = deps.assetBase;
    this.debug = deps.debug;
    this.touch = deps.touch;
    this.emitExternal = deps.emit;
  }

  /** assetBase-prefixed URL for relative paths such as /uploads/x/backdrop.png. */
  url(u: string): string {
    if (ABSOLUTE_URL.test(u) || u.startsWith('data:') || u.startsWith('blob:')) return u;
    return this.assetBase + u;
  }

  static entityKey(e: Entity): string {
    return `ent_${e.id}`;
  }

  preload(): void {
    const { level } = this;
    if (level.source.backdrop_url) this.load.image('backdrop', this.url(level.source.backdrop_url));
    if (level.sprites.player) this.load.image('player_custom', this.url(level.sprites.player));
    for (const e of level.entities) {
      if (e.image_url) this.load.image(LevelScene.entityKey(e), this.url(e.image_url));
    }
    // preload() runs again on every restart; keep a single listener.
    this.load.off(Phaser.Loader.Events.FILE_LOAD_ERROR, this.onLoadError, this);
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, this.onLoadError, this);
  }

  private onLoadError(file: Phaser.Loader.File): void {
    console.warn(`[draw-a-level] could not load ${file.key} from ${file.src}; using the ink fallback`);
  }

  /** Generate (once per texture manager) a canvas-drawn texture. */
  ensureCanvasTexture(key: string, w: number, h: number, draw: DrawFn): string {
    if (!this.textures.exists(key)) {
      const c = ink.makeCanvas(w, h);
      draw(ink.ctxOf(c));
      this.textures.addCanvas(key, c);
    }
    return key;
  }

  /** The entity's loaded crop when it exists, else a generated ink fallback. */
  entityTexture(e: Entity, fallbackKey: string, w: number, h: number, draw: DrawFn): string {
    const k = LevelScene.entityKey(e);
    if (e.image_url && this.textures.exists(k)) return k;
    return this.ensureCanvasTexture(fallbackKey, w, h, draw);
  }

  create(): void {
    const { level } = this;
    this.won = false;
    this.dying = false;
    this.coins = 0;
    this.deaths = 0;
    this.rules = new RuleBus();
    this.behaviors = [];
    this.doors.clear();
    this.timer = null;
    this.goalImage = null;
    this.solverOverlay = null;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());

    // Left/right/top are walls; the bottom is open so falling out of the level is a death.
    this.physics.world.setBounds(0, 0, GAME_W, GAME_H + 8 * CELL);
    this.physics.world.setBoundsCollision(true, true, true, false);

    this.createBackdrop();
    this.createTilemap();
    this.createPlayer();
    this.createPointEntities();
    this.createBehaviors();

    this.totalCoins = level.entities.filter((e) => e.type === 'coin').length;
    this.hud = new Hud(this, {
      totalCoins: this.totalCoins,
      hasTimer: level.rules.some((r) => parseTimerRule(r.when) !== null),
      debug: this.debug,
      onRestart: () => this.scene.restart(),
      onToggleDebug: (on) => this.setDebugVisible(on),
    });

    this.registerRules();
    if (this.debug) this.buildSolverOverlay();
    this.setDebugVisible(this.debug);

    this.startedAt = this.time.now;
    this.emitExternal('ready', { level: level.id });
  }

  private createBackdrop(): void {
    const { level } = this;
    if (level.source.backdrop_url && this.textures.exists('backdrop')) {
      this.add.image(0, 0, 'backdrop').setOrigin(0, 0).setDisplaySize(GAME_W, GAME_H).setDepth(0);
      return;
    }
    const key = `ink_backdrop_${level.id}`;
    if (!this.textures.exists(key)) this.textures.addCanvas(key, ink.renderInkBackdrop(level, true));
    this.add.image(0, 0, key).setOrigin(0, 0).setDepth(0);
  }

  private createTilemap(): void {
    const tilesKey = this.ensureCanvasTexture('tiles_collision', CELL * 3, CELL, (ctx) => {
      // tile 0: empty. tile 1: solid outline. tile 2: hazard outline. Only visible in debug.
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(229,57,53,0.9)';
      ctx.fillStyle = 'rgba(229,57,53,0.18)';
      ctx.fillRect(CELL + 0.5, 0.5, CELL - 1, CELL - 1);
      ctx.strokeRect(CELL + 0.5, 0.5, CELL - 1, CELL - 1);
      ctx.strokeStyle = 'rgba(255,140,0,0.9)';
      ctx.fillStyle = 'rgba(255,140,0,0.18)';
      ctx.fillRect(2 * CELL + 0.5, 0.5, CELL - 1, CELL - 1);
      ctx.strokeRect(2 * CELL + 0.5, 0.5, CELL - 1, CELL - 1);
    });
    const map = this.make.tilemap({ tileWidth: CELL, tileHeight: CELL, width: GRID_W, height: GRID_H });
    const tileset = map.addTilesetImage('tiles', tilesKey, CELL, CELL, 0, 0, 0);
    if (!tileset) throw new Error('tileset texture missing');
    const layer = map.createBlankLayer('collision', tileset, 0, 0);
    if (!layer) throw new Error('could not create the collision layer');
    const rows = this.level.grid.rows;
    for (let y = 0; y < GRID_H && y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < GRID_W && x < row.length; x++) {
        if (row[x] === TILE_SOLID) layer.putTileAt(1, x, y, false);
        else if (row[x] === TILE_HAZARD) layer.putTileAt(2, x, y, false);
      }
    }
    layer.setCollision([1], true, true);
    layer.setTileIndexCallback(2, () => this.die(), this);
    layer.setAlpha(0.35).setDepth(50).setVisible(false);
    this.layer = layer;
  }

  private createPlayer(): void {
    const { level } = this;
    const key =
      level.sprites.player && this.textures.exists('player_custom')
        ? 'player_custom'
        : this.ensureCanvasTexture('player_doodle', ink.PLAYER_TEX_W, ink.PLAYER_TEX_H, ink.drawPlayerDoodle);
    this.player = new Player(this, key, this.touch);
    const start = level.entities.find((e) => e.type === 'player_start' && e.x != null && e.y != null);
    this.respawn = start ? { x: start.x as number, y: start.y as number } : { x: 1, y: GRID_H - 2 };
    this.placePlayerAt(this.respawn.x, this.respawn.y);
    this.physics.add.collider(this.player.sprite, this.layer);
    // Overlap (not collide) with the layer so the hazard tile callback fires without tile 2 being solid.
    this.physics.add.overlap(this.player.sprite, this.layer);
  }

  private placePlayerAt(cellX: number, cellY: number): void {
    this.player.setFeet(cellX * CELL + CELL / 2, (cellY + 1) * CELL);
  }

  private createPointEntities(): void {
    const { level } = this;
    const coinKey = this.ensureCanvasTexture('coin', ink.COIN_SIZE, ink.COIN_SIZE, ink.drawCoin);
    const goalKey = this.ensureCanvasTexture('goal', ink.GOAL_W, ink.GOAL_H, ink.drawGoalFlag);
    this.ensureCanvasTexture('puff', ink.PUFF_SIZE, ink.PUFF_SIZE, ink.drawPuff);

    const coins = this.physics.add.staticGroup();
    for (const e of level.entities) {
      if (e.type !== 'coin' || e.x == null || e.y == null) continue;
      const cx = e.x * CELL + CELL / 2;
      const cy = e.y * CELL + CELL / 2;
      const s = coins.create(cx, cy, coinKey) as Phaser.Physics.Arcade.Sprite;
      s.setDepth(15);
      s.setData('id', e.id);
      this.tweens.add({ targets: s, y: cy - 2, duration: 500 + (e.x % 5) * 60, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    }
    this.physics.add.overlap(this.player.sprite, coins, (_p, c) => this.collectCoin(c as Phaser.Physics.Arcade.Sprite));

    const goal = level.entities.find((e) => e.type === 'goal' && e.x != null && e.y != null);
    if (goal) {
      const gx = goal.x as number;
      const gy = goal.y as number;
      this.goalImage = this.add.image(gx * CELL, (gy + 1) * CELL, goalKey).setOrigin(0, 1).setDepth(14);
      // The win zone is the standing cell plus the one above it (what the solver checks too).
      const zone = this.add.zone(gx * CELL, (gy - 1) * CELL, CELL, CELL * 2).setOrigin(0, 0);
      this.physics.add.existing(zone, true);
      this.physics.add.overlap(this.player.sprite, zone, () => this.win());
    }
  }

  private createBehaviors(): void {
    for (const e of this.level.entities) {
      switch (e.type) {
        case 'moving_platform':
          this.behaviors.push(new MovingPlatform(this, e));
          break;
        case 'enemy':
          this.behaviors.push(new Patroller(this, e));
          break;
        case 'bounce_pad':
          this.behaviors.push(new BouncePad(this, e));
          break;
        case 'key':
          if (e.x != null && e.y != null) this.behaviors.push(new Key(this, e));
          break;
        case 'door': {
          const door = new Door(this, e);
          this.doors.set(e.id, door);
          this.behaviors.push(door);
          break;
        }
        case 'checkpoint':
          if (e.x != null && e.y != null) this.behaviors.push(new Checkpoint(this, e));
          break;
        default:
          break;
      }
    }
  }

  private registerRules(): void {
    for (const rule of this.level.rules) {
      const action = parseAction(rule.then);
      if (!action) {
        console.warn(`[draw-a-level] unknown rule action "${rule.then}" ignored`);
        continue;
      }
      const seconds = parseTimerRule(rule.when);
      if (seconds !== null && !this.timer) {
        this.timer = new Timer(this, rule.when, seconds);
        this.behaviors.push(this.timer);
      }
      this.rules.on(rule.when, () => this.runAction(action));
    }
  }

  private runAction(action: RuleAction): void {
    switch (action.kind) {
      case 'open': {
        const door = this.doors.get(action.id);
        if (door) door.open();
        else console.warn(`[draw-a-level] rule opens unknown door "${action.id}"`);
        break;
      }
      case 'win':
        this.win();
        break;
      case 'lose':
        this.lose();
        break;
    }
  }

  private collectCoin(coin: Phaser.Physics.Arcade.Sprite): void {
    if (!coin.active) return;
    const id = coin.getData('id') as string;
    const x = coin.x;
    const y = coin.y;
    coin.destroy();
    this.coins += 1;
    this.hud.setCoins(this.coins);
    const pop = this.add.text(x, y - 6, '+1', { fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: ink.BLUE_DARK }).setOrigin(0.5).setDepth(30);
    this.tweens.add({ targets: pop, y: y - 26, alpha: 0, duration: 450, onComplete: () => pop.destroy() });
    this.rules.emit(`collect:${id}`);
    this.emitExternal('coin', { id, count: this.coins, total: this.totalCoins });
  }

  /** Small cloud of gray particles (doors opening). */
  puff(x: number, y: number, count = 14): void {
    const emitter = this.add.particles(x, y, 'puff', {
      speed: { min: 30, max: 110 },
      angle: { min: 0, max: 360 },
      scale: { start: 1.2, end: 0 },
      alpha: { start: 0.9, end: 0 },
      lifespan: 450,
      emitting: false,
    });
    emitter.setDepth(40);
    emitter.explode(count);
    this.time.delayedCall(700, () => emitter.destroy());
  }

  setRespawn(cellX: number, cellY: number): void {
    this.respawn = { x: cellX, y: cellY };
  }

  die(): void {
    if (this.dying || this.won) return;
    this.dying = true;
    this.deaths += 1;
    this.hud.setDeaths(this.deaths);
    const p = this.player;
    p.frozen = true;
    p.body.enable = false;
    p.sprite.setTint(0xe53935);
    this.tweens.add({ targets: p.sprite, alpha: 0, angle: p.sprite.flipX ? -40 : 40, duration: 260, ease: 'Quad.In' });
    this.cameras.main.shake(300, 0.012);
    this.emitExternal('die', { deaths: this.deaths });
    this.time.delayedCall(300, () => this.respawnPlayer());
  }

  private respawnPlayer(): void {
    const p = this.player;
    this.tweens.killTweensOf(p.sprite);
    p.sprite.clearTint().setAlpha(1).setAngle(0);
    p.body.enable = true;
    this.placePlayerAt(this.respawn.x, this.respawn.y);
    p.frozen = false;
    this.dying = false;
  }

  win(): void {
    if (this.won || this.dying) return;
    this.won = true;
    const p = this.player;
    p.frozen = true;
    p.body.setVelocityX(0);
    if (this.goalImage) {
      this.tweens.add({ targets: this.goalImage, angle: { from: -6, to: 6 }, duration: 180, yoyo: true, repeat: 5 });
    }
    const payload = {
      level: this.level.id,
      coins: this.coins,
      total: this.totalCoins,
      deaths: this.deaths,
      timeMs: Math.round(this.time.now - this.startedAt),
    };
    this.hud.showBanner('You made it!', `${this.coins} / ${this.totalCoins} coins · ${this.deaths} ${this.deaths === 1 ? 'death' : 'deaths'}`);
    this.emitExternal('win', payload);
  }

  /** `lose` rule action: die, show why, and restart the timer. */
  lose(): void {
    if (this.won) return;
    this.die();
    this.timer?.reset();
    this.hud.showBanner('Out of time!');
    this.time.delayedCall(1100, () => this.hud.hideBanner());
  }

  private buildSolverOverlay(): void {
    const t0 = performance.now();
    const result = solve(this.level);
    const ms = performance.now() - t0;
    console.info(`[draw-a-level] solver: ${result.solvable ? 'solvable' : `unsolvable (${result.reason})`}, ${result.reachable.length} cells, ${ms.toFixed(1)} ms`);
    const g = this.add.graphics().setDepth(45);
    g.fillStyle(0x43a047, 0.22);
    for (const key of result.reachable) {
      const [x, y] = key.split(',').map(Number);
      g.fillRect(x * CELL, (y - 1) * CELL, CELL, CELL * 2);
    }
    if (!result.solvable && this.goalImage) {
      this.goalImage.setTint(0xe53935);
      this.tweens.add({ targets: this.goalImage, alpha: 0.35, duration: 400, yoyo: true, repeat: -1 });
    }
    this.solverOverlay = g;
  }

  setDebugVisible(on: boolean): void {
    this.layer.setVisible(on);
    if (on && !this.solverOverlay) this.buildSolverOverlay();
    this.solverOverlay?.setVisible(on);
    const world = this.physics.world;
    if (on && !world.debugGraphic) world.createDebugGraphic();
    world.drawDebug = on;
    world.debugGraphic?.setVisible(on).setDepth(60);
    if (!on) world.debugGraphic?.clear();
  }

  override update(time: number, delta: number): void {
    for (const b of this.behaviors) b.update?.(time, delta);
    this.player.update(time);
    if (!this.dying && this.player.body.top > GAME_H + 2 * CELL) this.die();
  }

  private teardown(): void {
    this.hud?.destroy();
    for (const b of this.behaviors) b.destroy();
    this.behaviors = [];
    this.doors.clear();
    this.timer = null;
    this.rules.clear();
    this.solverOverlay = null;
    this.goalImage = null;
  }
}
