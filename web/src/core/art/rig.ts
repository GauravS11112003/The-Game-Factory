/**
 * Rig extraction (PLAN_V2 §7.6) for studio vectors and paper character boxes (CV v2 sends the character as strokes).
 * - Body: all strokes.
 * - Legs: 1-4 strokes whose lowest point is in the bottom 25% of the bbox, within 35° of vertical and ≥ 15% of the
 *   height long. None found → 2 stick legs are synthesized in the kid's main ink colour.
 * - Arms: strokes in the middle band that stick out past the body silhouette.
 * - Eyes: 1-2 small closed dark blobs (≤ 12% of the width) in the top half.
 */
import type { InkStroke, Rig } from '../types.gen.ts';
import { RIG } from '../params.ts';
import { polyLen } from './geom.ts';

interface Info {
  s: InkStroke;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  len: number;
  cx: number;
  cy: number;
}

function info(s: InkStroke): Info {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  for (const p of s.pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
    cx += p[0];
    cy += p[1];
  }
  const n = Math.max(1, s.pts.length);
  return { s, x0, y0, x1, y1, len: polyLen(s.pts as [number, number][]), cx: cx / n, cy: cy / n };
}

/** Angle of a stroke's principal direction from vertical, degrees (0 = vertical). */
function offVertical(s: InkStroke): number {
  const p = s.pts;
  if (p.length < 2) return 90;
  let mx = 0;
  let my = 0;
  for (const q of p) {
    mx += q[0];
    my += q[1];
  }
  mx /= p.length;
  my /= p.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const q of p) {
    const dx = q[0] - mx;
    const dy = q[1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // principal axis angle from the x axis
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const fromVertical = 90 - Math.abs((theta * 180) / Math.PI);
  return Math.abs(fromVertical);
}

const DARK = new Set(['black', 'pencil']);

export function extractRig(strokes: InkStroke[]): Rig {
  const rigEmpty: Rig = { legs: [], arms: [], eyes: [], synth_legs: true, hip_y: 0.7 };
  const items = strokes.filter((s) => s.pts.length > 0).map(info);
  if (!items.length) return rigEmpty;
  const X0 = Math.min(...items.map((i) => i.x0));
  const Y0 = Math.min(...items.map((i) => i.y0));
  const X1 = Math.max(...items.map((i) => i.x1));
  const Y1 = Math.max(...items.map((i) => i.y1));
  const W = Math.max(1e-6, X1 - X0);
  const H = Math.max(1e-6, Y1 - Y0);

  // eyes: small closed dark blobs (or dots) in the top half
  const eyes = items
    .filter((i) => {
      const small = i.x1 - i.x0 <= RIG.eye_max_w_frac * W + 1e-6 && i.y1 - i.y0 <= RIG.eye_max_w_frac * W * 1.6 + 1e-6;
      const closed = i.s.closed || i.s.kind === 'dot' || i.s.kind === 'blob' || i.s.pts.length === 1;
      return small && closed && DARK.has(i.s.color) && i.cy <= Y0 + H / 2 && items.length > 1;
    })
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx)
    .slice(0, 2);
  const eyeIds = new Set(eyes.map((e) => e.s.id));

  // legs: lowest point in the bottom 25%, near-vertical, ≥ 15% of the height
  const legs = items
    .filter(
      (i) =>
        !eyeIds.has(i.s.id) && !i.s.closed && i.s.kind === 'line' && i.y1 >= Y1 - RIG.leg.bottom_frac * H &&
        offVertical(i.s) <= RIG.leg.max_off_vertical_deg && i.y1 - i.y0 >= RIG.leg.min_len_frac * H &&
        i.y0 >= Y0 + 0.25 * H, // a leg starts below the head
    )
    .sort((a, b) => b.len - a.len)
    .slice(0, RIG.leg.count[1])
    .sort((a, b) => a.cx - b.cx);
  const legIds = new Set(legs.map((l) => l.s.id));

  // body silhouette: everything that is not a leg or an eye
  const bodyItems = items.filter((i) => !legIds.has(i.s.id) && !eyeIds.has(i.s.id));
  const core = bodyItems.length ? bodyItems.reduce((a, b) => ((b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a)) : null;
  const arms = core
    ? bodyItems
        .filter((i) => {
          if (i === core || i.s.closed) return false;
          const mid = i.cy >= Y0 + 0.3 * H && i.cy <= Y0 + 0.75 * H;
          const out = i.x0 < core.x0 - 0.1 * W || i.x1 > core.x1 + 0.1 * W;
          return mid && out && i.s.kind === 'line';
        })
        .slice(0, 2)
    : [];

  const hip = legs.length ? (Math.min(...legs.map((l) => l.y0)) - Y0) / H : 0.7;
  return {
    legs: legs.map((l) => l.s.id),
    arms: arms.map((a) => a.s.id),
    eyes: eyes.map((e) => e.s.id),
    synth_legs: legs.length === 0,
    hip_y: Math.round(Math.min(0.95, Math.max(0.3, hip)) * 1000) / 1000,
  };
}
