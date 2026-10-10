/** Perception: grouping, grammar, merge, rules parser, remix diff, symbol match (lane B, §3.3, §6.5, §8.1). P0 stubs. */
import type {
  AskCard, EditRecord, InkDoc, InkStroke, LevelV2, LibraryType, PerceptionJson, SceneGraph, Setpiece,
} from '../types.gen.ts';
import { NotImplemented } from '../util/errors.ts';

export function perceiveHeuristic(ink: InkDoc, ctx: { library: LibraryType[]; parent: LevelV2 | null }): SceneGraph {
  void ink;
  void ctx;
  throw new NotImplemented('perceiveHeuristic');
}

export function mergePerception(g0: SceneGraph, perceptions: PerceptionJson[], ink: InkDoc):
  { edits: EditRecord[]; asks: AskCard[]; setpieces: Setpiece[]; dropped: string[]; discarded: boolean } {
  void g0;
  void perceptions;
  void ink;
  throw new NotImplemented('mergePerception');
}

export function parseRules(text: string, g: SceneGraph): { edits: EditRecord[]; asks: AskCard[] } {
  void text;
  void g;
  throw new NotImplemented('parseRules');
}

export function remixDiff(parent: LevelV2, ink: InkDoc): { matched: Record<number, string>; added: number[] } {
  void parent;
  void ink;
  throw new NotImplemented('remixDiff');
}

export function matchSymbol(glyph: InkStroke[], lib: LibraryType[]): { type_id: string; version: number; dist: number } | null {
  void glyph;
  void lib;
  throw new NotImplemented('matchSymbol');
}
