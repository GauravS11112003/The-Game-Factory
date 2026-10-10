/** core.validateLevel(): the published level schema (embedded in types.gen.ts) plus the semantic checks
 * JSON Schema cannot express (w = 48·screens, tile rows decode to world.w × world.h). */
import { LEVEL_SCHEMA } from '../types.gen.ts';
import type { LevelV2 } from '../types.gen.ts';
import { SchemaValidator } from '../util/schema.ts';
import { decodeRow } from './tiles.ts';

let validator: SchemaValidator | null = null;

export function validateLevel(x: unknown): { ok: true; level: LevelV2 } | { ok: false; errors: string[] } {
  validator ??= new SchemaValidator(LEVEL_SCHEMA);
  const schemaErrors = validator.validate(x);
  if (schemaErrors.length) return { ok: false, errors: schemaErrors.map((e) => `${e.path}: ${e.message}`) };
  const level = x as LevelV2;
  const errors: string[] = [];
  const { screens, w } = level.world;
  const h = level.world.h ?? 27;
  if (w !== 48 * screens) errors.push(`/world/w: must be 48*screens (${48 * screens}), got ${w}`);
  const rows = level.compiled.tiles.rows;
  if (rows.length !== h) errors.push(`/compiled/tiles/rows: ${rows.length} rows, world.h is ${h}`);
  rows.forEach((row, i) => {
    const n = decodeRow(row).length;
    if (n !== w) errors.push(`/compiled/tiles/rows/${i}: decodes to ${n} cells, world.w is ${w}`);
  });
  return errors.length ? { ok: false, errors } : { ok: true, level };
}
