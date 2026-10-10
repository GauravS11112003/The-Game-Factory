/** Engine and render API (PLAN_V2 §11.3g): lane E provides, lane F consumes. */
import type { CellXY, LevelV2, Morph, RectCells, Replay } from '../core/types.gen.ts';
import type { InkStroke } from '../core/types.gen.ts';
import type { GameRules } from '../core/types.gen.ts';

export interface OverlaySpec {
  editGhosts?: { before: RectCells[]; after: RectCells[]; kind: 'move' | 'appear' | 'vanish' }[];
  botPath?: CellXY[];
  flags?: { at: CellXY; code: string }[];
  reachHalo?: CellXY[];
}

export type GameEvent = 'ready' | 'win' | 'die' | 'coin' | 'big_coin' | 'checkpoint' | 'entity_error';

export interface MountOptions {
  mode: 'play' | 'preview' | 'test' | 'thumbnail';
  rules: GameRules;
  startAt?: CellXY;
  ghosts?: { replay: Replay; strokes?: InkStroke[]; label: string }[]; // ≤ 3
  overlays?: OverlaySpec; // edit ghosts, bot path, flags, reach halo; in-scene
  audio?: boolean;
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
}
