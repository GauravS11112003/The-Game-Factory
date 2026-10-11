/**
 * The Studio editor's working shapes (docs/v6/CONTRACTS_V6.md §2): a GameDoc with every default filled in and plain
 * arrays instead of the generated max-length tuples, so the editor never has to ask "is this set?". `normalizeDoc`
 * turns any GameDoc (from the server, a template, a draft) into one; `asGameDoc` hands it back to APIs and the runtime.
 */
import type {
  ActionDef, ArtDirection, ArtVariant, Backdrop, BackdropLayer, BehaviorDef, CameraDef, Condition, GameDoc, HudItem, JointDef,
  PhysicsDef, Stroke, StudioEdit, StudioTheme, TerrainSkin, WorldDef,
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
  /** v7: AI art variants and which look plays (absent = never drawn by Claude). */
  art?: SArt | null;
}
/** v7 ObjectArt with plain arrays (docs/v7/CONTRACTS_V7.md §1). */
export interface SArt {
  use: 'sketch' | 'ai';
  chosen: string | null;
  variants: ArtVariant[];
  terrain: TerrainSkin | null;
  asked: boolean;
}
export type SLook = 'game' | 'sketch';
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
/** Credit for a shared block used in this game (doc extension `x_credits`, v6 §9): shown on the play page. */
export interface StudioCredit { block_id: string; name: string; author: string; kind: 'object' | 'theme' }

export interface SDoc {
  /** Extension keys the server keeps: who made the blocks this game uses, and the game this one was remixed from. */
  x_credits?: StudioCredit[];
  x_remix_of?: string;
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
  /** v7: `game` plays the finished look (AI art, cleaned sketch, backdrop), `sketch` the raw strokes. Default game. */
  look?: SLook;
  /** v7: the one game-wide style guide every piece of AI art follows. */
  art_direction?: ArtDirection | null;
  /** v7: the AI-painted parallax world behind everything (replaces theme.background in the game look). */
  backdrop?: Backdrop | null;
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
    ...(isObj(x.art) ? { art: normalizeArt(x.art) } : {}),
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** One AI variant, or null when it is not usable (no id, no SVG, no box). */
export function normalizeVariant(v: unknown): ArtVariant | null {
  if (!isObj(v) || typeof v.id !== 'string' || !ID_RE.test(v.id) || typeof v.svg !== 'string' || !v.svg.trim()) return null;
  const w = num(v.w, 0);
  const h = num(v.h, 0);
  if (!(w > 0) || !(h > 0)) return null;
  const out: ArtVariant = { id: v.id, svg: v.svg, w, h, rev: Math.max(0, Math.round(num(v.rev, 0))) };
  if (typeof v.note === 'string' && v.note) out.note = v.note.slice(0, 200);
  return out;
}

export function normalizeVariants(v: unknown, max = 6): ArtVariant[] {
  const out: ArtVariant[] = [];
  if (!Array.isArray(v)) return out;
  for (const x of v) {
    const n = normalizeVariant(x);
    if (n && !out.some((o) => o.id === n.id)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

export function normalizeTerrain(t: unknown): TerrainSkin | null {
  if (!isObj(t)) return null;
  const fill = Array.isArray(t.fill) ? t.fill.filter((c): c is string => typeof c === 'string' && HEX6.test(c)).slice(0, 4) : [];
  const out: TerrainSkin = {
    fill: (fill.length ? fill : ['#8d6e63', '#5d4037']) as TerrainSkin['fill'],
    surface: typeof t.surface === 'string' && HEX6.test(t.surface) ? t.surface : '#3bb273',
    surface_width: Math.min(80, Math.max(0, num(t.surface_width, 14))),
    surface_svg: typeof t.surface_svg === 'string' && t.surface_svg.trim() ? t.surface_svg : null,
    texture_svg: typeof t.texture_svg === 'string' && t.texture_svg.trim() ? t.texture_svg : null,
    decor: normalizeVariants(t.decor) as TerrainSkin['decor'],
    decor_every: Math.min(4000, Math.max(40, num(t.decor_every, 220))),
    rev: Math.max(0, Math.round(num(t.rev, 0))),
  };
  return out;
}

/** Any ObjectArt-ish value → a complete SArt: `chosen` always names a variant when there is one; `ai` needs one. */
export function normalizeArt(a: unknown): SArt {
  const x = isObj(a) ? a : {};
  const variants = normalizeVariants(x.variants);
  const terrain = normalizeTerrain(x.terrain);
  let chosen = typeof x.chosen === 'string' && variants.some((v) => v.id === x.chosen) ? x.chosen : variants[0]?.id ?? null;
  if (!variants.length) chosen = null;
  const use = x.use === 'ai' && (variants.length > 0 || !!terrain) ? 'ai' : 'sketch';
  return { use, chosen, variants, terrain, asked: x.asked === true };
}

export function normalizeBackdrop(b: unknown): Backdrop | null {
  if (!isObj(b)) return null;
  const sky = Array.isArray(b.sky) ? b.sky.filter((c): c is string => typeof c === 'string' && HEX6.test(c)).slice(0, 4) : [];
  const layers: BackdropLayer[] = [];
  for (const l of Array.isArray(b.layers) ? b.layers : []) {
    if (!isObj(l) || typeof l.svg !== 'string' || !l.svg.trim()) continue;
    const w = num(l.w, 0);
    const h = num(l.h, 0);
    if (!(w > 0) || !(h > 0)) continue;
    layers.push({
      svg: l.svg, w, h,
      depth: Math.min(1, Math.max(0, num(l.depth, 0.5))),
      anchor: l.anchor === 'top' || l.anchor === 'fill' ? l.anchor : 'bottom',
      tile_x: l.tile_x !== false,
      height: Math.min(1, Math.max(0.01, num(l.height, 0.5))),
    });
    if (layers.length >= 4) break;
  }
  if (!sky.length && !layers.length) return null;
  return { rev: Math.max(0, Math.round(num(b.rev, 0))), sky: sky as Backdrop['sky'], layers: layers as Backdrop['layers'] };
}

export function normalizeDirection(d: unknown): ArtDirection | null {
  if (!isObj(d)) return null;
  const kinds: Record<string, string> = {};
  if (isObj(d.kinds)) for (const [k, v] of Object.entries(d.kinds)) if (typeof v === 'string' && k.trim()) kinds[k.trim().slice(0, 24)] = v.slice(0, 400);
  const palette = Array.isArray(d.palette) ? d.palette.filter((c): c is string => typeof c === 'string' && HEX6.test(c)).slice(0, 10) : [];
  const out: ArtDirection = {
    rev: Math.max(1, Math.round(num(d.rev, 1))),
    prompt: str(d.prompt, '').slice(0, 300),
    summary: str(d.summary, '').slice(0, 300),
    guide: str(d.guide, '').slice(0, 6000),
    palette: palette as ArtDirection['palette'],
    kinds,
  };
  if (!out.prompt && !out.summary && !out.guide && !palette.length && !Object.keys(kinds).length) return null;
  return out;
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
    ...(x.look === 'sketch' || x.look === 'game' ? { look: x.look } : {}),
    ...(normalizeDirection(x.art_direction) ? { art_direction: normalizeDirection(x.art_direction) } : {}),
    ...(normalizeBackdrop(x.backdrop) ? { backdrop: normalizeBackdrop(x.backdrop) } : {}),
    created_at: typeof x.created_at === 'string' ? x.created_at : null,
    updated_at: typeof x.updated_at === 'string' ? x.updated_at : null,
    ...(Array.isArray(x.x_credits) ? { x_credits: normalizeCredits(x.x_credits) } : {}),
    ...(typeof x.x_remix_of === 'string' ? { x_remix_of: x.x_remix_of } : {}),
  };
}

export function normalizeCredits(v: unknown): StudioCredit[] {
  if (!Array.isArray(v)) return [];
  const out: StudioCredit[] = [];
  for (const c of v) {
    if (!isObj(c) || typeof c.block_id !== 'string') continue;
    if (out.some((o) => o.block_id === c.block_id)) continue;
    out.push({ block_id: c.block_id, name: str(c.name, ''), author: str(c.author, ''), kind: c.kind === 'theme' ? 'theme' : 'object' });
  }
  return out.slice(0, 50);
}

/** The doc's credits with this block added (once per block). */
export function withCredit(credits: StudioCredit[] | undefined, c: StudioCredit): StudioCredit[] {
  return normalizeCredits([...(credits ?? []).filter((x) => x.block_id !== c.block_id), c]);
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
