/**
 * Player (PLAN.md section 10, "Engine details").
 *
 * Texture from sprites.player or the runtime doodle; arcade body
 * PLAYER_W x PLAYER_H aligned to the sprite's feet; constants from
 * constants.ts; coyote time, jump buffer and variable jump cut in update().
 * Input: arrows, WASD, space/up, plus the touch buttons from touch.ts.
 */
import Phaser from 'phaser';
import {
  BUFFER_MS,
  COYOTE_MS,
  GRAVITY,
  JUMP_CUT_VY,
  JUMP_VY,
  PLAYER_H,
  PLAYER_W,
  RUN_SPEED,
} from './constants';
import { PLAYER_TEX_H, PLAYER_TEX_W } from './tiles';
import type { TouchControls } from './touch';

interface Keys {
  left: Phaser.Input.Keyboard.Key;
  right: Phaser.Input.Keyboard.Key;
  up: Phaser.Input.Keyboard.Key;
  a: Phaser.Input.Keyboard.Key;
  d: Phaser.Input.Keyboard.Key;
  w: Phaser.Input.Keyboard.Key;
  space: Phaser.Input.Keyboard.Key;
}

/** Set by a MovingPlatform's collider each frame the player stands on it. */
export interface RideDelta {
  dx: number;
  dy: number;
}

export class Player {
  readonly sprite: Phaser.Physics.Arcade.Sprite;
  readonly body: Phaser.Physics.Arcade.Body;
  /** When true, input is ignored and the player stands still (win / death). */
  frozen = false;
  /** Platform the player is riding this frame; cleared after update(). */
  ride: RideDelta | null = null;

  private readonly scene: Phaser.Scene;
  private readonly keys: Keys | null;
  private readonly touch: TouchControls | null;
  private readonly spriteScale: number;
  private lastGroundedAt = -1e9;
  private jumpBufferedAt = -1e9;
  private prevJumpDown = false;
  private jumpActive = false;
  private wasGrounded = false;
  private squashTween: Phaser.Tweens.Tween | null = null;

  constructor(scene: Phaser.Scene, textureKey: string, touch: TouchControls | null) {
    this.scene = scene;
    this.touch = touch;
    this.sprite = scene.physics.add.sprite(0, 0, textureKey);
    this.body = this.sprite.body as Phaser.Physics.Arcade.Body;

    // Custom sprites are at most 32x48 (CV pipeline), but be safe: fit into that box, never upscale.
    const fw = this.sprite.width;
    const fh = this.sprite.height;
    const s = Math.min(PLAYER_TEX_W / fw, PLAYER_TEX_H / fh, 1);
    this.spriteScale = s;
    this.sprite.setScale(s);
    // Body size/offset are in texture pixels; divide by the scale so the body is PLAYER_W x PLAYER_H on screen.
    const bw = PLAYER_W / s;
    const bh = PLAYER_H / s;
    this.body.setSize(bw, bh);
    this.body.setOffset((fw - bw) / 2, fh - bh);
    this.body.setGravityY(GRAVITY);
    this.body.setCollideWorldBounds(true);
    this.body.setMaxVelocityY(1200);
    this.sprite.setDepth(20);

    const kb = scene.input.keyboard;
    this.keys = kb
      ? (kb.addKeys({
          left: Phaser.Input.Keyboard.KeyCodes.LEFT,
          right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
          up: Phaser.Input.Keyboard.KeyCodes.UP,
          a: Phaser.Input.Keyboard.KeyCodes.A,
          d: Phaser.Input.Keyboard.KeyCodes.D,
          w: Phaser.Input.Keyboard.KeyCodes.W,
          space: Phaser.Input.Keyboard.KeyCodes.SPACE,
        }) as Keys)
      : null;
  }

  /** Place the player by the pixel position of its feet center and stop it. */
  setFeet(x: number, y: number): void {
    const halfH = (this.sprite.height * this.spriteScale) / 2;
    this.sprite.setPosition(x, y - halfH);
    this.body.reset(x, y - halfH);
    this.body.setVelocity(0, 0);
    this.jumpActive = false;
    this.jumpBufferedAt = -1e9;
    this.lastGroundedAt = -1e9;
    this.wasGrounded = false;
    this.ride = null;
  }

  get feetX(): number {
    return this.body.center.x;
  }

  get feetY(): number {
    return this.body.bottom;
  }

  get onGround(): boolean {
    return this.body.blocked.down || this.body.touching.down;
  }

  /** Bounce pads: launch regardless of input; not subject to the jump cut. */
  bounce(vy: number): void {
    this.body.setVelocityY(vy);
    this.jumpActive = false;
    this.lastGroundedAt = -1e9;
    this.jumpBufferedAt = -1e9;
    this.squash(0.7, 1.3);
  }

  private squash(sx: number, sy: number): void {
    this.squashTween?.stop();
    const s = this.spriteScale;
    this.sprite.setScale(s * sx, s * sy);
    this.squashTween = this.scene.tweens.add({
      targets: this.sprite,
      scaleX: s,
      scaleY: s,
      duration: 160,
      ease: 'Quad.Out',
    });
  }

  private readInput(): { dir: -1 | 0 | 1; jump: boolean } {
    const k = this.keys;
    const t = this.touch?.state;
    const left = (k?.left.isDown || k?.a.isDown || t?.left) ?? false;
    const right = (k?.right.isDown || k?.d.isDown || t?.right) ?? false;
    const jump = (k?.up.isDown || k?.w.isDown || k?.space.isDown || t?.jump) ?? false;
    const dir: -1 | 0 | 1 = left === right ? 0 : left ? -1 : 1;
    return { dir, jump };
  }

  update(time: number): void {
    const body = this.body;
    const grounded = this.onGround;
    const landed = grounded && !this.wasGrounded;
    this.wasGrounded = grounded;
    const { dir, jump } = this.frozen ? { dir: 0 as const, jump: false } : this.readInput();

    body.setVelocityX(dir * RUN_SPEED);
    if (dir !== 0) this.sprite.setFlipX(dir < 0);

    if (this.onGround) {
      this.lastGroundedAt = time;
      if (body.velocity.y >= 0) this.jumpActive = false;
    }

    if (jump && !this.prevJumpDown) this.jumpBufferedAt = time;

    const canJump = time - this.lastGroundedAt <= COYOTE_MS;
    const wantsJump = time - this.jumpBufferedAt <= BUFFER_MS;
    if (canJump && wantsJump && !this.jumpActive) {
      body.setVelocityY(JUMP_VY);
      this.jumpActive = true;
      this.jumpBufferedAt = -1e9;
      this.lastGroundedAt = -1e9;
      this.squash(0.85, 1.15);
    }

    if (!jump && this.prevJumpDown && this.jumpActive && body.velocity.y < JUMP_CUT_VY) {
      body.setVelocityY(JUMP_CUT_VY);
      this.jumpActive = false;
    }
    this.prevJumpDown = jump;

    // Landing squash (skipped while riding a platform, whose re-contact each frame would flicker it).
    if (landed && !this.ride) this.squash(1.15, 0.85);

    // Carried by a moving platform: the platform's delta for this frame (set by its collider).
    if (this.ride) {
      this.sprite.x += this.ride.dx;
      if (this.ride.dy > 0) this.sprite.y += this.ride.dy;
      this.ride = null;
    }
  }

  destroy(): void {
    this.squashTween?.stop();
    this.sprite.destroy();
  }
}
