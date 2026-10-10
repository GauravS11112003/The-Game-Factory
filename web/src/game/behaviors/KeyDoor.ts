/**
 * key + door (PLAN.md section 10, shared/behaviors.md).
 *
 * Key: collectable sprite at a cell; overlap -> rules.emit("collect:<key id>").
 * Door: static image (crop or ink planks) on its bbox with a static body;
 * the scene's rule handler calls open() on "open:<door id>", which destroys
 * it with a puff of particles.
 */
import type Phaser from 'phaser';
import type { Entity } from '../../types';
import { CELL } from '../constants';
import type { LevelScene } from '../LevelScene';
import { KEY_H, KEY_W, drawDoorInk, drawKey } from '../tiles';
import type { Behavior } from './types';

export class Key implements Behavior {
  private readonly scene: LevelScene;
  private readonly image: Phaser.Physics.Arcade.Image;
  private readonly overlap: Phaser.Physics.Arcade.Collider;
  private readonly id: string;
  private collected = false;

  constructor(scene: LevelScene, entity: Entity) {
    this.scene = scene;
    this.id = entity.id;
    const cx = (entity.x ?? 0) * CELL + CELL / 2;
    const cy = (entity.y ?? 0) * CELL + CELL / 2;
    const key = scene.ensureCanvasTexture('key', KEY_W, KEY_H, drawKey);
    this.image = scene.physics.add.staticImage(cx, cy, key).setDepth(15);
    scene.tweens.add({ targets: this.image, y: cy - 3, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    this.overlap = scene.physics.add.overlap(scene.player.sprite, this.image, () => this.collect());
  }

  private collect(): void {
    if (this.collected) return;
    this.collected = true;
    this.overlap.destroy();
    this.scene.tweens.killTweensOf(this.image);
    this.scene.tweens.add({
      targets: this.image,
      y: this.image.y - 24,
      alpha: 0,
      scale: 1.6,
      duration: 350,
      ease: 'Quad.Out',
      onComplete: () => this.image.destroy(),
    });
    this.scene.rules.emit(`collect:${this.id}`);
  }

  destroy(): void {
    this.overlap.destroy();
    this.image.destroy();
  }
}

export class Door implements Behavior {
  private readonly scene: LevelScene;
  private readonly image: Phaser.Physics.Arcade.Image;
  private readonly collider: Phaser.Physics.Arcade.Collider;
  private opened = false;

  constructor(scene: LevelScene, entity: Entity) {
    this.scene = scene;
    const [x0, y0, x1, y1] = entity.bbox ?? [entity.x ?? 0, entity.y ?? 0, entity.x ?? 0, entity.y ?? 0];
    const w = (x1 - x0 + 1) * CELL;
    const h = (y1 - y0 + 1) * CELL;
    const key = scene.entityTexture(entity, `door_${w}x${h}`, w, h, (ctx) => drawDoorInk(ctx, w, h));
    this.image = scene.physics.add.staticImage(x0 * CELL, y0 * CELL, key).setOrigin(0, 0).setDisplaySize(w, h).setDepth(10);
    (this.image.body as Phaser.Physics.Arcade.StaticBody).updateFromGameObject();
    this.collider = scene.physics.add.collider(scene.player.sprite, this.image);
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const cx = this.image.x + this.image.displayWidth / 2;
    const cy = this.image.y + this.image.displayHeight / 2;
    this.scene.puff(cx, cy, Math.round(10 + this.image.displayHeight / 8));
    this.collider.destroy();
    this.image.destroy();
  }

  destroy(): void {
    if (!this.opened) {
      this.collider.destroy();
      this.image.destroy();
    }
  }
}
