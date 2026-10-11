import { describe, expect, it } from 'vitest';
import { COYOTE, Controls, InputState, JUMP_BUFFER, spawnPoint, stepBehaviors } from '../runtime/behaviors.ts';
import { convexHull, decompose, rdp, shapeFor } from '../runtime/shapes.ts';
import { box, makeWorld, type FakeBody } from './runtime_fakes.ts';

const DT = 1 / 60;

function hero(params: Record<string, unknown> = {}) {
  const { world } = makeWorld({ scenes: [{ id: 's', objects: [
    { id: 'hero', player: 1, drawing: box(), physics: { body: 'dynamic' }, behaviors: [{ id: 'p', type: 'platformer', params }] }] }] });
  const input = new InputState();
  const controls = new Controls(input, 1);
  const e = world.byId.get('hero')!;
  const body = e.body as FakeBody;
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      stepBehaviors(world, controls, DT);
      input.endStep();
    }
  };
  return { world, input, body, e, step };
}

describe('platformer', () => {
  it('runs toward the pressed direction and faces it', () => {
    const { input, body, e, step } = hero({ speed: 300 });
    body.grounded = true;
    input.keyDown('ArrowLeft');
    step(30);
    expect(body.vx).toBeLessThan(-280);
    expect(e.facing).toBe(-1);
  });

  it('jumps within coyote time after leaving a ledge, not after it', () => {
    const a = hero({ jump: 600 });
    a.body.grounded = true;
    a.step();
    a.body.grounded = false;
    a.step(Math.floor((COYOTE * 60) / 2));
    a.input.keyDown('Space');
    a.step();
    expect(a.body.vy).toBe(-600);

    const b = hero({ jump: 600 });
    b.body.grounded = true;
    b.step();
    b.body.grounded = false;
    b.step(Math.ceil(COYOTE * 60) + 2);
    b.input.keyDown('Space');
    b.step();
    expect(b.body.vy).not.toBe(-600);
  });

  it('buffers a jump pressed just before landing', () => {
    const { input, body, step } = hero({ jump: 500 });
    body.grounded = false;
    body.vy = 300;
    input.keyDown('ArrowUp');
    step(Math.floor((JUMP_BUFFER * 60) / 2));
    body.grounded = true;
    step();
    expect(body.vy).toBe(-500);
  });

  it('double jumps once in the air when allowed', () => {
    const { input, body, step } = hero({ jump: 500, double_jump: true });
    body.grounded = false;
    step(10);
    input.keyDown('Space');
    step();
    expect(body.vy).toBeCloseTo(-450);
    input.keyUp('Space');
    step();
    body.vy = 100;
    input.keyDown('Space');
    step();
    expect(body.vy).toBe(100 * 1); // no third jump (the held-cut only shortens rising jumps)
  });
});

describe('controls', () => {
  it('drives player 2 with the arrows only in 2-player worlds and lets the computer drive ai fighters', () => {
    const { world } = makeWorld({ scenes: [{ id: 's', world: { players: 2 }, objects: [
      { id: 'a', player: 1, drawing: box() }, { id: 'b', player: 2, drawing: box() }] }] });
    const input = new InputState();
    const c = new Controls(input, 2);
    input.keyDown('ArrowLeft');
    expect(c.down(world.byId.get('a')!, 'left')).toBe(false);
    expect(c.down(world.byId.get('b')!, 'left')).toBe(true);
    const b = world.byId.get('b')!;
    b.ai = { left: false, jump: true };
    b.aiPrev = {};
    expect(c.down(b, 'left')).toBe(false);
    expect(c.pressed(b, 'jump')).toBe(true);
  });
});

describe('spawner areas', () => {
  it('uses the spawner box when it has one, else the visible edge', () => {
    const { world } = makeWorld({ scenes: [{ id: 's', objects: [
      { id: 'sp', x: 500, y: 700, drawing: { strokes: [], w: 0, h: 2 } }, { id: 'wide', x: 800, y: 0, drawing: { strokes: [], w: 1000, h: 0 } }] }] });
    world.view = { x: 1000, y: 0, w: 1600, h: 900 };
    const [rx, ry] = spawnPoint(world, world.byId.get('sp')!, 'right');
    expect(rx).toBe(2660);
    expect(Math.abs(ry - 700)).toBeLessThanOrEqual(1);
    const [tx, ty] = spawnPoint(world, world.byId.get('wide')!, 'top');
    expect(ty).toBe(-60);
    expect(tx).toBeGreaterThanOrEqual(300);
    expect(tx).toBeLessThanOrEqual(1300);
  });
});

describe('shapes', () => {
  it('hulls, simplifies and decomposes', () => {
    expect(convexHull([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10]]).length).toBe(4);
    expect(rdp([[0, 0], [5, 0.1], [10, 0]], 1)).toEqual([[0, 0], [10, 0]]);
    const L = decompose([[0, 0], [100, 0], [100, 20], [20, 20], [20, 100], [0, 100]]);
    expect(L && L.length).toBe(2);
  });

  it('turns ground strokes into chains and keeps gaps between two closed shapes open', () => {
    const line = shapeFor({ strokes: [{ points: [[0, 0], [100, 0], [200, 50]], width: 10 }], w: 200, h: 50 } as never, 'line', 'static');
    expect(line.kind).toBe('chain');
    const rect = (y0: number, y1: number): [number, number][] => [[-50, y0], [50, y0], [50, y1], [-50, y1]];
    const pipes = shapeFor({ strokes: [{ points: rect(-400, -100), closed: true, width: 6 }, { points: rect(100, 400), closed: true, width: 6 }], w: 100, h: 800 } as never,
      'auto', 'kinematic');
    expect(pipes.kind).toBe('chain');
    if (pipes.kind === 'chain') expect(pipes.parts?.length).toBe(2);
    const crate = shapeFor({ strokes: [{ points: rect(-50, 50), closed: true, width: 6 }], w: 100, h: 100 } as never, 'auto', 'dynamic');
    expect(crate.kind).toBe('poly');
    expect(JSON.stringify(shapeFor({ strokes: [], w: 40, h: 20 } as never, 'auto', 'static'))).toBe(JSON.stringify({ kind: 'box', cx: 0, cy: 0, w: 40, h: 20 }));
  });
});
