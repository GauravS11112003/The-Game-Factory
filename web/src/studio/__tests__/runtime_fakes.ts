/** Test doubles for the runtime's pure layer: a fake engine host and fake bodies. */
import type { NObject } from '../runtime/normalize.ts';
import { normalizeDoc } from '../runtime/normalize.ts';
import { World, type BodyIO, type Ent, type Host } from '../runtime/world.ts';

export class FakeBody implements BodyIO {
  kind: BodyIO['kind'];
  x: number;
  y: number;
  angle = 0;
  vx = 0;
  vy = 0;
  av = 0;
  grounded = false;
  groundVx = 0;
  frozen = false;
  constructor(kind: BodyIO['kind'], x: number, y: number) {
    this.kind = kind;
    this.x = x;
    this.y = y;
  }
  setVelocity(vx: number, vy: number): void {
    this.vx = vx;
    this.vy = vy;
  }
  setAngularVelocity(d: number): void {
    this.av = d;
  }
  setAngle(d: number): void {
    this.angle = d;
  }
  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
  setFrozen(f: boolean): void {
    this.frozen = f;
  }
}

export interface Call {
  name: string;
  args: unknown[];
}

export function fakeHost(): Host & { calls: Call[]; world?: World } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const host: Host & { calls: Call[]; world?: World } = {
    calls,
    spawn(def: NObject, o: { vx: number; vy: number }): Ent | null {
      const e = host.world!.addEnt(def);
      const b = new FakeBody(def.physics.body, def.x, def.y);
      b.vx = o.vx;
      b.vy = o.vy;
      e.body = b;
      calls.push({ name: 'spawn', args: [def.id] });
      return e;
    },
    destroy: rec('destroy'),
    setVisible: rec('setVisible'),
    setSensor: rec('setSensor'),
    setGravity: rec('setGravity'),
    flipGravity: rec('flipGravity'),
    timeScale: rec('timeScale'),
    sound: rec('sound'),
    shake: rec('shake'),
    flash: rec('flash'),
    say: rec('say'),
    camera: rec('camera'),
    win: rec('win'),
    lose: rec('lose'),
    nextScene: rec('nextScene'),
    goScene: rec('goScene'),
    fx: rec('fx'),
    counterChanged: rec('counterChanged'),
    emit: rec('emit'),
    defaultProjectile: () => normalizeDoc({ scenes: [{ id: 's', objects: [{ id: 'bullet', drawing: { strokes: [{ points: [[0, 0]] }], w: 8, h: 8 },
      physics: { body: 'dynamic', sensor: true, gravity_scale: 0 } }] }] }).doc.scenes[0].objects[0],
  };
  return host;
}

/** A world from a raw doc, with every placed object as an entity on a fake body. */
export function makeWorld(raw: unknown, sceneIndex = 0): { world: World; host: ReturnType<typeof fakeHost>; errors: string[] } {
  const { doc, errors } = normalizeDoc(raw);
  const host = fakeHost();
  const scene = doc.scenes[sceneIndex];
  let seq = 0;
  const world = new World(doc, scene, host, { random: () => ((seq = (seq * 9301 + 49297) % 233280) / 233280) });
  host.world = world;
  for (const o of scene.objects) {
    if (o.template) continue;
    const e = world.addEnt(o);
    e.body = new FakeBody(o.physics.body, o.x, o.y);
  }
  return { world, host, errors };
}

export function names(host: { calls: Call[] }, name: string): unknown[][] {
  return host.calls.filter((c) => c.name === name).map((c) => c.args);
}

export const box = (w = 40, h = 40) => ({ strokes: [{ points: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], closed: true }], w, h });
