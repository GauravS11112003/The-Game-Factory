/**
 * Migration from v1 (§2.6, `web/src/core/build/migrate_v1.ts`), idempotent. The compiled tiles copy the v1 grid
 * exactly (so the reachable set under `v1-classic` is unchanged): '1' → '#'; a '2' run with a solid neighbour
 * becomes a spike strip on that face (entity, never tile); other '2' cells become legacy 'X'. Entities are typed
 * (bounce_pad → spring 1.0; zero-length mover paths are dropped with a warning; patrolling enemies become
 * horizontal flyers, so they play exactly as before with no gravity). Terrain is re-synthesized as `migrated` ink
 * strokes + objects (one per maximal top-exposed run, thin stacks as walls) so the level can be remixed in v2.
 */
import { WORLD } from '../params.ts';
import type {
  CellXY, Entity, InkComponent, InkStroke, LevelV2, MessageRef, SceneObject, Trigger,
} from '../types.gen.ts';
import { computeComponents } from '../ink/index.ts';
import { CORE_VERSION } from '../util/version.ts';
import { levelHash } from './hash.ts';
import { resolveRules } from './level.ts';
import { encodeRow } from './tiles.ts';
import { validateLevel } from './validate.ts';

type Any = Record<string, unknown>;
type V1Entity = { id: string; type: string; x?: number | null; y?: number | null; bbox?: number[] | null; path?: number[][] | null; speed?: number | null; patrol?: { dx: number; speed: number } | null; strength?: number | null; opens?: string | null };

const W = WORLD.screen_w;
const H = WORLD.h;

function isV2(x: Any): boolean {
  return x.format === 'dal-level' && x.schema_version === 2;
}

export function migrateV1(v1: unknown): LevelV2 {
  const src = (v1 ?? {}) as Any;
  if (isV2(src)) {
    const r = validateLevel(src);
    if (r.ok) return r.level;
    throw new Error(`migrateV1: not a valid v2 level: ${r.errors[0]}`);
  }
  const grid = (src.grid as Any | undefined)?.rows as string[] | undefined;
  if (!Array.isArray(grid) || grid.length !== H || grid.some((r) => typeof r !== 'string' || r.length !== W)) throw new Error('migrateV1: v1 grid must be 27 rows of 48 chars');
  const cells = grid.map((r) => r.split(''));
  const out: string[][] = cells.map((r) => r.map((c) => (c === '1' ? '#' : '.')));
  const warnings: MessageRef[] = [];
  const entities: Entity[] = [];
  const strips: { id: string; face: 'top' | 'bottom' | 'left' | 'right'; x0: number; x1: number; y: number }[] = [];
  const hz = cells.map((r) => r.map((c) => c === '2'));
  const solid = (c: number, r: number): boolean => r >= 0 && r < H && c >= 0 && c < W && cells[r][c] === '1';
  // horizontal '2' runs on a top or bottom face
  for (let r = 0; r < H; r++) {
    let c = 0;
    while (c < W) {
      if (!hz[r][c]) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < W && hz[r][c]) c++;
      const run = Array.from({ length: c - c0 }, (_, k) => c0 + k);
      if (run.every((x) => solid(x, r + 1))) {
        strips.push({ id: `spk${strips.length + 1}`, face: 'top', x0: c0, x1: c, y: r + 1 });
        for (const x of run) hz[r][x] = false;
      } else if (run.every((x) => solid(x, r - 1))) {
        strips.push({ id: `spk${strips.length + 1}`, face: 'bottom', x0: c0, x1: c, y: r });
        for (const x of run) hz[r][x] = false;
      }
    }
  }
  // vertical '2' runs on a left or right face
  for (let c = 0; c < W; c++) {
    let r = 0;
    while (r < H) {
      if (!hz[r][c]) {
        r++;
        continue;
      }
      const r0 = r;
      while (r < H && hz[r][c]) r++;
      const run = Array.from({ length: r - r0 }, (_, k) => r0 + k);
      if (run.every((y) => solid(c - 1, y))) {
        strips.push({ id: `spk${strips.length + 1}`, face: 'right', x0: r0, x1: r, y: c });
        for (const y of run) hz[y][c] = false;
      } else if (run.every((y) => solid(c + 1, y))) {
        strips.push({ id: `spk${strips.length + 1}`, face: 'left', x0: r0, x1: r, y: c + 1 });
        for (const y of run) hz[y][c] = false;
      }
    }
  }
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (hz[r][c]) out[r][c] = 'X';
  // entities
  const v1e = (Array.isArray(src.entities) ? src.entities : []) as V1Entity[];
  const keyFor = new Map<string, string>();
  for (const e of v1e) if (e.type === 'key' && e.opens) keyFor.set(e.opens, e.id);
  const bb = (e: V1Entity): [number, number, number, number] => {
    const b = e.bbox ?? [e.x ?? 0, e.y ?? 0, e.x ?? 0, e.y ?? 0];
    return [b[0], b[1], b[2], b[3]];
  };
  let goal: Entity | null = null;
  for (const e of v1e) {
    const x = e.x ?? 0;
    const y = e.y ?? 0;
    switch (e.type) {
      case 'player_start':
        entities.unshift({ id: 'start', type: 'player_start', x: x + 0.5, y: y + 1 });
        break;
      case 'goal':
        goal = { id: e.id, type: 'goal', x: x + 0.5, y: y + 1, trigger: [x, y - 1.5, x + 1, y + 1] };
        break;
      case 'coin':
        entities.push({ id: e.id, type: 'coin', x: x + 0.5, y: y + 0.5 });
        break;
      case 'checkpoint':
        entities.push({ id: e.id, type: 'checkpoint', x: x + 0.5, y: y + 1 });
        break;
      case 'key':
        entities.push({ id: e.id, type: 'key', x: x + 0.5, y: y + 0.5, door: e.opens ?? null });
        break;
      case 'door': {
        const [x0, y0, x1, y1] = bb(e);
        entities.push({ id: e.id, type: 'door', x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, key: keyFor.get(e.id) ?? null });
        break;
      }
      case 'bounce_pad': {
        const [x0, y0, x1, y1] = bb(e);
        // v1 compiled a drawn pad into solid cells and bounced the player off their top: the spring stands on them
        let padSolid = true;
        for (let c = x0; c <= x1; c++) if (!solid(c, y0)) padSolid = false;
        entities.push({ id: e.id, type: 'spring', x: (x0 + x1 + 1) / 2, y: padSolid ? y0 : y1 + 1, dir: 'up', strength: 1.0, w: x1 - x0 + 1 });
        break;
      }
      case 'moving_platform': {
        const [x0, y0, x1, y1] = bb(e);
        const path = (e.path ?? []).map((p) => [p[0], p[1]] as CellXY);
        const moves = path.length >= 2 && path.some((p) => p[0] !== path[0][0] || p[1] !== path[0][1]);
        if (!moves) {
          // zero-length path: a static block, with a warning (fixes [V 1])
          for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) if (r >= 0 && r < H && c >= 0 && c < W) out[r][c] = '#';
          warnings.push({ key: 'norm.behavior_dropped', args: { id: e.id } });
          break;
        }
        entities.push({ id: e.id, type: 'moving_platform', x: path[0][0], y: path[0][1], w: x1 - x0 + 1, path, speed: e.speed ?? 2, mode: 'pingpong', wait_s: 0.3, one_way: false });
        break;
      }
      case 'enemy': {
        const [x0, y0, x1, y1] = bb(e);
        const w = x1 - x0 + 1;
        const h = y1 - y0 + 1;
        const dx = e.patrol?.dx ?? 0;
        entities.push({
          id: e.id, type: 'enemy', archetype: 'flyer', x: x0 + w / 2, y: y1 + 1, w, h, spiky: false,
          params: { pattern: 'horizontal', range: Math.abs(dx), speed: e.patrol?.speed ?? 2 }, bounds: dx ? [Math.min(x0, x0 + dx), Math.max(x0, x0 + dx) + w] : null,
        });
        break;
      }
      default:
        warnings.push({ key: 'error.entity', args: { thing: String(e.type), where: e.id } });
    }
  }
  if (!entities.some((e) => e.type === 'player_start')) entities.unshift({ id: 'start', type: 'player_start', x: 2.5, y: 25 });
  for (const s of strips) entities.push({ id: s.id, type: 'spikes', host: null, face: s.face, x0: s.x0, x1: s.x1, y: s.y, facing: s.face === 'top' ? 'up' : s.face === 'bottom' ? 'down' : s.face });
  if (goal) entities.push(goal);
  const triggers: Trigger[] = ((Array.isArray(src.rules) ? src.rules : []) as Any[]).filter((r) => typeof r.when === 'string' && typeof r.then === 'string').map((r) => ({ when: String(r.when), then: String(r.then) }));
  // migrated ink + objects for remixing
  const strokes: InkStroke[] = [];
  const objects: SceneObject[] = [];
  let k = 0;
  const mk = (role: SceneObject['role'], stroke: Omit<InkStroke, 'id' | 'sheet' | 'origin'>, shape: SceneObject['shape'], collision: SceneObject['collision'], extra: Partial<SceneObject> = {}): void => {
    k++;
    const sid = `m${k}`;
    strokes.push({ ...stroke, id: sid, sheet: 0, origin: 'migrated' });
    objects.push({ id: `o${k}`, components: [k], strokes: [sid], role, conf: 1, role_by: 'migrated', origin: 'migrated', shape, collision, rel: {}, behavior: null, pinned: [], alt: [], lib: null, text: null, ...extra });
  };
  const isSolid = (c: number, r: number): boolean => r >= 0 && r < H && c >= 0 && c < W && out[r][c] === '#';
  for (let r = 0; r < H; r++) {
    let c = 0;
    while (c < W) {
      if (!isSolid(c, r) || isSolid(c, r - 1)) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < W && isSolid(c, r) && !isSolid(c, r - 1)) c++;
      let toBottom = true;
      for (let x = c0; x < c && toBottom; x++) for (let y = r; y < H; y++) if (!isSolid(x, y)) {
        toBottom = false;
        break;
      }
      const role = toBottom ? 'ground' : 'platform';
      mk(role, { color: 'black', kind: 'line', pts: [[c0, r + 0.25], [c, r + 0.25]], w: [0.5, 0.5], closed: false }, { k: 'surface', segs: [{ a: [c0, r], b: [c, r], slope: 0 }], fill: toBottom ? 'to_bottom' : 'one_row' }, 'solid');
    }
  }
  // thin stacks (1-2 columns, ≥ 2 rows, free on both sides) read as walls
  for (let c = 0; c < W; c++) {
    let r = 0;
    while (r < H) {
      const thin = (y: number): boolean => isSolid(c, y) && !isSolid(c - 1, y) && !isSolid(c + 1, y);
      if (!thin(r)) {
        r++;
        continue;
      }
      const r0 = r;
      while (r < H && thin(r)) r++;
      if (r - r0 >= 2) mk('wall', { color: 'black', kind: 'line', pts: [[c + 0.5, r0], [c + 0.5, r]], w: [0.5, 0.5], closed: false }, { k: 'wall', x: c, y0: r0, y1: r, w: 1 }, 'solid');
    }
  }
  for (const s of strips) {
    const horiz = s.face === 'top' || s.face === 'bottom';
    mk('spikes', { color: 'red', kind: 'line', pts: horiz ? [[s.x0, s.y - 0.3], [s.x1, s.y - 0.3]] : [[s.y, s.x0], [s.y, s.x1]], w: [0.4, 0.4], closed: false }, horiz ? { k: 'strip', a: [s.x0, s.y], b: [s.x1, s.y] } : { k: 'strip', a: [s.y, s.x0], b: [s.y, s.x1] }, 'hazard', { rel: { points: s.face === 'top' ? 'up' : s.face === 'bottom' ? 'down' : s.face } });
  }
  for (const e of entities) {
    if (e.type === 'coin') mk('coin', { color: 'blue', kind: 'dot', pts: [[e.x, e.y]], w: [0.875], closed: true }, { k: 'point', p: [e.x, e.y] }, 'none');
    else if (e.type === 'goal') mk('goal', { color: 'green', kind: 'blob', pts: [[e.x, e.y - 2.5], [e.x + 1.5, e.y - 2], [e.x, e.y - 1.5]], w: [0.5], closed: true }, { k: 'body', bbox: e.trigger }, 'trigger');
    else if (e.type === 'checkpoint') mk('checkpoint', { color: 'green', kind: 'blob', pts: [[e.x, e.y - 2.5], [e.x + 1.2, e.y - 2.1], [e.x, e.y - 1.7]], w: [0.5], closed: true }, { k: 'body', bbox: [e.x - 0.5, e.y - 2.5, e.x + 0.5, e.y] }, 'trigger');
    else if (e.type === 'key') mk('key', { color: 'blue', kind: 'blob', pts: [[e.x - 0.4, e.y - 0.3], [e.x + 0.4, e.y - 0.3], [e.x + 0.4, e.y + 0.3], [e.x - 0.4, e.y + 0.3]], w: [0.4], closed: true }, { k: 'body', bbox: [e.x - 0.5, e.y - 0.5, e.x + 0.5, e.y + 0.5] }, 'none');
    else if (e.type === 'door') mk('door', { color: 'black', kind: 'line', pts: [[e.x + 0.5, e.y], [e.x + 0.5, e.y + e.h]], w: [Math.max(0.5, e.w * 0.8)], closed: false }, { k: 'wall', x: e.x, y0: e.y, y1: e.y + e.h, w: e.w }, 'solid');
    else if (e.type === 'enemy') mk('enemy', { color: 'red', kind: 'blob', pts: [[e.x - e.w / 2, e.y - e.h], [e.x + e.w / 2, e.y - e.h], [e.x + e.w / 2, e.y], [e.x - e.w / 2, e.y]], w: [0.4], closed: true }, { k: 'body', bbox: [e.x - e.w / 2, e.y - e.h, e.x + e.w / 2, e.y] }, 'hazard', { behavior: { kind: 'enemy', archetype: 'flyer', spiky: false, params: { ...(e.params ?? {}) } } });
    else if (e.type === 'spring') mk('spring', { color: 'black', kind: 'line', pts: [[e.x - (e.w ?? 1) / 2, e.y - 0.4], [e.x + (e.w ?? 1) / 2, e.y - 0.4]], w: [0.5, 0.5], closed: false }, { k: 'body', bbox: [e.x - (e.w ?? 1) / 2, e.y - 0.75, e.x + (e.w ?? 1) / 2, e.y] }, 'solid', { behavior: { kind: 'spring', dir: 'up', strength: 1.0 } });
    else if (e.type === 'moving_platform') {
      const p1 = e.path[e.path.length - 1];
      const dx = p1[0] - e.x;
      const dy = p1[1] - e.y;
      const dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up';
      mk('platform', { color: 'black', kind: 'line', pts: [[e.x, e.y + 0.25], [e.x + e.w, e.y + 0.25]], w: [0.5, 0.5], closed: false }, { k: 'surface', segs: [{ a: [e.x, e.y], b: [e.x + e.w, e.y], slope: 0 }], fill: 'one_row' }, 'solid', { behavior: { kind: 'move', dir, cells: Math.max(Math.abs(dx), Math.abs(dy)), speed: e.speed, mode: 'pingpong' } });
    }
  }
  const components: InkComponent[] = computeComponents(strokes).map((c, i) => ({ ...c, id: i + 1, stroke_ids: c.stroke_ids }));
  // keep object ↔ component ids aligned with stroke order (one stroke per object)
  const compOf = new Map<string, number>();
  for (const c of components) for (const s of c.stroke_ids) compOf.set(s, c.id);
  for (const o of objects) o.components = [compOf.get(o.strokes[0]) ?? o.components[0]];
  const v1src = (src.source ?? {}) as Any;
  const meta = (src.meta ?? {}) as Any;
  for (const t of Array.isArray(meta.warnings) ? (meta.warnings as unknown[]) : []) if (typeof t === 'string') warnings.push({ key: 'warning.migrated_note', args: { text: t.slice(0, 120) } });
  const level: LevelV2 = {
    format: 'dal-level', schema_version: 2, core_min: CORE_VERSION,
    id: typeof src.id === 'string' ? src.id : 'lvl_migrated', version: 1,
    game_id: typeof src.game_id === 'string' ? src.game_id : null, parent_id: typeof src.parent_id === 'string' ? src.parent_id : null,
    order_index: typeof src.order_index === 'number' ? src.order_index : 0,
    title: typeof src.title === 'string' && src.title ? src.title : 'Level', author: typeof src.author === 'string' ? src.author : '',
    created_at: typeof src.created_at === 'string' ? src.created_at : '2026-01-01T00:00:00Z', license: 'CC-BY-4.0',
    world: { cell: 16, screens: 1, w: W, h: 27 },
    rules: resolveRules({ version: 1, physics_profile: 'v1-classic' }),
    source: { kind: 'migrated', prompt: null, pack_id: null, sheets: [{ index: 0, photo_url: (v1src.photo_url as string | null) ?? null, qr: null, sketch_url: (v1src.backdrop_url as string | null) ?? null }] },
    ink: { strokes, components, character: null, typed_rules: [], rules_ink: [], noise: { count: 0 } },
    objects, setpieces: [], edits: [],
    compiled: { tiles: { legend: '.#=/\\abcd~X', rows: out.map((r) => encodeRow(r.join(''))) }, entities, triggers, sprites: { player: null, objects: {} } },
    embedded_library: [],
    meta: { transcript: typeof meta.notes_transcript === 'string' ? meta.notes_transcript : '', intent: null, safety: 'unchecked', level_hash: '', core_version: CORE_VERSION, warnings, build: null },
  };
  level.meta.level_hash = levelHash(level);
  return level;
}
