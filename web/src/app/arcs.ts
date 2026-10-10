/**
 * Jump arcs for the rules sheet's mini-stage (§8.2 "a mini-stage shows the jump arc for the selected profile and
 * abilities, so double jump is visible before you commit to it"). The arcs are flown by the real Sim on a flat floor
 * with the game's rules, so they are exactly what play and the bot will do: standing jump, walking jump, running jump
 * (when Run is on) and the double jump (a second press at the apex) when it is on. Lane A's `jumpArcs` (the same
 * flights the bot's envelope is measured with) is used; the local flight below is the fallback. Positions are feet
 * offsets from the takeoff, in cells, y up.
 */
import type { GameRules, LevelV2 } from '../core/types.gen.ts';
import { jumpArcs as simArcs } from '../core/bot/index.ts';
import { CORE_VERSION, createSim } from '../core/index.ts';
import { SIM } from '../core/params.ts';

export type ArcKind = 'stand' | 'walk' | 'run' | 'double';

export interface Arc {
  kind: ArcKind;
  pts: [number, number][]; // (dx, dy-up) per frame from takeoff
  apex: number; // cells above the takeoff
  dist: number; // cells travelled when back on the floor
  frames: number;
}

const { R, J, RUN } = SIM.input_bits;
const W = 144;
const FLOOR_ROW = 22;

function floorLevel(rules: GameRules): LevelV2 {
  const rows: string[] = [];
  for (let r = 0; r < 27; r++) rows.push(r < FLOOR_ROW ? `${W}.` : `${W}#`);
  return {
    format: 'dal-level', schema_version: 2, core_min: CORE_VERSION, id: 'arcs', version: 1, title: 'arcs', author: 'rules',
    created_at: '2026-01-01T00:00:00Z', world: { cell: 16, screens: W / 48, w: W, h: 27 }, rules: { ...rules, lives: 'off', camera: 'follow' },
    source: { kind: 'canvas' },
    compiled: { tiles: { legend: '.#=/\\abcd~X', rows }, entities: [{ id: 'start', type: 'player_start', x: 3, y: FLOOR_ROW }] },
    meta: { level_hash: '', core_version: CORE_VERSION },
  } as LevelV2;
}

function fly(rules: GameRules, kind: ArcKind): Arc | null {
  const sim = createSim(floorLevel(rules), { seed: 1 });
  const run = kind === 'run' || kind === 'double';
  const dir = kind === 'stand' ? 0 : R;
  const hold = run ? RUN : 0;
  // run-up: long enough to reach top speed (walk ≈ 0.1 s, run ≈ 2.3 cells, §5.3)
  const runupTo = kind === 'stand' ? 0 : run ? 16 : 9;
  let guard = 0;
  sim.step(0);
  while (sim.view().player.x < runupTo && guard++ < 600) sim.step(dir | hold);
  const p0 = sim.view().player;
  const x0 = p0.x;
  const y0 = p0.y;
  const pts: [number, number][] = [[0, 0]];
  let apex = 0;
  let left = false;
  let second = kind !== 'double';
  let released = false;
  let frames = 0;
  for (let f = 0; f < 240; f++) {
    let bits = dir | hold;
    const v = sim.view().player;
    if (kind === 'double' && !second) {
      // hold to the apex, let go for one frame, then press again
      if (!released && left && v.vy >= 0) {
        released = true;
      } else if (released) {
        second = true;
        bits |= J;
      } else bits |= J;
    } else if (f < 40) bits |= J;
    else if (kind === 'double' && second && f < 80) bits |= J;
    sim.step(bits);
    const p = sim.view().player;
    frames++;
    const dx = p.x - x0;
    const up = y0 - p.y;
    pts.push([Math.round(dx * 100) / 100, Math.round(up * 100) / 100]);
    apex = Math.max(apex, up);
    if (!p.on_ground) left = true;
    if (left && p.on_ground) break;
  }
  if (!left) return null;
  const last = pts[pts.length - 1];
  return { kind, pts, apex: Math.round(apex * 10) / 10, dist: Math.round(last[0] * 10) / 10, frames };
}

/** Lane A's arcs (y < 0 up) as the mini-stage's arcs (y up): stand, walk, run, and the double jump of the fastest. */
function fromSim(rules: GameRules, ab: { run?: boolean; double_jump?: boolean }): Arc[] {
  const all = simArcs(rules.physics_profile ?? 'v2-standard', { run: ab.run !== false, double_jump: !!ab.double_jump });
  const conv = (kind: ArcKind, a: (typeof all)[number]): Arc => ({
    kind, pts: a.pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(-y * 100) / 100] as [number, number]),
    apex: Math.round(a.apex_c * 10) / 10, dist: Math.round(a.dist_c * 10) / 10, frames: a.pts.length,
  });
  const pick = (speed: 'stand' | 'walk' | 'run', dj: boolean) => all.find((a) => a.speed === speed && a.double_jump === dj);
  const out: Arc[] = [];
  for (const k of ['stand', 'walk', 'run'] as const) {
    const a = pick(k, false);
    if (a) out.push(conv(k, a));
  }
  if (ab.double_jump) {
    const d = pick('run', true) ?? pick('walk', true);
    if (d) out.push(conv('double', d));
  }
  return out;
}

/** The arcs the current rules allow; an arc that cannot fly (the Sim is not ready) is left out. */
export function jumpArcs(rules: GameRules): Arc[] {
  const ab = { run: true, stomp: true, double_jump: false, fast_fall: true, ...(rules.abilities ?? {}) };
  try {
    const arcs = fromSim(rules, ab);
    if (arcs.length) return arcs;
  } catch (e) {
    console.warn('lane A jumpArcs failed; flying the arcs locally', e);
  }
  const kinds: ArcKind[] = ['stand', 'walk'];
  if (ab.run && rules.physics_profile !== 'v1-classic') kinds.push('run');
  if (ab.double_jump) kinds.push('double');
  const out: Arc[] = [];
  for (const k of kinds) {
    try {
      const a = fly(rules, k);
      if (a) out.push(a);
    } catch (e) {
      console.warn('jump arc failed', k, e);
      return out;
    }
  }
  return out;
}
