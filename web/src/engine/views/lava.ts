/**
 * Lava (PLAN_V2 §5.8, §7.1 rule 1): the static fill comes from the ArtDoc; this draws the animated wavy top with
 * a dark outline and 2 bubbles/s per run, so the hazard is always moving and readable.
 */
import Phaser from 'phaser';
import type { ArtLava } from '../../core/art/types.ts';
import { HAZARDS } from '../../core/params.ts';
import { COLORS } from './juice.ts';
import { CELL, VIEW_W_PX } from '../gfx.ts';

interface Bubble {
  x: number;
  y: number;
  t: number;
  life: number;
  r: number;
}

export class LavaView {
  private g: Phaser.GameObjects.Graphics;
  private runs: ArtLava[];
  private bubbles: Bubble[] = [];
  private acc: number[];
  private reduced: boolean;

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Layer, runs: ArtLava[], reduced: boolean) {
    this.runs = runs;
    this.reduced = reduced;
    this.acc = runs.map(() => 0);
    this.g = scene.add.graphics().setDepth(55);
    layer.add(this.g);
  }

  update(now: number, dt: number, camX: number): void {
    const g = this.g;
    g.clear();
    if (!this.runs.length) return;
    const t = now / 1000;
    this.runs.forEach((run, i) => {
      const x0 = run.x0 * CELL;
      const x1 = run.x1 * CELL;
      if (x1 < camX - 32 || x0 > camX + VIEW_W_PX + 32) return;
      const top = run.y * CELL + 3.2;
      const pts: Phaser.Math.Vector2[] = [];
      for (let x = x0; x <= x1 + 0.01; x += 4) {
        const w = this.reduced ? 0 : Math.sin(x * 0.12 + t * 3.1) * 1.3 + Math.sin(x * 0.31 - t * 2.3) * 0.6;
        pts.push(new Phaser.Math.Vector2(Math.min(x, x1), top + w));
      }
      const poly = [...pts, new Phaser.Math.Vector2(x1, top + 8), new Phaser.Math.Vector2(x0, top + 8)];
      g.fillStyle(COLORS.red, 0.95);
      g.fillPoints(poly, true);
      g.lineStyle(2, 0x8e1f18, 0.95);
      g.strokePoints(pts, false);
      g.lineStyle(1.2, 0xffb347, 0.8);
      g.strokePoints(pts.map((p) => new Phaser.Math.Vector2(p.x, p.y + 2.2)), false);
      if (!this.reduced) {
        this.acc[i] += (dt / 1000) * HAZARDS.lava.bubbles_per_s * Math.max(1, (run.x1 - run.x0) / 6);
        while (this.acc[i] >= 1) {
          this.acc[i] -= 1;
          this.bubbles.push({ x: x0 + 4 + Math.random() * Math.max(1, x1 - x0 - 8), y: top + 6, t: 0, life: 600 + Math.random() * 500, r: 1.5 + Math.random() * 1.8 });
        }
      }
    });
    for (const b of this.bubbles) {
      b.t += dt;
      const k = b.t / b.life;
      const y = b.y - k * 9;
      g.lineStyle(1.3, 0x8e1f18, 1 - k * 0.6);
      g.strokeCircle(b.x, y, b.r * (k > 0.85 ? 1.6 : 1));
    }
    this.bubbles = this.bubbles.filter((b) => b.t < b.life);
  }

  destroy(): void {
    this.g.destroy();
  }
}
