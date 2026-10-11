/**
 * GameDoc → the runtime's normalized model. Never throws: anything malformed takes the spec default, unknown behaviour /
 * event / action types are dropped with one error each (docs/v6/CONTRACTS_V6.md §4.1), params are resolved against the
 * catalog (params.ts). Pure (no DOM, no Phaser).
 */
import type { Drawing, GameDoc, StudioTheme } from '../../core/types.gen.ts';
import { ACTIONS, BEHAVIORS, EVENTS } from '../model/catalog.ts';
import { resolveParams, type Params } from './params.ts';

export type Vec = [number, number];
export type BodyKind = 'none' | 'static' | 'dynamic' | 'kinematic';

export interface NPhysics {
  body: BodyKind;
  shape: 'auto' | 'box' | 'circle' | 'line';
  density: number;
  friction: number;
  bounce: number;
  fixed_rotation: boolean;
  sensor: boolean;
  gravity_scale: number;
}

export interface NBehavior {
  id: string;
  type: string;
  params: Params;
  off: boolean;
}

export interface NCondition {
  subject: string;
  counter: string;
  op: '>=' | '<=' | '==' | '!=' | '>' | '<';
  value: number;
}

export interface NAction {
  type: string;
  params: Params;
}

export interface NRule {
  id: string;
  when: { type: string; params: Params };
  conditions: NCondition[];
  then: NAction[];
  once: boolean;
  off: boolean;
}

export interface NJoint {
  type: 'wheel' | 'hinge' | 'rope' | 'weld' | 'spring';
  to: string;
  at: Vec;
  to_at: Vec;
  motor: boolean;
  speed: number;
  length: number | null;
  stiffness: number;
}

export interface NObject {
  id: string;
  name: string;
  kind: string;
  drawing: Drawing;
  w: number;
  h: number;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  layer: number;
  physics: NPhysics;
  behaviors: NBehavior[];
  rules: NRule[];
  counters: Record<string, number>;
  tags: string[];
  joints: NJoint[];
  template: boolean;
  hidden: boolean;
  player: 0 | 1 | 2;
  order: number;
}

export interface NCamera {
  mode: 'fixed' | 'follow' | 'auto_scroll';
  target: string | null;
  axis: 'x' | 'y' | 'xy';
  speed: number;
  zoom: number;
}

export interface NWorld {
  kind: string;
  width: number;
  height: number;
  gravity: Vec;
  camera: NCamera;
  edges: 'none' | 'walls' | 'wrap' | 'floor';
  players: 1 | 2;
}

export interface NHudItem {
  subject: string;
  counter: string;
  label: string | null;
  style: 'number' | 'bar' | 'hearts' | 'icons';
  max: number | null;
}

export interface NScene {
  id: string;
  name: string;
  world: NWorld;
  objects: NObject[];
  rules: NRule[];
}

export interface NDoc {
  id: string;
  title: string;
  theme: StudioTheme;
  hud: { items: NHudItem[]; timer: boolean; title: string | null };
  rules: NRule[];
  counters: Record<string, number>;
  scenes: NScene[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const n = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : d;
  return Math.max(lo, Math.min(hi, x));
};
const b = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);
function oneOf<T extends string>(v: unknown, list: readonly T[], d: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : d;
}
const vecOf = (v: unknown, d: Vec): Vec => (Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))
  ? [Number(v[0]), Number(v[1])] : d);

const NAME_RE = /^[a-z][a-z0-9 _]{0,23}$/;

export function counterMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    const key = k.trim().toLowerCase();
    if (NAME_RE.test(key) && typeof x === 'number' && Number.isFinite(x)) out[key] = x;
  }
  return out;
}

export class Normalizer {
  errors: string[] = [];
  private seen = new Set<string>();

  private error(kind: string, type: string): void {
    const k = `${kind}:${type}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.errors.push(`unknown ${kind} "${type}"`);
  }

  physics(v: unknown): NPhysics {
    const p = isObj(v) ? v : {};
    const shape = oneOf(p.shape, ['auto', 'box', 'circle', 'line'] as const, 'auto');
    let body = oneOf(p.body, ['none', 'static', 'dynamic', 'kinematic'] as const, 'static');
    if (shape === 'line' && body !== 'none') body = 'static';
    return {
      body,
      shape,
      density: n(p.density, 1, 0.05, 50),
      friction: n(p.friction, 0.4, 0, 2),
      bounce: n(p.bounce, 0, 0, 1.5),
      fixed_rotation: b(p.fixed_rotation),
      sensor: b(p.sensor),
      gravity_scale: n(p.gravity_scale, 1, -5, 5),
    };
  }

  behavior(v: unknown, i: number): NBehavior | null {
    if (!isObj(v)) return null;
    const type = s(v.type, '');
    const entry = BEHAVIORS.get(type);
    if (!entry) {
      this.error('behaviour', type || '?');
      return null;
    }
    return { id: s(v.id, `b${i + 1}`), type, params: resolveParams(entry, v.params), off: v.off === true };
  }

  rule(v: unknown, i: number): NRule | null {
    if (!isObj(v)) return null;
    const w = isObj(v.when) ? v.when : {};
    const type = s(w.type, '');
    const ev = EVENTS.get(type);
    if (!ev) {
      this.error('event', type || '?');
      return null;
    }
    const then: NAction[] = [];
    for (const a of arr(v.then)) {
      if (!isObj(a)) continue;
      const at = s(a.type, '');
      const entry = ACTIONS.get(at);
      if (!entry) {
        this.error('action', at || '?');
        continue;
      }
      then.push({ type: at, params: resolveParams(entry, a.params) });
    }
    const conditions: NCondition[] = [];
    for (const c of arr(v.conditions).slice(0, 4)) {
      if (!isObj(c)) continue;
      const counter = s(c.counter, '').trim().toLowerCase();
      if (!counter) continue;
      conditions.push({
        subject: s(c.subject, 'self') || 'self',
        counter,
        op: oneOf(c.op, ['>=', '<=', '==', '!=', '>', '<'] as const, '>='),
        value: n(c.value, 0),
      });
    }
    return { id: s(v.id, `r${i + 1}`), when: { type, params: resolveParams(ev, w.params) }, conditions, then, once: v.once === true,
      off: v.off === true };
  }

  rules(v: unknown): NRule[] {
    return arr(v).map((r, i) => this.rule(r, i)).filter((r): r is NRule => !!r);
  }

  joint(v: unknown): NJoint | null {
    if (!isObj(v)) return null;
    const type = oneOf(v.type, ['wheel', 'hinge', 'rope', 'weld', 'spring'] as const, 'hinge');
    const to = s(v.to, '');
    if (!to) return null;
    const len = typeof v.length === 'number' && Number.isFinite(v.length) && v.length >= 0 ? v.length : null;
    return { type, to, at: vecOf(v.at, [0, 0]), to_at: vecOf(v.to_at, [0, 0]), motor: b(v.motor), speed: n(v.speed, 0, -100000, 100000),
      length: len, stiffness: n(v.stiffness, 0.5, 0, 1) };
  }

  object(v: unknown, order: number): NObject | null {
    if (!isObj(v)) return null;
    const id = s(v.id, '');
    if (!id) return null;
    const d = isObj(v.drawing) ? (v.drawing as unknown as Drawing) : ({ strokes: [], w: 0, h: 0 } as Drawing);
    const strokes = Array.isArray(d.strokes) ? d.strokes : [];
    let w = n(d.w, 0, 0);
    let h = n(d.h, 0, 0);
    if ((!w || !h) && strokes.length) {
      // derive the box from the points when the editor did not
      let ex = 0;
      let ey = 0;
      for (const st of strokes) for (const p of arr((st as unknown as Obj)?.points)) {
        if (!Array.isArray(p)) continue;
        ex = Math.max(ex, Math.abs(Number(p[0]) || 0));
        ey = Math.max(ey, Math.abs(Number(p[1]) || 0));
      }
      w = w || ex * 2;
      h = h || ey * 2;
    }
    const tags = arr(v.tags).filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const player = v.player === 1 || v.player === 2 ? v.player : 0;
    return {
      id,
      name: s(v.name, ''),
      kind: s(v.kind, 'thing'),
      drawing: d,
      w,
      h,
      x: n(v.x, 0),
      y: n(v.y, 0),
      rotation: n(v.rotation, 0),
      scale: n(v.scale, 1, 0.01, 20),
      layer: Math.round(n(v.layer, 0, -10, 10)),
      physics: this.physics(v.physics),
      behaviors: arr(v.behaviors).map((x, i) => this.behavior(x, i)).filter((x): x is NBehavior => !!x),
      rules: this.rules(v.rules),
      counters: counterMap(v.counters),
      tags: [...new Set(tags)],
      joints: arr(v.joints).map((j) => this.joint(j)).filter((j): j is NJoint => !!j),
      template: v.template === true,
      hidden: v.hidden === true,
      player,
      order,
    };
  }

  world(v: unknown): NWorld {
    const w = isObj(v) ? v : {};
    const c = isObj(w.camera) ? w.camera : {};
    return {
      kind: s(w.kind, ''),
      width: n(w.width, 1600, 320, 40000),
      height: n(w.height, 900, 240, 20000),
      gravity: vecOf(w.gravity, [0, 1]),
      camera: {
        mode: oneOf(c.mode, ['fixed', 'follow', 'auto_scroll'] as const, 'fixed'),
        target: typeof c.target === 'string' && c.target ? c.target : null,
        axis: oneOf(c.axis, ['x', 'y', 'xy'] as const, 'xy'),
        speed: n(c.speed, 120, 0, 2000),
        zoom: n(c.zoom, 1, 0.1, 5),
      },
      edges: oneOf(w.edges, ['none', 'walls', 'wrap', 'floor'] as const, 'walls'),
      players: w.players === 2 ? 2 : 1,
    };
  }

  scene(v: unknown, i: number): NScene | null {
    if (!isObj(v)) return null;
    const ids = new Set<string>();
    const objects: NObject[] = [];
    arr(v.objects).forEach((o, k) => {
      const obj = this.object(o, k);
      if (obj && !ids.has(obj.id)) {
        ids.add(obj.id);
        objects.push(obj);
      }
    });
    return { id: s(v.id, `s${i + 1}`), name: s(v.name, `Level ${i + 1}`), world: this.world(v.world), objects, rules: this.rules(v.rules) };
  }

  doc(v: unknown): NDoc {
    const d = isObj(v) ? v : {};
    const hud = isObj(d.hud) ? d.hud : {};
    const items: NHudItem[] = [];
    for (const it of arr(hud.items).slice(0, 8)) {
      if (!isObj(it)) continue;
      const counter = s(it.counter, '').trim().toLowerCase();
      if (!counter) continue;
      items.push({
        subject: s(it.subject, 'game') || 'game',
        counter,
        label: typeof it.label === 'string' ? it.label : null,
        style: oneOf(it.style, ['number', 'bar', 'hearts', 'icons'] as const, 'number'),
        max: typeof it.max === 'number' && Number.isFinite(it.max) ? it.max : null,
      });
    }
    let scenes = arr(d.scenes).map((x, i) => this.scene(x, i)).filter((x): x is NScene => !!x);
    if (!scenes.length) scenes = [{ id: 's1', name: 'Level 1', world: this.world({}), objects: [], rules: [] }];
    return {
      id: s(d.id, 'game'),
      title: s(d.title, 'Untitled game'),
      theme: (isObj(d.theme) ? d.theme : {}) as StudioTheme,
      hud: { items, timer: hud.timer === true, title: typeof hud.title === 'string' ? hud.title : null },
      rules: this.rules(d.rules),
      counters: counterMap(d.counters),
      scenes,
    };
  }
}

/** Normalize a doc; `errors` lists each unknown behaviour / event / action type once. */
export function normalizeDoc(doc: GameDoc | unknown): { doc: NDoc; errors: string[] } {
  const nz = new Normalizer();
  let out: NDoc;
  try {
    out = nz.doc(doc);
  } catch {
    out = new Normalizer().doc({});
  }
  return { doc: out, errors: nz.errors };
}
