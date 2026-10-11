/**
 * Per-step behaviours (docs/v6/CONTRACTS_V6.md §3): control (platformer, move_keys, car, thrust_ship, launcher, draggable,
 * ai_fighter), action (shooter, melee), movement (follow, patrol, rotate, oscillate, float, wrap) and world timers
 * (spawner, lifetime). Pure: reads input through `Controls`, moves bodies through `BodyIO`, everything else through
 * the World. Contact behaviours (pickup, damage, hazard, goal, checkpoint, bounce_pad, conveyor) live in world.ts.
 */
import { behaviorCodes, schemeName } from './keys.ts';
import { bool, num, str, vec } from './params.ts';
import type { BehState, Ent, World } from './world.ts';

export const COYOTE = 0.08;
export const JUMP_BUFFER = 0.1;

export interface PointerState {
  x: number;
  y: number;
  down: boolean;
  pressed: boolean;
  released: boolean;
}

/** Keyboard (and touch buttons) as seen by one step. Codes are KeyboardEvent.code. */
export class InputState {
  down = new Set<string>();
  pressed = new Set<string>();
  released = new Set<string>();
  pointer: PointerState = { x: 0, y: 0, down: false, pressed: false, released: false };

  keyDown(code: string): void {
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
  }

  keyUp(code: string): void {
    if (this.down.has(code)) this.released.add(code);
    this.down.delete(code);
  }

  pointerDown(x: number, y: number): void {
    this.pointer.x = x;
    this.pointer.y = y;
    if (!this.pointer.down) this.pointer.pressed = true;
    this.pointer.down = true;
  }

  pointerMove(x: number, y: number): void {
    this.pointer.x = x;
    this.pointer.y = y;
  }

  pointerUp(): void {
    if (this.pointer.down) this.pointer.released = true;
    this.pointer.down = false;
  }

  /** Forget edges once a step has seen them. */
  endStep(): void {
    this.pressed.clear();
    this.released.clear();
    this.pointer.pressed = false;
    this.pointer.released = false;
  }

  clear(): void {
    this.down.clear();
    this.endStep();
    this.pointer.down = false;
  }
}

/** Logical keys for entities: the owner's scheme (§3), or the computer's keys for an ai_fighter. */
export class Controls {
  constructor(public input: InputState, public players: 1 | 2) {}

  private codes(e: Ent, key: string): string[] {
    return behaviorCodes(key, schemeName(e.player, this.players));
  }

  /** Is this entity driven by keys at all? (player objects; a player-2 ai_fighter in a 1-player world is the computer's) */
  human(e: Ent): boolean {
    return e.player > 0 && !e.ai;
  }

  down(e: Ent, key: string): boolean {
    if (e.ai) return !!e.ai[key];
    if (e.player === 0) return false;
    return this.codes(e, key).some((c) => this.input.down.has(c));
  }

  pressed(e: Ent, key: string): boolean {
    if (e.ai) return !!e.ai[key] && !e.aiPrev?.[key];
    if (e.player === 0) return false;
    return this.codes(e, key).some((c) => this.input.pressed.has(c));
  }

  released(e: Ent, key: string): boolean {
    if (e.ai) return !e.ai[key] && !!e.aiPrev?.[key];
    if (e.player === 0) return false;
    return this.codes(e, key).some((c) => this.input.released.has(c));
  }

  get pointer(): PointerState {
    return this.input.pointer;
  }
}

const approach = (v: number, target: number, k: number): number => v + (target - v) * Math.min(1, Math.max(0, k));
const rad = (d: number): number => (d * Math.PI) / 180;

/** Run every behaviour of every active entity for one fixed step. */
export function stepBehaviors(w: World, c: Controls, dt: number): void {
  // computer fighters decide first, so their keys are ready for the control behaviours
  for (const e of w.ents) {
    if (!w.active(e)) continue;
    const ai = w.beh(e, 'ai_fighter');
    const humanP2 = e.player === 2 && w.players === 2;
    if (ai && !humanP2) aiFighter(w, e, ai, dt);
    else if (e.ai) {
      e.ai = null;
      e.aiPrev = null;
    }
  }
  const list = w.ents.slice();
  for (const e of list) {
    if (!w.active(e) || e.def.template) continue;
    for (const b of e.behaviors) {
      if (!b.on || !e.alive) continue;
      try {
        stepOne(w, c, e, b, dt);
      } catch {
        /* a broken behaviour never stops the game */
      }
    }
    if (e.body) e.groundedPrev = e.body.grounded;
  }
}

function stepOne(w: World, c: Controls, e: Ent, b: BehState, dt: number): void {
  const p = b.def.params;
  const s = b.s;
  const body = e.body;
  switch (b.def.type) {
    case 'platformer': {
      if (!body) return;
      const grounded = body.grounded;
      if (grounded && !e.groundedPrev && (s.airTime as number ?? 0) > 0.12) w.host.fx('land', e, { power: Math.min(3, Math.abs(s.fallV as number ?? 0) / 600) });
      s.airTime = grounded ? 0 : ((s.airTime as number) ?? 0) + dt;
      if (!grounded) s.fallV = body.vy;
      s.coyote = grounded ? COYOTE : Math.max(0, ((s.coyote as number) ?? 0) - dt);
      if (grounded) s.jumps = 0;
      if (c.pressed(e, 'jump') || c.pressed(e, 'up')) s.buffer = JUMP_BUFFER;
      else s.buffer = Math.max(0, ((s.buffer as number) ?? 0) - dt);
      const speed = num(p, 'speed', 280);
      const auto = num(p, 'auto_run', 0);
      const dir = (c.down(e, 'right') ? 1 : 0) - (c.down(e, 'left') ? 1 : 0);
      const target = (auto ? auto + dir * speed * 0.5 : dir * speed) + (grounded ? body.groundVx : 0);
      const k = grounded ? dt * 18 : dt * 18 * num(p, 'air_control', 0.8);
      let vx = approach(body.vx, target, k);
      let vy = body.vy;
      const jump = num(p, 'jump', 640);
      if ((s.buffer as number) > 0 && (s.coyote as number) > 0) {
        vy = -jump;
        s.buffer = 0;
        s.coyote = 0;
        s.held = true;
        w.host.fx('jump', e);
      } else if ((s.buffer as number) > 0 && bool(p, 'double_jump') && !grounded && ((s.jumps as number) ?? 0) < 1) {
        vy = -jump * 0.9;
        s.buffer = 0;
        s.jumps = 1;
        s.held = true;
        w.host.fx('jump', e, { power: 2 });
      }
      // let go early for a shorter hop
      if (s.held && !(c.down(e, 'jump') || c.down(e, 'up'))) {
        if (vy < 0) vy *= 0.55;
        s.held = false;
      }
      if (vy > 0) s.held = false;
      if (dir) e.facing = dir > 0 ? 1 : -1;
      else if (auto) e.facing = auto > 0 ? 1 : -1;
      vx = Math.abs(vx) < 1 && !target ? 0 : vx;
      body.setVelocity(vx, vy);
      body.groundVx = 0;
      return;
    }
    case 'move_keys': {
      if (!body) return;
      const axes = str(p, 'axes', 'xy');
      let dx = axes === 'y' ? 0 : (c.down(e, 'right') ? 1 : 0) - (c.down(e, 'left') ? 1 : 0);
      let dy = axes === 'x' ? 0 : (c.down(e, 'down') ? 1 : 0) - (c.down(e, 'up') ? 1 : 0);
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      const sp = num(p, 'speed', 260);
      const k = dt * 16;
      const vx = axes === 'y' ? body.vx : approach(body.vx, dx * sp, k);
      const vy = axes === 'x' ? body.vy : approach(body.vy, dy * sp, k);
      body.setVelocity(vx, vy);
      if (dx) e.facing = dx > 0 ? 1 : -1;
      if (bool(p, 'face_move') && l > 0) {
        const target = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        const cur = e.faceAngle ?? target;
        const diff = ((target - cur + 540) % 360) - 180;
        e.faceAngle = cur + diff * Math.min(1, dt * 14);
      }
      return;
    }
    case 'car': {
      if (!body) return;
      let throttle = (c.down(e, 'right') ? 1 : 0) - (c.down(e, 'left') ? 1 : 0);
      const fuel = str(p, 'fuel_counter', '');
      if (fuel && (e.counters[fuel] ?? 0) <= 0) throttle = 0;
      if (fuel && throttle !== 0) w.addCounter(e, fuel, -dt);
      const wheels = body.wheels?.() ?? [];
      const driven = wheels.filter((x) => x.motor).length ? wheels.filter((x) => x.motor) : wheels;
      const max = num(p, 'max_speed', 900);
      const power = num(p, 'power', 0.6);
      const onGround = body.grounded || wheels.some((x) => x.body.grounded);
      const forward = body.vx * Math.cos(rad(body.angle)) + body.vy * Math.sin(rad(body.angle));
      if (driven.length) {
        for (const wh of driven) {
          const r = Math.max(4, wh.radius);
          let targetDeg = (throttle * max) / r * (180 / Math.PI);
          let k = power * dt * 4;
          if (throttle < 0 && forward > 40) {
            targetDeg = 0; // brake first
            k = dt * 6;
          }
          if (throttle === 0) continue; // free wheel
          wh.body.setAngularVelocity(approach(wh.body.av, targetDeg, k));
        }
      } else if (onGround && throttle) {
        body.setVelocity(approach(body.vx, throttle * max, power * dt * 3), body.vy);
      }
      if (!onGround && throttle) {
        // in the air: gas tips the nose up, brake tips it down
        body.setAngularVelocity(body.av + -throttle * num(p, 'tilt', 0.5) * 360 * dt);
      }
      if (throttle) e.facing = throttle > 0 ? 1 : -1;
      const dc = str(p, 'distance_counter', 'distance');
      if (dc) {
        const m = Math.max(0, Math.floor((e.x - e.startX) / 50));
        if (m > (w.game[dc] ?? 0)) w.setCounter('game', dc, m);
      }
      s.throttle = throttle;
      return;
    }
    case 'thrust_ship': {
      if (!body) return;
      const turn = num(p, 'turn', 220);
      const dir = (c.down(e, 'right') ? 1 : 0) - (c.down(e, 'left') ? 1 : 0);
      body.setAngularVelocity(dir * turn);
      let vx = body.vx;
      let vy = body.vy;
      if (c.down(e, 'up')) {
        const a = rad(body.angle);
        vx += Math.sin(a) * num(p, 'thrust', 600) * dt;
        vy += -Math.cos(a) * num(p, 'thrust', 600) * dt;
        if (w.frame % 3 === 0) w.host.fx('thrust', e);
      } else if (c.down(e, 'down')) {
        vx *= 1 - dt * 2;
        vy *= 1 - dt * 2;
      }
      const sp = Math.hypot(vx, vy);
      const max = num(p, 'max_speed', 700);
      if (sp > max) {
        vx *= max / sp;
        vy *= max / sp;
      }
      body.setVelocity(vx, vy);
      return;
    }
    case 'launcher':
      launcher(w, c, e, b, dt);
      return;
    case 'draggable': {
      if (!body) return;
      const ptr = c.pointer;
      if (ptr.pressed && !s.drag && w.hitTest(ptr.x, ptr.y, 10) === e) {
        s.drag = true;
        s.ox = e.x - ptr.x;
        s.oy = e.y - ptr.y;
      }
      if (s.drag) {
        const tx = ptr.x + (s.ox as number);
        const ty = ptr.y + (s.oy as number);
        if (body.kind === 'dynamic') body.setVelocity((tx - body.x) * 14, (ty - body.y) * 14);
        else body.setPosition(tx, ty);
        if (!ptr.down) {
          s.drag = false;
          if (body.kind === 'dynamic') body.setVelocity(body.vx * 0.5, body.vy * 0.5);
        }
      }
      return;
    }
    case 'shooter':
      shooter(w, c, e, b, dt);
      return;
    case 'melee':
      melee(w, c, e, b, dt);
      return;
    case 'health':
      return; // counters and safe time are kept by the World
    case 'spawner': {
      s.t = ((s.t as number) ?? 0) + dt;
      const every = Math.max(0.05, num(p, 'every', 2));
      if ((s.t as number) < every) return;
      s.t = 0;
      const tpl = str(p, 'template', '');
      const live = w.ents.filter((x) => x.alive && x.spawnedBy === `${e.id}/${b.def.id}`).length;
      if (live >= num(p, 'max', 12)) return;
      const [x, y] = spawnPoint(w, e, str(p, 'area', 'self'));
      const [vx0, vy0] = vec(p, 'velocity');
      const j = num(p, 'jitter', 0);
      w.spawn(tpl, x, y, vx0 + (w.random() * 2 - 1) * j, vy0 + (w.random() * 2 - 1) * j, { spawner: `${e.id}/${b.def.id}` });
      return;
    }
    case 'follow': {
      if (!body) return;
      const t = w.resolve(str(p, 'target', 'player'), { self: e, other: null }).filter((x) => x !== e)[0];
      const axes = str(p, 'axes', 'x');
      const range = num(p, 'range', 0);
      const sp = num(p, 'speed', 150);
      if (!t) return;
      const dx = t.x - e.x;
      const dy = t.y - e.y;
      const d = Math.hypot(dx, dy);
      const inRange = range <= 0 || d <= range;
      let vx = body.vx;
      let vy = body.vy;
      if (axes === 'x') vx = inRange && Math.abs(dx) > 4 ? Math.sign(dx) * sp : approach(vx, 0, dt * 8);
      else if (axes === 'y') vy = inRange && Math.abs(dy) > 4 ? Math.sign(dy) * sp : approach(vy, 0, dt * 8);
      else if (inRange && d > 4) {
        vx = (dx / d) * sp;
        vy = (dy / d) * sp;
      } else {
        vx = approach(vx, 0, dt * 8);
        vy = approach(vy, 0, dt * 8);
      }
      if (Math.abs(dx) > 4 && axes !== 'y') e.facing = dx > 0 ? 1 : -1;
      body.setVelocity(vx, vy);
      return;
    }
    case 'patrol': {
      if (!body) return;
      const axis = str(p, 'axis', 'x');
      const range = num(p, 'range', 200);
      const sp = num(p, 'speed', 120);
      if (s.dir === undefined) {
        s.dir = 1;
        s.ox = e.startX;
        s.oy = e.startY;
      }
      let dir = s.dir as number;
      const pos = axis === 'x' ? body.x : body.y;
      const origin = (axis === 'x' ? s.ox : s.oy) as number;
      if (pos > origin + range / 2 && dir > 0) dir = -1;
      else if (pos < origin - range / 2 && dir < 0) dir = 1;
      s.stuck = (axis === 'x' ? Math.abs(body.vx) < sp * 0.2 : Math.abs(body.vy) < sp * 0.2) ? ((s.stuck as number) ?? 0) + dt : 0;
      if ((s.stuck as number) > 0.25) {
        dir = -dir;
        s.stuck = -0.3;
      }
      if (axis === 'x' && body.grounded && body.probe && w.gravity[1] !== 0) {
        const ahead = body.probe(body.x + dir * (e.w / 2 + 8), body.y + e.h / 2 + 12);
        if (!ahead) dir = -dir;
      }
      s.dir = dir;
      if (axis === 'x') {
        body.setVelocity(dir * sp, body.kind === 'dynamic' ? body.vy : 0);
        e.facing = dir > 0 ? 1 : -1;
      } else body.setVelocity(body.kind === 'dynamic' ? body.vx : 0, dir * sp);
      return;
    }
    case 'rotate': {
      if (!body) return;
      body.setAngularVelocity(num(p, 'speed', 90));
      return;
    }
    case 'oscillate': {
      if (!body) return;
      const axis = str(p, 'axis', 'y');
      const range = num(p, 'range', 80);
      const period = Math.max(0.1, num(p, 'period', 2));
      s.t = ((s.t as number) ?? 0) + dt;
      const wv = (Math.PI * 2) / period;
      const off = Math.sin((s.t as number) * wv) * (range / 2);
      const v = Math.cos((s.t as number) * wv) * (range / 2) * wv;
      if (body.kind === 'dynamic') {
        body.setVelocity(axis === 'x' ? v : body.vx, axis === 'y' ? v : body.vy);
      } else {
        const x = axis === 'x' ? e.startX + off : body.x;
        const y = axis === 'y' ? e.startY + off : body.y;
        body.setPosition(x, y);
        body.setVelocity(axis === 'x' ? v : 0, axis === 'y' ? v : 0);
      }
      return;
    }
    case 'float': {
      s.t = ((s.t as number) ?? 0) + dt;
      const period = Math.max(0.1, num(p, 'period', 2));
      e.bob = Math.sin(((s.t as number) / period) * Math.PI * 2 + e.x * 0.01) * num(p, 'amplitude', 6);
      return;
    }
    case 'wrap':
      wrapEnt(w, e);
      return;
    case 'lifetime': {
      s.t = ((s.t as number) ?? 0) + dt;
      if ((s.t as number) >= num(p, 'seconds', 3)) w.destroy(e);
      return;
    }
    case 'ai_fighter':
      return; // decided above
    default:
      return; // bounce_pad, conveyor, goal, hazard, checkpoint, pickup, damage: contacts (world.ts)
  }
}

/** Leaving one side of the world enters the opposite one. */
export function wrapEnt(w: World, e: Ent): void {
  const W = w.scene.world.width;
  const H = w.scene.world.height;
  const body = e.body;
  if (!body) return;
  const hw = e.w / 2;
  const hh = e.h / 2;
  let x = body.x;
  let y = body.y;
  if (x < -hw) x = W + hw;
  else if (x > W + hw) x = -hw;
  if (y < -hh) y = H + hh;
  else if (y > H + hh) y = -hh;
  if (x !== body.x || y !== body.y) body.setPosition(x, y);
}

/** Where a spawner puts a copy (§3: self = its box, top/bottom/left/right = just outside the camera, screen = visible). */
export function spawnPoint(w: World, e: Ent, area: string): [number, number] {
  const r = w.random;
  const v = w.view;
  const m = 60;
  // along the spawner's own box when it has a size on that axis, else anywhere along the visible edge
  const bw = e.def.w * e.def.scale;
  const bh = e.def.h * e.def.scale;
  const alongX = (): number => (bw > 0 ? e.x + (r() - 0.5) * bw : v.x + r() * v.w);
  const alongY = (): number => (bh > 0 ? e.y + (r() - 0.5) * bh : v.y + r() * v.h);
  switch (area) {
    case 'top':
      return [alongX(), v.y - m];
    case 'bottom':
      return [alongX(), v.y + v.h + m];
    case 'left':
      return [v.x - m, alongY()];
    case 'right':
      return [v.x + v.w + m, alongY()];
    case 'screen':
      return [v.x + m + r() * Math.max(1, v.w - 2 * m), v.y + m + r() * Math.max(1, v.h - 2 * m)];
    default:
      return [e.x + (r() - 0.5) * e.w, e.y + (r() - 0.5) * e.h];
  }
}

function keyFor(name: string): string {
  return name === 'space' ? 'space' : name === 'action2' ? 'action2' : 'action';
}

/** Facing direction of an entity as a unit vector. */
export function facingVec(w: World, e: Ent): [number, number] {
  if (w.hasBeh(e, 'thrust_ship')) {
    const a = rad(e.body?.angle ?? e.angle);
    return [Math.sin(a), -Math.cos(a)];
  }
  if (e.faceAngle !== null) {
    const a = rad(e.faceAngle);
    return [Math.sin(a), -Math.cos(a)];
  }
  return [e.facing, 0];
}

function shooter(w: World, c: Controls, e: Ent, b: BehState, dt: number): void {
  const p = b.def.params;
  const s = b.s;
  s.cool = Math.max(0, ((s.cool as number) ?? 0) - dt);
  const key = str(p, 'key', 'space');
  let fire = false;
  let toward: [number, number] | null = null;
  if (key === 'auto') fire = true;
  else if (key === 'click') {
    fire = c.pointer.down && (e.player > 0 || e.player === 0);
    toward = [c.pointer.x, c.pointer.y];
  } else fire = c.down(e, keyFor(key));
  if (!fire || (s.cool as number) > 0) return;
  s.cool = 1 / Math.max(0.2, num(p, 'rate', 4));
  let [dx, dy] = facingVec(w, e);
  switch (str(p, 'direction', 'facing')) {
    case 'up': [dx, dy] = [0, -1]; break;
    case 'down': [dx, dy] = [0, 1]; break;
    case 'left': [dx, dy] = [-1, 0]; break;
    case 'right': [dx, dy] = [1, 0]; break;
    case 'mouse': toward = [c.pointer.x, c.pointer.y]; break;
    case 'player': {
      const t = w.resolve('player', { self: e, other: null }).filter((x) => x !== e)[0];
      if (!t) return;
      toward = [t.x, t.y];
      break;
    }
  }
  if (toward) {
    const l = Math.hypot(toward[0] - e.x, toward[1] - e.y) || 1;
    dx = (toward[0] - e.x) / l;
    dy = (toward[1] - e.y) / l;
  }
  const spread = num(p, 'spread', 0);
  if (spread > 0) {
    const a = Math.atan2(dy, dx) + rad((w.random() - 0.5) * spread);
    dx = Math.cos(a);
    dy = Math.sin(a);
  }
  const reach = Math.max(e.w, e.h) / 2 + 10;
  const sp = num(p, 'speed', 800);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  const proj = w.spawn(str(p, 'projectile', 'default') || 'default', e.x + dx * reach, e.y + dy * reach, dx * sp, dy * sp,
    { shooter: e, angle });
  if (!proj) return;
  proj.shooter = e;
  proj.projectileDamage = num(p, 'damage', 1);
  if (!proj.behaviors.some((x) => x.def.type === 'lifetime')) {
    proj.behaviors.push({ def: { id: 'life', type: 'lifetime', params: { seconds: num(p, 'lifetime', 2) }, off: false }, on: true, s: {} });
  }
  w.host.fx('shoot', e, { x: e.x + dx * reach, y: e.y + dy * reach });
}

function melee(w: World, c: Controls, e: Ent, b: BehState, dt: number): void {
  const p = b.def.params;
  const s = b.s;
  s.cool = Math.max(0, ((s.cool as number) ?? 0) - dt);
  if (!c.pressed(e, keyFor(str(p, 'key', 'action'))) || (s.cool as number) > 0) return;
  s.cool = num(p, 'cooldown', 0.4);
  const range = num(p, 'range', 60);
  const [fx] = facingVec(w, e);
  const dir = fx >= 0 ? 1 : -1;
  w.host.fx('swing', e);
  for (const o of w.ents) {
    if (!w.active(o) || o === e || o.def.template || w.allies(e, o) || o.root === e) continue;
    const hasHealth = !!w.beh(o, 'health') || 'health' in o.counters;
    if (!hasHealth) continue;
    const dx = (o.x - e.x) * dir;
    const dy = Math.abs(o.y - e.y);
    if (dx >= -e.w * 0.25 && dx - o.w / 2 <= e.w / 2 + range && dy <= (e.h + o.h) / 2 + 10) {
      w.hurt(o, num(p, 'damage', 1), e, 0);
      const kb = num(p, 'knockback', 450);
      if (o.body && o.body.kind === 'dynamic') o.body.setVelocity(dir * kb, -kb * 0.45);
    }
  }
}

function launcher(w: World, c: Controls, e: Ent, b: BehState, dt: number): void {
  const p = b.def.params;
  const s = b.s;
  const body = e.body;
  if (!body) return;
  const shots = str(p, 'shots_counter', '');
  if (s.state === undefined) {
    s.state = 'ready';
    s.ax = e.x;
    s.ay = e.y;
    body.setFrozen?.(true);
  }
  const ptr = c.pointer;
  const maxPull = num(p, 'max_pull', 180);
  const ax = s.ax as number;
  const ay = s.ay as number;
  if (s.state === 'ready') {
    if (ptr.pressed && Math.hypot(ptr.x - ax, ptr.y - ay) <= Math.max(70, Math.max(e.w, e.h))) {
      if (!shots || (w.game[shots] ?? 0) > 0) s.state = 'drag';
    }
  }
  if (s.state === 'drag') {
    let dx = ptr.x - ax;
    let dy = ptr.y - ay;
    const l = Math.hypot(dx, dy);
    if (l > maxPull) {
      dx *= maxPull / l;
      dy *= maxPull / l;
    }
    body.setPosition(ax + dx, ay + dy);
    s.px = dx;
    s.py = dy;
    if (!ptr.down) {
      const pull = Math.hypot(dx, dy);
      if (pull < 12) {
        body.setPosition(ax, ay);
        s.state = 'ready';
        return;
      }
      const k = num(p, 'power', 1) * 12;
      body.setFrozen?.(false);
      body.setVelocity(-dx * k, -dy * k);
      s.state = 'flying';
      s.t = 0;
      s.still = 0;
      if (shots) w.addCounter('game', shots, -1);
      w.host.fx('launch', e, { power: pull / maxPull });
    }
    return;
  }
  if (s.state === 'flying') {
    s.t = (s.t as number) + dt;
    s.still = Math.hypot(body.vx, body.vy) < 25 ? (s.still as number) + dt : 0;
    const out = body.x < -200 || body.x > w.scene.world.width + 200 || body.y > w.scene.world.height + 200;
    if ((s.still as number) > 1.2 || (s.t as number) > 7 || out) {
      if (!shots || (w.game[shots] ?? 0) > 0) {
        body.setFrozen?.(true);
        body.setVelocity(0, 0);
        body.setAngle(0);
        body.setPosition(ax, ay);
        e.x = ax;
        e.y = ay;
        s.state = 'ready';
        w.host.fx('respawn', e);
      } else {
        s.state = 'done';
        s.t = 0;
      }
    }
    return;
  }
  if (s.state === 'done') {
    s.t = (s.t as number) + dt;
    if ((s.t as number) > 1.5 && s.lost !== true && str(p, 'out_of_shots', 'lose') === 'lose') {
      s.lost = true;
      w.host.lose('rt.out_of_shots');
    }
  }
}

/** The aim preview for the adapter: the pull vector while dragging a launcher (null otherwise). */
export function launcherAim(e: Ent): { ax: number; ay: number; px: number; py: number; k: number } | null {
  const b = e.behaviors.find((x) => x.on && x.def.type === 'launcher');
  if (!b || b.s.state !== 'drag') return null;
  return { ax: b.s.ax as number, ay: b.s.ay as number, px: b.s.px as number ?? 0, py: b.s.py as number ?? 0,
    k: num(b.def.params, 'power', 1) * 12 };
}

/** Computer fighter (§3): walk to the target, jump over obstacles, attack in range; skill sets reaction and accuracy. */
function aiFighter(w: World, e: Ent, b: BehState, dt: number): void {
  const p = b.def.params;
  const s = b.s;
  const skill = num(p, 'skill', 0.5);
  e.aiPrev = e.ai ? { ...e.ai } : {};
  if (!e.ai) e.ai = {};
  s.think = ((s.think as number) ?? 0) - dt;
  // release taps after one step so attacks register as presses
  e.ai.action = false;
  e.ai.action2 = false;
  e.ai.jump = false;
  const t = w.resolve(str(p, 'target', 'player1'), { self: e, other: null }).filter((x) => x !== e)[0];
  if (!t) {
    e.ai.left = false;
    e.ai.right = false;
    return;
  }
  const dx = t.x - e.x;
  const dy = t.y - e.y;
  const melee = w.beh(e, 'melee');
  const shoot = w.beh(e, 'shooter');
  const reach = melee ? num(melee.def.params, 'range', 60) + (e.w + t.w) / 2 : 80;
  s.rest = Math.max(0, ((s.rest as number) ?? 0) - dt);
  if ((s.think as number) <= 0) {
    s.think = 0.5 - skill * 0.3 + w.random() * 0.2;
    const far = Math.abs(dx) > reach * 0.85;
    const lowHp = (e.counters.health ?? 10) <= 2 && w.random() < 0.3 * (1 - skill);
    s.move = far ? Math.sign(dx) : lowHp ? -Math.sign(dx) : 0;
    if (!far && Math.abs(dy) < e.h && (s.rest as number) <= 0 && w.random() < 0.25 + skill * 0.5) s.attack = 1;
    if (shoot && Math.abs(dx) > 220 && Math.abs(dy) < 120 && w.random() < 0.25 + skill * 0.5) s.fire = 1;
    if (dy < -e.h * 0.8 && w.random() < 0.5 + skill * 0.4) s.hop = 1;
    if (w.random() < 0.06 + skill * 0.06) s.hop = 1; // a little unpredictability
  }
  const move = (s.move as number) ?? 0;
  e.ai.right = move > 0;
  e.ai.left = move < 0;
  if (move === 0) e.facing = dx >= 0 ? 1 : -1;
  // blocked while walking: jump
  if (move && e.body && e.body.grounded && Math.abs(e.body.vx) < 20) s.blocked = ((s.blocked as number) ?? 0) + dt;
  else s.blocked = 0;
  if ((s.blocked as number) > 0.25 || s.hop) {
    e.ai.jump = true;
    s.hop = 0;
    s.blocked = 0;
  }
  if (s.attack) {
    const key = melee ? str(melee.def.params, 'key', 'action') : 'action';
    e.ai[key === 'space' ? 'space' : key] = true;
    s.attack = 0;
    s.rest = 0.7 - skill * 0.45; // breathe between attacks so a person can answer
    if (w.random() < 0.35 - skill * 0.2) s.move = -Math.sign(dx); // step back sometimes
  }
  if (s.fire && shoot) {
    const key = str(shoot.def.params, 'key', 'space');
    e.ai[key === 'action2' ? 'action2' : key === 'space' ? 'space' : 'action'] = true;
    e.facing = dx >= 0 ? 1 : -1;
    s.fire = 0;
  }
}
