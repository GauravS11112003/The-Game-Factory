/**
 * The working scene the edit vocabulary operates on: SceneGraph objects plus the build state that the format
 * does not store per object (start, fitted creatures, par, timer, drift budgets). The state rides along in the
 * returned graph as the extension key `x_work`, so a BuildResult is enough to resume (candidates, sandboxes).
 */
import { WORLD } from '../params.ts';
import { PROFILES } from '../sim/profiles.ts';
import type { PhysicsProfile } from '../sim/types.ts';
import type {
  Behavior, BNpc, BPickup, BPortal, BZone, CellXY, EditOp, GameRules, InkDoc, LibraryType, PlaytestReport, Role, RuleV4, SceneGraph,
  SceneObject, Setpiece, Shape, SurfaceSeg, Tier,
} from '../types.gen.ts';
import { segsBBox, surfaceYAt } from '../build/fit.ts';
import { clone, overlap1, q16, rectGap } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';

export interface WorkState {
  start: CellXY | null;
  start_near: string | null; // U6 set_start
  fitted: string[]; // N13 applied
  trimmed: string[]; // N8 trimmed patrols
  par_ms: number | null;
  timer_s: number | null;
  drift: Record<string, number>; // per object |dx|+|dy| (R and designer moves) vs the Faithful base
  drift_r: number; // Σ R cell-moves (≤ 8)
  drift_d: number; // Σ designer cell-moves (≤ 10)
  added: string[]; // designer-added object ids, in order
  reprised: boolean;
  repair_alts: RepairAlt[]; // the repair search's alternatives, for DESIGN repair_choices
  logic?: RuleV4[]; // v4: the level's typed rules (CONTRACTS_V4 §2.4), set by build only when there are some
}

export interface RepairAlt {
  group: string; // alts group id, e.g. "alts.wall_too_tall.o7"
  kind: string; // failure kind
  chosen: string[]; // applied edit ids
  options: { cid: string; ops: EditOp[]; cost: number }[]; // the chosen one first
}

export interface Work {
  objs: SceneObject[];
  st: WorkState;
  setpieces: Setpiece[];
  intent: string | null;
  wish: SceneGraph['difficulty_wish'];
  title: string | null;
  safety: SceneGraph['safety'];
  world: { w: number; h: number; screens: number };
}

export interface Ctx {
  ink: InkDoc | null;
  library: LibraryType[];
  rules: GameRules;
  profile: PhysicsProfile;
  tier: Tier;
  report: PlaytestReport | null; // the latest report (slots, fastest time)
  parentIds?: ReadonlySet<string>;
}

export function emptyState(): WorkState {
  return { start: null, start_near: null, fitted: [], trimmed: [], par_ms: null, timer_s: null, drift: {}, drift_r: 0, drift_d: 0, added: [], reprised: false, repair_alts: [] };
}

export function profileOf(rules: GameRules): PhysicsProfile {
  return PROFILES[rules.physics_profile ?? 'v2-standard'] ?? PROFILES['v2-standard'];
}

export function workFromGraph(g: SceneGraph, world: { w: number; h?: number; screens: number }): Work {
  const x = (g as SceneGraph & { x_work?: WorkState }).x_work;
  return {
    objs: clone(g.objects ?? []),
    st: x ? { ...emptyState(), ...clone(x) } : emptyState(),
    setpieces: clone(g.setpieces ?? []),
    intent: g.intent ?? null,
    wish: g.difficulty_wish ?? 'none',
    title: g.title ?? null,
    safety: g.safety ?? 'unchecked',
    world: { w: world.w, h: world.h ?? WORLD.h, screens: world.screens },
  };
}

export function graphOf(w: Work): SceneGraph {
  const g: SceneGraph & { x_work?: WorkState } = {
    objects: w.objs, setpieces: w.setpieces, intent: w.intent, difficulty_wish: w.wish, title: w.title, safety: w.safety,
  };
  g.x_work = w.st;
  return g;
}

export function cloneWork(w: Work): Work {
  return { ...w, objs: clone(w.objs), st: clone(w.st), setpieces: clone(w.setpieces), world: { ...w.world } };
}

export function obj(w: Work, id: string | null | undefined): SceneObject | undefined {
  if (!id) return undefined;
  return w.objs.find((o) => o.id === id);
}

// ---- shapes ------------------------------------------------------------------------------------

export function shapeBBox(s: Shape): Rect {
  switch (s.k) {
    case 'surface':
      return s.fill === 'to_top' ? (() => {
        const b = segsBBox(s.segs, 0);
        return [b[0], b[1] - 1, b[2], b[3]] as Rect;
      })() : segsBBox(s.segs, 1);
    case 'strip':
      return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]) - (s.a[1] === s.b[1] ? 0.4 : 0), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
    case 'body':
      return [s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]];
    case 'point':
      return [s.p[0] - 0.3, s.p[1] - 0.3, s.p[0] + 0.3, s.p[1] + 0.3];
    case 'wall':
      return [s.x, s.y0, s.x + (s.w ?? 1), s.y1];
  }
}

export function objBBox(o: SceneObject): Rect {
  return shapeBBox(o.shape);
}

export function translateShape(s: Shape, dx: number, dy: number): Shape {
  switch (s.k) {
    case 'surface':
      return { ...s, segs: s.segs.map((g) => ({ a: [g.a[0] + dx, g.a[1] + dy], b: [g.b[0] + dx, g.b[1] + dy], slope: g.slope })) };
    case 'strip':
      return { ...s, a: [q16(s.a[0] + dx), q16(s.a[1] + dy)], b: [q16(s.b[0] + dx), q16(s.b[1] + dy)] };
    case 'body':
      return { ...s, bbox: [q16(s.bbox[0] + dx), q16(s.bbox[1] + dy), q16(s.bbox[2] + dx), q16(s.bbox[3] + dy)] };
    case 'point':
      return { ...s, p: [q16(s.p[0] + dx), q16(s.p[1] + dy)] };
    case 'wall':
      return { ...s, x: s.x + dx, y0: s.y0 + dy, y1: s.y1 + dy };
  }
}

/** Length used by size(o) (§3.6): surface span, wall height, otherwise the bbox's longer side. */
export function objLength(o: SceneObject): number {
  const s = o.shape;
  if (s.k === 'surface') {
    const b = segsBBox(s.segs, 0);
    return b[2] - b[0];
  }
  if (s.k === 'wall') return s.y1 - s.y0;
  if (s.k === 'strip') return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  const b = objBBox(o);
  return Math.max(b[2] - b[0], b[3] - b[1]);
}

export function isSurface(o: SceneObject): o is SceneObject & { shape: { k: 'surface'; segs: SurfaceSeg[]; fill: 'to_bottom' | 'one_row' | 'to_top' | 'none' } } {
  return o.shape.k === 'surface';
}

export function isFloor(o: SceneObject): boolean {
  return isSurface(o) && o.shape.k === 'surface' && o.shape.fill !== 'to_top' && (o.collision === 'solid' || o.collision === 'one_way') && !o.rel.part_of && !isDynamic(o) && !(o.behavior && isV4(o.behavior));
}

export function isWallLike(o: SceneObject): boolean {
  return o.shape.k === 'wall' && (o.role === 'wall' || o.role === 'door') && o.collision === 'solid';
}

/** Moving, crumbling or falling (compiled as an entity, not tiles). */
export function isDynamic(o: SceneObject): boolean {
  const b = o.behavior;
  return !!b && (b.kind === 'move' || b.kind === 'crumble' || b.kind === 'falling');
}

/** v4 primitives (CONTRACTS_V4 §5): portal, zone, pickup and npc behaviours compile to their own entities, never tiles. */
export function isV4(b: Behavior): b is BPortal | BZone | BPickup | BNpc {
  return b.kind === 'portal' || b.kind === 'zone' || b.kind === 'pickup' || b.kind === 'npc';
}

/** Top line of an object's standable face at x (surfaces: lattice height; walls: y0), or null. */
export function topAt(o: SceneObject, x: number): number | null {
  const s = o.shape;
  if (s.k === 'surface') return s.fill === 'to_top' ? null : surfaceYAt(s.segs, x);
  if (s.k === 'wall') return x >= s.x && x <= s.x + (s.w ?? 1) ? s.y0 : null;
  return null;
}

export function surfaceSpan(o: SceneObject): [number, number] {
  const b = objBBox(o);
  return [b[0], b[2]];
}

/** The floor (surface or wall top) at x whose top is the first at or below y (feet line), within maxDy. */
export function floorBelow(w: Work, x: number, y: number, maxDy = 27, exclude?: ReadonlySet<string>): { o: SceneObject; y: number } | null {
  let best: { o: SceneObject; y: number } | null = null;
  for (const o of w.objs) {
    if (exclude?.has(o.id)) continue;
    if (!(isFloor(o) || isWallLike(o))) continue;
    const t = topAt(o, x);
    if (t === null || t < y - 0.51 || t - y > maxDy) continue;
    if (!best || t < best.y) best = { o, y: t };
  }
  return best;
}

/** Every object whose bbox overlaps r (optionally grown). */
export function objectsNear(w: Work, r: Rect, d = 0, pred?: (o: SceneObject) => boolean): SceneObject[] {
  return w.objs.filter((o) => (!pred || pred(o)) && rectGap(objBBox(o), r) <= d);
}

/** The whole group an op moves: the root, its parts, and what rests on or attaches to any member [M fail 5]. */
export function carriedGroup(w: Work, rootId: string): string[] {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of w.objs) {
      if (out.has(o.id)) continue;
      const r = o.rel;
      const carried = (r.part_of && out.has(r.part_of)) || (r.rests_on && out.has(r.rests_on)) || (r.attached && out.has(r.attached.host));
      if (carried) {
        out.add(o.id);
        grew = true;
      }
    }
  }
  return [...out];
}

export function isKid(o: SceneObject): boolean {
  return o.origin === 'kid' || o.origin === 'parent' || o.origin === 'migrated';
}

export function screensOf(w: Work): number {
  return w.world.screens;
}

export function screenOfX(x: number): number {
  return Math.max(0, Math.floor(x / WORLD.screen_w));
}

export function overlapFrac(a: Rect, b: Rect): number {
  const o = overlap1(a[0], a[2], b[0], b[2]);
  return o / Math.max(1e-6, Math.min(a[2] - a[0], b[2] - b[0]));
}

export function countRole(w: Work, role: Role, pred?: (o: SceneObject) => boolean): number {
  return w.objs.filter((o) => o.role === role && (!pred || pred(o))).length;
}

/** Designer-added object id for an edit: deterministic from the edit's hash. */
export function addedId(prefix: string, editId: string, k = 0): string {
  const h = editId.slice(editId.lastIndexOf(':') + 1);
  return k ? `e_${prefix}_${h}_${k}` : `e_${prefix}_${h}`;
}
