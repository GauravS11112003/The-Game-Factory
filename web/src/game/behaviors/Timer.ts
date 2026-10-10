/**
 * timer (PLAN.md section 10, shared/behaviors.md).
 *
 * Built from a rule whose `when` is `timer:N`: counts down in the HUD and
 * emits that exact `when` string once it reaches zero. The rule's `then`
 * (normally `lose`) does the rest; the scene's lose() calls reset().
 */
import type { LevelScene } from '../LevelScene';
import type { Behavior } from './types';

export class Timer implements Behavior {
  private readonly scene: LevelScene;
  private readonly when: string;
  private readonly seconds: number;
  private remaining: number;
  private fired = false;

  constructor(scene: LevelScene, when: string, seconds: number) {
    this.scene = scene;
    this.when = when;
    this.seconds = seconds;
    this.remaining = seconds;
    scene.hud.setTimer(seconds);
  }

  update(_time: number, delta: number): void {
    if (this.fired || this.scene.won || this.scene.dying) return;
    this.remaining -= delta / 1000;
    if (this.remaining <= 0) {
      this.remaining = 0;
      this.fired = true;
      this.scene.hud.setTimer(0);
      this.scene.rules.emit(this.when);
      return;
    }
    this.scene.hud.setTimer(this.remaining);
  }

  reset(): void {
    this.remaining = this.seconds;
    this.fired = false;
    this.scene.hud.setTimer(this.seconds);
  }

  destroy(): void {
    this.fired = true;
  }
}
