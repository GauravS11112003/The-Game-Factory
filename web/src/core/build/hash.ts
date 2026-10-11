/**
 * level_hash (§2.5): "sha256:" + hex(sha256(canonical_json({world, rules, tiles, entities (gameplay fields only),
 * triggers}))). Art fields (sprite, origin) are excluded so a renderer change never invalidates runs.
 * Must match vision/app/spec/level.py level_hash().
 */
import type { LevelV2 } from '../types.gen.ts';
import { canonicalJson } from '../util/canonical.ts';
import { sha256Hex } from '../util/sha256.ts';

export const ENTITY_ART_FIELDS: readonly string[] = ['sprite', 'origin'];

export function gameplayView(level: LevelV2): Record<string, unknown> {
  const c = level.compiled;
  const entities = c.entities.map((e) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) if (!ENTITY_ART_FIELDS.includes(k)) out[k] = v;
    return out;
  });
  const view: Record<string, unknown> = { world: level.world, rules: level.rules, tiles: c.tiles, entities, triggers: c.triggers ?? [] };
  if (c.logic && c.logic.length) view.logic = c.logic; // v4: absent or empty keeps the v2 hash (CONTRACTS_V4 §2)
  return view;
}

export function levelHash(level: LevelV2): string {
  return 'sha256:' + sha256Hex(canonicalJson(gameplayView(level)));
}
