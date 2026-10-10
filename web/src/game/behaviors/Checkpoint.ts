/**
 * checkpoint (PLAN.md section 10, shared/behaviors.md).
 *
 * A small flag at the cell; the first overlap raises it, sets the respawn
 * point and emits "touch:<id>" once.
 */
import type Phaser from 'phaser';
import type { Entity } from '../../types';
import { CELL } from '../constants';
import type { LevelScene } from '../LevelScene';
import { FLAG_H, FLAG_W, drawCheckpointFlag } from '../tiles';
import type { Behavior } from './types';

export class Checkpoint implements Behavior {
  private readonly image: Phaser.GameObjects.Image;
  private readonly zone: Phaser.GameObjects.Zone;
  private readonly overlap: Phaser.Physics.Arcade.Collider;
  private active = false;

  constructor(scene: LevelScene, entity: Entity) {
    const cx = entity.x ?? 0;
    const cy = entity.y ?? 0;
    const off = scene.ensureCanvasTexture('flag_off', FLAG_W, FLAG_H, (ctx) => drawCheckpointFlag(ctx, false));
    scene.ensureCanvasTexture('flag_on', FLAG_W, FLAG_H, (ctx) => drawCheckpointFlag(ctx, true));
    this.image = scene.add.image(cx * CELL, (cy + 1) * CELL, off).setOrigin(0, 1).setDepth(14);
    this.zone = scene.add.zone(cx * CELL, (cy - 1) * CELL, CELL, CELL * 2).setOrigin(0, 0);
    scene.physics.add.existing(this.zone, true);
    this.overlap = scene.physics.add.overlap(scene.player.sprite, this.zone, () => {
      if (this.active) return;
      this.active = true;
      this.image.setTexture('flag_on');
      this.image.setScale(1.3);
      scene.tweens.add({ targets: this.image, scale: 1, duration: 250, ease: 'Back.Out' });
      scene.setRespawn(cx, cy);
      scene.rules.emit(`touch:${entity.id}`);
    });
  }

  destroy(): void {
    this.overlap.destroy();
    this.zone.destroy();
    this.image.destroy();
  }
}
