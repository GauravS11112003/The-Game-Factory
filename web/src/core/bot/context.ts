/** Shared analysis context for the bot's report builders (flags, slots, frontier). */
import type { SegmentStats } from '../difficulty/model.ts';
import type { SimCore } from '../sim/core.ts';
import { CELL } from '../sim/tiles.ts';
import type { SimWorld } from '../sim/world.ts';
import type { LevelV2, RouteKind, SceneObject, Tier } from '../types.gen.ts';
import type { BEdge, Explorer } from './explore.ts';
import type { StepWindows } from './measure.ts';

export interface RStep {
  i: number;
  kind: RouteKind;
  edges: BEdge[];
  from: number;
  to: number; // node index or GOAL
  frames: number;
  required: boolean;
  win: StepWindows;
  pc: number; // p_death casual
  ps: number; // p_death skilled
  seg: number;
  startF: number; // global trace frame at the step start
  endF: number;
  pressF: number; // global frame of the jump press (−1)
  leaveF: number; // global frame the player left the ground (−1)
  camX: number | null; // camera left edge (cells) at the press / leave frame
  takeoff: [number, number]; // px
  land: [number, number]; // px
  apexY: number; // px (min feet y)
  bonk: boolean;
  cps: number[]; // checkpoint def indices activated in this step
  path: [number, number][]; // feet samples (px) every 2 frames
  setpiece: string | null;
  blind: boolean;
}

export interface Ctx {
  level: LevelV2;
  sim: SimCore;
  W: SimWorld;
  ex: Explorer;
  tier: Tier;
  mode: 'fast' | 'full';
  steps: RStep[];
  segs: SegmentStats[];
  routeNodes: Set<number>;
  d2g: Float64Array;
  reach: Uint8Array;
  C: number;
  entMin: Float64Array; // min px distance of the route body to each def
  entFirstF: Float64Array; // first route frame within 2 cells (Infinity)
  stomped: Set<number>;
  traceOk: boolean;
}

/** Bounding box (cells) of a scene object's shape. */
export function objectBox(o: SceneObject): [number, number, number, number] | null {
  const s = o.shape as unknown as Record<string, unknown> | undefined;
  if (!s) return null;
  switch (s.k) {
    case 'surface': {
      const segs = (s.segs as { a: [number, number]; b: [number, number] }[]) ?? [];
      if (!segs.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const g of segs) {
        x0 = Math.min(x0, g.a[0], g.b[0]); x1 = Math.max(x1, g.a[0], g.b[0]);
        y0 = Math.min(y0, g.a[1], g.b[1]); y1 = Math.max(y1, g.a[1], g.b[1]);
      }
      return [x0, y0, x1, y1 + 1];
    }
    case 'strip': {
      const a = s.a as [number, number];
      const b = s.b as [number, number];
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]) - 0.5, Math.max(a[0], b[0]), Math.max(a[1], b[1]) + 0.5];
    }
    case 'body': {
      const b = s.bbox as [number, number, number, number];
      return b ? [b[0], b[1], b[2], b[3]] : null;
    }
    case 'point': {
      const p = s.p as [number, number];
      return [p[0] - 0.5, p[1] - 0.5, p[0] + 0.5, p[1] + 0.5];
    }
    case 'wall':
      return [(s.x as number) - 0.5, s.y0 as number, (s.x as number) + 0.5, s.y1 as number];
    default:
      return null;
  }
}

/** Ids of scene objects whose box intersects a cell rect (optionally filtered by role). */
export function objectsIn(level: LevelV2, x0: number, y0: number, x1: number, y1: number, roles?: string[]): string[] {
  const out: string[] = [];
  for (const o of level.objects ?? []) {
    if (roles && !roles.includes(o.role)) continue;
    const b = objectBox(o);
    if (!b) continue;
    if (b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0) out.push(o.id);
  }
  return out;
}

export const r2 = (v: number): number => Math.round(v * 100) / 100;
export const cellsXY = (x: number, y: number): [number, number] => [r2(x / CELL), r2(y / CELL)];
