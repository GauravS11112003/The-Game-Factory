/**
 * Level skins (docs/v3/CONTRACTS_V3.md "Skin on levels"): generated art (Adobe Firefly, or a Claude SVG) laid over
 * the kid's drawing. Pure and DOM-free: this module maps each `life` entry to the level object it replaces and says
 * where its picture goes; the engine (web/src/engine/views/skin.ts) and the Canvas2D thumbnails draw it.
 *
 * Mapping: the entry goes to the object group (an object plus its `part_of` parts) whose strokes overlap the entry's
 * `stroke_ids` most (ties prefer the entry's `object_id`); the character's strokes compete too, so a skin of the
 * character becomes the player sprite. A group drawn by a gameplay entity (an enemy, a coin, a moving platform, …)
 * skins that entity, so the sprite follows it; any other group is a static picture over its fitted ink box.
 *
 * Art never changes gameplay: nothing here touches collision, entities or level_hash.
 */
import type { Entity, InkDoc, LevelInk, LevelSkin, LevelV2, RectCells, SceneObject, SkinCredit } from '../types.gen.ts';
import type { ArtDoc, ArtPath } from './types.ts';
import { characterOf } from './artdoc.ts';
import { CELL } from './geom.ts';

export type { LevelSkin, SkinBackdrop, SkinCredit, SkinObject } from '../types.gen.ts';

// ---- the `skin` block, normalized (LevelV2.skin is optional, loosely typed JSON and not part of level_hash) ------

/** One `skin.objects[]` entry with its defaults filled in. */
export interface SkinEntry {
  stroke_ids: string[];
  object_id: string | null;
  url: string;
  label: string | null;
  credit: SkinCredit | null;
  /** 'life' (show the art) or 'ink' (the kid chose "My drawing"). */
  mode: 'life' | 'ink';
}

/** A level skin with its defaults filled in and broken entries dropped (what the renderers read). */
export interface SkinSpec {
  provider: string | null;
  style_id: string | null;
  backdrop: { url: string; credit: SkinCredit | null } | null;
  objects: SkinEntry[];
}

/** Horizontal scroll factor of the skin backdrop (behind the ink, in front of the paper). */
export const SKIN_PARALLAX = 0.3;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function credit(v: unknown): SkinCredit | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  return { by: str(c.by), tool: str(c.tool), prompt: str(c.prompt) };
}

/** A clean copy of any `skin`-shaped value (unknown fields dropped, entries without a url skipped); null when empty. */
export function normalizeSkin(v: unknown): SkinSpec | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  const objects: SkinEntry[] = [];
  for (const o of Array.isArray(s.objects) ? s.objects : []) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const url = str(r.url);
    if (!url) continue;
    const ids = Array.isArray(r.stroke_ids) ? r.stroke_ids.filter((x): x is string => typeof x === 'string') : [];
    objects.push({ stroke_ids: ids, object_id: str(r.object_id), url, label: str(r.label), credit: credit(r.credit), mode: r.mode === 'ink' ? 'ink' : 'life' });
  }
  const b = s.backdrop && typeof s.backdrop === 'object' ? (s.backdrop as Record<string, unknown>) : null;
  const bu = b ? str(b.url) : null;
  const backdrop = b && bu ? { url: bu, credit: credit(b.credit) } : null;
  if (!objects.length && !backdrop) return null;
  return { provider: str(s.provider), style_id: str(s.style_id), backdrop, objects };
}

/** The level's skin, normalized (null when it has none or nothing drawable). */
export function skinOf(level: LevelV2 | null | undefined): SkinSpec | null {
  if (!level) return null;
  return normalizeSkin((level as { skin?: unknown }).skin);
}

/** The level with another skin (null removes it); everything else is shared, so gameplay stays identical. */
export function withSkin(level: LevelV2, skin: LevelSkin | null | undefined): LevelV2 {
  const out: LevelV2 = { ...level };
  if (skin) out.skin = skin;
  else delete out.skin;
  return out;
}

/** A short signature of the skin's pictures (cache keys for thumbnails). */
export function skinSignature(skin: SkinSpec | null): string {
  if (!skin) return '';
  const parts = (skin.objects ?? []).filter((o) => o.mode !== 'ink').map((o) => `${o.url}#${o.stroke_ids.join('.')}#${o.object_id ?? ''}`);
  if (skin.backdrop?.url) parts.push(`bg:${skin.backdrop.url}`);
  return parts.join('|');
}

/**
 * True when two levels differ only in their skin (or in fields the engine never reads: title, author, meta, design…),
 * so a swap can re-skin in place instead of rebuilding and restarting the run.
 */
export function sameExceptSkin(a: LevelV2, b: LevelV2): boolean {
  if (a === b) return true;
  if (a.id !== b.id) return false;
  const keys = ['world', 'rules', 'compiled', 'objects', 'ink', 'edits', 'embedded_library', 'source'] as const;
  for (const k of keys) {
    const x = a[k] as unknown;
    const y = b[k] as unknown;
    if (x === y) continue;
    if ((x === undefined || x === null) && (y === undefined || y === null)) continue;
    try {
      if (JSON.stringify(x) !== JSON.stringify(y)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---- credits ----------------------------------------------------------------------------------------------------

export interface SkinCredits {
  /** Some picture says it was made with Adobe Firefly (or the skin's provider is firefly). */
  firefly: boolean;
  /** The people who drew what the art was made from (unique, in order). */
  names: string[];
}

export function skinCredits(skin: SkinSpec | null, fallbackName?: string | null): SkinCredits {
  const out: SkinCredits = { firefly: false, names: [] };
  if (!skin) return out;
  const seen = new Set<string>();
  const take = (c: SkinCredit | null | undefined): void => {
    if (!c) return;
    if (c.tool && /firefly/i.test(c.tool)) out.firefly = true;
    const n = (c.by ?? '').trim();
    if (n && !seen.has(n.toLowerCase())) {
      seen.add(n.toLowerCase());
      out.names.push(n);
    }
  };
  for (const o of skin.objects ?? []) if (o.mode !== 'ink') take(o.credit);
  take(skin.backdrop?.credit);
  if ((skin.provider ?? '').toLowerCase() === 'firefly') out.firefly = true;
  const fb = (fallbackName ?? '').trim();
  if (!out.names.length && fb) out.names.push(fb);
  return out;
}

/** "Maya", "Maya & Leo", "Maya, Leo +2". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}, ${names[1]} +${names.length - 2}`;
}

// ---- placement --------------------------------------------------------------------------------------------------

/**
 * How a picture fills its box:
 * - 'feet': uniform fit, centred, bottom on the box bottom (creatures, the character, flags, springs, doors);
 * - 'center': uniform fit, centred (items, decoration floating in the air);
 * - 'platform': stretched when the aspects differ by < 25%, else tiled along the long side, else fitted to the top.
 */
export type SkinFit = 'feet' | 'center' | 'platform';

export type SkinTarget = { kind: 'entity'; id: string } | { kind: 'object'; id: string } | { kind: 'player' };

export interface SkinPlacement {
  /** Stable per target ('entity:e3', 'object:o7', 'player'). */
  key: string;
  url: string;
  target: SkinTarget;
  fit: SkinFit;
  /** Cells. Entities: local to `anchor` (the sprite frame); the player: local, feet centre at (0, 0); objects: world. */
  box: RectCells;
  /** World cells of the local origin (entity anchor, player start; [0, 0] for objects). */
  anchor: [number, number];
  /** ArtDoc object ids whose ink this picture replaces (the object and its parts; the entity id; 'player'). */
  hide: string[];
  /** The scene object it was matched to (null for the player). */
  object_id: string | null;
  label: string | null;
  credit: SkinCredit | null;
  /** How many of the entry's strokes the target owns (diagnostics). */
  overlap: number;
}

const INK_LAYER_IDS = new Set(['decoration', 'signs', 'terrain']);
const HIDE_LAYER_IDS = new Set(['decoration', 'signs', 'terrain', 'entities', 'player']);

function rootOf(id: string, byId: Map<string, SceneObject>): string {
  let cur = id;
  const seen = new Set<string>();
  for (;;) {
    const o = byId.get(cur);
    const up = o?.rel?.part_of;
    if (!up || !byId.has(up) || seen.has(up)) return cur;
    seen.add(cur);
    cur = up;
  }
}

interface Group {
  root: string;
  members: string[]; // object ids (root first)
  strokes: Set<string>;
}

interface Groups {
  groups: Map<string, Group>;
  byId: Map<string, SceneObject>;
  /** object id → the root of its group */
  owner: Map<string, string>;
}

function groupsOf(objects: SceneObject[]): Groups {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const groups = new Map<string, Group>();
  const owner = new Map<string, string>();
  for (const o of objects) {
    const r = rootOf(o.id, byId);
    let g = groups.get(r);
    if (!g) {
      g = { root: r, members: [], strokes: new Set() };
      groups.set(r, g);
    }
    if (o.id === r) g.members.unshift(o.id);
    else g.members.push(o.id);
    owner.set(o.id, r);
    for (const s of o.strokes ?? []) g.strokes.add(s);
  }
  // `rel.parts` lists children too (some builds fill only that direction): fold those groups into their parent's
  for (const o of objects) {
    for (const p of o.rel?.parts ?? []) {
      const g = groups.get(owner.get(o.id) ?? '');
      const cg = groups.get(owner.get(p) ?? '');
      if (!g || !cg || cg === g) continue;
      for (const m of cg.members) {
        if (!g.members.includes(m)) g.members.push(m);
        owner.set(m, g.root);
      }
      for (const s of cg.strokes) g.strokes.add(s);
      groups.delete(cg.root);
    }
  }
  return { groups, byId, owner };
}

/** The object id that draws each entity (the same lookup buildArt uses). */
function entityObjects(entities: Entity[], byId: Map<string, SceneObject>): Map<string, Entity[]> {
  const out = new Map<string, Entity[]>();
  for (const e of entities) {
    if (e.type === 'player_start') continue;
    const oid = e.sprite && byId.has(e.sprite) ? e.sprite : byId.has(e.id) ? e.id : null;
    if (!oid) continue;
    const list = out.get(oid) ?? [];
    list.push(e);
    out.set(oid, list);
  }
  return out;
}

function boxOfPaths(paths: readonly ArtPath[]): RectCells | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths) {
    const pad = (p.w && p.w.length ? Math.max(...p.w) : 3) / 2 / CELL;
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      x0 = Math.min(x0, p.pts[i] - pad);
      y0 = Math.min(y0, p.pts[i + 1] - pad);
      x1 = Math.max(x1, p.pts[i] + pad);
      y1 = Math.max(y1, p.pts[i + 1] + pad);
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/** The scene object's own shape box (cells), when it has no ink of its own in the ArtDoc. */
export function shapeBox(o: SceneObject): RectCells | null {
  const s = o.shape;
  switch (s.k) {
    case 'surface': {
      if (!s.segs.length) return null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const g of s.segs)
        for (const p of [g.a, g.b]) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
      return [x0, y0, x1, y1 + 1];
    }
    case 'wall':
      return [s.x - 0.5, s.y0, s.x + 0.5, s.y1];
    case 'body':
      return s.bbox;
    case 'point':
      return [s.p[0] - 0.5, s.p[1] - 0.5, s.p[0] + 0.5, s.p[1] + 0.5];
    case 'strip':
      return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]) - 0.5, Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
    default:
      return null;
  }
}

/** World box (cells) of an object group's drawn ink in the ArtDoc's ink layers, else of its shapes. */
export function objectArtBox(doc: ArtDoc, ids: readonly string[], objects?: Map<string, SceneObject>): RectCells | null {
  const set = new Set(ids);
  const paths: ArtPath[] = [];
  for (const l of doc.layers) {
    if (!INK_LAYER_IDS.has(String(l.id))) continue;
    for (const p of l.paths) if (p.object_id && set.has(p.object_id)) paths.push(p);
  }
  const b = boxOfPaths(paths);
  if (b) return b;
  if (!objects) return null;
  let out: RectCells | null = null;
  for (const id of ids) {
    const o = objects.get(id);
    const sb = o ? shapeBox(o) : null;
    if (!sb) continue;
    out = out ? [Math.min(out[0], sb[0]), Math.min(out[1], sb[1]), Math.max(out[2], sb[2]), Math.max(out[3], sb[3])] : sb;
  }
  return out;
}

function entityFit(e: Entity): SkinFit {
  switch (e.type) {
    case 'enemy':
    case 'goal':
    case 'checkpoint':
    case 'spring':
    case 'door':
      return 'feet';
    case 'moving_platform':
    case 'crumble':
    case 'falling_platform':
    case 'spikes':
      return 'platform';
    default:
      return 'center';
  }
}

function objectFit(o: SceneObject): SkinFit {
  switch (o.role) {
    case 'ground':
    case 'platform':
    case 'wall':
    case 'ceiling':
    case 'lava':
    case 'spikes':
      return 'platform';
    case 'enemy':
    case 'goal':
    case 'checkpoint':
    case 'spring':
    case 'door':
    case 'pole':
    case 'start_marker':
      return 'feet';
    case 'coin':
    case 'big_coin':
    case 'key':
    case 'saw':
      return 'center';
    default:
      // decoration and the rest: centred, unless it stands on something (a tree on the ground keeps its roots down)
      return o.rel?.rests_on ? 'feet' : 'center';
  }
}

/** Entities whose sprite frame has its feet on the anchor line (local y = 0). */
const FEET_ANCHORED = new Set(['enemy', 'goal', 'checkpoint', 'spring']);

/** The entry's best target: the object group (or the character) owning most of its strokes. */
function matchEntry(
  entry: SkinEntry,
  gs: Groups,
  character: Set<string>,
  entities: Entity[],
): { kind: 'group'; group: Group; n: number } | { kind: 'player'; n: number } | null {
  const { groups, owner, byId } = gs;
  const ids = new Set(entry.stroke_ids);
  let best: Group | null = null;
  let bestN = 0;
  // the entry's object id may name a scene object or an entity (whose drawing is a scene object)
  let preferred: string | null = null;
  if (entry.object_id) {
    preferred = owner.get(entry.object_id) ?? null;
    if (!preferred) {
      const e = entities.find((x) => x.id === entry.object_id);
      const oid = e ? (e.sprite && byId.has(e.sprite) ? e.sprite : e.id) : null;
      preferred = oid ? owner.get(oid) ?? null : null;
    }
  }
  for (const g of groups.values()) {
    let n = 0;
    for (const s of g.strokes) if (ids.has(s)) n++;
    if (n > bestN || (n > 0 && n === bestN && g.root === preferred)) {
      best = g;
      bestN = n;
    }
  }
  let charN = 0;
  for (const s of character) if (ids.has(s)) charN++;
  if (charN > bestN) return { kind: 'player', n: charN };
  if (best && bestN > 0) return { kind: 'group', group: best, n: bestN };
  // no stroke in common (strokes from another document, a rebuilt graph): trust the entry's object id
  if (preferred) {
    const g = groups.get(preferred);
    if (g) return { kind: 'group', group: g, n: 0 };
  }
  return null;
}

/** Which level object (or 'player') a set of drawing strokes became: what a fly-in aims at. Null when none. */
export function skinTargetOf(level: LevelV2, ink: InkDoc | LevelInk | null | undefined, strokeIds: readonly string[], objectId?: string | null): { object_id: string | 'player'; entity_ids: string[] } | null {
  const gs = groupsOf(level.objects ?? []);
  const character = new Set((characterOf(ink, level) ?? []).map((s) => s.id));
  const m = matchEntry({ stroke_ids: [...strokeIds], object_id: objectId ?? null, url: '-', label: null, credit: null, mode: 'life' }, gs, character, level.compiled?.entities ?? []);
  if (!m) return null;
  if (m.kind === 'player') return { object_id: 'player', entity_ids: [] };
  const eo = entityObjects(level.compiled?.entities ?? [], gs.byId);
  const ents: string[] = [];
  for (const id of m.group.members) for (const e of eo.get(id) ?? []) ents.push(e.id);
  return { object_id: m.group.root, entity_ids: ents };
}

/**
 * Resolve every `life` entry of a skin against a built level: one placement per target (an entry matching an
 * object drawn by several entities places one per entity). When two entries hit the same target the one owning
 * more strokes wins (ties: the later entry, i.e. the newest art).
 */
export function resolveSkin(level: LevelV2, ink: InkDoc | LevelInk | null | undefined, doc: ArtDoc, skin: SkinSpec | null): SkinPlacement[] {
  if (!skin) return [];
  const entries = skin.objects.filter((o) => o.url && o.mode !== 'ink');
  if (!entries.length) return [];
  const gs = groupsOf(level.objects ?? []);
  const byId = gs.byId;
  const entities = level.compiled?.entities ?? [];
  const eo = entityObjects(entities, byId);
  const sprites = new Map(doc.sprites.map((s) => [s.id, s]));
  const character = new Set((characterOf(ink, level) ?? []).map((s) => s.id));
  const start = entities.find((e) => e.type === 'player_start');
  const startAt: [number, number] = start ? [start.x, start.y] : [2, 22];
  const out = new Map<string, SkinPlacement>();
  const put = (p: SkinPlacement): void => {
    const old = out.get(p.key);
    if (old && old.overlap > p.overlap) return;
    out.set(p.key, p);
  };
  for (const entry of entries) {
    const m = matchEntry(entry, gs, character, entities);
    if (!m) continue;
    const base = { url: entry.url, label: entry.label, credit: entry.credit, overlap: m.n };
    if (m.kind === 'player') {
      const b = doc.player.bbox;
      const box: RectCells = [b[0], b[1], b[2], b[3] > 0 && b[1] < 0 ? 0 : b[3]];
      put({ ...base, key: 'player', target: { kind: 'player' }, fit: 'feet', box, anchor: startAt, hide: ['player'], object_id: null });
      continue;
    }
    const g = m.group;
    const ents: Entity[] = [];
    for (const id of g.members) for (const e of eo.get(id) ?? []) if (!ents.includes(e)) ents.push(e);
    if (ents.length) {
      for (const e of ents) {
        const sp = sprites.get(e.id);
        if (!sp) continue;
        const b = sp.bbox;
        const box: RectCells = [b[0], b[1], b[2], FEET_ANCHORED.has(e.type) && b[3] > 0 && b[1] < 0 ? 0 : b[3]];
        if (!(box[2] > box[0] && box[3] > box[1])) continue;
        put({
          ...base, key: `entity:${e.id}`, target: { kind: 'entity', id: e.id }, fit: entityFit(e), box, anchor: [sp.anchor[0], sp.anchor[1]],
          hide: [e.id, ...g.members], object_id: g.root,
        });
      }
      continue;
    }
    const root = byId.get(g.root);
    if (!root) continue;
    const fit = objectFit(root);
    let box = objectArtBox(doc, g.members, byId);
    if (!box) continue;
    if (fit === 'platform') {
      // a terrain line is thin: the picture gets at least one cell of thickness (top edge kept), walls one cell of width
      const w = box[2] - box[0];
      const h = box[3] - box[1];
      if (h < 1 && w >= h) box = [box[0], box[1], box[2], box[1] + 1];
      else if (w < 1 && h > w) {
        const cx = (box[0] + box[2]) / 2;
        box = [cx - 0.5, box[1], cx + 0.5, box[3]];
      }
    }
    if (!(box[2] > box[0] && box[3] > box[1])) continue;
    put({ ...base, key: `object:${g.root}`, target: { kind: 'object', id: g.root }, fit, box, anchor: [0, 0], hide: [...g.members], object_id: g.root });
  }
  return [...out.values()];
}

/** The ArtDoc without the ink of these object ids (the kid's drawing stays in the level; only its art is hidden). */
export function hideSkinned(doc: ArtDoc, ids: ReadonlySet<string>): ArtDoc {
  if (!ids.size) return doc;
  return {
    ...doc,
    layers: doc.layers.map((l) => (HIDE_LAYER_IDS.has(String(l.id)) ? { ...l, paths: l.paths.filter((p) => !(p.object_id && ids.has(p.object_id))) } : l)),
  };
}

/** Destination rects [x, y, w, h] (same units as `box`) for an iw × ih picture placed by `fit`. */
export function fitRects(iw: number, ih: number, box: RectCells, fit: SkinFit): [number, number, number, number][] {
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (!(bw > 0 && bh > 0 && iw > 0 && ih > 0)) return [];
  const ia = iw / ih;
  const contain = (valign: 'top' | 'center' | 'bottom'): [number, number, number, number] => {
    const s = Math.min(bw / iw, bh / ih);
    const w = iw * s;
    const h = ih * s;
    const y = valign === 'top' ? y0 : valign === 'bottom' ? y1 - h : y0 + (bh - h) / 2;
    return [x0 + (bw - w) / 2, y, w, h];
  };
  if (fit === 'feet') return [contain('bottom')];
  if (fit === 'center') return [contain('center')];
  const ratio = bw / bh / ia;
  if (Math.max(ratio, 1 / ratio) < 1.25) return [[x0, y0, bw, bh]];
  if (ratio > 1) {
    // the box is wider than the picture: repeat it along x at the box height
    const n = Math.round(bw / (bh * ia));
    if (n >= 2) {
      const w = bw / n;
      return Array.from({ length: n }, (_, i) => [x0 + i * w, y0, w, bh] as [number, number, number, number]);
    }
    return [contain('top')];
  }
  if (bh > bw) {
    // a tall box (a wall): repeat along y at the box width
    const n = Math.round(bh / (bw / ia));
    if (n >= 2) {
      const h = bh / n;
      return Array.from({ length: n }, (_, i) => [x0, y0 + i * h, bw, h] as [number, number, number, number]);
    }
  }
  return [contain('top')];
}

/** World box (cells) of a placement at its spawn / static position. */
export function placementWorldBox(p: SkinPlacement): RectCells {
  return [p.box[0] + p.anchor[0], p.box[1] + p.anchor[1], p.box[2] + p.anchor[0], p.box[3] + p.anchor[1]];
}
