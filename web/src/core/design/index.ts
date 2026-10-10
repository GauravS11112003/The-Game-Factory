/** The designer: tiers, menu, model plan application and transfer, digests (lane B, §3.8). P0 stubs. */
import type { BuildInput, BuildResult, TierSet } from '../index.ts';
import type { Band, Candidate, DesignPlanJson, SceneGraph } from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export function buildTiers(i: Omit<BuildInput, 'tier'>, o: { deadlineMs: number; band?: Band }): TierSet {
  void i;
  void o;
  throw new NotImplemented('buildTiers');
}

export function candidates(base: BuildResult, o: { max: number }): Candidate[] {
  void base;
  void o;
  throw new NotImplemented('candidates');
}

export function applyPlan(i: Omit<BuildInput, 'tier'>, menu: Candidate[], plan: DesignPlanJson):
  TierSet & { rejected: { cid: string; why: string }[] } {
  void i;
  void menu;
  void plan;
  throw new NotImplemented('applyPlan');
}

export function transferPlan(plan: DesignPlanJson, oldMenu: Candidate[], newMenu: Candidate[], oldG: SceneGraph, newG: SceneGraph):
  { plan: DesignPlanJson; ratio: number; routeRolesChanged: boolean } {
  void plan;
  void oldMenu;
  void newMenu;
  void oldG;
  void newG;
  throw new NotImplemented('transferPlan');
}

export function digest(r: BuildResult, menu: Candidate[]): { graph_digest: string; level_digest: string; menu_rows: string } {
  void r;
  void menu;
  throw new NotImplemented('digest');
}
