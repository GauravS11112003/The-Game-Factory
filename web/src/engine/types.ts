/** Engine and render API (PLAN_V2 §11.3g): lane E provides, lane F consumes. Additions beyond §11.3g are optional. */
import type { CellXY, LevelV2, Morph, RectCells, Replay, Theme } from '../core/types.gen.ts';
import type { InkStroke } from '../core/types.gen.ts';
import type { GameRules } from '../core/types.gen.ts';

export interface OverlaySpec {
  editGhosts?: { before: RectCells[]; after: RectCells[]; kind: 'move' | 'appear' | 'vanish' }[];
  botPath?: CellXY[];
  flags?: { at: CellXY; code: string }[];
  reachHalo?: CellXY[];
}

export type GameEvent = 'ready' | 'win' | 'die' | 'coin' | 'big_coin' | 'checkpoint' | 'entity_error';

/** Who a ghost is (label colour, sounds); inferred from the label ("bot") when omitted. */
export type GhostKind = 'pb' | 'you' | 'leader' | 'challenger' | 'bot' | 'other';

export interface GhostOption {
  replay: Replay;
  /** The runner's character strokes (drawn as a pencil copy). */
  strokes?: InkStroke[];
  label: string;
  /** The runner's character PNG (GET /api/v2/runs/{id} → sprite_url), pencilized; used when no strokes are given. */
  sprite_url?: string | null;
  kind?: GhostKind;
  /** 'race' (default in play / test: starts with your first input) or 'free' (default in preview: runs at 1×, loops). */
  sync?: 'race' | 'free';
}

export interface MountOptions {
  mode: 'play' | 'preview' | 'test' | 'thumbnail';
  /** The game's rules: `theme` and `music` here win over the level's resolved snapshot (cosmetic only). */
  rules: GameRules;
  startAt?: CellXY;
  ghosts?: GhostOption[]; // ≤ 3
  overlays?: OverlaySpec; // edit ghosts, bot path, flags, reach halo; in-scene
  audio?: boolean;
  /** The level's music loop (default: rules.music, else on). The player's own ♪ setting still applies. */
  music?: boolean;
  /** "My original sketch" underlay at 15% (paper levels with sheet photos). Default off. */
  underlay?: boolean;
  reducedMotion?: boolean;
  record?: boolean;
  debug?: boolean;
}

export interface GameHandle {
  // 'win' payload: { frames, time_ms, deaths, coins, big_coins_banked, replay }; 'die': { cause, x, y, frame, segment }
  on(ev: GameEvent, fn: (p: any) => void): void;
  swapLevel(level: LevelV2, o?: { morphs?: Morph[]; when?: 'now' | 'safe' }): void; // 'safe' = next respawn/pause/goal
  setOverlays(o: OverlaySpec): void;
  pause(): void;
  resume(): void;
  restart(from?: 'start' | 'checkpoint'): void;
  replay(): Replay;
  destroy(): void;
  // ---- additions (lane E wave 2) ----
  /** Swap the paper theme in place (the theme picker); the run continues. */
  setTheme(theme: Theme): void;
  /** Apply the cosmetic part of new rules (theme, music) without remounting. */
  setRules(rules: Partial<GameRules>): void;
  /** The level's music loop on / off. */
  setMusic(on: boolean): void;
  /** The sketch underlay on / off; resolves false when the level has no sheet photos. */
  setUnderlay(on: boolean): boolean;
  /** The current frame as a PNG (e.g. the win moment for a share card); null when it can't be read. */
  snapshot(o?: { hud?: boolean }): Promise<Blob | null>;
  /** The ghosts' live status. */
  ghosts(): GhostResult[];
}

export interface GhostResult {
  label: string;
  kind: GhostKind;
  finished: boolean;
  time_ms: number | null; // the ghost's speedrun clock at its goal
  deaths: number;
}

/** 'win' payload: emitted once, after the 400 ms slow-motion win moment (the results card is the app's). */
export interface WinPayload {
  frames: number;
  time_ms: number; // the speedrun clock: sim frames from the first input to the goal
  deaths: number;
  coins: number;
  big_coins_banked: number;
  replay: Replay;
  rewound: number; // > 0 when "restart from checkpoint" rewound time (no sim kill yet): keep it off boards
  /** Race ghosts when you crossed the line; `beat` = you finished first (a ghost still running counts as beaten). */
  ghosts: (GhostResult & { beat: boolean })[];
}

/** 'die' payload. */
export interface DiePayload {
  cause: string;
  x: number;
  y: number;
  frame: number;
  segment: string; // the checkpoint the run was in ('start' before any)
}

/** 'ready' payload. */
export interface ReadyPayload {
  sim: 'core' | 'static'; // 'static' until lane A's createSim lands (←/→ pan the camera)
  reason: string | null;
  render_scale: number;
  boil: boolean;
  mode: MountOptions['mode'];
  theme: Theme;
  /** True when the level has sheet photos for the sketch underlay. */
  underlay: boolean;
}
