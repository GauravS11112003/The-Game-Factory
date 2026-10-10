/**
 * The draw-a-level core: one pure-TS implementation of everything after strokes (PLAN_V2 D1, §11.3b).
 * Runs in the browser (Web Worker) and in Node workers (`node web/src/core/worker/main.ts`) with no build step.
 * Every lane implements its functions in its own directory; this file only declares and re-exports the API.
 */
import type {
  Candidate, EditRecord, GameRules, InkDoc, LevelPlan, LevelV2, LibraryType, MessageRef, PlaytestReport, SceneGraph, Tier,
} from './types.gen.ts';

export type * from './types.gen.ts'; // InkDoc, SceneGraph, EditRecord, LevelV2, PlaytestReport, Candidate, GameRules, LibraryType, Replay, …
export type { ArtDoc, ArtLayer, ArtPath, ArtStyle } from './art/types.ts';
export type { CameraState, EntityView, PhysicsProfile, PlayerView, Sim, SimEvent, SimSnapshot, SimView } from './sim/types.ts';
export type { AnalyzeOptions } from './bot/index.ts';
/** The plan type names used in the API signatures (§11.3b). */
export type LevelPlanJson = LevelPlan;

export { SPEC_VERSION } from './types.gen.ts';
export { CORE_VERSION } from './util/version.ts';
export { NotImplemented, isNotImplemented } from './util/errors.ts';

// ---- Lane B ----
export interface BuildInput {
  ink: InkDoc;
  graph0: SceneGraph;
  edits: EditRecord[];
  rules: GameRules;
  library: LibraryType[];
  parent: LevelV2 | null;
  tier: Tier;
  repairUnsolvable: boolean;
  seed: number;
}
export interface BuildResult {
  graph: SceneGraph;
  level: LevelV2;
  report: PlaytestReport;
  edits: EditRecord[];
  rejected: EditRecord[];
  ms: number;
}
export interface TierSet {
  faithful: BuildResult;
  polished: BuildResult;
  normal: BuildResult;
  hard: BuildResult;
  reach: Record<'polished' | 'normal' | 'hard', boolean>;
  why?: MessageRef;
  menu: Candidate[];
}
export { inkFromStrokes } from './ink/index.ts';
/** Lane B helpers beyond §11.3(b) (additive): components/features for any InkDoc, offline asks, Fix-it menus. */
export { computeComponents, ensureComponents } from './ink/index.ts';
export { heuristicAsks } from './scene/merge.ts';
export { matchSymbol, mergePerception, parseRules, perceiveHeuristic, remixDiff } from './scene/index.ts';
export { build, levelHash, migrateV1, validateLevel } from './build/index.ts';
export { applyPlan, buildTiers, candidates, digest, transferPlan } from './design/index.ts';
export { keywordPlan, layoutPlan } from './generate/index.ts';
/** Lane B P5 helpers beyond §11.3(b) (additive): the verified generator, "Ink it", the rules re-verify dry run. */
export { generateLevel, inkIt, layoutDetailed } from './generate/index.ts';
export type { GenerateOptions, GenerateResult, LayoutOverrides } from './generate/index.ts';
export { libraryUpdateCheck, rulesCheck, repairUnder } from './design/rules_check.ts';
export { withParentInk } from './scene/remix.ts';

// ---- Lane A ----
export { PROFILES, profileHash } from './sim/profiles.ts';
export { cameraStep, createSim } from './sim/index.ts';
export { analyze } from './bot/index.ts';
export { decodeReplay, encodeReplay, verifyRun } from './replay/index.ts';
/** Lane A helpers beyond §11.3(b) (A-2): ghosts, recording, detailed verdicts, the rules-aware envelope, local re-solve. */
export { GhostTrack, ReplayRecorder, ghostTrack, replayOfTrace, verifyRunDetail } from './replay/index.ts';
export { jumpArcs, localReach, reachFor } from './bot/index.ts';

// ---- Lane E ----
export { artToSvg, buildArt, extractRig } from './art/index.ts';

/** Every §11.3(b) function, by name; `cli.ts selftest` checks each is exported and reports stubs. */
export const API_FUNCTIONS = [
  'inkFromStrokes', 'perceiveHeuristic', 'mergePerception', 'parseRules', 'build', 'buildTiers', 'candidates', 'applyPlan',
  'transferPlan', 'digest', 'layoutPlan', 'keywordPlan', 'remixDiff', 'matchSymbol', 'migrateV1', 'levelHash',
  'validateLevel', 'createSim', 'cameraStep', 'analyze', 'encodeReplay', 'decodeReplay', 'verifyRun', 'buildArt',
  'artToSvg', 'extractRig',
] as const;
/** Implemented for real at P0 (§11.4 P0 item 2); everything else throws NotImplemented('<fn>'). */
export const P0_REAL = ['levelHash', 'validateLevel', 'encodeReplay', 'decodeReplay'] as const;
