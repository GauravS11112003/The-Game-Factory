/**
 * StudioEdit semantics (docs/v6/CONTRACTS_V6.md §5.2): the copilot's only output, and the path every inspector control
 * goes through too. `applyEdits` is pure and immutable: it returns a new doc (untouched parts are shared), plain
 * warnings for edits it had to drop or fix, the ids of objects it created, and the `ask_draw` prompts to show.
 */
import type { BehaviorDef, Condition, HudItem, JointDef, StudioEdit, StudioTheme } from '../../core/types.gen.ts';
import { ACTIONS, BEHAVIORS, CATALOG, EVENTS, withDefaults, type Archetype, type CatalogEntry, type ParamSpec } from './catalog.ts';
import { allObjectIds, freshId, recentre, sceneOf, validId, withScene } from './doc.ts';
import {
  isSDoc, normalizeDoc, normalizeObject, normalizePhysics, normalizeRule, normalizeTheme, normalizeWorld,
  type AskDraw, type SDoc, type SObj, type SRule, type SScene,
} from './types.ts';

export interface ApplyResult { doc: SDoc; warnings: string[]; created: string[]; asks: AskDraw[] }
export interface ApplyContext { themes?: StudioTheme[] }

const NAME_RE = /^[a-z][a-z0-9 _]{0,23}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Counter / tag names: lower case, ≤ 24 chars, starting with a letter. Returns null when it cannot be fixed. */
export function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().replace(/[^a-z0-9 _]+/g, '').slice(0, 24);
  return NAME_RE.test(s) ? s : null;
}

// ---- params against the catalog -----------------------------------------------------------------------------------

function cleanParam(p: ParamSpec, v: unknown): unknown {
  switch (p.type) {
    case 'number':
    case 'int': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (!finite(n)) return undefined;
      let x = clamp(n, p.min ?? -1e9, p.max ?? 1e9);
      if (p.type === 'int') x = Math.round(x);
      return x;
    }
    case 'bool':
      return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
    case 'choice':
      return typeof v === 'string' && (p.options ?? []).includes(v) ? v : undefined;
    case 'key':
      return typeof v === 'string' && CATALOG.keys.names.includes(v) ? v : undefined;
    case 'vec':
      return Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined;
    case 'counter':
      if (v === '') return '';
      return cleanName(v) ?? undefined;
    case 'tag':
      return cleanName(v) ?? (typeof v === 'string' && validId(v) ? v : undefined);
    default:
      return typeof v === 'string' ? v.slice(0, 200) : finite(v) ? String(v) : undefined;
  }
}

/**
 * Params checked against a catalog entry: unknown names are dropped, bad values are dropped (so the default applies),
 * numbers are clamped to min/max. With `fill`, every missing param gets its default.
 */
export function cleanParams(entry: CatalogEntry | undefined, params: unknown, fill = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const src = isObj(params) ? params : {};
  for (const p of entry?.params ?? []) {
    const v = p.name in src ? cleanParam(p, src[p.name]) : undefined;
    if (v !== undefined) out[p.name] = v;
  }
  return fill ? withDefaults(entry, out) : out;
}

function cleanBehavior(b: unknown, taken: Set<string>, warn: (s: string) => void): BehaviorDef | null {
  if (!isObj(b) || typeof b.type !== 'string' || !BEHAVIORS.has(b.type)) {
    warn(`unknown behaviour ${isObj(b) ? String(b.type) : '?'}`);
    return null;
  }
  let id = validId(b.id) && !taken.has(b.id) ? b.id : '';
  if (!id) id = freshId('b', taken);
  taken.add(id);
  const out: BehaviorDef = { id, type: b.type, params: cleanParams(BEHAVIORS.get(b.type), b.params, true) };
  if (b.off === true) out.off = true;
  return out;
}

function cleanCondition(c: unknown): Condition | null {
  if (!isObj(c)) return null;
  const counter = cleanName(c.counter);
  if (!counter) return null;
  const op = typeof c.op === 'string' && ['>=', '<=', '==', '!=', '>', '<'].includes(c.op) ? (c.op as Condition['op']) : '>=';
  return { subject: typeof c.subject === 'string' && c.subject ? c.subject.slice(0, 40) : 'self', counter, op, value: finite(c.value) ? c.value : 0 };
}

/** A rule checked against the catalog (null when its event is unknown or no known action is left). */
export function cleanRule(r: unknown, taken: Set<string>, warn: (s: string) => void): SRule | null {
  const n = normalizeRule(r, '');
  if (!EVENTS.has(n.when.type)) {
    warn(`unknown event ${n.when.type}`);
    return null;
  }
  const then = n.then.filter((a) => {
    if (ACTIONS.has(a.type)) return true;
    warn(`unknown action ${a.type}`);
    return false;
  }).slice(0, 8).map((a) => ({ type: a.type, params: cleanParams(ACTIONS.get(a.type), a.params, true) }));
  if (!then.length) {
    warn('rule without actions');
    return null;
  }
  let id = validId(n.id) && !taken.has(n.id) ? n.id : '';
  if (!id) id = freshId('r', taken);
  taken.add(id);
  return {
    id,
    when: { type: n.when.type, params: cleanParams(EVENTS.get(n.when.type), n.when.params, true) },
    conditions: n.conditions.map(cleanCondition).filter((c): c is Condition => !!c).slice(0, 4),
    then,
    once: n.once,
    off: n.off,
    text: n.text ? n.text.slice(0, 200) : null,
  };
}

function cleanJoint(j: unknown, self: string): JointDef | null {
  if (!isObj(j) || !['wheel', 'hinge', 'rope', 'weld', 'spring'].includes(String(j.type)) || !validId(j.to) || j.to === self) return null;
  const vec = (v: unknown): [number, number] => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : [0, 0]);
  const out: JointDef = { type: j.type as JointDef['type'], to: j.to, at: vec(j.at), to_at: vec(j.to_at), motor: j.motor === true, speed: finite(j.speed) ? j.speed : 0, stiffness: finite(j.stiffness) ? clamp(j.stiffness, 0, 1) : 0.5 };
  if (finite(j.length)) out.length = Math.max(0, j.length);
  return out;
}

function cleanCounters(base: Record<string, number>, patch: unknown, warn: (s: string) => void): Record<string, number> {
  const out = { ...base };
  if (!isObj(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    const name = cleanName(k);
    if (!name) { warn(`bad counter name ${k}`); continue; }
    if (v === null) delete out[name];
    else if (finite(v)) out[name] = v;
  }
  return out;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    const n = cleanName(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 8);
}

function cleanHudItem(i: unknown): HudItem | null {
  if (!isObj(i)) return null;
  const counter = cleanName(i.counter);
  if (!counter) return null;
  const style = ['number', 'bar', 'hearts', 'icons'].includes(String(i.style)) ? (i.style as HudItem['style']) : 'number';
  const out: HudItem = { subject: typeof i.subject === 'string' && i.subject ? i.subject.slice(0, 40) : 'game', counter, style };
  if (typeof i.label === 'string' && i.label) out.label = i.label.slice(0, 24);
  if (finite(i.max)) out.max = i.max;
  return out;
}

// ---- object patches -------------------------------------------------------------------------------------------------

/** Apply a partial ObjectDef (§5.2 update_object) to an object: physics deep-merged, counters merged, lists replaced. */
export function patchObject(o: SObj, data: Record<string, unknown>, warn: (s: string) => void): SObj {
  const next: SObj = { ...o };
  if (typeof data.name === 'string') next.name = data.name.slice(0, 32);
  if (typeof data.kind === 'string') next.kind = data.kind.trim().slice(0, 24) || 'thing';
  for (const k of ['x', 'y', 'rotation'] as const) if (finite(data[k])) next[k] = data[k] as number;
  if (finite(data.scale)) next.scale = clamp(data.scale, 0.05, 20);
  if (finite(data.layer)) next.layer = clamp(Math.round(data.layer), -10, 10);
  if (isObj(data.physics)) {
    const p = normalizePhysics({ ...o.physics, ...data.physics });
    p.density = clamp(p.density, 0.05, 50);
    p.friction = clamp(p.friction, 0, 2);
    p.bounce = clamp(p.bounce, 0, 1.5);
    p.gravity_scale = clamp(p.gravity_scale, -5, 5);
    if (!['none', 'static', 'dynamic', 'kinematic'].includes(p.body)) p.body = o.physics.body;
    if (!['auto', 'box', 'circle', 'line'].includes(p.shape)) p.shape = o.physics.shape;
    if (p.shape === 'line') p.body = 'static';
    next.physics = p;
  }
  if (Array.isArray(data.behaviors)) {
    const taken = new Set<string>();
    next.behaviors = data.behaviors.map((b) => cleanBehavior(b, taken, warn)).filter((b): b is BehaviorDef => !!b).slice(0, 12);
  }
  if (Array.isArray(data.rules)) {
    const taken = new Set<string>();
    next.rules = data.rules.map((r) => cleanRule(r, taken, warn)).filter((r): r is SRule => !!r).slice(0, 24);
  }
  if (isObj(data.counters)) next.counters = cleanCounters(o.counters, data.counters, warn);
  if (Array.isArray(data.tags)) next.tags = cleanTags(data.tags);
  if (Array.isArray(data.joints)) next.joints = data.joints.map((j) => cleanJoint(j, o.id)).filter((j): j is JointDef => !!j).slice(0, 8);
  if (typeof data.template === 'boolean') next.template = data.template;
  if (typeof data.hidden === 'boolean') next.hidden = data.hidden;
  if (data.player === 0 || data.player === 1 || data.player === 2) next.player = data.player;
  if (isObj(data.drawing)) {
    if ('strokes' in data.drawing) warn('update_object cannot change strokes');
    if (!o.drawing.strokes.length) {
      const w = finite(data.drawing.w) ? Math.max(0, data.drawing.w) : o.drawing.w;
      const h = finite(data.drawing.h) ? Math.max(0, data.drawing.h) : o.drawing.h;
      next.drawing = { ...o.drawing, w, h };
    }
  }
  if (next.physics.shape === 'line' && next.physics.body !== 'static') next.physics = { ...next.physics, body: 'static' };
  return next;
}

// ---- archetypes -----------------------------------------------------------------------------------------------------

export function archetypeFor(kind: string): Archetype | undefined {
  const k = kind.trim().toLowerCase();
  return CATALOG.archetypes.find((a) => a.kind === k || a.label.toLowerCase() === k);
}

/** The object acting like a catalog archetype: physics merged, behaviours added (defaults filled), counters, tags. */
export function applyArchetype(obj: SObj, kind: string): SObj {
  const a = archetypeFor(kind);
  if (!a) return { ...obj, kind: kind.trim().slice(0, 24) || obj.kind };
  return patchObject(obj, archetypePatch(obj, a), () => undefined);
}

function archetypePatch(obj: SObj, a: Archetype): Record<string, unknown> {
  const behaviors: unknown[] = obj.behaviors.map((b) => ({ ...b }));
  for (const nb of a.behaviors) {
    const i = behaviors.findIndex((b) => (b as BehaviorDef).type === nb.type);
    if (i >= 0) behaviors[i] = { ...(behaviors[i] as BehaviorDef), params: { ...(behaviors[i] as BehaviorDef).params, ...(nb.params ?? {}) }, off: undefined };
    else behaviors.push({ type: nb.type, params: nb.params ?? {} });
  }
  const tags = [...obj.tags];
  for (const t of a.tags ?? []) if (!tags.includes(t)) tags.push(t);
  const patch: Record<string, unknown> = {
    kind: a.kind,
    physics: { ...obj.physics, ...a.physics },
    behaviors,
    tags,
    counters: { ...(a.counters ?? {}), ...obj.counters },
  };
  if (a.player !== undefined) patch.player = a.player;
  if (a.template) patch.template = true;
  return patch;
}

/**
 * The edits that make an object act like an archetype, as one undoable copilot-style step: the object update, the
 * camera following it (archetypes with `camera`), and an ask to draw wheels for a car without any.
 */
export function archetypeEdits(doc: SDoc, sceneId: string, objId: string, kind: string): StudioEdit[] {
  const sc = sceneOf(doc, sceneId);
  const o = sc.objects.find((x) => x.id === objId);
  const a = archetypeFor(kind);
  if (!o) return [];
  if (!a) return [{ action: 'update_object', target: objId, scene: sc.id, data: { kind: kind.trim().slice(0, 24) } }];
  const edits: StudioEdit[] = [{ action: 'update_object', target: objId, scene: sc.id, data: archetypePatch(o, a) }];
  if (a.camera && sc.world.camera.mode === 'fixed' && (sc.world.width > 1700 || sc.world.height > 1000)) {
    edits.push({ action: 'set_world', scene: sc.id, data: { camera: { mode: 'follow', target: objId } } });
  }
  if (a.wheels && !o.joints.some((j) => j.type === 'wheel')) {
    const taken = allObjectIds(doc);
    const half = Math.max(o.drawing.w * o.scale, 40) / 2;
    const r = Math.max(14, Math.min(60, o.drawing.h * o.scale * 0.35));
    for (const [i, dx] of [-half * 0.6, half * 0.6].entries()) {
      const wid = freshId('wheel', taken);
      taken.add(wid);
      edits.push({ action: 'add_joint', target: objId, scene: sc.id, data: { type: 'wheel', to: wid, at: [Math.round(dx / o.scale), Math.round((o.drawing.h / 2))], motor: true } });
      edits.push({
        action: 'ask_draw', scene: sc.id,
        data: { id: wid, prompt: i === 0 ? 'Draw the back wheel' : 'Draw the front wheel', object: { kind: 'wheel', name: i === 0 ? 'Back wheel' : 'Front wheel', physics: { body: 'dynamic', shape: 'circle', friction: 1.2 }, tags: ['wheel'], x: Math.round(o.x + dx), y: Math.round(o.y + o.drawing.h * o.scale / 2), drawing: { w: r * 2, h: r * 2 } } },
      });
    }
  }
  return edits;
}

// ---- applyEdits -----------------------------------------------------------------------------------------------------

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out as T;
}

type RuleOwner = { kind: 'object'; id: string } | { kind: 'scene' } | { kind: 'game' };

function ownerOf(target: string | null | undefined): RuleOwner {
  if (!target || target === '@game') return { kind: 'game' };
  if (target === '@scene') return { kind: 'scene' };
  return { kind: 'object', id: target };
}

/** Apply StudioEdits in order (§5.2). Bad edits are skipped with a warning; nothing throws. */
export function applyEdits(input: SDoc | unknown, sceneId: string, edits: StudioEdit[], ctx: ApplyContext = {}): ApplyResult {
  let doc: SDoc = isSDoc(input) ? input : normalizeDoc(input);
  const warnings: string[] = [];
  const created: string[] = [];
  const asks: AskDraw[] = [];

  for (const [n, e] of (Array.isArray(edits) ? edits : []).entries()) {
    const warn = (s: string): void => { warnings.push(`edit ${n + 1} (${isObj(e) ? String(e.action) : '?'}): ${s}`); };
    if (!isObj(e) || typeof e.action !== 'string') { warn('not an edit'); continue; }
    const data: Record<string, unknown> = isObj(e.data) ? e.data : {};
    const sid = typeof e.scene === 'string' && e.scene ? e.scene : sceneId;
    const scene: SScene | undefined = doc.scenes.find((s) => s.id === sid) ?? (e.scene ? undefined : doc.scenes[0]);
    if (!scene && e.action !== 'add_scene' && e.action !== 'set_title' && e.action !== 'set_theme' && e.action !== 'set_hud' && e.action !== 'set_game_counters') {
      warn(`no scene ${sid}`);
      continue;
    }
    const sc = scene ?? doc.scenes[0];
    const objIndex = (id: unknown): number => (typeof id === 'string' ? sc.objects.findIndex((o) => o.id === id) : -1);
    const putObject = (o: SObj): void => {
      const i = objIndex(o.id);
      const objects = sc.objects.slice();
      if (i >= 0) objects[i] = o;
      else objects.push(o);
      doc = withScene(doc, { ...sc, objects });
    };
    const needObject = (): SObj | null => {
      const i = objIndex(e.target);
      if (i < 0) { warn(`no object ${String(e.target)}`); return null; }
      return sc.objects[i];
    };

    switch (e.action) {
      case 'set_world': {
        const merged = deepMerge(sc.world as unknown as Record<string, unknown>, data);
        const w = normalizeWorld(merged);
        w.width = clamp(w.width, 320, 40000);
        w.height = clamp(w.height, 240, 20000);
        w.camera.speed = clamp(w.camera.speed, 0, 2000);
        w.camera.zoom = clamp(w.camera.zoom, 0.11, 5);
        if (w.camera.target && !validId(w.camera.target)) w.camera.target = null;
        doc = withScene(doc, { ...sc, world: w });
        break;
      }
      case 'set_theme': {
        if (typeof data.preset === 'string') {
          const p = (ctx.themes ?? []).find((t) => t.id === data.preset || t.name?.toLowerCase() === String(data.preset).toLowerCase());
          if (!p) { warn(`no theme preset ${data.preset}`); break; }
          const { preset: _preset, ...rest } = data;
          doc = { ...doc, theme: normalizeTheme(deepMerge(normalizeTheme(p) as Record<string, unknown>, rest)) };
        } else {
          const merged = normalizeTheme(deepMerge(doc.theme as Record<string, unknown>, data));
          const pal: Record<string, string> = {};
          for (const [k, v] of Object.entries(merged.palette ?? {})) if (typeof v === 'string' && HEX_RE.test(v)) pal[k] = v;
          merged.palette = pal;
          doc = { ...doc, theme: merged };
        }
        break;
      }
      case 'set_hud': {
        const items = Array.isArray(data.items) ? data.items.map(cleanHudItem).filter((i): i is HudItem => !!i).slice(0, 8) : [];
        doc = { ...doc, hud: { items, timer: data.timer === true, title: typeof data.title === 'string' && data.title ? data.title.slice(0, 40) : null } };
        break;
      }
      case 'set_title': {
        const title = typeof data.title === 'string' ? data.title.trim().slice(0, 60) : '';
        if (!title) { warn('empty title'); break; }
        doc = { ...doc, title };
        break;
      }
      case 'add_scene': {
        if (doc.scenes.length >= 40) { warn('too many scenes'); break; }
        const taken = new Set(doc.scenes.map((s) => s.id));
        const id = validId(data.id) && !taken.has(data.id) ? data.id : freshId('s', taken);
        const from = typeof data.copy_from === 'string' ? doc.scenes.find((s) => s.id === data.copy_from) : undefined;
        if (data.copy_from && !from) warn(`no scene ${String(data.copy_from)} to copy`);
        const world = normalizeWorld(deepMerge((from?.world ?? sc.world) as unknown as Record<string, unknown>, isObj(data.world) ? data.world : {}));
        const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 40) : `Level ${doc.scenes.length + 1}`;
        const objects = from ? from.objects.map((o) => normalizeObject(JSON.parse(JSON.stringify(o)))) : [];
        const rules = from ? from.rules.map((r) => normalizeRule(JSON.parse(JSON.stringify(r)))) : [];
        doc = { ...doc, scenes: [...doc.scenes, { id, name, world, objects, rules }] };
        break;
      }
      case 'update_object': {
        const i = objIndex(e.target);
        if (i >= 0) {
          putObject(patchObject(sc.objects[i], data, warn));
          break;
        }
        if (sc.objects.length >= 600) { warn('too many objects'); break; }
        const taken = allObjectIds(doc);
        const id = validId(e.target) && !taken.has(e.target) ? e.target : freshId(typeof data.kind === 'string' ? data.kind : 'o', taken);
        const d = isObj(data.drawing) ? data.drawing : {};
        if (!finite(d.w) || !finite(d.h) || !finite(data.x) || !finite(data.y)) warn('new object without a box or position; using defaults');
        const base = normalizeObject({
          id, kind: 'thing',
          x: finite(data.x) ? data.x : sc.world.width / 2, y: finite(data.y) ? data.y : sc.world.height / 2,
          drawing: { strokes: [], w: finite(d.w) ? Math.max(0, d.w) : 80, h: finite(d.h) ? Math.max(0, d.h) : 80 },
        });
        const { drawing: _drawing, ...rest } = data;
        putObject(patchObject(base, rest, warn));
        created.push(id);
        break;
      }
      case 'delete_object': {
        const o = needObject();
        if (!o) break;
        const objects = sc.objects.filter((x) => x.id !== o.id).map((x) => (x.joints.some((j) => j.to === o.id) ? { ...x, joints: x.joints.filter((j) => j.to !== o.id) } : x));
        const world = sc.world.camera.target === o.id ? { ...sc.world, camera: { ...sc.world.camera, target: null } } : sc.world;
        doc = withScene(doc, { ...sc, world, objects });
        break;
      }
      case 'duplicate_object': {
        const o = needObject();
        if (!o) break;
        const count = clamp(Math.round(finite(data.count) ? data.count : 1), 1, 50);
        const dx = finite(data.dx) ? data.dx : 40;
        const dy = finite(data.dy) ? data.dy : finite(data.dx) ? 0 : 40;
        const taken = allObjectIds(doc);
        const prefix = o.id.replace(/\d+$/, '') || 'o';
        const copies: SObj[] = [];
        for (let k = 0; k < count; k++) {
          const id = freshId(prefix, taken);
          taken.add(id);
          const x = finite(data.x) ? data.x + dx * k : o.x + dx * (k + 1);
          const y = finite(data.y) ? data.y + dy * k : o.y + dy * (k + 1);
          copies.push({ ...o, id, x, y, joints: [], behaviors: o.behaviors.map((b) => ({ ...b, params: { ...b.params } })), rules: o.rules.map((r) => normalizeRule(JSON.parse(JSON.stringify(r)))), counters: { ...o.counters }, tags: [...o.tags] });
          created.push(id);
        }
        if (o.joints.length) warn('copies do not keep joints');
        const at = objIndex(o.id);
        const objects = [...sc.objects.slice(0, at + 1), ...copies, ...sc.objects.slice(at + 1)];
        doc = withScene(doc, { ...sc, objects: objects.slice(0, 600) });
        break;
      }
      case 'add_behavior': {
        const o = needObject();
        if (!o) break;
        if (typeof data.type !== 'string' || !BEHAVIORS.has(data.type)) { warn(`unknown behaviour ${String(data.type)}`); break; }
        const same = o.behaviors.findIndex((b) => b.type === data.type && (!validId(data.id) || b.id === data.id));
        if (same >= 0) {
          const b = o.behaviors[same];
          const nb: BehaviorDef = { ...b, type: data.type, params: { ...b.params, ...cleanParams(BEHAVIORS.get(data.type), data.params) } };
          if (data.off === true) nb.off = true;
          else delete nb.off;
          putObject({ ...o, behaviors: o.behaviors.map((x, k) => (k === same ? nb : x)) });
          break;
        }
        if (o.behaviors.length >= 12) { warn('too many behaviours'); break; }
        const nb = cleanBehavior(data, new Set(o.behaviors.map((b) => b.id)), warn);
        if (nb) putObject({ ...o, behaviors: [...o.behaviors, nb] });
        break;
      }
      case 'update_behavior': {
        const o = needObject();
        if (!o) break;
        const k = o.behaviors.findIndex((b) => b.id === data.id) >= 0 ? o.behaviors.findIndex((b) => b.id === data.id) : o.behaviors.findIndex((b) => b.type === data.type);
        if (k < 0) { warn(`no behaviour ${String(data.id ?? data.type)}`); break; }
        const b = o.behaviors[k];
        const nb: BehaviorDef = { ...b, params: { ...b.params, ...cleanParams(BEHAVIORS.get(b.type), data.params) } };
        if (data.off === true) nb.off = true;
        else if (data.off === false || data.off === null) delete nb.off;
        putObject({ ...o, behaviors: o.behaviors.map((x, j) => (j === k ? nb : x)) });
        break;
      }
      case 'remove_behavior': {
        const o = needObject();
        if (!o) break;
        const byId = o.behaviors.some((b) => b.id === data.id);
        const left = o.behaviors.filter((b) => (byId ? b.id !== data.id : b.type !== data.type));
        if (left.length === o.behaviors.length) { warn(`no behaviour ${String(data.id ?? data.type)}`); break; }
        putObject({ ...o, behaviors: left });
        break;
      }
      case 'add_rule':
      case 'update_rule':
      case 'remove_rule': {
        const owner = ownerOf(e.target);
        let list: SRule[];
        let objAt = -1;
        if (owner.kind === 'game') list = doc.rules;
        else if (owner.kind === 'scene') list = sc.rules;
        else {
          objAt = objIndex(owner.id);
          if (objAt < 0) { warn(`no object ${owner.id}`); break; }
          list = sc.objects[objAt].rules;
        }
        let next: SRule[] | null = null;
        if (e.action === 'add_rule') {
          const max = owner.kind === 'object' ? 24 : 48;
          if (list.length >= max) { warn('too many rules'); break; }
          const r = cleanRule(data, new Set(list.map((x) => x.id)), warn);
          if (r) next = [...list, r];
        } else if (e.action === 'update_rule') {
          const k = list.findIndex((r) => r.id === data.id);
          if (k < 0) { warn(`no rule ${String(data.id)}`); break; }
          const old = list[k];
          const merged = { ...old, ...data, when: isObj(data.when) ? data.when : old.when, id: old.id };
          const r = cleanRule(merged, new Set(list.filter((_, j) => j !== k).map((x) => x.id)), warn);
          if (r) {
            if (data.off === false) r.off = null;
            next = list.map((x, j) => (j === k ? r : x));
          }
        } else {
          next = list.filter((r) => r.id !== data.id);
          if (next.length === list.length) { warn(`no rule ${String(data.id)}`); next = null; }
        }
        if (!next) break;
        if (owner.kind === 'game') doc = { ...doc, rules: next };
        else if (owner.kind === 'scene') doc = withScene(doc, { ...sc, rules: next });
        else putObject({ ...sc.objects[objAt], rules: next });
        break;
      }
      case 'add_joint': {
        const o = needObject();
        if (!o) break;
        const j = cleanJoint(data, o.id);
        if (!j) { warn('bad joint'); break; }
        const joints = o.joints.filter((x) => !(x.to === j.to && x.type === j.type));
        if (joints.length >= 8) { warn('too many joints'); break; }
        putObject({ ...o, joints: [...joints, j] });
        break;
      }
      case 'set_counters': {
        const o = needObject();
        if (!o) break;
        putObject({ ...o, counters: cleanCounters(o.counters, data.counters, warn) });
        break;
      }
      case 'set_game_counters':
        doc = { ...doc, counters: cleanCounters(doc.counters, data.counters, warn) };
        break;
      case 'ask_draw': {
        const obj = isObj(data.object) ? data.object : {};
        const taken = new Set([...asks.map((a) => a.id)]);
        const id = validId(data.id) && !taken.has(data.id) ? data.id : freshId(typeof obj.kind === 'string' ? obj.kind : 'o', new Set([...taken, ...allObjectIds(doc)]));
        const prompt = typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt.trim().slice(0, 120) : 'Draw something';
        asks.push({ id, prompt, object: { ...obj }, scene: sc.id });
        break;
      }
      default:
        warn('unknown action');
    }
  }
  return { doc, warnings, created, asks };
}

/**
 * The maker finished drawing an object while an ask_draw was pending: the drawn object becomes the ask's id with
 * its settings. If an invisible placeholder with that id exists, it takes the drawing (and keeps its other settings).
 */
export function fulfilAsk(doc: SDoc, sceneId: string, drawnId: string, ask: AskDraw): { doc: SDoc; id: string } {
  const sc = sceneOf(doc, sceneId);
  const drawn = sc.objects.find((o) => o.id === drawnId);
  if (!drawn) return { doc, id: drawnId };
  const { x: _x, y: _y, drawing: _d, id: _id, ...settings } = ask.object as Record<string, unknown>;
  const holder = sc.objects.find((o) => o.id === ask.id);
  if (holder && holder.id !== drawnId && !holder.drawing.strokes.length) {
    const merged = recentre({ ...holder, x: drawn.x, y: drawn.y, rotation: drawn.rotation, scale: drawn.scale, drawing: drawn.drawing });
    const objects = sc.objects.filter((o) => o.id !== drawnId).map((o) => (o.id === holder.id ? patchObject(merged, settings, () => undefined) : o));
    return { doc: withScene(doc, { ...sc, objects }), id: holder.id };
  }
  const id = holder && holder.id !== drawnId ? freshId(ask.id, allObjectIds(doc)) : ask.id;
  const renamed = patchObject({ ...drawn, id }, settings, () => undefined);
  const objects = sc.objects.map((o) => (o.id === drawnId ? renamed : o));
  return { doc: withScene(doc, { ...sc, objects }), id };
}
