/**
 * Jump envelope and trajectory templates (§4.1, §5.3), measured with the same rules as the Sim.
 *
 * - freeFlight(): the free-flight body offsets of one jump (no terrain), the per-frame template the bot uses
 *   for head-bonk reach loss and coin arcs;
 * - measureEnvelope(): apex / distance per start speed and hold, tap hop, and g_max(runway) measured by the real
 *   Sim on synthetic flat levels (what `cli.ts envelope` writes into params.json).
 * - reachFor(): the reach of one game's rules (profile + abilities): the highest ledge and the g_max table with
 *   running on or off and the double jump on or off, measured the same way; the frontier quotes it.
 */
import { ABILITIES } from '../params.ts';
import { CORE_VERSION } from '../util/version.ts';
import { SimCore } from '../sim/core.ts';
import { PROFILES } from '../sim/profiles.ts';
import { CELL } from '../sim/tiles.ts';
import { IN_J, IN_R, IN_RUN } from '../sim/types.ts';
import type { PhysicsProfile } from '../sim/types.ts';
import type { LevelV2, ProfileId } from '../types.gen.ts';

const DT = 1 / 60;

export interface Flight {
  dx: number[]; // px per frame offsets from takeoff
  dy: number[];
  apex: number; // px above takeoff (positive)
  apexF: number;
  landF: number; // first frame back at takeoff height (falling)
  dist: number; // px travelled when back at takeoff height
}

/** Abilities that change the jump envelope. */
export interface ReachAbilities {
  run: boolean;
  double_jump: boolean;
}

const DEFAULT_AB: ReachAbilities = { run: true, double_jump: false };

/**
 * Free flight of a jump with constant horizontal input (dir held, run held when speed is run), J held `hold`
 * frames. Same integration order as the Sim (velocity, then position; release cut once; apex half gravity).
 * `dj` > 0 presses the double jump `dj` frames after the first press (J released the frame before, then held 16 f,
 * the bot's pattern).
 */
export function freeFlight(p: PhysicsProfile, vx0: number, hold: number, maxF = 180, dj = 0): Flight {
  let vy = -(p.jump_base + p.jump_vx_bonus * Math.abs(vx0));
  let y = 0;
  let x = 0;
  let cut = true;
  let apex = 0;
  let apexF = 0;
  let landF = maxF;
  let dist = 0;
  const dx: number[] = [];
  const dy: number[] = [];
  for (let f = 0; f < maxF; f++) {
    const held = dj > 0 ? f < Math.min(hold, dj - 1) || (f >= dj && f < dj + 16) : f < hold;
    if (dj > 0 && f === dj) {
      vy = ABILITIES.double_jump.vy;
      cut = true;
    }
    if (!held && cut && vy < p.release_cut) {
      vy = p.release_cut;
      cut = false;
    }
    if (vy >= 0) cut = false;
    let g: number;
    if (held && Math.abs(vy) < p.apex_vy) g = p.g_apex_held;
    else if (held && vy < 0) g = p.g_rise_held;
    else g = p.g_fall;
    vy = Math.min(vy + g * DT, p.max_fall);
    y += vy * DT;
    x += vx0 * DT;
    dx.push(x);
    dy.push(y);
    if (-y > apex) {
      apex = -y;
      apexF = f;
    }
    if (f > 1 && y >= 0 && landF === maxF) {
      landF = f;
      dist = x;
    }
  }
  return { dx, dy, apex, apexF, landF, dist };
}

const flightCache = new Map<string, Flight>();

/** Cached free flight per (profile, start-speed class, hold, double-jump frame). speed: 0 stand, 1 walk, 2 run. */
export function template(p: PhysicsProfile, speed: number, hold: number, dj = 0): Flight {
  const key = `${p.id}|${speed}|${hold}|${dj}`;
  let f = flightCache.get(key);
  if (!f) {
    const vx = speed === 2 ? (p.run_max ?? p.walk_max) : speed === 1 ? p.walk_max : 0;
    f = freeFlight(p, vx, hold, 180, dj);
    flightCache.set(key, f);
  }
  return f;
}

function flatLevel(profile: ProfileId, rows: string[], w: number, start: [number, number], ab: ReachAbilities = DEFAULT_AB): LevelV2 {
  return {
    format: 'dal-level', schema_version: 2, core_min: CORE_VERSION, id: 'env', version: 1, title: 'envelope', author: 'core',
    created_at: '2026-01-01T00:00:00Z', world: { cell: 16, screens: Math.max(1, Math.ceil(w / 48)), w, h: 27 },
    rules: { version: 1, physics_profile: profile, abilities: { run: ab.run, stomp: true, double_jump: ab.double_jump, fast_fall: true } },
    source: { kind: 'canvas' },
    compiled: { tiles: { legend: '.#=/\\abcd~X', rows }, entities: [{ id: 'start', type: 'player_start', x: start[0], y: start[1] }] },
    meta: { level_hash: '', core_version: CORE_VERSION },
  } as LevelV2;
}

function floorRows(w: number, gapFrom: number, gapTo: number): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 27; r++) {
    if (r < 22) rows.push(`${w}.`);
    else {
      let s = '';
      for (let c = 0; c < w; c++) s += c >= gapFrom && c < gapTo ? '.' : '#';
      rows.push(s);
    }
  }
  return rows;
}

/**
 * One measured jump on an open flat floor: apex (cells) and distance (cells) for a start speed and hold. With the
 * double jump on, the second jump is pressed at the apex of the first and held as long.
 */
export function measureJump(profile: ProfileId, speed: number, hold: number, ab: ReachAbilities = DEFAULT_AB): { apex: number; dist: number } {
  const p = PROFILES[profile];
  const w = 160;
  const lvl = flatLevel(profile, floorRows(w, w, w), w, [4, 22], ab);
  const sim = new SimCore(lvl, { seed: 1 });
  sim.camOff = true;
  const dir = speed === 0 ? 0 : IN_R;
  const run = speed === 2 && p.run_max !== null && ab.run ? IN_RUN : 0;
  // run-up of 4 cells so the speed is reached
  let f = 0;
  if (speed > 0) while (sim.S.p.x < 8 * CELL && f++ < 300) sim.tick(dir | run);
  const x0 = sim.S.p.x;
  const y0 = sim.S.p.y;
  let apex = 0;
  let second = -1;
  sim.tick(dir | run | IN_J);
  for (let k = 1; k < 400; k++) {
    let j = k < hold;
    if (ab.double_jump) {
      if (second < 0 && sim.S.p.vy >= 0) second = k + 1; // release this frame, press again on the next
      if (second >= 0) j = k >= second && k < second + hold;
      else if (k >= hold) j = false;
    }
    sim.tick(dir | run | (j ? IN_J : 0));
    apex = Math.max(apex, y0 - sim.S.p.y);
    if (sim.S.p.gnd > 0) break;
  }
  return { apex: apex / CELL, dist: (sim.S.p.x - x0) / CELL };
}

const gmaxCache = new Map<string, number[]>();

/**
 * g_max(runway): the widest gap (cells) cleared with `runway` cells of floor before the edge, for runway 0..6,
 * measured on synthetic levels by running (Run held when the rules allow it), pressing Jump at the best of four
 * edge offsets and holding (with the double jump: a second press at the apex).
 */
export function gMaxTable(profile: ProfileId, ab: ReachAbilities = DEFAULT_AB): number[] {
  const key = `${profile}|${ab.run ? 1 : 0}|${ab.double_jump ? 1 : 0}`;
  const hit = gmaxCache.get(key);
  if (hit) return hit;
  const p = PROFILES[profile];
  const out: number[] = [];
  const maxGap = ab.double_jump ? 18 : 14;
  for (let runway = 0; runway <= 6; runway++) {
    let best = 0;
    for (let g = 1; g <= maxGap; g++) {
      if (clears(profile, p, runway, g, ab)) best = g;
      else if (g > best + 1) break;
    }
    out.push(best);
  }
  gmaxCache.set(key, out);
  return out;
}

function clears(profile: ProfileId, p: PhysicsProfile, runway: number, gap: number, ab: ReachAbilities): boolean {
  const edgeCol = 11 + runway; // the start stands on column 10 (centre 10.5); runway counts the cells after it
  const w = edgeCol + gap + 12;
  const rows = floorRows(w, edgeCol, edgeCol + gap);
  // a wall behind the start, so the run-up is exactly `runway` cells
  for (let r = 0; r < 22; r++) rows[r] = '9.#' + `${w - 10}.`;
  const lvl = flatLevel(profile, rows, w, [10.5, 22], ab);
  const edgeX = edgeCol * CELL + 6;
  for (const off of [-6, -2, 2, 5]) {
    const sim = new SimCore(lvl, { seed: 1 });
    sim.camOff = true;
    const run = p.run_max !== null && ab.run ? IN_RUN : 0;
    let pressed = -1;
    let second = -1;
    for (let f = 0; f < 400; f++) {
      const P = sim.S.p;
      let input = IN_R | run;
      if (pressed < 0 && P.x >= edgeX + off) pressed = f;
      if (pressed >= 0) {
        if (ab.double_jump) {
          if (second < 0 && f > pressed + 1 && P.vy >= 0) second = f + 1;
          if (second < 0 ? f - pressed < 45 && P.vy < 0 : f >= second && f - second < 45) input |= IN_J;
        } else if (f - pressed < 45) input |= IN_J;
      }
      sim.tick(input);
      if (sim.S.p.mode !== 0) break;
      if (pressed >= 0 && f > pressed + 2 && sim.S.p.gnd > 0) {
        if (sim.S.p.x > (edgeCol + gap) * CELL - 5) return true;
        break;
      }
    }
  }
  return false;
}

export interface EnvelopeTable {
  profile: ProfileId;
  apex_c: { stand: number; walk: number; run: number | null };
  dist_c: { walk: number; run: number | null };
  tap_hop_c: number;
  g_max: number[]; // runway 0..6
}

export function measureEnvelope(profile: ProfileId, ab: ReachAbilities = DEFAULT_AB): EnvelopeTable {
  const p = PROFILES[profile];
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  const stand = measureJump(profile, 0, 60, ab);
  const walk = measureJump(profile, 1, 60, ab);
  const run = p.run_max !== null && ab.run ? measureJump(profile, 2, 60, ab) : null;
  const tap = measureJump(profile, 0, 1, { run: ab.run, double_jump: false });
  return {
    profile,
    apex_c: { stand: r2(stand.apex), walk: r2(walk.apex), run: run ? r2(run.apex) : null },
    dist_c: { walk: r2(walk.dist), run: run ? r2(run.dist) : null },
    tap_hop_c: r2(tap.apex),
    g_max: gMaxTable(profile, ab),
  };
}

export interface Reach {
  /** Highest ledge (cells above the feet) the best moving jump reaches. */
  apex_c: number;
  /** Highest ledge from a standing jump. */
  stand_apex_c: number;
  /** g_max(runway) for runway 0..6 cells. */
  g_max: number[];
  /** The widest gap with any runway. */
  g_max_best: number;
  /** Runway (cells) needed for g_max_best. */
  runway_for_best: number;
}

const reachCache = new Map<string, Reach>();

/**
 * The reach of one game's rules (§5.3, §8.2): profile + run on/off + double jump on/off. Without the double jump
 * the apex values are the profile's published envelope; with it they are measured in the Sim (second press at the
 * apex). Cached per (profile, abilities).
 */
export function reachFor(profile: ProfileId, ab: Partial<ReachAbilities> = DEFAULT_AB): Reach {
  const p = PROFILES[profile] ?? PROFILES['v2-standard'];
  const a: ReachAbilities = { run: ab.run !== false && p.run_max !== null, double_jump: !!ab.double_jump };
  const key = `${p.id}|${a.run ? 1 : 0}|${a.double_jump ? 1 : 0}`;
  const hit = reachCache.get(key);
  if (hit) return hit;
  let apex: number;
  let stand: number;
  if (a.double_jump) {
    apex = measureJump(p.id, a.run ? 2 : 1, 60, a).apex;
    stand = measureJump(p.id, 0, 60, a).apex;
  } else {
    apex = (a.run ? p.envelope.apex_c.run : null) ?? p.envelope.apex_c.walk;
    stand = p.envelope.apex_c.stand;
  }
  const g = gMaxTable(p.id, a);
  let best = 0;
  let runway = 0;
  for (let k = 0; k < g.length; k++) if (g[k] > best) {
    best = g[k];
    runway = k;
  }
  const r: Reach = { apex_c: apex, stand_apex_c: stand, g_max: g, g_max_best: best, runway_for_best: runway };
  reachCache.set(key, r);
  return r;
}

export interface JumpArc {
  speed: 'stand' | 'walk' | 'run';
  double_jump: boolean;
  /** Feet positions relative to the takeoff, cells (y < 0 is up), one per frame until landing. */
  pts: [number, number][];
  apex_c: number;
  dist_c: number;
}

const arcCache = new Map<string, JumpArc[]>();

/**
 * The jump arcs of one game's rules, played in the Sim on an open floor (full hold; with the double jump also the
 * second press at the apex): what the rules screen's mini-stage draws so "double jump" and the profile are visible
 * before a creator commits to them (§8.2).
 */
export function jumpArcs(profile: ProfileId, ab: Partial<ReachAbilities> = DEFAULT_AB): JumpArc[] {
  const p = PROFILES[profile] ?? PROFILES['v2-standard'];
  const a: ReachAbilities = { run: ab.run !== false && p.run_max !== null, double_jump: !!ab.double_jump };
  const key = `${p.id}|${a.run ? 1 : 0}|${a.double_jump ? 1 : 0}`;
  const hit = arcCache.get(key);
  if (hit) return hit;
  const out: JumpArc[] = [];
  const speeds: (0 | 1 | 2)[] = a.run ? [0, 1, 2] : [0, 1];
  for (const dj of a.double_jump ? [false, true] : [false]) {
    for (const speed of speeds) {
      const w = 160;
      const lvl = flatLevel(p.id, floorRows(w, w, w), w, [4, 22], { run: a.run, double_jump: dj });
      const sim = new SimCore(lvl, { seed: 1 });
      sim.camOff = true;
      const dir = speed === 0 ? 0 : IN_R;
      const run = speed === 2 ? IN_RUN : 0;
      let f = 0;
      if (speed > 0) while (sim.S.p.x < 8 * CELL && f++ < 300) sim.tick(dir | run);
      const x0 = sim.S.p.x;
      const y0 = sim.S.p.y;
      const pts: [number, number][] = [[0, 0]];
      let apex = 0;
      let second = -1;
      sim.tick(dir | run | IN_J);
      pts.push([(sim.S.p.x - x0) / CELL, (sim.S.p.y - y0) / CELL]);
      for (let k = 1; k < 400; k++) {
        let j = k < 60;
        if (dj) {
          if (second < 0 && sim.S.p.vy >= 0) second = k + 1;
          j = second < 0 ? k < 60 : k >= second && k < second + 60;
        }
        sim.tick(dir | run | (j ? IN_J : 0));
        const dx = (sim.S.p.x - x0) / CELL;
        const dy = (sim.S.p.y - y0) / CELL;
        pts.push([Math.round(dx * 1000) / 1000, Math.round(dy * 1000) / 1000]);
        apex = Math.max(apex, -dy);
        if (sim.S.p.gnd > 0) break;
      }
      const last = pts[pts.length - 1];
      out.push({ speed: speed === 0 ? 'stand' : speed === 1 ? 'walk' : 'run', double_jump: dj, pts, apex_c: Math.round(apex * 100) / 100, dist_c: Math.round(last[0] * 100) / 100 });
    }
  }
  arcCache.set(key, out);
  return out;
}
