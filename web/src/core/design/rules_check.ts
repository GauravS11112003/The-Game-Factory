/**
 * The rules re-verify helper (§8.2 "Apply to all levels"): before a game's rules change, dry-run the bot over every
 * level under the new rules. Gameplay geometry does not depend on the rules (tiles and entities compile from the
 * scene), so the check re-analyzes each compiled level with the new physics profile and abilities. A level that was
 * solvable and no longer is gets listed with the reason in kid words (`rules.needs_run`, `rules.needs_double_jump`,
 * else `rules.becomes_unsolvable`), and — when the level carries its ink — the designer tries a Faithful repair
 * under the new rules and reports the repair edits (shown per level), so the creator can accept them or cancel.
 * Levels already unsolvable under their own rules are not blamed on the change.
 */
import type { AffectedLevel, EditRecord, GameRules, InkDoc, LevelV2, LibraryType, SceneGraph } from '../types.gen.ts';
import { analyze } from '../bot/index.ts';
import { build } from '../build/build.ts';
import { levelHash } from '../build/hash.ts';
import { resolveRules } from '../build/level.ts';
import { levelLogic } from '../logic/index.ts';
import { perceiveHeuristic } from '../scene/perceive.ts';

function inkOfLevel(lv: LevelV2): InkDoc | null {
  const li = lv.ink;
  if (!li?.strokes?.length) return null;
  return {
    v: 2, source: lv.source.kind, world: { screens: lv.world.screens, w: lv.world.w, h: 27 }, strokes: li.strokes,
    components: li.components ?? [], character: li.character ?? null, typed_rules: li.typed_rules ?? [], rules_ink: li.rules_ink ?? [],
    sheets: (lv.source.sheets ?? []).map((s) => ({ index: s.index, photo_url: s.photo_url ?? null, qr: s.qr ?? null, warnings: [] })),
    noise: li.noise ?? { count: 0 }, parent: null,
  };
}

function solvableUnder(lv: LevelV2, rules: GameRules): boolean {
  try {
    return analyze({ ...lv, rules }, { mode: 'fast' }).solvable;
  } catch {
    return false;
  }
}

function reasonFor(before: GameRules, after: GameRules): string {
  const a0 = before.abilities ?? {};
  const a1 = after.abilities ?? {};
  if (a0.run !== false && a1.run === false) return 'rules.needs_run';
  if (a0.double_jump && !a1.double_jump) return 'rules.needs_double_jump';
  return 'rules.becomes_unsolvable';
}

/** Rebuild a level's Faithful tier under new rules with repairs on; null when the level carries no ink. */
export function repairUnder(lv: LevelV2, rules: GameRules): { solvable: boolean; repairs: EditRecord[]; level: LevelV2 } | null {
  const ink = inkOfLevel(lv);
  if (!ink) return null;
  // migrated levels keep their migration objects as G0; drawn levels are re-perceived (the kid's labels and the
  // model's understanding live in the edit records, which the rebuild honours by id)
  const graph0: SceneGraph = lv.source.kind === 'migrated' && lv.objects?.length ? { objects: lv.objects, setpieces: lv.setpieces ?? [] } : perceiveHeuristic(ink, { library: lv.embedded_library ?? [], parent: null });
  const edits = (lv.edits ?? []).filter((e) => e.status === 'applied' || e.status === 'undone');
  // v4: the level keeps its own rules (CONTRACTS_V4 §2.4)
  const r = build({ ink, graph0, edits, rules, library: lv.embedded_library ?? [], parent: null, tier: 'faithful', repairUnsolvable: true, seed: 1, logic: levelLogic(lv) });
  const repairs = r.edits.filter((e) => e.class === 'R' && e.status === 'applied' && (e.by === 'auto' || e.by === 'greedy'));
  return { solvable: r.report.solvable, repairs, level: r.level };
}

/** Dry-run new game rules over a game's levels (`POST /api/v2/games/{id}/rules/check`). */
export function rulesCheck(levels: readonly LevelV2[], rulesIn: GameRules, o: { repair?: boolean } = {}): { affected: AffectedLevel[] } {
  const rules = resolveRules(rulesIn);
  const affected: AffectedLevel[] = [];
  for (const lv of levels ?? []) {
    if (!lv || !lv.compiled) continue;
    const before = resolveRules(lv.rules);
    const wasOk = lv.design?.solvable ?? solvableUnder(lv, before);
    if (!wasOk) continue;
    if (solvableUnder(lv, rules)) continue;
    const row: AffectedLevel = { level_id: lv.id, reason_key: reasonFor(before, rules), repairable: null, repairs: [], level_hash: null };
    if (o.repair !== false) {
      const fix = repairUnder(lv, rules);
      if (fix) {
        row.repairable = fix.solvable;
        row.repairs = fix.solvable ? fix.repairs : [];
        row.level_hash = fix.solvable ? levelHash(fix.level) : null;
      } else row.repairable = false;
    }
    affected.push(row);
  }
  return { affected };
}

/**
 * "Update levels to v<n>" (§8.1 versioning): a library type got a new immutable version. Every level pinning an older
 * version of it is rebuilt with the new version (its strokes' `lib`, its `use_library` edits and its embedded copy)
 * and re-verified; the ones that would break are listed (`library.update_breaks`), the others come back rebuilt so the
 * caller can save them as new level versions. Nothing changes silently: a published level keeps its pinned version
 * until this runs.
 */
export function libraryUpdateCheck(levels: readonly LevelV2[], type: LibraryType, library: readonly LibraryType[] = []): { updated: { level_id: string; level: LevelV2 }[]; broken: AffectedLevel[] } {
  const updated: { level_id: string; level: LevelV2 }[] = [];
  const broken: AffectedLevel[] = [];
  for (const lv of levels ?? []) {
    const uses = (lv.objects ?? []).some((o) => o.lib?.type_id === type.id && o.lib.version < type.version);
    if (!uses) continue;
    const ink0 = inkOfLevel(lv);
    if (!ink0) continue;
    const bump = <T extends { lib?: { type_id: string; version: number } | null }>(x: T): T => (x.lib && x.lib.type_id === type.id ? { ...x, lib: { type_id: type.id, version: type.version } } : x);
    const ink: InkDoc = { ...ink0, strokes: ink0.strokes.map(bump) };
    const edits: EditRecord[] = (lv.edits ?? []).filter((e) => e.status === 'applied' || e.status === 'undone').map((e) => {
      if (e.op.op !== 'use_library' || e.op.type_id !== type.id) return e;
      return { ...e, op: { ...e.op, version: type.version } };
    });
    const lib = [...(lv.embedded_library ?? []).filter((t) => t.id !== type.id), ...library.filter((t) => t.id !== type.id), type];
    const rules = resolveRules(lv.rules);
    const graph0: SceneGraph = perceiveHeuristic(ink, { library: lib, parent: null });
    const tier = lv.design?.tier ?? 'faithful';
    const r = build({ ink, graph0, edits, rules, library: lib, parent: null, tier, repairUnsolvable: tier === 'faithful', seed: 1, logic: levelLogic(lv) });
    if (!r.report.solvable) broken.push({ level_id: lv.id, reason_key: 'library.update_breaks', repairable: false, repairs: [], level_hash: null });
    else {
      const next: LevelV2 = { ...r.level, id: lv.id, version: lv.version + 1, game_id: lv.game_id ?? null, parent_id: lv.parent_id ?? null, order_index: lv.order_index ?? 0, title: lv.title, author: lv.author, created_at: lv.created_at, license: lv.license };
      next.meta = { ...next.meta, level_hash: levelHash(next) };
      updated.push({ level_id: lv.id, level: next });
    }
  }
  return { updated, broken };
}
