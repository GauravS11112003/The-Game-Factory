/** Prompt-to-level layout and the offline keyword planner (lane B, §8.3); also authors Starter World. P0 stubs. */
import type { GameRules, InkDoc, LevelPlan } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export function layoutPlan(plan: LevelPlan, rules: GameRules, seed: number): InkDoc {
  void plan;
  void rules;
  void seed;
  throw new NotImplemented('layoutPlan');
}

export function keywordPlan(prompt: string, screens: number): LevelPlan {
  void prompt;
  void screens;
  throw new NotImplemented('keywordPlan');
}
