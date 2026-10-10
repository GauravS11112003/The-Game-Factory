/**
 * enemy with patrol (PLAN.md section 10, shared/behaviors.md).
 *
 * Image (crop or an ink blob) that walks between bbox.x0 and bbox.x0 + patrol.dx
 * at patrol.speed cells/s, flipping at the ends or when blocked by the grid.
 * No gravity: a monster drawn in mid-air hovers back and forth, one drawn on
 * the ground stays there. Overlap with the player = die.
 */
import type Phaser from 'phaser';
import type { Entity } from '../../types';
import { CELL, DEFAULT_PATROL_SPEED } from '../constants';
import type { LevelScene } from '../LevelScene';
import { drawEnemyBlob } from '../tiles';
import type { Behavior } from './types';

export class Patroller implements Behavior {
  readonly image: Phaser.Physics.Arcade.Image;
  readonly body: Phaser.Physics.Arcade.Body;
  private readonly minX: number;
  private readonly maxX: number;
  private readonly speedPx: number;
  private dir: -1 | 1;
  private readonly cleanups: Array<() => void> = [];

  constructor(scene: LevelScene, entity: Entity) {
    const [x0, y0, x1, y1] = entity.bbox ?? [entity.x ?? 0, entity.y ?? 0, entity.x ?? 0, entity.y ?? 0];
    const w = (x1 - x0 + 1) * CELL;
    const h = (y1 - y0 + 1) * CELL;
    const dx = entity.patrol?.dx ?? 6;
    this.speedPx = Math.max(0.1, entity.patrol?.speed ?? DEFAULT_PATROL_SPEED) * CELL;
    this.minX = Math.min(x0, x0 + dx) * CELL;
    this.maxX = Math.max(x0, x0 + dx) * CELL;
    this.dir = dx < 0 ? -1 : 1;

    const key = scene.entityTexture(entity, `enemy_${w}x${h}`, w, h, (ctx) => drawEnemyBlob(ctx, w, h));
    this.image = scene.physics.add.image(x0 * CELL, y0 * CELL, key).setOrigin(0, 0).setDisplaySize(w, h).setDepth(12);
    this.body = this.image.body as Phaser.Physics.Arcade.Body;
    this.body.setAllowGravity(false);
    this.body.setImmovable(true);
    this.body.pushable = false;

    const layerCollider = scene.physics.add.collider(this.image, scene.layer);
    const hit = scene.physics.add.overlap(scene.player.sprite, this.image, () => {
      scene.rules.emit(`touch:${entity.id}`);
      scene.die();
    });
    this.cleanups.push(() => layerCollider.destroy(), () => hit.destroy());
  }

  update(): void {
    const x = this.image.x;
    if (this.dir < 0 && (x <= this.minX || this.body.blocked.left)) this.dir = 1;
    else if (this.dir > 0 && (x >= this.maxX || this.body.blocked.right)) this.dir = -1;
    this.body.setVelocityX(this.dir * this.speedPx);
    this.image.setFlipX(this.dir < 0);
  }

  destroy(): void {
    for (const fn of this.cleanups.splice(0)) fn();
    this.image.destroy();
  }
}
