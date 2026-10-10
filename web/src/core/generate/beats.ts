/**
 * Beat catalogue clamps (§8.3, `core/generate/beats.ts`). The model (or the keyword planner, or a Starter World
 * author) picks beats and rough sizes; code clamps every integer by band and by the physics envelope before any
 * geometry is laid out, so a plan can never ask for a jump the profile cannot make.
 *
 *   gap width       easy 2-4 (walk-gap) · normal 4-6, width ≥ 5 gets a runway ≥ 4 · hard 6-8 with a runway ≥ 3
 *   step rise       easy 1-2 · normal 2-3 · hard 3-4 (a walking jump)
 *   spacing         easy 2-3 · normal 3-4 · hard 4-6, landings 2
 *   gauntlet n      easy 1 walker · normal 2 walkers / 1 hopper · hard 2-4, any archetype
 *   moving bridge   easy 1 platform, slow · normal 2, normal · hard 3, fast + saw
 *   tower rise      3 · 3 · 3-4
 * A negative `rise` on `step` / `stairs` steps down (an extension: the schema has no bounds).
 */
import { DERIVED, PROMPT_LEVEL, WORLD } from '../params.ts';
import type { PhysicsProfile } from '../sim/types.ts';
import type { Beat, LevelPlan, Section } from '../types.gen.ts';
import { gMax, hMax } from '../edits/envelope.ts';

export type PlanBand = 'easy' | 'normal' | 'hard';

const C = PROMPT_LEVEL.clamps;

export function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.max(lo, Math.min(hi, n));
}

function range(r: readonly number[], v: unknown, def?: number): number {
  return clampInt(v, r[0], r[1], def ?? r[0]);
}

export function bandOf(b: unknown): PlanBand {
  return b === 'easy' || b === 'hard' ? b : 'normal';
}

/** The widest gap (empty cells) a level may ask for at this band with this runway, inside the envelope. */
export function maxGap(p: PhysicsProfile, band: PlanBand, runway: number, canRun: boolean): number {
  const env = gMax(p, canRun ? runway : 0);
  return Math.max(2, Math.min(C.gap_width[band][1], env));
}

/** The highest up-step (rows) at this band: standing jumps for easy/normal, walking jumps for hard. */
export function maxRise(p: PhysicsProfile, band: PlanBand): number {
  const stand = Math.max(1, hMax(p, 'stand'));
  const walk = Math.max(stand, hMax(p, 'walk'));
  return Math.min(C.step_rise[band][1], band === 'hard' ? walk : Math.min(stand, DERIVED.standing_wall_c));
}

/** How strictly to clamp: by the plan's band (model and keyword plans), or only by the envelope (authored plans). */
export type ClampMode = 'band' | 'envelope';

type BandTable = { easy: readonly number[]; normal: readonly number[]; hard: readonly number[] };

function bandRange(t: BandTable, band: PlanBand, mode: ClampMode): readonly number[] {
  if (mode === 'band') return t[band];
  return [Math.min(t.easy[0], t.normal[0], t.hard[0]), Math.max(t.easy[1], t.normal[1], t.hard[1])];
}

/** Clamp one beat by band and envelope. Unknown kinds become a short rest. */
export function clampBeat(b: Beat, band0: PlanBand, p: PhysicsProfile, canRun: boolean, mode: ClampMode = 'band'): Beat {
  const any = b as unknown as Record<string, unknown>;
  const band: PlanBand = mode === 'envelope' ? 'hard' : band0;
  const R = (t: BandTable): readonly number[] => bandRange(t, band0, mode);
  switch (b.kind) {
    case 'flat':
      return {
        kind: 'flat', length: range(C.flat_len, b.length, 8),
        enemy: b.enemy === 'walker' || b.enemy === 'hopper' || b.enemy === 'chaser' ? b.enemy : 'none',
        coins: clampInt(b.coins, 0, 7, 0), spikes: b.spikes === 'middle' || b.spikes === 'far_end' ? b.spikes : 'none',
      };
    case 'gap': {
      const lo = C.gap_width[band0][0];
      const width = clampInt(b.width, 2, maxGap(p, band, 3, canRun), lo);
      return { kind: 'gap', width: Math.max(2, width), floor: b.floor === 'spikes' || b.floor === 'lava' ? b.floor : 'void' };
    }
    case 'step': {
      const r = clampInt(b.rise, -6, 6, 2);
      const length = clampInt(b.length, 2, 16, 4);
      if (r < 0) return { kind: 'step', rise: r, length };
      const hi = maxRise(p, band);
      const lo = mode === 'envelope' ? 1 : Math.min(C.step_rise[band][0], hi);
      return { kind: 'step', rise: Math.max(lo, Math.min(hi, r || lo)), length };
    }
    case 'stairs': {
      const r = clampInt(b.rise, -4, 4, 2);
      const mag = Math.max(1, Math.min(Math.abs(r || 1), r < 0 ? 4 : maxRise(p, band)));
      return { kind: 'stairs', n: range(C.stairs_n, b.n, 3), rise: r < 0 ? -mag : mag, run: range(R(C.stairs_run), b.run, R(C.stairs_run)[1]) };
    }
    case 'pillars':
      return { kind: 'pillars', n: range(C.pillars_n, b.n, 3), spacing: range(R(C.spacing), b.spacing, R(C.spacing)[0]), hazard: b.hazard === 'spikes' || b.hazard === 'lava' ? b.hazard : 'void' };
    case 'floaters':
      return { kind: 'floaters', n: range(C.floaters_n, b.n, 3), dy: range(R(C.floaters_dy), b.dy, 2), spacing: range(R(C.spacing), b.spacing, R(C.spacing)[0]), oneway: b.oneway !== false };
    case 'ceiling':
      return { kind: 'ceiling', length: range(C.ceiling_len, b.length, 10), spikes: !!b.spikes, headroom: range(C.ceiling_headroom, b.headroom, 4) };
    case 'wall':
      return { kind: 'wall', height: Math.min(range(R(C.wall_height), b.height, R(C.wall_height)[0]), maxRise(p, band)), spikes: b.spikes === 'near_face' ? 'near_face' : 'none' };
    case 'moving_bridge':
      return { kind: 'moving_bridge', gap: range(R(C.bridge_gap), b.gap, R(C.bridge_gap)[0]), speed: b.speed === 'slow' || b.speed === 'fast' ? b.speed : 'normal', vertical: !!b.vertical };
    case 'crumble_run':
      return { kind: 'crumble_run', n: range(R(C.crumble_n), b.n, R(C.crumble_n)[0]), floor: b.floor === 'shallow' ? 'shallow' : 'void' };
    case 'saw_corridor':
      return { kind: 'saw_corridor', length: range(C.saw_corridor_len, b.length, 12), saws: range(R(C.saws), b.saws, R(C.saws)[0]) };
    case 'tower':
      return { kind: 'tower', tiers: range(C.tower_tiers, b.tiers, 3), rise: range(R(C.tower_rise), b.rise, 3), oneway: b.oneway !== false };
    case 'enemy_gauntlet': {
      const okArch = band === 'easy' ? ['walker', 'hopper', 'flyer'] : ['walker', 'hopper', 'flyer', 'shooter', 'chaser', 'crusher'];
      const archetype = (okArch.includes(b.archetype) ? b.archetype : 'walker') as Extract<Beat, { kind: 'enemy_gauntlet' }>['archetype'];
      return { kind: 'enemy_gauntlet', archetype, n: range(R(C.gauntlet_n), b.n, R(C.gauntlet_n)[0]) };
    }
    case 'spring_up':
      return { kind: 'spring_up', height: range(C.spring_height, b.height, 5) };
    case 'key':
      return { kind: 'key', place: b.place === 'high' || b.place === 'alcove' ? b.place : 'guarded' };
    case 'door':
      return { kind: 'door' };
    case 'rest':
      return { kind: 'rest', length: range(C.rest_len, b.length, 6) };
    case 'checkpoint':
      return { kind: 'checkpoint' };
    case 'goal':
      return { kind: 'goal', style: b.style === 'staircase' ? 'staircase' : 'flag' };
    default:
      return { kind: 'rest', length: clampInt(any.length, C.rest_len[0], C.rest_len[1], 4) };
  }
}

/** A clamped deep copy of a plan: screens 1..6, band, every beat inside its bounds, exactly one goal at the end. */
export function normalizePlan(plan: LevelPlan, p: PhysicsProfile, canRun = true, mode: ClampMode = 'band'): LevelPlan {
  const band = bandOf(plan?.band);
  const screens = clampInt(plan?.screens, 1, WORLD.max_screens, 2);
  const sections: Section[] = [];
  let goal: Beat | null = null;
  for (const s of plan?.sections ?? []) {
    const role = s?.role === 'teach' || s?.role === 'test' || s?.role === 'twist' || s?.role === 'finale' || s?.role === 'rest' ? s.role : 'test';
    const beats: Beat[] = [];
    for (const b of s?.beats ?? []) {
      if (!b || typeof b !== 'object' || typeof (b as { kind?: unknown }).kind !== 'string') continue;
      const c = clampBeat(b, band, p, canRun, mode);
      if (c.kind === 'goal') {
        goal = c;
        continue;
      }
      beats.push(c);
    }
    if (beats.length) sections.push({ role, beats });
  }
  if (!sections.length) sections.push({ role: 'teach', beats: [{ kind: 'flat', length: 12, enemy: 'none', coins: 3, spikes: 'none' }] });
  sections[sections.length - 1].beats.push(goal ?? { kind: 'goal', style: 'flag' });
  const theme = plan?.theme === 'notebook' || plan?.theme === 'graph' || plan?.theme === 'kraft' ? plan.theme : 'sketchbook';
  return {
    title: String(plan?.title ?? 'My level').slice(0, 60) || 'My level', theme, screens, band, sections,
    kid_summary: String(plan?.kid_summary ?? '').slice(0, 240), safety_ok: plan?.safety_ok !== false,
  };
}

/** One step easier for the deterministic fixer (§8.3 step 3): shrink width / rise / spacing by 1, or null. */
export function shrinkBeat(b: Beat, band: PlanBand): Beat | null {
  const lo2 = 2;
  switch (b.kind) {
    case 'gap':
      if (b.floor !== 'void' && b.width <= 3) return { ...b, floor: 'void' };
      return b.width > lo2 ? { ...b, width: b.width - 1 } : null;
    case 'step':
      return Math.abs(b.rise) > 1 ? { ...b, rise: b.rise > 0 ? b.rise - 1 : b.rise + 1 } : null;
    case 'stairs':
      if (Math.abs(b.rise) > 1) return { ...b, rise: b.rise > 0 ? b.rise - 1 : b.rise + 1 };
      return b.n > 2 ? { ...b, n: b.n - 1 } : null;
    case 'pillars':
      if (b.spacing > 2) return { ...b, spacing: b.spacing - 1 };
      return b.n > 2 ? { ...b, n: b.n - 1 } : null;
    case 'floaters':
      if (b.spacing > 2) return { ...b, spacing: b.spacing - 1 };
      if (b.dy > 1) return { ...b, dy: b.dy - 1 };
      return b.n > 2 ? { ...b, n: b.n - 1 } : null;
    case 'ceiling':
      if (b.spikes) return { ...b, spikes: false };
      return b.headroom < C.ceiling_headroom[1] ? { ...b, headroom: b.headroom + 1 } : null;
    case 'wall':
      if (b.spikes !== 'none') return { ...b, spikes: 'none' };
      return b.height > 1 ? { ...b, height: b.height - 1 } : null;
    case 'moving_bridge':
      if (b.speed === 'fast') return { ...b, speed: 'normal' };
      return b.gap > C.bridge_gap.easy[0] ? { ...b, gap: b.gap - 1 } : null;
    case 'crumble_run':
      if (b.floor === 'void') return { ...b, floor: 'shallow' };
      return b.n > 2 ? { ...b, n: b.n - 1 } : null;
    case 'saw_corridor':
      return b.saws > 1 ? { ...b, saws: b.saws - 1 } : null;
    case 'tower':
      if (b.rise > 2) return { ...b, rise: b.rise - 1 };
      return b.tiers > 2 ? { ...b, tiers: b.tiers - 1 } : null;
    case 'enemy_gauntlet':
      if (b.n > 1) return { ...b, n: b.n - 1 };
      return b.archetype !== 'walker' ? { ...b, archetype: 'walker' } : null;
    case 'spring_up':
      return b.height > C.spring_height[0] ? { ...b, height: b.height - 1 } : null;
    case 'flat':
      if (b.spikes !== 'none') return { ...b, spikes: 'none' };
      return b.enemy !== 'none' && band !== 'hard' ? { ...b, enemy: 'none' } : null;
    case 'key':
      return b.place === 'high' ? { ...b, place: 'guarded' } : b.place === 'guarded' ? { ...b, place: 'alcove' } : null;
    default:
      return null;
  }
}
