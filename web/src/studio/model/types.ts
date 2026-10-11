/**
 * The Studio editor's working shapes (docs/v6/CONTRACTS_V6.md §2): a GameDoc with every default filled in and plain
 * arrays instead of the generated max-length tuples, so the editor never has to ask "is this set?". `normalizeDoc`
 * turns any GameDoc (from the server, a template, a draft) into one; `asGameDoc` hands it back to APIs and the runtime.
 */
import type {
  ActionDef, BehaviorDef, CameraDef, Condition, GameDoc, HudItem, JointDef, PhysicsDef, Stroke, StudioEdit, StudioTheme,
  WorldDef,
} from '../../core/types.gen.ts';

export type Vec = [number, number];

export interface SDrawing { strokes: Stroke[]; w: number; h: number }
export type SPhysics = Required<PhysicsDef>;
export interface SRule {
  id: string;
  when: { type: string; params: Record<string, unknown> };
  conditions: Condition[];
  then: ActionDef[];
  once: boolean;
  off: boolean | null;
  text: string | null;
}
export interface SObj {
  id: string;
  name: string;
  kind: string;
  drawing: SDrawing;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  layer: number;
  physics: SPhysics;
  behaviors: BehaviorDef[];
  rules: SRule[];
  counters: Record<string, number>;
  tags: string[];
  joints: JointDef[];
  template: boolean;
  hidden: boolean;
  player: 0 | 1 | 2;
}
export interface SWorld {
  kind: string;
  width: number;
  height: number;
  gravity: Vec;
  camera: Required<Omit<CameraDef, 'target'>> & { target: string | null };
  edges: NonNullable<WorldDef['edges']>;
  players: 1 | 2;
}
export interface SScene { id: string; name: string; world: SWorld; objects: SObj[]; rules: SRule[] }
export interface SHud { items: HudItem[]; timer: boolean; title: string | null }
export interface SDoc {
  format: 'drawplay-studio';
  version: 1;
  id: string;
  title: string;
  author: string | null;
  theme: StudioTheme;
  hud: SHud;
  rules: SRule[];
  counters: Record<string, number>;
  scenes: SScene[];
  created_at: string | null;
  updated_at: string | null;
}

/** An `ask_draw` waiting for the maker: the next finished object becomes `id` with `object`'s settings. */
export interface AskDraw { id: string; prompt: string; object: Record<string, unknown>; scene: string }

export type Edit = StudioEdit;

export const PHYSICS_DEFAULTS: SPhysics = {
  body: 'static', shape: 'auto', density: 1, friction: 0.4, bounce: 0, fixed_rotation: false, sensor: false, gravity_scale: 1,
};

export const CAMERA_DEFAULTS: SWorld['camera'] = { mode: 'fixed', target: null, axis: 'xy', speed: 120, zoom: 1 };

export const WORLD_DEFAULTS: SWorld = {
  kind: '', width: 1600, height: 900, gravity: [0, 1], camera: CAMERA_DEFAULTS, edges: 'walls', players: 1,
};

export const THEME_FALLBACK: StudioTheme = {
  id: 'sketchbook',
  name: 'Sketchbook',
  palette: { bg: '#f6f1e7', ink: '#1f1b18', accent: '#e4572e', accent2: '#2e86ab', text: '#1f1b18', danger: '#d7263d', good: '#3bb273' },
  background: { style: 'paper', colors: ['#f6f1e7'], parallax: true },
  stroke: { style: 'marker', outline: null, width_scale: 1, glow: false, fill_closed: true, halftone: false, wobble: 0 },
  recolor: false,
  particles: 'dust',
  font: 'hand',
  music: 'upbeat',
};

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (isObj(v)) for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  return out;
};

export function normalizeRule(r: unknown, fallbackId = 'r1'): SRule {
  const o = isObj(r) ? r : {};
  const when = isObj(o.when) ? o.when : {};
  return {
    id: str(o.id, fallbackId) || fallbackId,
    when: { type: str(when.type, 'start'), params: isObj(when.params) ? { ...when.params } : {} },
    conditions: Array.isArray(o.conditions) ? (o.conditions as Condition[]).filter(isObj).map((c) => ({ ...c })) : [],
    then: Array.isArray(o.then) ? (o.then as ActionDef[]).filter(isObj).map((a) => ({ type: str(a.type, 'win'), params: isObj(a.params) ? { ...a.params } : {} })) : [],
    once: o.once === true,
    off: o.off === true ? true : null,
    text: typeof o.text === 'string' ? o.text : null,
  };
}

export function normalizePhysics(p: unknown): SPhysics {
  return { ...PHYSICS_DEFAULTS, ...(isObj(p) ? (p as Partial<SPhysics>) : {}) };
}

export function normalizeObject(o: unknown): SObj {
  const x = isObj(o) ? o : {};
  const d = isObj(x.drawing) ? x.drawing : {};
  const player = x.player === 1 || x.player === 2 ? x.player : 0;
  return {
    id: str(x.id, 'o1'),
    name: str(x.name, ''),
    kind: str(x.kind, 'thing') || 'thing',
    drawing: { strokes: Array.isArray(d.strokes) ? (d.strokes as Stroke[]) : [], w: num(d.w, 0), h: num(d.h, 0) },
    x: num(x.x, 0),
    y: num(x.y, 0),
    rotation: num(x.rotation, 0),
    scale: num(x.scale, 1) || 1,
    layer: num(x.layer, 0),
    physics: normalizePhysics(x.physics),
    behaviors: Array.isArray(x.behaviors) ? (x.behaviors as BehaviorDef[]).filter(isObj).map((b) => ({ ...b, params: isObj(b.params) ? { ...b.params } : {} })) : [],
    rules: Array.isArray(x.rules) ? x.rules.map((r, i) => normalizeRule(r, `r${i + 1}`)) : [],
    counters: numMap(x.counters),
    tags: Array.isArray(x.tags) ? (x.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    joints: Array.isArray(x.joints) ? (x.joints as JointDef[]).filter(isObj).map((j) => ({ ...j })) : [],
    template: x.template === true,
    hidden: x.hidden === true,
    player,
  };
}

export function normalizeWorld(w: unknown): SWorld {
  const x = isObj(w) ? w : {};
  const g = Array.isArray(x.gravity) && x.gravity.length === 2 ? ([num(x.gravity[0], 0), num(x.gravity[1], 1)] as Vec) : WORLD_DEFAULTS.gravity;
  const cam = isObj(x.camera) ? x.camera : {};
  return {
    kind: str(x.kind, ''),
    width: num(x.width, 1600),
    height: num(x.height, 900),
    gravity: [g[0], g[1]],
    camera: {
      mode: cam.mode === 'follow' || cam.mode === 'auto_scroll' ? cam.mode : 'fixed',
      target: typeof cam.target === 'string' && cam.target ? cam.target : null,
      axis: cam.axis === 'x' || cam.axis === 'y' ? cam.axis : 'xy',
      speed: num(cam.speed, 120),
      zoom: num(cam.zoom, 1) || 1,
    },
    edges: x.edges === 'none' || x.edges === 'wrap' || x.edges === 'floor' ? x.edges : 'walls',
    players: x.players === 2 ? 2 : 1,
  };
}

export function normalizeScene(s: unknown, i = 0): SScene {
  const x = isObj(s) ? s : {};
  return {
    id: str(x.id, `s${i + 1}`) || `s${i + 1}`,
    name: str(x.name, `Level ${i + 1}`),
    world: normalizeWorld(x.world),
    objects: Array.isArray(x.objects) ? x.objects.map(normalizeObject) : [],
    rules: Array.isArray(x.rules) ? x.rules.map((r, j) => normalizeRule(r, `r${j + 1}`)) : [],
  };
}

export function normalizeTheme(t: unknown): StudioTheme {
  const x = isObj(t) ? (t as StudioTheme) : {};
  return {
    ...THEME_FALLBACK,
    ...x,
    palette: { ...THEME_FALLBACK.palette, ...(isObj(x.palette) ? x.palette : {}) },
    background: { ...THEME_FALLBACK.background, ...(isObj(x.background) ? x.background : {}) },
    stroke: { ...THEME_FALLBACK.stroke, ...(isObj(x.stroke) ? x.stroke : {}) },
  };
}

/** Any GameDoc-ish value → a complete SDoc (never throws; unknown fields are dropped). */
export function normalizeDoc(doc: unknown): SDoc {
  const x = isObj(doc) ? doc : {};
  const hud = isObj(x.hud) ? x.hud : {};
  const scenes = Array.isArray(x.scenes) && x.scenes.length ? x.scenes.map(normalizeScene) : [normalizeScene({}, 0)];
  return {
    format: 'drawplay-studio',
    version: 1,
    id: str(x.id, 'local') || 'local',
    title: str(x.title, 'Untitled game'),
    author: typeof x.author === 'string' ? x.author : null,
    theme: normalizeTheme(x.theme),
    hud: {
      items: Array.isArray(hud.items) ? (hud.items as HudItem[]).filter(isObj).map((i) => ({ ...i })) : [],
      timer: hud.timer === true,
      title: typeof hud.title === 'string' ? hud.title : null,
    },
    rules: Array.isArray(x.rules) ? x.rules.map((r, i) => normalizeRule(r, `r${i + 1}`)) : [],
    counters: numMap(x.counters),
    scenes,
    created_at: typeof x.created_at === 'string' ? x.created_at : null,
    updated_at: typeof x.updated_at === 'string' ? x.updated_at : null,
  };
}

/** Is this already a complete SDoc (every object and scene filled in)? Cheap structural check. */
export function isSDoc(v: unknown): v is SDoc {
  if (!isObj(v) || v.format !== 'drawplay-studio' || !Array.isArray(v.scenes) || !v.scenes.length || !isObj(v.hud) || !Array.isArray(v.rules) || !isObj(v.counters) || !isObj(v.theme)) return false;
  for (const s of v.scenes as unknown[]) {
    if (!isObj(s) || !Array.isArray(s.objects) || !Array.isArray(s.rules) || !isObj(s.world) || !isObj((s.world as Record<string, unknown>).camera)) return false;
    for (const o of s.objects as unknown[]) {
      if (!isObj(o) || !isObj(o.physics) || !isObj(o.drawing) || !Array.isArray((o.drawing as Record<string, unknown>).strokes) || !Array.isArray(o.behaviors)
        || !Array.isArray(o.rules) || !isObj(o.counters) || !Array.isArray(o.tags) || !Array.isArray(o.joints)) return false;
    }
  }
  return true;
}

/** The SDoc as the generated GameDoc type (same JSON; the generated tuples are just stricter array types). */
export function asGameDoc(doc: SDoc): GameDoc {
  return doc as unknown as GameDoc;
}
