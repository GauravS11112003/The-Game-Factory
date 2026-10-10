/**
 * Model merge (§3.3, `core/scene/merge.ts`): the model's Perception becomes perception edits relative to G0, so
 * every model change is visible and undoable.
 *   1. ids checked (unknown/invented ids and colour-forbidden roles dropped; > 30% invalid → discard all)
 *   2. roles reconciled by confidence: the model wins at ≥ medium, or when the heuristic is < 0.75; otherwise the
 *      heuristic stands and the model's role becomes the first re-label chip
 *   3. relations validated geometrically (rests_on within 3 cells, part_of within 2); failures → "unsure" chips
 *   4. bindings only from the typed union (a flat FlatBinding is accepted too); a key with no door → Ask card
 *   6. setpieces (1-4) from the model
 *   7. gameplay-relevant objects below 0.75 get "Is this right?"
 * Called with `perceptions: []` (model off) it returns the heuristic's own Ask cards.
 */
import { GRIDS, MODEL, PERCEPTION } from '../params.ts';
import type {
  AskCard, AskOption, Behavior, Binding, EditOp, EditRecord, InkDoc, LibraryType, PerceptionJson, PerceptionNode, Role,
  SceneGraph, SceneObject, Setpiece,
} from '../types.gen.ts';
import { OP_CLASS, explain } from '../edits/vocabulary.ts';
import { clamp, rectGap } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';
import { editId } from '../util/ids.ts';
import { askCard } from './asks.ts';
import { GAMEPLAY_ROLES, roleAllowed } from './roles.ts';

type Any = Record<string, unknown>;

function confNum(c: unknown): number {
  if (typeof c === 'number') return clamp(c, 0, 1);
  const m = PERCEPTION.model_conf as Record<string, number>;
  return typeof c === 'string' && c in m ? m[c] : 0.5;
}

function speedNum(v: unknown, grid: keyof typeof GRIDS, def: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const e = GRIDS[grid].enum as Record<string, number>;
  return typeof v === 'string' && v in e ? e[v] : def;
}

function bboxOf(o: SceneObject): Rect {
  const s = o.shape;
  switch (s.k) {
    case 'surface': {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const g of s.segs) {
        x0 = Math.min(x0, g.a[0], g.b[0]);
        x1 = Math.max(x1, g.a[0], g.b[0]);
        y0 = Math.min(y0, g.a[1], g.b[1]);
        y1 = Math.max(y1, g.a[1], g.b[1]);
      }
      return [x0, y0, x1, y1 + 1];
    }
    case 'strip':
      return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]) - 0.4, Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
    case 'body':
      return s.bbox;
    case 'point':
      return [s.p[0] - 0.3, s.p[1] - 0.3, s.p[0] + 0.3, s.p[1] + 0.3];
    case 'wall':
      return [s.x, s.y0, s.x + (s.w ?? 1), s.y1];
  }
}

function rec(op: EditOp, by: EditRecord['by'], extra: Partial<EditRecord> = {}): EditRecord {
  const ex = explain(op, null);
  return {
    id: editId(op), op, class: OP_CLASS[op.op], by, stage: 'understood', tier: 'faithful', status: 'applied',
    reason_key: ex.reason_key, reason_args: {}, reason_text: null, depends_on: [], required: false, group: ex.group,
    validation: null, ghost: null, reject_reason: null, cid: null, ...extra,
  };
}

/** Accept a flat FlatBinding (sentinels −1 / "none" / 0 / "") as well as the typed union. */
export function normalizeBinding(b: Any): Binding | null {
  const kind = String(b.kind ?? '');
  const num = (k: string): number | null => (typeof b[k] === 'number' && (b[k] as number) >= 0 ? (b[k] as number) : null);
  const str = (k: string): string | null => (typeof b[k] === 'string' && b[k] !== 'none' && b[k] !== '' ? (b[k] as string) : typeof b[k] === 'number' ? String(b[k]) : null);
  const target = num('target');
  switch (kind) {
    case 'move': {
      const dir = str('dir');
      if (target === null || !dir || dir === 'none') return null;
      return { kind: 'move', target, dir: dir as 'left', cells: Math.max(0, Number(b.cells ?? 0)), speed: speedNum(b.speed, 'platform_speed', 2), mode: (str('mode') ?? 'pingpong') as 'pingpong' };
    }
    case 'enemy': {
      if (target === null) return null;
      const arch = str('archetype') ?? 'walker';
      return { kind: 'enemy', target, archetype: arch as 'walker', speed: speedNum(b.speed, 'walker_speed', 2), spiky: !!b.spiky };
    }
    case 'spring':
      if (target === null) return null;
      return { kind: 'spring', target, dir: ((str('dir') ?? 'up') === 'down' ? 'up' : str('dir') ?? 'up') as 'up', strength: speedNum(b.strength, 'spring_strength', 1) };
    case 'crumble':
      return target === null ? null : { kind: 'crumble', target, falls: !!b.falls };
    case 'saw':
      return target === null ? null : { kind: 'saw', target, dir: (str('dir') ?? 'none') as 'none', cells: Math.max(0, Number(b.cells ?? 0)), speed: speedNum(b.speed, 'saw_speed', 3) };
    case 'key_door': {
      const key = num('key') ?? target;
      const door = num('door');
      return key === null || door === null ? null : { kind: 'key_door', key, door };
    }
    case 'checkpoint':
      return target === null ? null : { kind: 'checkpoint', target };
    case 'start': {
      const near = num('near') ?? target;
      return near === null ? null : { kind: 'start', near };
    }
    case 'timer':
      return { kind: 'timer', seconds: Number(b.seconds ?? 0) };
    case 'library':
      return target === null ? null : { kind: 'library', target, type_name: String(b.type_name ?? '') };
    default:
      return null;
  }
}

/** The newest version of each library type whose name (or circled letter) matches, case-insensitively. */
export function libraryByName(library: readonly LibraryType[], name: string): LibraryType | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const hits = library.filter((t) => t.name.trim().toLowerCase() === n || (n.length === 1 && t.letter.toLowerCase() === n));
  if (!hits.length) return null;
  return [...hits].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : b.version - a.version))[0];
}

/** "Is this Grumpo?" options: one per library type (≤ 4, newest version), each applying U7, plus "no" → scenery. */
export function libraryOptions(o: SceneObject, library: readonly LibraryType[]): AskOption[] {
  const latest = new Map<string, LibraryType>();
  for (const t of library) {
    const cur = latest.get(t.id);
    if (!cur || t.version > cur.version) latest.set(t.id, t);
  }
  const types = [...latest.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 4);
  const opts: AskOption[] = types.map((t) => ({
    id: t.id, label_key: types.length === 1 ? 'ask.option.yes' : 'library.option', label_args: { name: t.name },
    ops: [{ op: 'use_library', target: o.id, type_id: t.id, version: t.version }], tap_target: false,
  }));
  opts.push({ id: 'no', label_key: 'ask.option.no', ops: [{ op: 'set_role', target: o.id, role: 'decoration' }], tap_target: false });
  return opts;
}

export function mergePerception(g0: SceneGraph, perceptions: PerceptionJson[], ink: InkDoc, library: readonly LibraryType[] = []):
  { edits: EditRecord[]; asks: AskCard[]; setpieces: Setpiece[]; dropped: string[]; discarded: boolean } {
  const objs = g0.objects ?? [];
  const byId = new Map(objs.map((o) => [o.id, o] as const));
  const comps = new Map((ink.components ?? []).map((c) => [c.id, c] as const));
  // component → its object (the primary piece 'o<cid>' wins; else the object that holds it)
  const objOf = new Map<number, SceneObject>();
  for (const o of objs) for (const c of o.components) if (o.id === `o${c}` || !objOf.has(c)) objOf.set(c, o);
  const edits: EditRecord[] = [];
  const asks: AskCard[] = [];
  const dropped: string[] = [];
  const asked = new Set<string>();
  const ask = (a: AskCard): void => {
    if (asked.has(a.about + a.kind)) return;
    asked.add(a.about + a.kind);
    asks.push(a);
  };
  const add = (r: EditRecord): void => {
    if (!edits.some((e) => e.id === r.id)) edits.push(r);
  };
  // ---- 1. nodes: collect, dedupe across tiles (higher confidence wins), validate ----
  const nodes = new Map<number, PerceptionNode>();
  for (const p of perceptions ?? []) {
    for (const n of p.nodes ?? []) {
      const prev = nodes.get(n.id);
      if (!prev || confNum(n.conf) > confNum(prev.conf)) nodes.set(n.id, n);
    }
  }
  let invalid = 0;
  const valid: PerceptionNode[] = [];
  for (const n of [...nodes.values()].sort((a, b) => a.id - b.id)) {
    const c = comps.get(n.id);
    if (!c || !objOf.has(n.id)) {
      dropped.push(`node:${n.id}`);
      invalid++;
      continue;
    }
    if (!roleAllowed(c.color, n.role)) {
      dropped.push(`role:${n.id}:${n.role}`);
      invalid++;
      continue;
    }
    valid.push(n);
  }
  const uniq = Math.max(1, nodes.size);
  if (perceptions?.length && invalid / uniq > PERCEPTION.merge_max_invalid_frac) {
    return { edits: [], asks: heuristicAsks(objs, new Set()), setpieces: [], dropped, discarded: true };
  }
  // ---- 2. roles: one vote per object (majority of its components, then confidence) ----
  const votes = new Map<string, { role: Role; conf: number; n: number }[]>();
  for (const n of valid) {
    const o = objOf.get(n.id)!;
    const list = votes.get(o.id) ?? [];
    const v = list.find((x) => x.role === n.role);
    if (v) {
      v.n++;
      v.conf = Math.max(v.conf, confNum(n.conf));
    } else list.push({ role: n.role, conf: confNum(n.conf), n: 1 });
    votes.set(o.id, list);
  }
  const resolved = new Set<string>();
  for (const [id, list] of votes) {
    const o = byId.get(id)!;
    const top = [...list].sort((a, b) => b.n - a.n || b.conf - a.conf || a.role.localeCompare(b.role))[0];
    if (o.pinned.includes('role') || o.role_by === 'kid' || o.role_by === 'stamp') continue;
    if (o.rel.part_of && top.role !== 'pole') continue;
    if (top.role === o.role) {
      if (top.conf >= PERCEPTION.model_conf.medium) resolved.add(id);
      continue;
    }
    if (top.conf >= PERCEPTION.model_conf.medium || o.conf < PERCEPTION.ask_conf) {
      add(rec({ op: 'set_role', target: id, role: top.role, x_conf: top.conf } as EditOp, 'model', { reason_args: { role: top.role } }));
      resolved.add(id);
    } else {
      ask(askCard('is_this_right', o, 'model', { roles: [top.role] }));
    }
  }
  // ---- 3. relations, validated geometrically ----
  for (const n of valid) {
    const o = objOf.get(n.id)!;
    const ob = bboxOf(o);
    if (n.on !== null && n.on !== undefined) {
      const h = objOf.get(n.on);
      if (h && h !== o) {
        const hb = bboxOf(h);
        const ok = rectGap(ob, hb) <= PERCEPTION.merge_rests_on_max_c;
        if (!ok) ask(askCard('is_this_right', o, 'model'));
      }
    }
    if (n.att !== null && n.att !== undefined && n.face && n.face !== 'none') {
      const h = objOf.get(n.att);
      if (h && h !== o) {
        const ok = rectGap(ob, bboxOf(h)) <= 2.5;
        if (ok) add(rec({ op: 'snap', target: o.id, host: h.id, face: n.face }, 'model', { reason_key: 'norm.snapped' }));
        else ask(askCard('is_this_right', o, 'model'));
      }
    }
    if (n.part !== null && n.part !== undefined) {
      const root = objOf.get(n.part);
      if (root && root !== o && o.rel.part_of !== root.id) {
        if (rectGap(ob, bboxOf(root)) <= PERCEPTION.merge_part_of_max_c) add(rec({ op: 'group', root: root.id, parts: [o.id] }, 'model'));
        else ask(askCard('is_this_right', o, 'model'));
      }
    }
  }
  // ---- 4. bindings (typed union, or the flat form) ----
  const pinMap = (p: readonly string[]): string[] => [...new Set(p.filter((x) => ['speed', 'cells', 'dir', 'archetype', 'strength', 'seconds'].includes(x)))].sort();
  for (const p of perceptions ?? []) {
    for (const bound of p.bindings ?? []) {
      const b = normalizeBinding(bound.binding as unknown as Any);
      const pinned = pinMap(bound.pinned ?? []);
      const evidence = (bound.evidence ?? '').slice(0, 90) || null;
      if (!b) {
        // a key with no door (or a binding missing a required id) → Ask, never a silent downgrade [M v1]
        const raw = bound.binding as unknown as Any;
        if (raw && raw.kind === 'key_door') {
          const k = objOf.get(Number(raw.key ?? raw.target));
          if (k) ask(askCard('which_door', k, 'model'));
        }
        continue;
      }
      const T = (cid: number): SceneObject | undefined => objOf.get(cid);
      switch (b.kind) {
        case 'move': {
          const o = T(b.target);
          if (!o) break;
          const beh: Behavior = { kind: 'move', dir: b.dir, cells: clamp(Math.round(b.cells || 4), MODEL.sanitize.cells[0], MODEL.sanitize.cells[1]), speed: b.speed, mode: b.mode };
          add(rec({ op: 'bind', target: o.id, behavior: beh, x_pinned: pinned } as EditOp, 'model', { reason_text: evidence }));
          break;
        }
        case 'enemy': {
          const o = T(b.target);
          if (!o) break;
          if (o.role !== 'enemy' && roleAllowed(comps.get(b.target)?.color ?? 'red', 'enemy')) add(rec({ op: 'set_role', target: o.id, role: 'enemy', x_conf: 0.9 } as EditOp, 'model'));
          // the sanitizer maps the speed enum per archetype (D-1): seconds for hopper/shooter (interval) and crusher (warn)
          const params = b.archetype === 'hopper' || b.archetype === 'shooter' ? { interval: b.speed } : b.archetype === 'crusher' ? { warn: b.speed } : { speed: b.speed };
          const beh: Behavior = b.archetype === 'static' ? { kind: 'static' } : { kind: 'enemy', archetype: b.archetype, spiky: b.spiky, params };
          add(rec({ op: 'bind', target: o.id, behavior: beh, x_pinned: b.archetype === 'static' ? [...pinned, 'archetype'] : pinned } as EditOp, 'model', { reason_text: evidence }));
          break;
        }
        case 'spring': {
          const o = T(b.target);
          if (!o) break;
          add(rec({ op: 'bind', target: o.id, behavior: { kind: 'spring', dir: b.dir, strength: clamp(b.strength, 0.6, 1.4) }, x_pinned: pinned } as EditOp, 'model', { reason_text: evidence }));
          break;
        }
        case 'crumble': {
          const o = T(b.target);
          if (!o) break;
          add(rec({ op: 'bind', target: o.id, behavior: b.falls ? { kind: 'falling' } : { kind: 'crumble' }, x_pinned: pinned } as EditOp, 'model', { reason_text: evidence }));
          break;
        }
        case 'saw': {
          const o = T(b.target);
          if (!o) break;
          add(rec({ op: 'bind', target: o.id, behavior: { kind: 'saw', dir: b.dir, cells: clamp(Math.round(b.cells), 0, 12), speed: b.speed }, x_pinned: pinned } as EditOp, 'model', { reason_text: evidence }));
          break;
        }
        case 'key_door': {
          const k = T(b.key);
          const d = T(b.door);
          if (!k || !d || k === d) {
            if (k) ask(askCard('which_door', k, 'model'));
            break;
          }
          if (k.role !== 'key' && roleAllowed(comps.get(b.key)?.color ?? 'blue', 'key')) add(rec({ op: 'set_role', target: k.id, role: 'key', x_conf: 0.9 } as EditOp, 'model'));
          add(rec({ op: 'link', key: k.id, door: d.id }, 'model', { reason_text: evidence }));
          break;
        }
        case 'checkpoint': {
          const o = T(b.target);
          if (o && o.role !== 'checkpoint') add(rec({ op: 'set_role', target: o.id, role: 'checkpoint', x_conf: 0.9 } as EditOp, 'model'));
          break;
        }
        case 'start': {
          const o = T(b.near);
          if (o) add(rec({ op: 'set_start', near: o.id }, 'model', { reason_text: evidence, reason_args: { text: o.text ?? 'S' } }));
          break;
        }
        case 'timer': {
          const s = clamp(Math.round(b.seconds), MODEL.sanitize.seconds[0], MODEL.sanitize.seconds[1]);
          add(rec({ op: 'set_timer', k: 2, x_seconds: s } as EditOp, 'model', { class: 'U', reason_args: { seconds: s }, reason_text: evidence }));
          break;
        }
        case 'library': {
          // a circled letter or a written name next to a blob (§8.1): matched case-insensitively against the library
          const o = T(b.target);
          if (!o) break;
          const t = libraryByName(library, b.type_name);
          if (t) add(rec({ op: 'use_library', target: o.id, type_id: t.id, version: t.version }, 'model', { reason_args: { name: t.name }, reason_text: evidence }));
          else ask(askCard('is_library', o, 'model', { args: { name: b.type_name.slice(0, 16) }, options: library.length ? libraryOptions(o, library) : undefined }));
          break;
        }
      }
    }
  }
  // ---- 6. setpieces ----
  const setpieces: Setpiece[] = [];
  for (const p of perceptions ?? []) {
    for (const s of p.setpieces ?? []) {
      if (setpieces.length >= PERCEPTION.setpieces.model_max) break;
      const ids = [...new Set(s.ids.map((c) => objOf.get(c)?.id).filter((x): x is string => !!x))];
      if (!ids.length || setpieces.some((x) => x.name === s.name)) continue;
      setpieces.push({ name: String(s.name).slice(0, 40), ids, kind: s.kind, by: 'model' });
    }
  }
  // ---- model asks ----
  for (const p of perceptions ?? []) {
    for (const a of p.asks ?? []) {
      const o = objOf.get(a.about);
      if (o) ask(askCard(a.kind, o, 'model'));
    }
  }
  // ---- 7. heuristic asks (unless the model resolved that object) and low-confidence chips ----
  for (const a of heuristicAsks(objs, resolved, library)) ask(a);
  return { edits, asks, setpieces, dropped, discarded: false };
}

/** The heuristic's own questions (H12 grass or spikes, H20 is it a door, H22 is this right) and < 0.75 chips. */
export function heuristicAsks(objs: readonly SceneObject[], resolved: ReadonlySet<string>, library: readonly LibraryType[] = []): AskCard[] {
  const out: AskCard[] = [];
  for (const o of objs) {
    if (resolved.has(o.id) || o.rel.part_of || o.pinned.includes('role') || o.lib) continue;
    const k = (o as SceneObject & { x_ask?: string }).x_ask;
    if (k === 'is_library') {
      const opts = library.length ? libraryOptions(o, library) : undefined;
      const one = library.length && opts && opts.length === 2 ? opts[0].label_args?.name : null;
      out.push(askCard(k, o, 'heuristic', { args: one ? { name: String(one) } : {}, options: opts }));
    } else if (k === 'grass_or_spikes' || k === 'is_door') out.push(askCard(k, o, 'heuristic'));
    else if (o.conf < PERCEPTION.ask_conf && (GAMEPLAY_ROLES.has(o.role) || o.role === 'unknown')) out.push(askCard('is_this_right', o, 'heuristic'));
  }
  return out;
}
