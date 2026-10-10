/**
 * In-scene preview overlays (PLAN_V2 §7.10, §7.11), depth 100, drawn in world space so they scroll with the level:
 * edit ghosts (before = dashed graphite, after = solid pencil, an arrow for moves), the bot path (dotted pencil),
 * flags (orange ring; an eye for blind spots) and the reach halo (reachable standing cells shaded green).
 */
import Phaser from 'phaser';
import type { CellXY, RectCells } from '../../core/types.gen.ts';
import { at, isFloor } from '../../core/art/terrain.ts';
import type { Grid } from '../../core/art/terrain.ts';
import type { OverlaySpec } from '../types.ts';
import { COLORS } from './juice.ts';
import { CELL } from '../gfx.ts';

const ORANGE = 0xf08a24;
const GRAPHITE = 0x3b3632;

function dashedRect(g: Phaser.GameObjects.Graphics, r: RectCells, dash = 5, gap = 4): void {
  const x0 = r[0] * CELL;
  const y0 = r[1] * CELL;
  const x1 = r[2] * CELL;
  const y1 = r[3] * CELL;
  const edge = (ax: number, ay: number, bx: number, by: number): void => {
    const L = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / (L || 1);
    const uy = (by - ay) / (L || 1);
    for (let s = 0; s < L; s += dash + gap) {
      const e = Math.min(L, s + dash);
      g.lineBetween(ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e);
    }
  };
  edge(x0, y0, x1, y0);
  edge(x1, y0, x1, y1);
  edge(x1, y1, x0, y1);
  edge(x0, y1, x0, y0);
}

function arrow(g: Phaser.GameObjects.Graphics, ax: number, ay: number, bx: number, by: number): void {
  g.lineBetween(ax, ay, bx, by);
  const a = Math.atan2(by - ay, bx - ax);
  for (const d of [-0.5, 0.5]) g.lineBetween(bx, by, bx - Math.cos(a + d) * 8, by - Math.sin(a + d) * 8);
}

export class Overlays {
  private g: Phaser.GameObjects.Graphics;
  private pulse: Phaser.GameObjects.Graphics;
  private flags: { at: CellXY; code: string }[] = [];

  constructor(scene: Phaser.Scene, layer: Phaser.GameObjects.Layer) {
    this.g = scene.add.graphics().setDepth(100);
    this.pulse = scene.add.graphics().setDepth(101);
    layer.add([this.g, this.pulse]);
  }

  set(o: OverlaySpec, grid?: Grid): void {
    const g = this.g;
    g.clear();
    // reach halo: the standing cell of each entry, merged into horizontal runs. An entry may be a feet position
    // (y = the floor's top) or a standing cell (y = the row just above the floor, the bot's "cx,cy" key); the
    // tiles tell them apart.
    const rowOf = (x: number, y: number): number => {
      const c = Math.floor(x);
      const r = Math.round(y);
      if (!grid) return r - 1;
      if (isFloor(at(grid, c, r)) && !isFloor(at(grid, c, r - 1))) return r - 1;
      if (isFloor(at(grid, c, r + 1))) return r;
      return r - 1;
    };
    const cells = [...new Set((o.reachHalo ?? []).map(([x, y]) => `${Math.floor(x)},${rowOf(x, y)}`))]
      .map((k) => k.split(',').map(Number) as [number, number])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    g.fillStyle(COLORS.green, 0.16);
    for (let i = 0; i < cells.length; ) {
      const [x, row] = cells[i];
      let j = i + 1;
      while (j < cells.length && cells[j][1] === row && cells[j][0] === cells[j - 1][0] + 1) j++;
      g.fillRect(x * CELL, row * CELL, (j - i) * CELL, CELL);
      i = j;
    }
    // bot path: dotted pencil
    const path = o.botPath ?? [];
    g.fillStyle(COLORS.violet, 0.75);
    let carry = 0;
    for (let i = 1; i < path.length; i++) {
      const ax = path[i - 1][0] * CELL;
      const ay = path[i - 1][1] * CELL - 10;
      const bx = path[i][0] * CELL;
      const by = path[i][1] * CELL - 10;
      const L = Math.hypot(bx - ax, by - ay);
      let s = carry;
      for (; s < L; s += 6) g.fillCircle(ax + ((bx - ax) * s) / L, ay + ((by - ay) * s) / L, 1.4);
      carry = s - L;
    }
    // edit ghosts
    for (const eg of o.editGhosts ?? []) {
      if (eg.kind !== 'appear') {
        g.lineStyle(1.5, GRAPHITE, 0.7);
        for (const r of eg.before) dashedRect(g, r);
      }
      if (eg.kind !== 'vanish') {
        g.lineStyle(2, COLORS.violet, 0.9);
        for (const r of eg.after) g.strokeRect(r[0] * CELL, r[1] * CELL, (r[2] - r[0]) * CELL, (r[3] - r[1]) * CELL);
      }
      if (eg.kind === 'move' && eg.before[0] && eg.after[0]) {
        const b = eg.before[0];
        const a = eg.after[0];
        g.lineStyle(2, COLORS.violet, 0.9);
        arrow(g, ((b[0] + b[2]) / 2) * CELL, ((b[1] + b[3]) / 2) * CELL, ((a[0] + a[2]) / 2) * CELL, ((a[1] + a[3]) / 2) * CELL);
      }
    }
    this.flags = o.flags ?? [];
  }

  update(now: number): void {
    const p = this.pulse;
    p.clear();
    if (!this.flags.length) return;
    const k = 1 + 0.15 * Math.sin((now / 1000) * Math.PI * 3);
    for (const f of this.flags) {
      const x = f.at[0] * CELL;
      const y = f.at[1] * CELL - 12;
      p.lineStyle(2.4, ORANGE, 0.95);
      p.strokeCircle(x, y, 11 * k);
      if (/blind/.test(f.code)) {
        // an eye: the landing is off screen at takeoff
        p.lineStyle(1.8, GRAPHITE, 1);
        p.beginPath();
        p.arc(x, y + 5, 7, -Math.PI * 0.85, -Math.PI * 0.15, false);
        p.strokePath();
        p.beginPath();
        p.arc(x, y - 5, 7, Math.PI * 0.15, Math.PI * 0.85, false);
        p.strokePath();
        p.fillStyle(GRAPHITE, 1);
        p.fillCircle(x, y, 2.2);
      } else if (!/tight/.test(f.code)) {
        p.lineStyle(2.2, ORANGE, 1);
        p.lineBetween(x, y - 5, x, y + 1.5);
        p.fillStyle(ORANGE, 1);
        p.fillCircle(x, y + 5, 1.5);
      }
    }
  }

  destroy(): void {
    this.g.destroy();
    this.pulse.destroy();
  }
}
