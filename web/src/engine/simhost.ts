/**
 * The engine drives lane A's core Sim (PLAN_V2 D2, §5.2). The Sim is the only physics: Phaser never moves a body.
 * Until the core Sim lands (it throws NotImplemented at P0), a static stand-in keeps every screen usable: the level
 * is drawn, the character stands at the start and ←/→ pan the camera.
 */
import { cameraStep, createSim, isNotImplemented } from '../core/index.ts';
import type { CameraState, EntityView, Sim, SimEvent, SimSnapshot, SimView } from '../core/sim/types.ts';
import type { CellXY, LevelV2, World } from '../core/types.gen.ts';
import { CAMERA } from '../core/params.ts';
import { BIT } from './input.ts';

export interface SimHost {
  sim: Sim;
  real: boolean;
  reason?: string;
}

function startOf(level: LevelV2, startAt?: CellXY): [number, number] {
  if (startAt) return [startAt[0], startAt[1]];
  const s = level.compiled.entities.find((e) => e.type === 'player_start');
  return s ? [s.x, s.y] : [2, 22];
}

export function entityViewsAtSpawn(level: LevelV2): EntityView[] {
  return level.compiled.entities
    .filter((e) => e.type !== 'player_start')
    .map((e) => {
      const any = e as unknown as { x?: number; y?: number; x0?: number; x1?: number; w?: number; h?: number; r?: number };
      const x = e.type === 'spikes' ? (e.x0 + e.x1) / 2 : (any.x ?? 0);
      const w = e.type === 'spikes' ? e.x1 - e.x0 : (any.w ?? (any.r ? any.r * 2 : 1));
      return { id: e.id, type: e.type, x, y: any.y ?? 0, w, h: any.h ?? 1, active: true };
    });
}

/** Fallback camera with the §6.2 follow rule (look-ahead, dead zone, lerp 0.1, clamp, horizontal only). */
export function followCamera(c: CameraState, v: SimView, world: World): CameraState {
  const vw = CAMERA.view_w_c;
  const walk = 6; // c/s, v2-standard walk max
  const vxc = v.player.vx / 16;
  const facing: 1 | -1 = v.player.vx > 1 ? 1 : v.player.vx < -1 ? -1 : c.facing;
  const want = Math.abs(vxc) > CAMERA.look_ahead_min_speed_frac * walk ? facing * CAMERA.look_ahead_c : facing * CAMERA.look_ahead_c * 0.5;
  const ease = 1 / (CAMERA.look_ease_s * 60);
  const look = c.look + (want - c.look) * Math.min(1, ease * 4);
  const target = v.player.x + look - vw / 2;
  let x = c.x;
  const dz = CAMERA.dead_zone_c / 2;
  if (target > x + dz) x += (target - dz - x) * CAMERA.lerp_per_frame;
  else if (target < x - dz) x += (target + dz - x) * CAMERA.lerp_per_frame;
  x = Math.max(0, Math.min(Math.max(0, world.w - vw), x));
  return { x, look, facing, max_x: Math.max(c.max_x, x) };
}

class StaticSim implements Sim {
  frame = 0;
  private cam: CameraState;
  private readonly level: LevelV2;
  private readonly start: [number, number];
  private readonly ents: EntityView[];

  constructor(level: LevelV2, startAt?: CellXY) {
    this.level = level;
    this.start = startOf(level, startAt);
    this.ents = entityViewsAtSpawn(level);
    const x = Math.max(0, Math.min(level.world.w - CAMERA.view_w_c, this.start[0] - CAMERA.view_w_c / 3));
    this.cam = { x, look: 0, facing: 1, max_x: x };
  }

  step(input: number): SimEvent[] {
    this.frame++;
    const max = Math.max(0, this.level.world.w - CAMERA.view_w_c);
    if (input & BIT.L) this.cam = { ...this.cam, x: Math.max(0, this.cam.x - 0.4) };
    if (input & BIT.R) this.cam = { ...this.cam, x: Math.min(max, this.cam.x + 0.4) };
    return [];
  }

  view(): SimView {
    return {
      frame: this.frame,
      player: { x: this.start[0], y: this.start[1], vx: 0, vy: 0, facing: 1, on_ground: true, state: 'idle', invulnerable_f: 0 },
      entities: this.ents,
      coins: 0, big_coins_held: 0, big_coins_banked: 0, deaths: 0, lives: null, hearts: this.level.rules.hearts ?? 1,
      checkpoint: null, timer_frames_left: null, won: false,
    };
  }

  camera(): CameraState {
    return this.cam;
  }

  snapshot(): SimSnapshot {
    return { frame: this.frame, data: { cam: { ...this.cam } } };
  }

  restore(s: SimSnapshot): void {
    this.frame = s.frame;
    this.cam = { ...(s.data as { cam: CameraState }).cam };
  }

  hash(): string {
    return `static:${this.frame}`;
  }
}

/** A Sim wrapper whose camera falls back to the engine's follow rule if the core camera is not there yet. */
class CamGuard implements Sim {
  private inner: Sim;
  private cam: CameraState | null = null;
  private world: World;
  private coreCam = true;
  constructor(inner: Sim, world: World) {
    this.inner = inner;
    this.world = world;
  }
  get frame(): number {
    return this.inner.frame;
  }
  step(input: number): SimEvent[] {
    const ev = this.inner.step(input);
    if (!this.coreCam) this.cam = followCamera(this.cam!, this.inner.view(), this.world);
    return ev;
  }
  view(): SimView {
    return this.inner.view();
  }
  camera(): CameraState {
    if (this.coreCam) {
      try {
        return this.inner.camera();
      } catch {
        this.coreCam = false;
      }
    }
    if (!this.cam) {
      const v = this.inner.view();
      let c: CameraState = { x: Math.max(0, v.player.x - CAMERA.view_w_c / 3), look: 0, facing: 1, max_x: 0 };
      try {
        c = cameraStep(c, v, this.world);
      } catch {
        c = followCamera(c, v, this.world);
      }
      this.cam = c;
    }
    return this.cam;
  }
  snapshot(): SimSnapshot {
    return { frame: this.inner.frame, data: { inner: this.inner.snapshot(), cam: this.cam ? { ...this.cam } : null } };
  }
  restore(s: SimSnapshot): void {
    const d = s.data as { inner: SimSnapshot; cam: CameraState | null };
    this.inner.restore(d.inner);
    this.cam = d.cam ? { ...d.cam } : null;
  }
  hash(): string {
    return this.inner.hash();
  }
}

/** The static stand-in (used when the core Sim is missing or has crashed). */
export function makeStaticSim(level: LevelV2, startAt?: CellXY): Sim {
  return new StaticSim(level, startAt);
}

export function makeSim(level: LevelV2, o: { startAt?: CellXY; seed?: number } = {}): SimHost {
  try {
    const sim = createSim(level, o);
    sim.view();
    return { sim: new CamGuard(sim, level.world), real: true };
  } catch (e) {
    return { sim: new StaticSim(level, o.startAt), real: false, reason: isNotImplemented(e) ? 'not_implemented' : String(e) };
  }
}
