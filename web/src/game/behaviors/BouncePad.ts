/**
 * bounce_pad (PLAN.md section 10, shared/behaviors.md).
 *
 * The tiles under the bbox stay solid; a zone over the bbox (with a 4 px lip
 * above it, so a player resting on the tiles overlaps) launches the player
 * with vy = BOUNCE_VY * strength whenever it overlaps while falling or
 * resting (vy >= 0). A spring doodle sits on top and squashes on launch.
 */
import type Phaser from 'phaser';
import type { Entity } from '../../types';
import { BOUNCE_VY, CELL } from '../constants';
import type { LevelScene } from '../LevelScene';
import { PAD_H, drawBouncePad } from '../tiles';
import type { Behavior } from './types';

const LIP = 4;
const COOLDOWN_MS = 120;

export class BouncePad implements Behavior {
  private readonly visual: Phaser.GameObjects.Image;
  private readonly zone: Phaser.GameObjects.Zone;
  private readonly overlap: Phaser.Physics.Arcade.Collider;
  private lastBounceAt = -1e9;

  constructor(scene: LevelScene, entity: Entity) {
    const [x0, y0, x1, y1] = entity.bbox ?? [entity.x ?? 0, entity.y ?? 0, entity.x ?? 0, entity.y ?? 0];
    const w = (x1 - x0 + 1) * CELL;
    const h = (y1 - y0 + 1) * CELL;
    const strength = entity.strength ?? 1;

    const key = scene.ensureCanvasTexture(`pad_${w}`, w, PAD_H, (ctx) => drawBouncePad(ctx, w));
    this.visual = scene.add.image(x0 * CELL, y0 * CELL, key).setOrigin(0, 1).setDepth(9);

    this.zone = scene.add.zone(x0 * CELL, y0 * CELL - LIP, w, h + LIP).setOrigin(0, 0);
    scene.physics.add.existing(this.zone, true);

    const player = scene.player;
    this.overlap = scene.physics.add.overlap(player.sprite, this.zone, () => {
      const now = scene.time.now;
      if (player.body.velocity.y < 0 || now - this.lastBounceAt < COOLDOWN_MS) return;
      this.lastBounceAt = now;
      player.bounce(BOUNCE_VY * strength);
      scene.rules.emit(`touch:${entity.id}`);
      this.visual.setScale(1.15, 0.5);
      scene.tweens.add({ targets: this.visual, scaleX: 1, scaleY: 1, duration: 220, ease: 'Back.Out' });
    });
  }

  destroy(): void {
    this.overlap.destroy();
    this.zone.destroy();
    this.visual.destroy();
  }
}
