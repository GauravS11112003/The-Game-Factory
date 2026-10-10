/**
 * Prompt-to-level and Starter World generator (lane B, §8.3, §9): beats → clamped plan → laid-out geometry →
 * blue-line draft InkDoc → verified build. `layoutPlan` and `keywordPlan` are the §11.3(b) API; `generateLevel`
 * adds the bot proof and the deterministic fixer; `inkIt` re-inks a draft in marker (K1, Starter World).
 */
import type { GameRules, InkDoc, LevelPlan } from '../types.gen.ts';
import { layoutDetailed } from './generate.ts';

export { keywordPlan, CANNED } from './keyword.ts';
export { generateLevel, inkIt, layoutDetailed, failingBeat } from './generate.ts';
export type { GenerateOptions, GenerateResult, PlanFix } from './generate.ts';
export { normalizePlan, clampBeat, shrinkBeat } from './beats.ts';
export type { Layout, LayoutOverrides, DrawSpec, Prim, Span } from './layout.ts';

/** §11.3(b) `layoutPlan`: a LevelPlan → the blue-line draft InkDoc (origin 'draft', exact labels). */
export function layoutPlan(plan: LevelPlan, rules: GameRules, seed: number): InkDoc {
  return layoutDetailed(plan, rules ?? { version: 1 }, Number.isFinite(seed) ? seed : 1).ink;
}
