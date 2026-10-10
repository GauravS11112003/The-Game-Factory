/**
 * Parallax (PLAN_V2 §7.5): deterministic from (level id, theme), no assets, ≤ 30% contrast.
 * - Far (0.2): 2-3 graphite hill lines (sums of 3 sines) and scalloped clouds every ~12 cells (drift 2 px/s, engine).
 * - Mid (0.5): bush, grass and tree doodles every 6-10 cells.
 * - Foreground (1.1): tufts about 1 per 8 cells on terrain tops, never within 2 cells of a hazard.
 */
import type { Entity, Theme, World } from '../types.gen.ts';
import { ART } from '../params.ts';
import type { ArtPath } from './types.ts';
import { flat, hash32, rng } from './geom.ts';
import type { V } from './geom.ts';
import { at, exposed } from './terrain.ts';
import type { Grid } from './terrain.ts';

const PX_ = ART.parallax;
const VIEW_W = 48;

/** Width (cells) a layer with scroll factor f must cover for a world of width w. */
export function layerWidth(w: number, f: number): number {
  return Math.ceil(Math.max(0, w - VIEW_W) * f + VIEW_W + 2);
}

function line(pts: [number, number][]): number[] {
  return flat(pts.map((p) => [p[0], p[1], 0] as V));
}

export interface ParallaxOut {
  far: ArtPath[];
  clouds: ArtPath[];
  mid: ArtPath[];
  fg: ArtPath[];
}

export function buildParallax(levelId: string, theme: Theme, world: World, g: Grid, entities: Entity[]): ParallaxOut {
  const r = rng(hash32(`${levelId}|${theme}|parallax`));
  const far: ArtPath[] = [];
  const clouds: ArtPath[] = [];
  const mid: ArtPath[] = [];
  const fg: ArtPath[] = [];

  // far hills: each a sum of 3 sines, back lines lighter
  const fw = layerWidth(world.w, PX_.far);
  const hills = 2 + (r() < 0.5 ? 1 : 0);
  for (let k = 0; k < hills; k++) {
    const base = 14.2 + k * 2.3 + r() * 1.2;
    const amps = [1.5 + r() * 0.9, 0.7 + r() * 0.4, 0.25 + r() * 0.2];
    const lams = [20 + r() * 9, 9 + r() * 4, 4 + r() * 2];
    const phs = [r() * 6.283, r() * 6.283, r() * 6.283];
    const pts: [number, number][] = [];
    for (let x = -2; x <= fw + 2; x += 0.5) {
      let y = base;
      for (let i = 0; i < 3; i++) y += amps[i] * Math.sin((x / lams[i]) * 6.283 + phs[i]);
      pts.push([x, y]);
    }
    const style = `far${hills - 1 - k}`;
    if (k === hills - 1) {
      // a faint wash under the nearest hill line gives the horizon some weight
      far.push({ pts: line([...pts, [fw + 2, 27], [-2, 27]]), closed: true, style: 'far_wash' });
    }
    far.push({ pts: line(pts), closed: false, style });
  }
  // scalloped clouds
  for (let x = 3 + r() * 6; x < fw; x += PX_.cloud_every_c * (0.75 + r() * 0.5)) {
    const y = 3 + r() * 4.5;
    const w = 3 + r() * 3;
    const bumps = 3 + Math.floor(r() * 3);
    const pts: [number, number][] = [[x, y]];
    for (let i = 0; i < bumps; i++) {
      const a0 = x + (w * i) / bumps;
      const a1 = x + (w * (i + 1)) / bumps;
      const rr = (a1 - a0) / 2;
      const h = rr * (1.1 + r() * 0.6);
      for (let t = 1; t <= 6; t++) {
        const ang = Math.PI - (Math.PI * t) / 6;
        pts.push([(a0 + a1) / 2 + Math.cos(ang) * rr, y - Math.sin(ang) * h]);
      }
    }
    pts.push([x + w, y]);
    clouds.push({ pts: line(pts), closed: true, style: 'cloud' });
  }

  // mid doodles along a baseline
  const mw = layerWidth(world.w, PX_.mid);
  const [e0, e1] = PX_.mid_every_c;
  for (let x = 2 + r() * 4; x < mw; x += e0 + r() * (e1 - e0)) {
    const y = 21.5 + r() * 1.5;
    const kind = r();
    if (kind < 0.35) {
      // bush: a bumpy dome
      const w = 1.6 + r() * 1.4;
      const pts: [number, number][] = [];
      for (let t = 0; t <= 16; t++) {
        const a = Math.PI - (Math.PI * t) / 16;
        const k = 1 + 0.12 * Math.sin(t * 2.1);
        pts.push([x + w / 2 + (Math.cos(a) * w * k) / 2, y - Math.sin(a) * w * 0.55 * k]);
      }
      mid.push({ pts: line(pts), closed: true, style: 'mid_wash' });
      mid.push({ pts: line(pts), closed: false, style: 'mid' });
    } else if (kind < 0.65) {
      // grass: 3-5 blades
      const n = 3 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const bx = x + i * 0.25;
        const h = 0.5 + r() * 0.5;
        mid.push({ pts: line([[bx, y], [bx + (r() - 0.5) * 0.4, y - h]]), closed: false, style: 'mid' });
      }
    } else {
      // tree: trunk + scribbly round crown
      const h = 3 + r() * 2.5;
      const cr = 1 + r() * 0.8;
      mid.push({ pts: line([[x, y], [x + 0.05, y - h]]), closed: false, style: 'mid' });
      const crown: [number, number][] = [];
      for (let t = 0; t <= 22; t++) {
        const a = (t / 22) * Math.PI * 2;
        const k = 1 + 0.15 * Math.sin(a * 5 + x);
        crown.push([x + Math.cos(a) * cr * k, y - h - cr * 0.6 + Math.sin(a) * cr * 0.85 * k]);
      }
      mid.push({ pts: line(crown), closed: true, style: 'mid_wash' });
      mid.push({ pts: line(crown), closed: false, style: 'mid' });
    }
  }

  // foreground tufts on walkable tops, ≥ 2 cells from any hazard
  const hazards: [number, number, number, number][] = [];
  for (const e of entities) {
    if (e.type === 'spikes') {
      const vertical = e.facing === 'left' || e.facing === 'right';
      hazards.push(vertical ? [e.y - 1, Math.min(e.x0, e.x1), e.y + 1, Math.max(e.x0, e.x1)] : [e.x0, e.y - 1, e.x1, e.y + 1]);
    }
    else if (e.type === 'saw') hazards.push([e.x - e.r, e.y - e.r, e.x + e.r, e.y + e.r]);
    else if (e.type === 'enemy') hazards.push([e.x - e.w / 2, e.y - e.h, e.x + e.w / 2, e.y]);
    else if (e.type === 'firebar') hazards.push([e.x - 3, e.y - 3, e.x + 3, e.y + 3]);
    else if (e.type === 'goal' || e.type === 'checkpoint') hazards.push([e.x - 1, e.y - 3, e.x + 1, e.y]);
  }
  for (let rr = 0; rr < g.h; rr++) for (let c = 0; c < g.w; c++) if (at(g, c, rr) === '~') hazards.push([c, rr, c + 1, rr + 1]);
  const clear = ART.foreground_tuft_hazard_clear_c;
  const near = (x: number, y: number): boolean =>
    hazards.some((h) => x > h[0] - clear && x < h[2] + clear && y > h[1] - clear && y < h[3] + clear);
  for (let x = 1 + r() * 6; x < world.w - 1; x += PX_.tuft_every_c * (0.6 + r() * 0.8)) {
    const c = Math.floor(x);
    let top = -1;
    for (let rr = 0; rr < g.h; rr++)
      if (exposed(g, c, rr) && at(g, c, rr) === '#') {
        top = rr;
        break;
      }
    if (top < 0 || near(x, top)) continue;
    const camX = Math.max(0, Math.min(world.w - VIEW_W, x - VIEW_W / 2));
    const lx = x + (PX_.fg - 1) * camX; // where the tuft sits on its terrain when the camera centres it
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const bx = lx + (i - n / 2) * 0.16;
      const h = 0.35 + r() * 0.4;
      fg.push({ pts: line([[bx, top + 0.05], [bx + (i - n / 2) * 0.1 + (r() - 0.5) * 0.15, top - h]]), closed: false, style: 'tuft' });
    }
  }
  return { far, clouds, mid, fg };
}
