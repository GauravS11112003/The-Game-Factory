/**
 * moving_platform (PLAN.md section 10, shared/behaviors.md).
 *
 * Image (comp_<id>.png, or an ink rectangle sized to the bbox) tweened
 * ping-pong between the path points at `speed` cells/s. The player rides it:
 * the collider marks the player as riding, and the platform's per-frame delta
 * (image position now minus last frame, which is what a tween moves and what
 * Arcade's body.deltaX() does not include) is added to the player in its update.
 */
import type Phaser from 'phaser';
import type { Entity } from '../../types';
import { CELL, DEFAULT_MOVE_SPEED } from '../constants';
import type { LevelScene } from '../LevelScene';
import type { RideDelta } from '../Player';
import { drawPlatformInk } from '../tiles';
import type { Behavior } from './types';

export class MovingPlatform implements Behavior {
  readonly image: Phaser.Physics.Arcade.Image;
  readonly body: Phaser.Physics.Arcade.Body;
  private readonly scene: LevelScene;
  private readonly targets: Array<{ x: number; y: number }>;
  private readonly speedPx: number;
  private readonly delta: RideDelta = { dx: 0, dy: 0 };
  private idx = 0;
  private forward = true;
  private lastX: number;
  private lastY: number;
  private tween: Phaser.Tweens.Tween | null = null;
  private collider: Phaser.Physics.Arcade.Collider | null = null;

  constructor(scene: LevelScene, entity: Entity) {
    this.scene = scene;
    const first = entity.path?.[0];
    const bbox = entity.bbox ?? (first ? [first[0], first[1], first[0] + 2, first[1]] : [0, 0, 2, 0]);
    const [x0, y0, x1, y1] = bbox;
    const w = (x1 - x0 + 1) * CELL;
    const h = (y1 - y0 + 1) * CELL;
    const path = entity.path && entity.path.length >= 1 ? entity.path : [[x0, y0]];
    this.targets = path.map(([cx, cy]) => ({ x: cx * CELL, y: cy * CELL }));
    this.speedPx = Math.max(0.1, entity.speed ?? DEFAULT_MOVE_SPEED) * CELL;

    const key = scene.entityTexture(entity, `plat_${w}x${h}`, w, h, (ctx) => drawPlatformInk(ctx, w, h));
    const start = this.targets[0];
    this.image = scene.physics.add.image(start.x, start.y, key).setOrigin(0, 0).setDisplaySize(w, h).setDepth(10);
    this.body = this.image.body as Phaser.Physics.Arcade.Body;
    this.body.setAllowGravity(false);
    this.body.setImmovable(true);
    this.body.pushable = false;
    this.lastX = this.image.x;
    this.lastY = this.image.y;

    const player = scene.player;
    this.collider = scene.physics.add.collider(player.sprite, this.image, () => {
      if (player.body.touching.down && this.body.touching.up) {
        player.ride = this.delta;
        scene.rules.emit(`touch:${entity.id}`);
      }
    });

    if (this.targets.length > 1) this.startLeg();
  }

  private startLeg(): void {
    const n = this.targets.length;
    let next = this.idx + (this.forward ? 1 : -1);
    if (next >= n) {
      this.forward = false;
      next = n - 2;
    } else if (next < 0) {
      this.forward = true;
      next = 1;
    }
    const to = this.targets[next];
    const dist = Math.hypot(to.x - this.image.x, to.y - this.image.y);
    this.idx = next;
    if (dist < 0.01) {
      this.startLeg();
      return;
    }
    this.tween = this.scene.tweens.add({
      targets: this.image,
      x: to.x,
      y: to.y,
      duration: (dist / this.speedPx) * 1000,
      ease: 'Linear',
      onComplete: () => this.startLeg(),
    });
  }

  update(): void {
    this.delta.dx = this.image.x - this.lastX;
    this.delta.dy = this.image.y - this.lastY;
    this.lastX = this.image.x;
    this.lastY = this.image.y;
  }

  destroy(): void {
    this.tween?.stop();
    this.tween = null;
    this.collider?.destroy();
    this.collider = null;
    this.image.destroy();
  }
}
