/**
 * game.json: what "Export to Phaser" writes next to index.html (vision/app/routers/v2/export_phaser.py) and what the
 * standalone player reads. Every image path inside a level is relative to the page ("assets/…"), so the folder can be
 * hosted anywhere. The player is tolerant: a hand-edited game.json with missing fields still plays.
 */
import type { GameRules, LevelV2 } from '../core/types.gen.ts';

export const GAME_FORMAT = 'drawplay-game';

export interface ExportedLevel {
  id: string;
  title: string;
  author: string;
  /** A level id to clear before this one opens (bonus levels), else null. */
  unlock_after: string | null;
  /** A bonus level: never on the main path, opens after `unlock_after`. */
  bonus: boolean;
  /** The full level (LevelV2, `dal-level` schema 2), with its `skin` and `embedded_library`. */
  level: LevelV2;
}

export interface ArtCredit {
  by: string;
  tool: string | null;
  label: string | null;
  level: string | null;
  prompt?: string | null;
}

export interface LevelCredit {
  index: number;
  id: string;
  title: string;
  author: string;
  license: string | null;
}

export interface LibraryCredit {
  name: string;
  author: string;
  kind: string | null;
}

export interface ContributorCredit {
  name: string;
  /** owner | maintainer | contributor (draw.play collaboration), when known. */
  role: string | null;
  levels: number;
  creatures: number;
  art: number;
  quests: number;
  reviews: number;
}

export interface ExportedCredits {
  /** Everyone who made a level, the game's author first. */
  authors: string[];
  levels: LevelCredit[];
  art: ArtCredit[];
  library: LibraryCredit[];
  contributors: ContributorCredit[];
}

export interface ExportedGame {
  format: typeof GAME_FORMAT;
  v: number;
  exported_at: string | null;
  game: { id: string; title: string; author: string; created_at: string | null };
  /** The game's rules (theme, music, lives…). The theme and music here win over each level's snapshot. */
  rules: GameRules | null;
  /** The levels in play order. */
  levels: ExportedLevel[];
  credits: ExportedCredits;
}

const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : d);
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : Array.isArray(x) ? x.length : 0);
const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);

/** A game.json (or a hand-made one) into a well-formed ExportedGame. Throws when there is nothing playable. */
export function normalizeGame(raw: unknown): ExportedGame {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const g = (j.game && typeof j.game === 'object' ? j.game : {}) as Record<string, any>;
  // a bare array of levels, or {levels: [LevelV2 | ExportedLevel]}, both work
  const rawLevels = Array.isArray(raw) ? raw : arr(j.levels);
  const levels: ExportedLevel[] = [];
  for (const x of rawLevels) {
    const lv = (x && typeof x === 'object' && 'level' in x ? x.level : x) as LevelV2 | null;
    if (!lv || typeof lv !== 'object' || !lv.compiled || !lv.world) continue;
    levels.push({
      id: str(x.id, str(lv.id, `level${levels.length + 1}`)),
      title: str(x.title, str(lv.title)),
      author: str(x.author, str(lv.author)),
      unlock_after: typeof x.unlock_after === 'string' ? x.unlock_after : null,
      bonus: !!x.bonus,
      level: lv,
    });
  }
  if (!levels.length) throw new Error('no levels');
  const c = (j.credits && typeof j.credits === 'object' ? j.credits : {}) as Record<string, any>;
  const authors = arr(c.authors).filter((a): a is string => typeof a === 'string' && !!a);
  for (const l of levels) if (l.author && !authors.includes(l.author)) authors.push(l.author);
  return {
    format: GAME_FORMAT,
    v: num(j.v) || 1,
    exported_at: typeof j.exported_at === 'string' ? j.exported_at : null,
    game: {
      id: str(g.id) || levels[0].level.game_id || 'game',
      title: str(g.title) || levels[0].title,
      author: str(g.author) || levels[0].author,
      created_at: typeof g.created_at === 'string' ? g.created_at : null,
    },
    rules: j.rules && typeof j.rules === 'object' ? (j.rules as GameRules) : null,
    levels,
    credits: {
      authors,
      levels: arr(c.levels).length
        ? arr(c.levels).map((l, i) => ({ index: num(l?.index) || i + 1, id: str(l?.id), title: str(l?.title), author: str(l?.author), license: typeof l?.license === 'string' ? l.license : null }))
        : levels.map((l, i) => ({ index: i + 1, id: l.id, title: l.title, author: l.author, license: l.level.license ?? null })),
      art: arr(c.art).filter((a) => a && typeof a.by === 'string').map((a) => ({
        by: a.by, tool: typeof a.tool === 'string' ? a.tool : null, label: typeof a.label === 'string' ? a.label : null,
        level: typeof a.level === 'string' ? a.level : null, prompt: typeof a.prompt === 'string' ? a.prompt : null,
      })),
      library: arr(c.library).filter((t) => t && typeof t.name === 'string').map((t) => ({ name: t.name, author: str(t.author), kind: typeof t.kind === 'string' ? t.kind : null })),
      contributors: arr(c.contributors).filter((p) => p && typeof p.name === 'string').map((p) => ({
        name: p.name, role: typeof p.role === 'string' ? p.role : null,
        levels: num(p.levels), creatures: num(p.creatures), art: num(p.art), quests: num(p.quests), reviews: num(p.reviews),
      })),
    },
  };
}
