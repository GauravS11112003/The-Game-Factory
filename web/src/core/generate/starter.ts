/**
 * Starter World v2 (§9) and Classic Starter, built from their sources (pure; `cli.ts starter:build` does the I/O).
 *
 * - Starter World: `shared/starter/L*.plan.json` (LevelPlan beats, the same generator as prompt-to-level) plus
 *   `L*.overrides.json` (per-beat recipe patches, extra drawn things — big coins, signs, ledges — and ordinary
 *   explicit edits). Plans are clamped by the physics envelope only (an authored level may mix bands), laid out,
 *   re-inked in the kid's marker palette (K1, so they look hand-drawn and go through the real renderer), and built
 *   with `tier: faithful`: the designer never touches the hand-authored levels.
 * - Classic Starter: the v1 fixtures migrated under `v1-classic` (§2.6), analyzed for their design block.
 */
import { STARTER } from '../params.ts';
import type { DesignBlock, EditOp, GameMode, GameRules, LevelPlan, LevelV2, PlaytestReport, RuleV4 } from '../types.gen.ts';
import { analyze } from '../bot/index.ts';
import { levelHash } from '../build/hash.ts';
import { resolveRules } from '../build/level.ts';
import { migrateV1 } from '../build/migrate_v1.ts';
import { generateLevel } from './generate.ts';
import type { GenerateResult } from './generate.ts';
import type { LayoutOverrides } from './layout.ts';

/** Game ids as lane D seeds them (D-2 §3.4): Starter World v2 and Classic Starter (the v1 level ids are kept). */
export const STARTER_GAME = { id: 'game_world', title: 'Starter World', author: 'Starter World', license: 'CC0-1.0' } as const;
export const CLASSIC_GAME = { id: 'game_classic', title: 'Classic Starter', author: 'team', license: 'CC0-1.0' } as const;
export const STARTER_TIME = '2026-10-10T00:00:00Z';
/** v4 showcase (docs/v4/CONTRACTS_V4.md): one level per mode, with rules and v4 primitives (shared/starter/showcase). */
export const SHOWCASE_GAME = { id: 'game_showcase', title: 'draw.play Showcase', author: 'team', license: 'CC0-1.0' } as const;

/** The game a starter level belongs to and how its level ids read (Starter World: lvl_world_l1…). */
export interface StarterGame {
  id: string;
  author: string;
  license: string;
  prefix: string;
}
const WORLD_IDS: StarterGame = { id: STARTER_GAME.id, author: STARTER_GAME.author, license: STARTER_GAME.license, prefix: 'lvl_world_' };
export const SHOWCASE_IDS: StarterGame = { id: SHOWCASE_GAME.id, author: SHOWCASE_GAME.author, license: SHOWCASE_GAME.license, prefix: 'lvl_show_' };

export interface StarterOverrides extends LayoutOverrides {
  id?: string;
  seed?: number;
  edits?: EditOp[];
  designer_note?: string;
  rules?: Partial<GameRules>;
  /** v4: the level's own rules (compiled.logic) and mode, built into the level rather than the game's rules. */
  logic?: RuleV4[];
  mode?: GameMode;
}

export interface StarterBuilt {
  id: string;
  level: LevelV2;
  gen: GenerateResult;
}

export function starterLevelId(id: string): string {
  return `lvl_world_${id.toLowerCase()}`;
}

/** Build one Starter World level from its plan and overrides. */
export function buildStarterLevel(id: string, plan: LevelPlan, ov: StarterOverrides, order: number, game: StarterGame = WORLD_IDS): StarterBuilt {
  const rules = resolveRules({ version: 1, physics_profile: 'v2-standard', theme: plan.theme ?? 'sketchbook', ...(ov.rules ?? {}) });
  const seed = typeof ov.seed === 'number' ? ov.seed : 1000 + order;
  const gen = generateLevel(plan, rules, seed, { tier: 'faithful', overrides: ov, clamp: 'envelope', ink: 'marker', logic: ov.logic ?? null, mode: ov.mode ?? null });
  const lv: LevelV2 = JSON.parse(JSON.stringify(gen.result.level));
  lv.id = `${game.prefix}${id.toLowerCase()}`;
  lv.version = 1;
  lv.game_id = game.id;
  lv.parent_id = null;
  lv.order_index = order;
  lv.title = gen.plan.title;
  lv.author = game.author;
  lv.created_at = STARTER_TIME;
  lv.license = game.license;
  lv.source = { ...lv.source, kind: 'prompt', prompt: null };
  lv.meta = { ...lv.meta, intent: gen.plan.kid_summary || null, safety: 'ok', core_version: lv.meta.core_version };
  if (lv.design) lv.design = { ...lv.design, designer_note: ov.designer_note ?? null, source: 'none' };
  lv.meta.level_hash = levelHash(lv);
  return { id, level: lv, gen };
}

function designOf(r: PlaytestReport): DesignBlock {
  return {
    tier: 'faithful', band: r.band, C: Math.round(Math.max(0, r.C) * 1000) / 1000, score: Math.max(0, Math.min(100, Math.round(r.score))),
    fastest_ms: Math.round(r.fastest_ms), par_ms: Math.round(r.par_ms), casual_clear_s: Math.round(r.casual_clear_s * 10) / 10,
    segments: r.segments.map((s) => ({ from: s.from, to: s.to, E: s.E, T_ms: Math.round(s.T_ms), F_s: s.F_s, actions: s.actions })),
    flags: r.flags, solvable: r.solvable, reach: {}, designer_note: null, source: 'none',
  };
}

/** Migrate one v1 fixture into the Classic Starter game. */
export function buildClassicLevel(v1: unknown, order: number): { level: LevelV2; report: PlaytestReport | null } {
  const lv = migrateV1(v1);
  lv.game_id = CLASSIC_GAME.id;
  lv.order_index = order;
  lv.license = CLASSIC_GAME.license;
  let report: PlaytestReport | null = null;
  try {
    report = analyze(lv, { mode: 'full', legacy_measure: true, tier: 'faithful' });
    lv.design = designOf(report);
  } catch {
    lv.design = null;
  }
  lv.meta.level_hash = levelHash(lv);
  return { level: lv, report };
}

/** The targets a level was authored for (§9 table), for the build log. */
export function starterTarget(id: string): (typeof STARTER.levels)[number] | null {
  return STARTER.levels.find((l) => l.id === id) ?? null;
}
