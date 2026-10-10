/** Messages between the app and its browser core worker (§1.3: canvas editing, live chips, reach halo, ▶, local toggles). */
import type {
  Behavior, CellXY, EditRecord, GameRules, InkDoc, InkStroke, LevelPlan, LevelV2, LibraryType, MessageRef, ParentRef,
  PlaytestReport, RectCells, Replay, Role, RunClaim, Candidate, SceneGraph, Tier,
} from '../core/types.gen.ts';

export interface InkParams {
  strokes: InkStroke[];
  screens: number;
  character: InkStroke[];
  rules: { text: string; strokeId: string | null }[];
  parent: ParentRef | null;
}

export interface HintsParams extends InkParams {
  rev: number;
  rules_game: GameRules;
  library: LibraryType[];
  /** The published parent of a remix (perception matches remixed objects to it, §6.5). */
  parentLevel?: LevelV2 | null;
}

export interface ObjHint {
  id: string;
  role: Role;
  conf: number;
  strokes: string[];
  bbox: RectCells | null;
  alt: Role[];
  pinned: boolean; // kid label, stamp or library: conf 1.0
  behavior: Behavior | null;
  partOf: string | null;
}

export interface TooFar {
  from: CellXY;
  to: CellXY;
  label: 'too_far' | 'needs_run_up';
  blocking: boolean; // true: nobody can make it yet
}

export interface SnapGhost {
  id: string;
  kind: 'spikes' | 'enemy';
  from: RectCells;
  to: RectCells;
  facing?: 'up' | 'down' | 'left' | 'right';
}

export interface HintsResult {
  rev: number;
  ms: number;
  objects: ObjHint[];
  reach: CellXY[]; // feet positions (cells) of reachable standing spots
  solvable: boolean;
  goalStrokes: string[];
  start: CellXY | null;
  tooFar: TooFar[];
  snaps: SnapGhost[];
  level: LevelV2;
  ink: InkDoc;
  report: PlaytestReport;
}

export interface LocalBuildParams {
  ink: InkDoc;
  graph0: SceneGraph;
  edits: EditRecord[];
  rules: GameRules;
  library: LibraryType[];
  tier: Tier;
  seed: number;
}

export interface LocalBuildResult {
  level: LevelV2;
  report: PlaytestReport;
  edits: EditRecord[];
  rejected: EditRecord[];
  graph: SceneGraph;
  ms: number;
}

export interface MenuResult {
  menu: Candidate[];
}

/** The bot on one level (the #/dev page, rules and library dry runs). */
export interface AnalyzeParams {
  level: LevelV2;
  mode: 'fast' | 'full';
}

export interface AnalyzeResult {
  report: PlaytestReport;
  ms: number;
}

/** A level the dry runs re-verify (rules check §8.2, "Update levels to vN" §8.1). */
export interface DryLevel {
  id: string;
  title: string;
  level: LevelV2;
}

export interface RulesCheckParams {
  levels: DryLevel[];
  rules: GameRules; // the new game rules
  /** Rebuild each affected level from its ink with Faithful repairs and report whether that saves it. */
  repair: boolean;
}

export interface DryRow {
  level_id: string;
  title: string;
  before: boolean; // solvable as published
  after: boolean; // solvable under the change
  reason_key: string | null; // why it breaks (messages.json), null when it still works
  /** Faithful repairs the designer would make (kid sentences), when `repair` was asked. */
  repairs: MessageRef[];
  repaired: boolean | null; // solvable after the repairs; null when not tried
  skipped: boolean; // the level has no ink to rebuild from
}

export interface LibraryCheckParams {
  levels: DryLevel[];
  type: LibraryType; // the new version
  library: LibraryType[]; // the game's library (latest versions)
}

export interface PlanParams {
  prompt: string;
  screens: number;
  rules: GameRules;
  seed: number;
  /** A plan from the server (PLAN call); otherwise the offline keyword planner picks one. */
  plan?: LevelPlan | null;
}

export interface PlanResult {
  plan: LevelPlan;
  ink: InkDoc;
  level: LevelV2 | null;
  solvable: boolean | null;
  /** Beats the deterministic fixer made easier (or rests it inserted) so the draft can be finished. */
  fixes: number;
  ms: number;
}

export interface RemixParams {
  parent: LevelV2;
  ink: InkDoc;
}

export interface RemixResult {
  /** Stroke ids of ink the remix diff calls new (unmatched to any parent object). */
  added: string[];
  matched: number;
}

/** Re-simulate a replay (verifyRun): before submitting a run, and for a challenger's real numbers (§8.4). */
export interface VerifyParams {
  level: LevelV2;
  replay: Replay;
  claimed?: RunClaim | null;
}

export interface VerifyResult {
  finished: boolean;
  accepted: boolean;
  reason: string;
  time_ms: number;
  deaths: number;
  coins: number;
  big_coins: number;
  stamps: string[];
}

export type CoreMethod = 'ink' | 'hints' | 'build' | 'menu' | 'hash' | 'graph0' | 'analyze' | 'rulesCheck' | 'libraryCheck' | 'plan' | 'remix' | 'verify';

export interface CoreRequest {
  id: number;
  method: CoreMethod;
  params: unknown;
}

export interface CoreErrorInfo {
  code: 'not_implemented' | 'internal';
  fn?: string;
  message: string;
}

export type CoreResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: CoreErrorInfo };
