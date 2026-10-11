/** What the game workspace's inspector panels share (lane D): the game, its rules and library, the chosen level. */
import type { GameRules, LevelV2, LibraryType } from '../../core/types.gen.ts';
import type { GameCard, LevelCard } from '../api.ts';
import type { GameTeam } from '../collab/roles.ts';
import { DEFAULT_RULES } from '../rules.ts';

export interface GwCtx {
  readonly game: GameCard;
  readonly team: GameTeam | null;
  rules(): GameRules;
  /** After a save: keep the server's answer and redraw what shows the rules. */
  setRules(r: GameRules): void;
  library(): LibraryType[];
  setLibrary(lib: LibraryType[]): void;
  /** The level picked in the left column, and its JSON once loaded. */
  levelCard(): LevelCard | null;
  level(): LevelV2 | null;
  /** Open another inspector tab. */
  show(tab: string): void;
  gone(): boolean;
}

/** A game's rules with every default filled in (the rules sheet does the same). */
export function withDefaults(r: GameRules | null | undefined): GameRules {
  const base = r ?? DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...base, abilities: { ...DEFAULT_RULES.abilities, ...(base.abilities ?? {}) } };
}
