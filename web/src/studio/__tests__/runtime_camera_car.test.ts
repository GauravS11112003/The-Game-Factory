import { describe, expect, it } from 'vitest';
import {
  baseZoom, canvasSize, clampCenter, comfortableZoom, containZoom, fillZoom, followStep, speedZoomFactor, viewWorldSize, zoomStep,
  type FollowState,
} from '../runtime/camera.ts';
import { fromBodyLocal, suspensionClamp, toBodyLocal, travelFor, wheelAnchor } from '../runtime/car.ts';

const wide = { w: 1920, h: 1080 };
const phone = { w: 780, h: 1688 };

describe('game camera', () => {
  it('sizes the canvas to the host aspect at device density, capped', () => {
    expect(canvasSize(1280, 720, 2)).toEqual({ w: 2560, h: 1440 });
    const big = canvasSize(2560, 1440, 2);
    expect(big.w * big.h).toBeLessThanOrEqual(2560 * 1640 + 5000);
    expect(big.w / big.h).toBeCloseTo(16 / 9, 2);
    expect(canvasSize(300, 150, 1).h).toBeGreaterThanOrEqual(320);
  });

  it('shows the whole world for fixed cameras (contain, no bars: spare room is backdrop)', () => {
    const world = { width: 1600, height: 900 };
    const z = baseZoom('fixed', { w: 2400, h: 1800 }, world, null);
    expect(z).toBeCloseTo(containZoom({ w: 2400, h: 1800 }, world));
    const v = viewWorldSize({ w: 2400, h: 1800 }, z);
    expect(v.w).toBeGreaterThanOrEqual(1600 - 1e-6);
    expect(v.h).toBeGreaterThanOrEqual(900 - 1e-6);
  });

  it('keeps a followed player about 1/8 of the view height', () => {
    const world = { width: 12000, height: 4000 };
    const z = comfortableZoom(wide, world, { w: 60, h: 120 });
    expect(viewWorldSize(wide, z).h / 120).toBeCloseTo(8, 0);
  });

  it('keeps enough room ahead on a portrait phone', () => {
    const world = { width: 12000, height: 4000 };
    const z = comfortableZoom(phone, world, { w: 180, h: 110 });
    expect(viewWorldSize(phone, z).w).toBeGreaterThanOrEqual(5 * 180 - 1);
  });

  it('never shows past a world big enough to fill the screen', () => {
    const world = { width: 12000, height: 1400 };
    const z = comfortableZoom(phone, world, { w: 180, h: 110 });
    expect(z).toBeGreaterThanOrEqual(fillZoom(phone, world) - 1e-9);
    const v = viewWorldSize(phone, z);
    expect(v.h).toBeLessThanOrEqual(1400 + 1e-6);
  });

  it('fits a runner world on its cross axis', () => {
    const z = baseZoom('auto_scroll', wide, { width: 20000, height: 900 }, null, 'x');
    expect(viewWorldSize(wide, z).h).toBeCloseTo(900);
  });

  it('applies the doc zoom as a factor', () => {
    const world = { width: 12000, height: 4000 };
    const base = comfortableZoom(wide, world, { w: 100, h: 100 });
    expect(baseZoom('follow', wide, world, { w: 100, h: 100 }, 'xy', 2)).toBeCloseTo(base * 2);
    // zooming out is softened
    expect(baseZoom('follow', wide, world, { w: 100, h: 100 }, 'xy', 0.64)).toBeCloseTo(base * 0.8);
  });

  it('eases out a little at speed', () => {
    expect(speedZoomFactor(0)).toBe(1);
    expect(speedZoomFactor(5000)).toBeCloseTo(0.86);
    expect(zoomStep(1, 2, 0.016)).toBeGreaterThan(1);
    expect(zoomStep(1, 2, 0.016)).toBeLessThan(1.1);
  });

  it('clamps the centre to the world, centring small worlds', () => {
    expect(clampCenter(-100, 800, 4000)).toBe(400);
    expect(clampCenter(5000, 800, 4000)).toBe(3600);
    expect(clampCenter(123, 2000, 1600)).toBe(800);
  });

  it('leads ahead of the motion smoothly and keeps the target on screen', () => {
    let s: FollowState = { x: 0, y: 0, lookX: 0, lookY: 0 };
    s = followStep(s, { tx: 0, ty: 0, vx: 0, vy: 0, vw: 1600, vh: 900, dt: 0, axis: 'xy', snap: true });
    expect(s.x).toBe(0);
    const xs: number[] = [];
    let tx = 0;
    for (let i = 0; i < 180; i++) {
      tx += 800 / 60;
      s = followStep(s, { tx, ty: 0, vx: 800, vy: 0, vw: 1600, vh: 900, dt: 1 / 60, axis: 'xy' });
      xs.push(s.x - tx);
      expect(Math.abs(s.x - tx)).toBeLessThanOrEqual(1600 * 0.4 + 1e-6);
    }
    // after a while the camera is ahead of the car (look-ahead), and it got there gradually
    expect(xs[xs.length - 1]).toBeGreaterThan(150);
    expect(Math.abs(xs[1] - xs[0])).toBeLessThan(40);
  });

  it('damps small vertical moves (dead zone) but follows big ones', () => {
    let s: FollowState = { x: 0, y: -54, lookX: 0, lookY: 0 };
    s = followStep(s, { tx: 0, ty: 20, vx: 0, vy: 0, vw: 1600, vh: 900, dt: 1 / 60, axis: 'xy' });
    expect(s.y).toBeCloseTo(-54 + 0, 0);
    for (let i = 0; i < 240; i++) s = followStep(s, { tx: 0, ty: 600, vx: 0, vy: 0, vw: 1600, vh: 900, dt: 1 / 60, axis: 'xy' });
    expect(600 - s.y).toBeLessThan(900 * 0.2);
  });
});

describe('car wheels', () => {
  const body = { x: 362.6, y: 865.9, rotation: 0, scale: 1, w: 174, h: 67.9 };

  it('round-trips body-local coordinates', () => {
    const b = { ...body, rotation: 30, scale: 1.5 };
    const p = toBodyLocal(b, ...fromBodyLocal(b, [20, -10]));
    expect(p[0]).toBeCloseTo(20);
    expect(p[1]).toBeCloseTo(-10);
  });

  it('keeps a joint that agrees with the drawing (the hill climb template)', () => {
    const a = wheelAnchor(body, { x: 308.3, y: 915, r: 30 }, [-54.3, 49.1], [0, 0]);
    expect(a.source).toBe('joint');
    expect(a.at).toEqual([-54.3, 49.1]);
  });

  it('anchors where the wheel was drawn when the joint disagrees', () => {
    const a = wheelAnchor(body, { x: 308.3, y: 915, r: 30 }, [0, 0], [0, 0]);
    expect(a.source).toBe('drawn');
    expect(a.at[0]).toBeCloseTo(-54.3, 1);
    expect(a.at[1]).toBeCloseTo(49.1, 1);
    expect(a.to_at).toEqual([0, 0]);
    const b = wheelAnchor(body, { x: 418.3, y: 914.3, r: 30 }, [55.7, 48.4], [25, 0]); // to_at off by > r/2
    expect(b.source).toBe('drawn');
  });

  it('handles rotated and scaled cars', () => {
    const b = { ...body, rotation: 90, scale: 2 };
    const [wx, wy] = fromBodyLocal(b, [-50, 40]);
    const a = wheelAnchor(b, { x: wx, y: wy, r: 50 }, null, null);
    expect(a.at[0]).toBeCloseTo(-50);
    expect(a.at[1]).toBeCloseTo(40);
  });

  it('uses the joint, or a bottom corner, for wheels drawn far away', () => {
    const far = { x: 2000, y: 200, r: 30 };
    expect(wheelAnchor(body, far, [60, 30], [0, 0])).toEqual({ at: [60, 30], to_at: [0, 0], source: 'joint' });
    const c = wheelAnchor(body, far, [0, 0], [0, 0]);
    expect(c.source).toBe('corner');
    expect(c.at[1]).toBeCloseTo(body.h / 2);
    expect(Math.abs(c.at[0])).toBeLessThan(body.w / 2);
  });

  it('clamps suspension travel in the car frame', () => {
    const t = travelFor(30);
    expect(suspensionClamp(0, 2, 0, t.lat, t.up, t.down)).toBeNull();
    const down = suspensionClamp(0, 50, 0, t.lat, t.up, t.down)!;
    expect(down.dy).toBeCloseTo(t.down);
    expect(down.hitY).toBe(1);
    // the car on its side: the car's "down" is world −x
    const side = suspensionClamp(-50, 0, Math.PI / 2, t.lat, t.up, t.down)!;
    expect(side.dx).toBeCloseTo(-t.down);
    expect(side.dy).toBeCloseTo(0);
    const lat = suspensionClamp(20, 0, 0, t.lat, t.up, t.down)!;
    expect(lat.dx).toBeCloseTo(t.lat);
    expect(lat.hitX).toBe(1);
  });
});
