/**
 * The 43-op vocabulary (§3.5): precondition + apply for every op, with bounds enforced here whoever proposes
 * the op (heuristic, model, kid, greedy). Targets are object ids; added content goes only into slots.
 * apply mutates the Work in place; callers clone first when they may roll back.
 */
import { EDIT_BOUNDS, ENEMIES, GRIDS, HAZARDS, PERCEPTION, WORLD } from '../params.ts';
import type {
  Behavior, EditBy, EditClass, EditOp, EnemyParams, Face, Ghost, MessageArgs, MessageRef, Role, SceneObject, Shape,
  SurfaceSeg, Tier,
} from '../types.gen.ts';
import { fitSurface, mergeSegs, surfaceYAt } from '../build/fit.ts';
import { shapeForStrokes } from '../scene/perceive.ts';
import { DEFAULT_COLLISION, roleAllowed, roleNoun } from '../scene/roles.ts';
import { clamp, q16, rectGap } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';
import { gMax } from './envelope.ts';
import { arcFeet, parseArc, parseGap, parseSlot } from './slots.ts';
import type { SlotSpec } from './slots.ts';
import {
  addedId, carriedGroup, floorBelow, isDynamic, isFloor, isKid, isSurface, isV4, isWallLike, obj, objBBox, objLength,
  screenOfX, topAt, translateShape,
} from './work.ts';
import type { Ctx, Work } from './work.ts';

export interface Move {
  id: string;
  dx: number;
  dy: number;
}

export type AddKind = 'pickup' | 'checkpoint' | 'arrow' | 'hazard' | 'enemy' | 'step' | 'spring';

export interface Outcome {
  ok: true;
  moved: Move[];
  trim: number;
  extend: number;
  roleChangeKid: boolean;
  collisionChangeKid: boolean;
  topology: boolean;
  pillar: boolean;
  adds: { what: AddKind; n: number }[];
  ghost: Ghost;
  args: MessageArgs;
  reason?: string;
  touched: string[];
  added: string[];
  noop?: boolean;
}

export interface Fail {
  ok: false;
  why: MessageRef;
}

export type Result = Outcome | Fail;

export interface RecMeta {
  id: string;
  by: EditBy;
  tier: Tier;
  cls: EditClass;
}

const TIER_RANK: Record<Tier, number> = { faithful: 0, polished: 1, normal: 2, hard: 3 };

export function fail(key: string, args: MessageArgs = {}): Fail {
  return { ok: false, why: { key, args } };
}

function out(partial: Partial<Outcome> & { touched: string[] }): Outcome {
  return {
    ok: true, moved: [], trim: 0, extend: 0, roleChangeKid: false, collisionChangeKid: false, topology: false, pillar: false,
    adds: [], ghost: { before: [], after: [] }, args: {}, added: [], ...partial,
  };
}

function r4(r: Rect): [number, number, number, number] {
  return [q16(r[0]), q16(r[1]), q16(r[2]), q16(r[3])];
}

function need(w: Work, id: string): SceneObject | Fail {
  const o = obj(w, id);
  return o ?? fail('reject.not_applicable', { what: id });
}

function isFail(x: unknown): x is Fail {
  return !!x && typeof x === 'object' && (x as Fail).ok === false;
}

function inkStrokes(o: SceneObject, ctx: Ctx) {
  if (!ctx.ink) return [];
  const ids = new Set(o.strokes);
  return ctx.ink.strokes.filter((s) => ids.has(s.id));
}

function startSupport(w: Work): SceneObject | null {
  const s = w.st.start;
  if (!s) return null;
  return floorBelow(w, s[0], s[1], 0.6)?.o ?? null;
}

function groundSpan(o: SceneObject): number {
  const b = objBBox(o);
  return b[2] - b[0];
}

// ---- surface geometry edits ------------------------------------------------------------------------

function segEnds(segs: readonly SurfaceSeg[]): { x0: number; y0: number; x1: number; y1: number } {
  const sorted = [...segs].sort((a, b) => a.a[0] - b.a[0]);
  const f = sorted[0];
  const l = sorted[sorted.length - 1];
  return { x0: f.a[0], y0: f.a[1], x1: l.b[0], y1: l.b[1] };
}

/** Cut a lattice surface to [xa, xb], snapping a cut inside a 1:2 run to its lattice. */
export function cutSegs(segs: readonly SurfaceSeg[], xa: number, xb: number): SurfaceSeg[] {
  const res: SurfaceSeg[] = [];
  for (const s of segs) {
    let a0 = Math.max(s.a[0], xa);
    let b0 = Math.min(s.b[0], xb);
    if (b0 <= a0) continue;
    const per = Math.abs(s.slope) === 0.5 ? 2 : 1;
    a0 = s.a[0] + Math.ceil((a0 - s.a[0]) / per - 1e-9) * per;
    b0 = s.a[0] + Math.floor((b0 - s.a[0]) / per + 1e-9) * per;
    if (b0 <= a0) continue;
    res.push({ a: [a0, s.a[1] + s.slope * (a0 - s.a[0])], b: [b0, s.a[1] + s.slope * (b0 - s.a[0])], slope: s.slope });
  }
  return res;
}

function trimSurface(o: SceneObject, side: 'left' | 'right', cells: number): number | Fail {
  if (o.shape.k !== 'surface') return fail('reject.not_applicable');
  const e = segEnds(o.shape.segs);
  const len = e.x1 - e.x0;
  if (len - cells < EDIT_BOUNDS.trim_min_result_c) return fail('reject.out_of_bounds', { cells });
  const segs = side === 'left' ? cutSegs(o.shape.segs, e.x0 + cells, e.x1) : cutSegs(o.shape.segs, e.x0, e.x1 - cells);
  if (!segs.length) return fail('reject.out_of_bounds');
  const ne = segEnds(segs);
  o.shape = { ...o.shape, segs: mergeSegs(segs) };
  return len - (ne.x1 - ne.x0);
}

function extendSurface(o: SceneObject, side: 'left' | 'right', cells: number, worldW: number): number | Fail {
  if (o.shape.k !== 'surface') return fail('reject.not_applicable');
  const e = segEnds(o.shape.segs);
  const segs = [...o.shape.segs.map((s) => ({ a: [s.a[0], s.a[1]] as [number, number], b: [s.b[0], s.b[1]] as [number, number], slope: s.slope }))];
  if (side === 'left') {
    const x = Math.max(0, e.x0 - cells);
    if (x >= e.x0) return fail('reject.out_of_bounds');
    segs.unshift({ a: [x, e.y0], b: [e.x0, e.y0], slope: 0 });
  } else {
    const x = Math.min(worldW, e.x1 + cells);
    if (x <= e.x1) return fail('reject.out_of_bounds');
    segs.push({ a: [e.x1, e.y1], b: [x, e.y1], slope: 0 });
  }
  o.shape = { ...o.shape, segs: mergeSegs(segs.sort((a, b) => a.a[0] - b.a[0])) };
  return cells;
}

/** Cells [x0, x1) × [y0, y1) overlapping any other colliding object (for "into empty space"). */
function occupied(w: Work, r: Rect, except: ReadonlySet<string>): boolean {
  return w.objs.some((o) => !except.has(o.id) && !o.rel.part_of && (o.collision === 'solid' || o.collision === 'one_way' || o.collision === 'hazard') && overlapsArea(objBBox(o), r));
}

function overlapsArea(a: Rect, b: Rect): boolean {
  return a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
}

/** Kid surfaces whose horizontal gap to `o` is closed (≤ 0) after a change but was > 1 cell before. */
function closesKidGap(w: Work, o: SceneObject, before: Rect): boolean {
  const after = objBBox(o);
  for (const q of w.objs) {
    if (q === o || !isKid(q) || !(isFloor(q) || isWallLike(q))) continue;
    const qb = objBBox(q);
    const vy = Math.min(after[3], qb[3]) - Math.max(after[1], qb[1]);
    if (vy < 0) continue;
    const gapBefore = Math.max(qb[0] - before[2], before[0] - qb[2]);
    const gapAfter = Math.max(qb[0] - after[2], after[0] - qb[2]);
    if (gapBefore > 1 && gapAfter <= 0) return true;
  }
  return false;
}

function grounded(w: Work, o: SceneObject): boolean {
  if (o.shape.k !== 'wall') return false;
  const x = o.shape.x + (o.shape.w ?? 1) / 2;
  if (o.shape.y1 >= w.world.h) return true;
  const f = floorBelow(w, x, o.shape.y1, 0.6, new Set([o.id]));
  return !!f;
}

// ---- moves -----------------------------------------------------------------------------------------

function moveGroup(w: Work, root: string, dx: number, dy: number): Move[] {
  const ids = carriedGroup(w, root);
  const support = startSupport(w);
  const moves: Move[] = [];
  for (const id of ids) {
    const o = obj(w, id)!;
    o.shape = translateShape(o.shape, dx, dy);
    moves.push({ id, dx, dy });
  }
  // the start rides on a moved support
  if (w.st.start && support && ids.includes(support.id)) w.st.start = [q16(w.st.start[0] + dx), q16(w.st.start[1] + dy)];
  return moves;
}

// ---- slots -------------------------------------------------------------------------------------------

function slotOf(id: string): SlotSpec | Fail {
  const s = parseSlot(id);
  return s ?? fail('reject.not_applicable', { what: id });
}

function addObject(w: Work, o: SceneObject): void {
  w.objs.push(o);
  w.st.added.push(o.id);
}

function designerObj(id: string, role: Role, shape: Shape, extra: Partial<SceneObject> = {}): SceneObject {
  return {
    id, components: [], strokes: [], role, conf: 1, role_by: 'designer', origin: 'designer', shape,
    collision: DEFAULT_COLLISION[role], rel: {}, behavior: null, pinned: [], alt: [], lib: null, text: null, ...extra,
  };
}

function inScreen(w: Work, x: number, pred: (o: SceneObject) => boolean): number {
  const s = screenOfX(x);
  return w.objs.filter((o) => pred(o) && screenOfX((objBBox(o)[0] + objBBox(o)[2]) / 2) === s).length;
}

function nearHazard(w: Work, r: Rect, d: number): boolean {
  return w.objs.some((o) => !o.rel.part_of && (o.role === 'spikes' || o.role === 'lava' || o.role === 'saw' || o.role === 'enemy') && rectGap(enemyPathRect(o), r) < d);
}

function enemyPathRect(o: SceneObject): Rect {
  const b = objBBox(o);
  const beh = o.behavior;
  if (beh && beh.kind === 'enemy' && (beh.archetype === 'walker' || beh.archetype === 'chaser')) return [b[0] - 3, b[1], b[2] + 3, b[3]];
  if (beh && beh.kind === 'saw' && beh.cells) return [b[0] - beh.cells, b[1] - beh.cells, b[2] + beh.cells, b[3] + beh.cells];
  return b;
}

function spawnPoints(w: Work): [number, number][] {
  const pts: [number, number][] = [];
  if (w.st.start) pts.push([w.st.start[0], w.st.start[1]]);
  for (const o of w.objs) if (o.role === 'checkpoint') {
    const b = objBBox(o);
    pts.push([(b[0] + b[2]) / 2, b[3]]);
  }
  return pts;
}

function farFromSpawns(w: Work, r: Rect, d: number): boolean {
  return spawnPoints(w).every(([x, y]) => rectGap(r, [x - 0.01, y - 1.5, x + 0.01, y]) >= d);
}

/** Flat standable run (cells) around x on the host top at y, and headroom above it. */
function flatRun(w: Work, host: SceneObject | undefined, x: number): { x0: number; x1: number; y: number } | null {
  if (!host) return null;
  const y = topAt(host, x);
  if (y === null) return null;
  let x0 = Math.floor(x);
  let x1 = Math.floor(x) + 1;
  while (x0 - 1 >= 0 && topAt(host, x0 - 0.5) === y && !blockedAbove(w, x0 - 1, y)) x0--;
  while (x1 < w.world.w && topAt(host, x1 + 0.5) === y && !blockedAbove(w, x1, y)) x1++;
  return { x0, x1, y };
}

function blockedAbove(w: Work, c: number, y: number): boolean {
  const r: Rect = [c + 0.05, y - 1.9, c + 0.95, y - 0.05];
  return w.objs.some((o) => !o.rel.part_of && (o.collision === 'solid' || o.collision === 'hazard') && overlapsArea(objBBox(o), r));
}

function headroom(w: Work, x: number, y: number): number {
  let h = 0;
  for (let k = 1; k <= 8; k++) {
    const r: Rect = [x - 0.4, y - k, x + 0.4, y - k + 1];
    if (w.objs.some((o) => !o.rel.part_of && (o.collision === 'solid' || o.collision === 'one_way') && overlapsArea(objBBox(o), r))) break;
    h = k;
  }
  return h;
}

// ---- param grids (P6 tune) -------------------------------------------------------------------------

type GridName = keyof typeof GRIDS;

function gridFor(o: SceneObject, param: string): { grid: readonly number[]; get: () => number | null; set: (v: number) => void } | null {
  const b = o.behavior;
  if (!b) return null;
  const pick = (name: GridName) => GRIDS[name].grid as readonly number[];
  if (b.kind === 'enemy') {
    const p: EnemyParams = (b.params ??= {});
    const a = b.archetype;
    if (param === 'speed' && (a === 'walker' || a === 'flyer' || a === 'chaser')) {
      const grid = pick(a === 'chaser' ? 'chaser_speed' : a === 'flyer' ? 'flyer_speed' : 'walker_speed');
      const def = a === 'chaser' ? ENEMIES.chaser.speed : a === 'flyer' ? ENEMIES.flyer.speed : ENEMIES.walker.speed;
      return { grid, get: () => p.speed ?? def, set: (v) => (p.speed = v) };
    }
    if (param === 'interval' && (a === 'hopper' || a === 'shooter')) {
      const grid = pick(a === 'hopper' ? 'hopper_interval' : 'shooter_interval');
      const def = a === 'hopper' ? ENEMIES.hopper.interval : ENEMIES.shooter.interval;
      return { grid, get: () => p.interval ?? def, set: (v) => (p.interval = v) };
    }
    if ((param === 'warn' || param === 'interval') && a === 'crusher') return { grid: pick('crusher_warn'), get: () => p.warn ?? ENEMIES.crusher.warn, set: (v) => (p.warn = v) };
    return null;
  }
  if (b.kind === 'move' && param === 'speed') return { grid: pick('platform_speed'), get: () => b.speed, set: (v) => (b.speed = v) };
  if (b.kind === 'saw' && param === 'speed') return { grid: pick('saw_speed'), get: () => b.speed ?? HAZARDS.saw.speed, set: (v) => (b.speed = v) };
  if (b.kind === 'crumble' && (param === 'delay' || param === 'speed' || param === 'interval')) return { grid: pick('crumble_delay'), get: () => b.delay_s ?? 0.5, set: (v) => (b.delay_s = v) };
  if (b.kind === 'firebar' && param === 'speed') return { grid: pick('firebar_speed'), get: () => b.speed_deg_s ?? 90, set: (v) => (b.speed_deg_s = v) };
  return null;
}

/** Next index on a grid that is sorted easy → hard. */
function gridStep(grid: readonly number[], v: number, step: number): number | null {
  let i = 0;
  let bd = Infinity;
  grid.forEach((g, k) => {
    if (Math.abs(g - v) < bd) {
      bd = Math.abs(g - v);
      i = k;
    }
  });
  const j = i + step;
  return j < grid.length ? grid[j] : null;
}

// ---- the ops ---------------------------------------------------------------------------------------

export function applyOp(w: Work, op: EditOp, ctx: Ctx, rec: RecMeta): Result {
  switch (op.op) {
    // ---------------- U · Understand ----------------
    case 'set_role': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (o.role === op.role) return out({ touched: [o.id], noop: true });
      const color = inkStrokes(o, ctx)[0]?.color ?? null;
      if (color && !roleAllowed(color, op.role)) return fail('reject.not_applicable', { role: op.role });
      const sup = startSupport(w);
      if (sup && sup.id === o.id && DEFAULT_COLLISION[op.role] !== 'solid' && DEFAULT_COLLISION[op.role] !== 'one_way') return fail('reject.start_support');
      const before = r4(objBBox(o));
      const kid = isKid(o);
      const strokes = inkStrokes(o, ctx);
      if (strokes.length) o.shape = shapeForStrokes(op.role, o.id, o.components, strokes, w.world.w);
      else if (op.role === 'decoration' || op.role === 'unknown' || op.role === 'text') o.shape = { k: 'body', bbox: before };
      const collisionBefore = o.collision;
      o.role = op.role;
      o.collision = DEFAULT_COLLISION[op.role];
      o.role_by = rec.by === 'kid' ? 'kid' : rec.by === 'model' ? 'model' : rec.by === 'parser' ? 'parser' : rec.by === 'library' ? 'library' : 'heuristic';
      const xc = (op as EditOp & { x_conf?: number }).x_conf;
      o.conf = rec.by === 'kid' ? 1 : clamp(typeof xc === 'number' ? xc : 0.9, 0, 1);
      if (rec.by === 'kid' && !o.pinned.includes('role')) o.pinned = [...o.pinned, 'role'].sort();
      for (const pid of o.rel.parts ?? []) {
        const p = obj(w, pid);
        if (p && p.role !== 'pole') p.role = op.role === 'goal' || op.role === 'checkpoint' ? p.role : op.role;
      }
      if (op.role !== 'enemy' && o.behavior?.kind === 'enemy') o.behavior = null;
      return out({ touched: [o.id], roleChangeKid: kid, collisionChangeKid: kid && collisionBefore !== o.collision, ghost: { before: [before], after: [r4(objBBox(o))] }, args: { role: roleNoun(op.role) } });
    }
    case 'group': {
      const root = need(w, op.root);
      if (isFail(root)) return root;
      const rb = objBBox(root);
      const parts: string[] = [];
      for (const pid of op.parts) {
        const p = obj(w, pid);
        if (!p || p === root) continue;
        if (rectGap(objBBox(p), rb) > EDIT_BOUNDS.group_part_max_c) return fail('reject.out_of_bounds', { cells: EDIT_BOUNDS.group_part_max_c });
        parts.push(pid);
      }
      if (!parts.length) return fail('reject.not_applicable');
      for (const pid of parts) {
        const p = obj(w, pid)!;
        p.rel = { ...p.rel, part_of: root.id };
        p.collision = 'none';
        if (p.role !== 'pole') p.role = root.role;
      }
      root.rel = { ...root.rel, parts: [...new Set([...(root.rel.parts ?? []), ...parts])].sort() };
      return out({ touched: [root.id, ...parts], ghost: { before: [r4(rb)], after: [r4(rb)] } });
    }
    case 'detach': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (!o.strokes.includes(op.branch) || o.strokes.length < 2) return fail('reject.not_applicable');
      const s = ctx.ink?.strokes.find((x) => x.id === op.branch);
      if (!s) return fail('reject.not_applicable');
      const sb = shapeForStrokes('text', `${o.id}_x`, o.components, [s], w.world.w);
      const bb = sb.k === 'body' ? sb.bbox : objBBox({ ...o, shape: sb });
      if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > EDIT_BOUNDS.detach_max_area_c2 + 1e-6) return fail('reject.out_of_bounds');
      const before = r4(objBBox(o));
      o.strokes = o.strokes.filter((x) => x !== op.branch);
      const rest = inkStrokes(o, ctx);
      if (rest.length && o.shape.k !== 'body' && o.shape.k !== 'point') o.shape = shapeForStrokes(o.role, o.id, o.components, rest, w.world.w);
      const hints = (o as SceneObject & { x_detach?: { branch: string; into: string | null }[] }).x_detach ?? [];
      const intoId = hints.find((h) => h.branch === op.branch)?.into ?? null;
      const into = intoId ? obj(w, intoId) : undefined;
      if (into) {
        into.strokes = [...into.strokes, op.branch];
        into.components = [...new Set([...into.components, ...o.components])].sort((a, b) => a - b);
        const all = inkStrokes(into, ctx);
        if (all.length) into.shape = shapeForStrokes(into.role, into.id, into.components, all, w.world.w);
      } else {
        const id = `${o.id}_${op.branch.replace(/[^A-Za-z0-9]/g, '')}`;
        if (!obj(w, id)) {
          w.objs.push({
            id, components: [...o.components], strokes: [op.branch], role: 'text', conf: 0.85, role_by: 'heuristic', origin: o.origin,
            shape: { k: 'body', bbox: r4(bb) }, collision: 'none', rel: {}, behavior: null, pinned: [], alt: [], lib: null, text: null,
          });
        }
      }
      return out({ touched: [o.id], ghost: { before: [before], after: [r4(objBBox(o)), r4(bb)] } });
    }
    case 'bind': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      const b: Behavior = JSON.parse(JSON.stringify(op.behavior));
      if ((b.kind === 'move' || b.kind === 'crumble' || b.kind === 'falling') && o.role === 'ground' && groundSpan(o) > PERCEPTION.ground_no_move_screen_frac * WORLD.screen_w) return fail('reject.ground_stays');
      if ((b.kind === 'move' || b.kind === 'crumble' || b.kind === 'falling') && startSupport(w)?.id === o.id && b.kind === 'move') return fail('reject.start_support');
      if (b.kind === 'move') {
        // clip the path to the world (U4)
        const bb = objBBox(o);
        const room = b.dir === 'left' ? bb[0] : b.dir === 'right' ? w.world.w - bb[2] : b.dir === 'up' ? bb[1] : w.world.h - bb[3];
        b.cells = clamp(Math.round(b.cells), 0, Math.max(0, Math.floor(room)));
        b.speed = clamp(b.speed, 1, 6);
      }
      if (b.kind === 'saw' && b.cells != null) b.cells = clamp(Math.round(b.cells), 0, 12);
      if (b.kind === 'spring') b.strength = clamp(b.strength ?? 1, 0.6, 1.4);
      const pin = ((op as EditOp & { x_pinned?: string[] }).x_pinned ?? []).filter((x) => typeof x === 'string');
      if (o.pinned.includes('behavior') && rec.by !== 'kid') return fail('reject.pinned');
      o.behavior = b.kind === 'static' ? { kind: 'static' } : b;
      if (isV4(b)) {
        // v4 primitives (CONTRACTS_V4 §5) are their own entities: no terrain, no contact damage, a body box
        o.role = 'decoration';
        o.collision = 'none';
        if (o.shape.k !== 'body') o.shape = { k: 'body', bbox: r4(objBBox(o)) };
        if (op.hidden === true) (o as SceneObject & { x_hidden?: boolean }).x_hidden = true;
      }
      if (b.kind === 'enemy' && o.role !== 'enemy' && roleAllowed(inkStrokes(o, ctx)[0]?.color ?? 'red', 'enemy')) {
        o.role = 'enemy';
        o.collision = 'hazard';
      }
      if (b.kind === 'spring' && o.role !== 'spring') {
        o.role = 'spring';
        o.collision = 'solid';
      }
      if ((b.kind === 'saw' || b.kind === 'firebar') && o.role !== 'saw') {
        o.role = 'saw';
        o.collision = 'hazard';
      }
      // a creature, spring or saw is a body, whatever terrain shape it had
      if ((o.role === 'enemy' || o.role === 'spring' || o.role === 'saw') && (o.shape.k === 'surface' || o.shape.k === 'wall')) o.shape = { k: 'body', bbox: r4(objBBox(o)) };
      o.pinned = [...new Set([...o.pinned, ...pin, ...(b.kind === 'static' ? ['archetype'] : [])])].sort();
      const r = r4(objBBox(o));
      return out({ touched: [o.id], ghost: { before: [r], after: [r] }, args: { what: roleNoun(o.role) } });
    }
    case 'link': {
      const k = need(w, op.key);
      if (isFail(k)) return k;
      const d = need(w, op.door);
      if (isFail(d)) return d;
      if (d.shape.k !== 'wall' && d.role !== 'door') return fail('reject.not_applicable');
      k.rel = { ...k.rel, refers_to: d.id };
      d.rel = { ...d.rel, refers_to: k.id };
      const kid = isKid(d) && d.role !== 'door';
      if (d.role !== 'door') {
        d.role = 'door';
        d.collision = 'solid';
      }
      if (k.role !== 'key') k.role = 'key';
      return out({ touched: [k.id, d.id], roleChangeKid: kid, ghost: { before: [r4(objBBox(k))], after: [r4(objBBox(d))] } });
    }
    case 'set_start': {
      const o = need(w, op.near);
      if (isFail(o)) return o;
      w.st.start_near = o.id;
      return out({ touched: [o.id], ghost: { before: [], after: [r4(objBBox(o))] } });
    }
    case 'use_library': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      const t = ctx.library.find((l) => l.id === op.type_id && l.version === op.version);
      if (!t) return fail('reject.not_applicable');
      const before = r4(objBBox(o));
      o.lib = { type_id: t.id, version: t.version };
      const hb = t.behavior;
      const v4 = isV4(hb);
      const role: Role = v4 ? 'decoration' : t.kind === 'creature' ? 'enemy' : t.kind === 'platform' ? 'platform'
        : t.kind === 'hazard' ? (hb.kind === 'saw' || hb.kind === 'firebar' ? 'saw' : 'spikes') : t.kind === 'pickup' ? 'coin' : 'decoration';
      o.role = role;
      o.role_by = 'library';
      o.conf = 1;
      o.collision = role === 'enemy' || role === 'saw' || role === 'spikes' ? 'hazard' : role === 'coin' || role === 'decoration' ? 'none' : t.collision;
      // v4 primitives (portal, zone, pickup, npc) keep their behaviour: compile turns it into the entity (CONTRACTS_V4 §5)
      o.behavior = v4 ? JSON.parse(JSON.stringify(hb)) : role === 'decoration' || role === 'coin' ? null : JSON.parse(JSON.stringify(hb));
      const hide = op.hidden === true || t.hidden === true;
      if (hide) (o as SceneObject & { x_hidden?: boolean }).x_hidden = true;
      if (o.behavior && o.behavior.kind === 'enemy' && t.spiky) o.behavior.spiky = true;
      // instance art: the type's drawing at its own size (§8.1), unless the kid toggled "use my new drawing"
      const own = !!(op as EditOp & { x_own_art?: boolean }).x_own_art;
      const [sw0, sh0] = t.art?.size_cells ?? [before[2] - before[0], before[3] - before[1]];
      const sw = own ? before[2] - before[0] : clamp(sw0, 0.5, 12);
      const sh = own ? before[3] - before[1] : clamp(sh0, 0.5, 12);
      const cx = (before[0] + before[2]) / 2;
      const flies = role === 'saw' || role === 'coin' || (o.behavior?.kind === 'enemy' && o.behavior.archetype === 'flyer');
      const cy = (before[1] + before[3]) / 2;
      const bottom = flies ? cy + sh / 2 : before[3];
      const box: Rect = [cx - sw / 2, bottom - sh, cx + sw / 2, bottom];
      if (role === 'platform') {
        const x0 = Math.round(box[0]);
        const x1 = Math.max(x0 + 1, Math.round(box[2]));
        const y = Math.round(box[1]);
        o.shape = { k: 'surface', segs: [{ a: [x0, y], b: [x1, y], slope: 0 }], fill: 'one_row' };
        if (t.behavior.kind === 'static') o.behavior = null;
      } else if (role === 'spikes') {
        o.shape = { k: 'strip', a: [q16(box[0]), q16(box[3])], b: [q16(box[2]), q16(box[3])] };
        o.behavior = null;
      } else if (role === 'coin') o.shape = { k: 'point', p: [q16(cx), q16(cy)] };
      else o.shape = { k: 'body', bbox: r4(box) };
      // the parts of a glyph (eyes, a circled letter's inner glyph) belong to the instance
      for (const pid of o.rel.parts ?? []) {
        const p = obj(w, pid);
        if (p && p.role !== 'pole') {
          p.role = role;
          p.collision = 'none';
        }
      }
      return out({ touched: [o.id], roleChangeKid: false, ghost: { before: [before], after: [r4(objBBox(o))] }, args: { name: t.name } });
    }

    // ---------------- N · Normalize ----------------
    case 'straighten': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (o.shape.k !== 'surface') return fail('reject.not_applicable');
      const strokes = inkStrokes(o, ctx);
      if (!strokes.length) return out({ touched: [o.id], noop: true });
      const before = r4(objBBox(o));
      const f = fitSurface(strokes, o.shape.fill === 'to_top' ? 'ceiling' : 'floor', w.world.w);
      const maxShift = Math.min(op.max_shift ?? EDIT_BOUNDS.straighten_max_shift_c, EDIT_BOUNDS.straighten_max_shift_c);
      if (f.maxShift > maxShift + 0.15) return fail('reject.out_of_bounds', { cells: maxShift });
      o.shape = { ...o.shape, segs: f.fitted };
      const ramps = f.fitted.filter((s) => s.slope !== 0).length;
      return out({ touched: [o.id], ghost: { before: [before], after: [r4(objBBox(o))] }, args: { n: 1, bumps: f.bumpsRaw, ramps } });
    }
    case 'close_gap':
    case 'join_seam': {
      const a = need(w, op.a);
      if (isFail(a)) return a;
      const b = need(w, op.b);
      if (isFail(b)) return b;
      if (a.shape.k !== 'surface' || b.shape.k !== 'surface') return fail('reject.not_applicable');
      const ea = segEnds(a.shape.segs);
      const eb = segEnds(b.shape.segs);
      const [L, R, eL, eR] = ea.x1 <= eb.x0 ? [a, b, ea, eb] : [b, a, eb, ea];
      const gap = eR.x0 - eL.x1;
      const dy = Math.abs(eR.y0 - eL.y1);
      const bound = op.op === 'close_gap' ? EDIT_BOUNDS.close_gap : { max_gap_c: EDIT_BOUNDS.join_seam.max_c * 2, max_dy_c: EDIT_BOUNDS.join_seam.max_dy_c };
      // N11 also joins paper seams whose ends touch or overlap by a hair (C-6 §3); N2 needs a real gap
      const minGap = op.op === 'join_seam' ? -2 * EDIT_BOUNDS.join_seam.max_c : 0;
      if (gap < minGap - 1e-6 || gap > bound.max_gap_c + 1e-6 || dy > bound.max_dy_c + 1e-6) return fail('reject.out_of_bounds');
      const gr: Rect = [eL.x1, Math.min(eL.y1, eR.y0) - 1.5, eR.x0, Math.max(eL.y1, eR.y0) + 0.5];
      if (w.objs.some((o) => (o.role === 'spikes' || o.role === 'lava' || o.role === 'saw') && overlapsArea(objBBox(o), gr))) return fail('reject.hazard_in_gap');
      if (L.shape.k !== 'surface') return fail('reject.not_applicable');
      const before = r4(objBBox(L));
      // a seam with a 1-row height change becomes one 1:2 ramp across the averaged seam point (§6.4), never a step
      if (op.op === 'join_seam' && dy > 1e-6 && gap < 2 && R.shape.k === 'surface') {
        const seam = Math.round((eL.x1 + eR.x0) / 2);
        const xa = seam - 1;
        const xb = seam + 1;
        const yl = surfaceYAt(L.shape.segs, Math.min(xa, eL.x1));
        const yr = surfaceYAt(R.shape.segs, Math.max(xb, eR.x0));
        if (yl !== null && yr !== null && xa > eL.x0 + 0.5 && xb < eR.x1 - 0.5 && Math.abs(yr - yl) <= 1 + 1e-6) {
          const left = cutSegs(L.shape.segs, eL.x0, xa);
          const right = cutSegs(R.shape.segs, xb, eR.x1);
          if (left.length && right.length) {
            L.shape = { ...L.shape, segs: mergeSegs([...left, { a: [xa, yl], b: [xb, yr], slope: (yr - yl) / 2 }]) };
            R.shape = { ...R.shape, segs: right };
            return out({ touched: [L.id, R.id], extend: Math.max(0, gap), ghost: { before: [before], after: [r4(objBBox(L))] } });
          }
        }
      }
      const segs = [...L.shape.segs];
      if (gap > 0) {
        if (eR.y0 === eL.y1) segs.push({ a: [eL.x1, eL.y1], b: [eR.x0, eL.y1], slope: 0 });
        else if (gap >= 2) segs.push({ a: [eL.x1, eL.y1], b: [eL.x1 + 2, eR.y0], slope: (eR.y0 - eL.y1) / 2 }, ...(gap > 2 ? [{ a: [eL.x1 + 2, eR.y0] as [number, number], b: [eR.x0, eR.y0] as [number, number], slope: 0 }] : []));
        else segs.push({ a: [eL.x1, eL.y1], b: [eR.x0, eL.y1], slope: 0 });
      }
      L.shape = { ...L.shape, segs: mergeSegs(segs) };
      void R;
      return out({ touched: [L.id, R.id], extend: gap, ghost: { before: [before], after: [r4(objBBox(L))] } });
    }
    case 'snap': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      const h = need(w, op.host);
      if (isFail(h)) return h;
      return snapTo(w, o, h, op.face);
    }
    case 'orient': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (o.rel.points === op.facing) return out({ touched: [o.id], noop: true });
      o.rel = { ...o.rel, points: op.facing };
      if (o.behavior?.kind === 'spring' && (op.facing === 'up' || op.facing === 'left' || op.facing === 'right')) o.behavior.dir = op.facing;
      const r = r4(objBBox(o));
      return out({ touched: [o.id], ghost: { before: [r], after: [r] }, args: { facing: op.facing } });
    }
    case 'form_goal': {
      const f = need(w, op.flag);
      if (isFail(f)) return f;
      const pole = op.pole ? obj(w, op.pole) : undefined;
      const before = r4(objBBox(f));
      if (pole) {
        pole.role = 'pole';
        pole.collision = 'none';
        pole.rel = { ...pole.rel, part_of: f.id };
        f.rel = { ...f.rel, parts: [...new Set([...(f.rel.parts ?? []), pole.id])].sort() };
      }
      // ground it: the pole foot (or the flag bottom) onto the floor below, ≤ 6 cells
      const fb = objBBox(f);
      const footX = pole && pole.shape.k === 'wall' ? pole.shape.x + (pole.shape.w ?? 1) / 2 : (fb[0] + fb[2]) / 2;
      const footY = pole && pole.shape.k === 'wall' ? pole.shape.y1 : fb[3];
      const ex = new Set([f.id, ...(pole ? [pole.id] : [])]);
      const fl = floorBelow(w, footX, footY - 0.5, EDIT_BOUNDS.form_goal_max_ground_c + 0.5, ex);
      let moved: Move[] = [];
      if (fl) {
        const dy = q16(fl.y - footY);
        if (Math.abs(dy) > 1e-6) {
          f.shape = translateShape(f.shape, 0, dy);
          moved.push({ id: f.id, dx: 0, dy });
          if (pole) {
            pole.shape = translateShape(pole.shape, 0, dy);
            moved.push({ id: pole.id, dx: 0, dy });
          }
        }
        f.rel = { ...f.rel, rests_on: fl.o.id };
        if (pole) pole.rel = { ...pole.rel, rests_on: fl.o.id };
      } else moved = [];
      return out({ touched: [f.id, ...(pole ? [pole.id] : [])], moved, ghost: { before: [before], after: [r4(objBBox(f))] }, args: {} });
    }
    case 'set_collision': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (o.collision === op.mode) return out({ touched: [o.id], noop: true });
      const sup = startSupport(w);
      if (sup && sup.id === o.id && op.mode === 'none') return fail('reject.start_support');
      const kid = isKid(o);
      o.collision = op.mode;
      const r = r4(objBBox(o));
      return out({ touched: [o.id], collisionChangeKid: kid && rec.cls !== 'N', ghost: { before: [r], after: [r] } });
    }
    case 'place_start': {
      if (!op.at) return fail('reject.not_applicable');
      const before = w.st.start ? [r4([w.st.start[0] - 0.5, w.st.start[1] - 1.75, w.st.start[0] + 0.5, w.st.start[1]])] : [];
      w.st.start = [q16(op.at[0]), q16(op.at[1])];
      return out({ touched: [], ghost: { before, after: [r4([op.at[0] - 0.5, op.at[1] - 1.75, op.at[0] + 0.5, op.at[1]])] } });
    }
    case 'clear_spawn': {
      if (!w.st.start) return fail('reject.not_applicable');
      const dx = clamp(op.start_dx ?? 0, -EDIT_BOUNDS.clear_spawn.move_start_max_c, EDIT_BOUNDS.clear_spawn.move_start_max_c);
      const s0 = w.st.start;
      w.st.start = [q16(s0[0] + dx), s0[1]];
      w.st.trimmed = [...new Set([...w.st.trimmed, ...(op.trimmed ?? [])])].sort();
      return out({ touched: op.trimmed ?? [], ghost: { before: [r4([s0[0] - 0.5, s0[1] - 1.75, s0[0] + 0.5, s0[1]])], after: [r4([s0[0] + dx - 0.5, s0[1] - 1.75, s0[0] + dx + 0.5, s0[1]])] }, args: { cells: Math.abs(Math.round(dx)) } });
    }
    case 'coin_from_dot': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      const b = objBBox(o);
      o.role = 'coin';
      o.collision = 'none';
      o.shape = { k: 'point', p: [q16((b[0] + b[2]) / 2), q16((b[1] + b[3]) / 2)] };
      return out({ touched: [o.id], ghost: { before: [r4(b)], after: [r4(b)] } });
    }
    case 'dedupe': {
      const keep = need(w, op.keep);
      if (isFail(keep)) return keep;
      const drop = need(w, op.drop);
      if (isFail(drop)) return drop;
      if (keep.role !== drop.role || rectGap(objBBox(keep), objBBox(drop)) > EDIT_BOUNDS.dedupe_max_c) return fail('reject.out_of_bounds');
      drop.role = 'decoration';
      drop.collision = 'none';
      drop.behavior = null;
      return out({ touched: [drop.id], ghost: { before: [r4(objBBox(drop))], after: [] } });
    }
    case 'fix_behavior': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (!o.behavior) return out({ touched: [o.id], noop: true });
      if (op.value === null) {
        o.behavior = null;
        return out({ touched: [o.id], reason: 'norm.behavior_dropped' });
      }
      (o.behavior as unknown as Record<string, unknown>)[op.param] = op.value;
      return out({ touched: [o.id], args: { cells: typeof op.value === 'number' ? op.value : 0 } });
    }
    case 'fit_creature': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (!w.st.fitted.includes(o.id)) w.st.fitted = [...w.st.fitted, o.id].sort();
      const r = r4(objBBox(o));
      return out({ touched: [o.id], ghost: { before: [r], after: [r] } });
    }

    // ---------------- R · Repair ----------------
    case 'nudge':
    case 'shift_platform': {
      const root = need(w, op.group);
      if (isFail(root)) return root;
      const isR = op.op === 'nudge';
      const bound = isR ? EDIT_BOUNDS.nudge.max_axis_c : TIER_RANK[ctx.tier] >= 3 ? EDIT_BOUNDS.shift_platform.hard : EDIT_BOUNDS.shift_platform.normal;
      const dx = Math.round(op.dx);
      const dy = Math.round(op.dy);
      const man = Math.abs(dx) + Math.abs(dy);
      if (!man) return fail('reject.not_applicable');
      if (Math.abs(dx) > bound || Math.abs(dy) > bound || (isR && man > EDIT_BOUNDS.nudge.max_manhattan_c)) return fail('reject.out_of_bounds', { cells: bound });
      if (!isR && (root.role === 'ground' || !isSurface(root))) return fail('reject.not_applicable');
      if (isR && w.st.drift_r + man > EDIT_BOUNDS.nudge.max_level_c) return fail('reject.out_of_bounds', { cells: EDIT_BOUNDS.nudge.max_level_c });
      if (!isR && w.st.drift_d + man > 10) return fail('reject.out_of_bounds', { cells: 10 });
      const before = objBBox(root);
      const wasGrounded = grounded(w, root);
      const b0 = objBBox(root);
      const nb: Rect = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy];
      if (nb[0] < 0 || nb[2] > w.world.w || nb[1] < 0 || nb[3] > w.world.h + 0.01) return fail('reject.out_of_bounds');
      const moved = moveGroup(w, root.id, dx, dy);
      if (isR) w.st.drift_r += man;
      else w.st.drift_d += man;
      const dk = `${isR ? 'r' : 'd'}:${root.id}`;
      w.st.drift[dk] = (w.st.drift[dk] ?? 0) + man;
      const pillar = (root.shape.k === 'wall' && wasGrounded && dy < 0) || (isSurface(root) && dy < 0 && root.role === 'platform' && !!w.objs.find((q) => isWallLike(q) && rectGap(objBBox(q), before) <= 0.05));
      const topology = (root.shape.k === 'wall' && wasGrounded && dy < 0) || closesKidGap(w, root, before);
      return out({ touched: moved.map((m) => m.id), moved, pillar, topology, ghost: { before: [r4(before)], after: [r4(objBBox(root))] }, args: { cells: man, dx: Math.abs(dx), dy: Math.abs(dy) } });
    }
    case 'trim':
    case 'shrink_landing': {
      const id = op.op === 'trim' ? op.target : op.surface;
      const o = need(w, id);
      if (isFail(o)) return o;
      const bounds = op.op === 'trim' ? EDIT_BOUNDS.trim_c : EDIT_BOUNDS.shrink_landing_c;
      const cells = Math.round(op.cells);
      if (cells < bounds[0] || cells > bounds[1]) return fail('reject.out_of_bounds', { cells });
      const before = objBBox(o);
      if (o.shape.k === 'wall') {
        const side = op.side;
        const s = { ...o.shape };
        const wasGrounded = grounded(w, o);
        if (side === 'top') s.y0 += cells;
        else if (side === 'bottom') s.y1 -= cells;
        else return fail('reject.not_applicable');
        if (s.y1 - s.y0 < 1) return fail('reject.out_of_bounds');
        o.shape = s;
        const pillar = side === 'bottom' && wasGrounded;
        return out({ touched: [o.id], trim: cells, pillar, topology: pillar, ghost: { before: [r4(before)], after: [r4(objBBox(o))] }, args: { cells } });
      }
      if (o.shape.k !== 'surface') return fail('reject.not_applicable');
      if (op.side !== 'left' && op.side !== 'right') return fail('reject.not_applicable');
      if (op.op === 'shrink_landing' && objLength(o) - cells < EDIT_BOUNDS.landing_min_c) return fail('reject.out_of_bounds');
      const r = trimSurface(o, op.side, cells);
      if (isFail(r)) return r;
      return out({ touched: [o.id], trim: r, ghost: { before: [r4(before)], after: [r4(objBBox(o))] }, args: { cells: r } });
    }
    case 'extend': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      const cells = Math.round(op.cells);
      if (cells < EDIT_BOUNDS.extend_c[0] || cells > EDIT_BOUNDS.extend_c[1]) return fail('reject.out_of_bounds', { cells });
      const before = objBBox(o);
      const ex = new Set([o.id, ...carriedGroup(w, o.id)]);
      if (o.shape.k === 'wall') {
        const s = { ...o.shape };
        if (op.side === 'top') s.y0 = Math.max(0, s.y0 - cells);
        else if (op.side === 'bottom') s.y1 = Math.min(w.world.h, s.y1 + cells);
        else return fail('reject.not_applicable');
        const add: Rect = op.side === 'top' ? [s.x, s.y0, s.x + (s.w ?? 1), o.shape.y0] : [s.x, o.shape.y1, s.x + (s.w ?? 1), s.y1];
        if (occupied(w, add, ex)) return fail('reject.not_empty');
        o.shape = s;
        return out({ touched: [o.id], extend: cells, topology: closesKidGap(w, o, before), ghost: { before: [r4(before)], after: [r4(objBBox(o))] }, args: { cells } });
      }
      if (o.shape.k !== 'surface' || (op.side !== 'left' && op.side !== 'right')) return fail('reject.not_applicable');
      const e = segEnds(o.shape.segs);
      const y = op.side === 'left' ? e.y0 : e.y1;
      const add: Rect = op.side === 'left' ? [e.x0 - cells, y, e.x0, y + 1] : [e.x1, y, e.x1 + cells, y + 1];
      if (occupied(w, add, ex)) return fail('reject.not_empty');
      const r = extendSurface(o, op.side, cells, w.world.w);
      if (isFail(r)) return r;
      return out({ touched: [o.id], extend: r, topology: closesKidGap(w, o, before), ghost: { before: [r4(before)], after: [r4(objBBox(o))] }, args: { cells: r } });
    }
    case 'add_step': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      const wd = Math.round(op.w);
      if (wd < EDIT_BOUNDS.add_step_w[0] || wd > EDIT_BOUNDS.add_step_w[1]) return fail('reject.out_of_bounds');
      const x0 = Math.round(s.x - wd / 2);
      const y = Math.round(s.y);
      const r: Rect = [x0, y, x0 + wd, y + 1];
      if (occupied(w, r, new Set()) || r[0] < 0 || r[2] > w.world.w) return fail('reject.not_empty');
      const id = addedId('step', rec.id);
      addObject(w, designerObj(id, 'platform', { k: 'surface', segs: [{ a: [x0, y], b: [x0 + wd, y], slope: 0 }], fill: 'one_row' }, { collision: 'one_way' }));
      return out({ touched: [id], added: [id], adds: [{ what: 'step', n: 1 }], ghost: { before: [], after: [r4(r)] } });
    }
    case 'add_spring': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      const strength = clamp(op.strength, EDIT_BOUNDS.add_spring_strength[0], EDIT_BOUNDS.add_spring_strength[1]);
      const id = addedId('spring', rec.id);
      const host = s.host ? obj(w, s.host) : floorBelow(w, s.x, s.y - 0.5, 1)?.o;
      const y = host ? topAt(host, s.x) ?? s.y : s.y;
      const r: Rect = [s.x - 0.5, y - 0.75, s.x + 0.5, y];
      if (occupied(w, [r[0], r[1], r[2], r[3] - 0.05], new Set(host ? [host.id] : []))) return fail('reject.not_empty');
      addObject(w, designerObj(id, 'spring', { k: 'body', bbox: r4(r) }, { behavior: { kind: 'spring', dir: 'up', strength }, rel: host ? { rests_on: host.id } : {} }));
      return out({ touched: [id], added: [id], adds: [{ what: 'spring', n: 1 }], ghost: { before: [], after: [r4(r)] } });
    }

    // ---------------- P · Polish ----------------
    case 'add_checkpoint': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      const b = EDIT_BOUNDS.checkpoint;
      if (s.x < b.none_before_c) return fail('reject.out_of_bounds');
      const host = s.host ? obj(w, s.host) : floorBelow(w, s.x, s.y - 0.5, 1)?.o;
      const run = flatRun(w, host, s.x);
      if (!run || run.x1 - run.x0 < b.min_flat_c) return fail('reject.not_applicable');
      const r: Rect = [s.x - 0.5, run.y - 2.5, s.x + 0.5, run.y];
      if (nearHazard(w, r, b.hazard_clear_c)) return fail('reject.too_close');
      if (inScreen(w, s.x, (o) => o.role === 'checkpoint') >= b.per_screen) return fail('reject.budget');
      const id = addedId('cp', rec.id);
      addObject(w, designerObj(id, 'checkpoint', { k: 'body', bbox: r4(r) }, { rel: host ? { rests_on: host.id } : {} }));
      return out({ touched: [id], added: [id], adds: [{ what: 'checkpoint', n: 1 }], ghost: { before: [], after: [r4(r)] } });
    }
    case 'add_coin_trail': {
      const a = parseArc(op.action);
      if (!a) return fail('reject.not_applicable');
      const n = Math.round(op.n);
      if (n < EDIT_BOUNDS.coin_trail_n[0] || n > EDIT_BOUNDS.coin_trail_n[1]) return fail('reject.out_of_bounds');
      const prefix = `e_trail_${rec.id.slice(rec.id.lastIndexOf(':') + 1)}`;
      if (w.objs.some((o) => o.id.startsWith(prefix))) return fail('reject.budget');
      const coins = w.objs.filter((o) => o.role === 'coin');
      const scr = screenOfX((a.from[0] + a.to[0]) / 2);
      if (coins.filter((o) => screenOfX(objBBox(o)[0]) === scr).length + n > EDIT_BOUNDS.coins_per_screen) return fail('reject.budget');
      const ids: string[] = [];
      const after: Rect[] = [];
      for (let i = 0; i < n; i++) {
        const [x, fy] = arcFeet(a, (i + 1) / (n + 1));
        const y = fy - 0.9;
        const id = addedId('trail', rec.id, i + 1);
        addObject(w, designerObj(id, 'coin', { k: 'point', p: [q16(x), q16(y)] }));
        ids.push(id);
        after.push([x - 0.3, y - 0.3, x + 0.3, y + 0.3]);
      }
      return out({ touched: ids, added: ids, adds: [{ what: 'pickup', n }], ghost: { before: [], after: after.map(r4) } });
    }
    case 'add_coin':
    case 'add_big_coin': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      const big = op.op === 'add_big_coin';
      if (big && w.objs.filter((o) => o.role === 'big_coin').length >= EDIT_BOUNDS.big_coins_per_level) return fail('reject.budget');
      if (!big && inScreen(w, s.x, (o) => o.role === 'coin') >= EDIT_BOUNDS.coins_per_screen) return fail('reject.budget');
      const r: Rect = [s.x - 0.4, s.y - 0.4, s.x + 0.4, s.y + 0.4];
      if (occupied(w, r, new Set())) return fail('reject.not_empty');
      const id = addedId(big ? 'bc' : 'coin', rec.id);
      addObject(w, designerObj(id, big ? 'big_coin' : 'coin', big ? { k: 'body', bbox: r4([s.x - 0.5, s.y - 0.5, s.x + 0.5, s.y + 0.5]) } : { k: 'point', p: [q16(s.x), q16(s.y)] }));
      return out({ touched: [id], added: [id], adds: [{ what: 'pickup', n: 1 }], ghost: { before: [], after: [r4(r)] } });
    }
    case 'add_hint_arrow': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      if (inScreen(w, s.x, (o) => o.role === 'arrow' && o.origin === 'designer') >= EDIT_BOUNDS.hint_arrows_per_screen) return fail('reject.budget');
      const id = addedId('hint', rec.id);
      const r: Rect = [s.x - 0.6, s.y - 0.4, s.x + 0.6, s.y + 0.4];
      addObject(w, designerObj(id, 'arrow', { k: 'body', bbox: r4(r) }, { rel: { points: op.dir } }));
      return out({ touched: [id], added: [id], adds: [{ what: 'arrow', n: 1 }], ghost: { before: [], after: [r4(r)] } });
    }
    case 'tune': {
      const o = need(w, op.entity);
      if (isFail(o)) return o;
      if (o.pinned.includes(op.param) || o.pinned.includes('behavior')) return fail('reject.pinned');
      if (ctx.tier === 'polished' && ctx.report && ctx.report.C > EDIT_BOUNDS.tune_polished_max_C) return fail('reject.budget');
      const g = gridFor(o, op.param);
      if (!g) return fail('reject.not_applicable');
      const cur = g.get();
      if (cur === null) return fail('reject.not_applicable');
      const nv = gridStep(g.grid, cur, op.step);
      if (nv === null) return fail('reject.out_of_bounds');
      g.set(nv);
      const r = r4(objBBox(o));
      return out({ touched: [o.id], ghost: { before: [r], after: [r] }, args: { what: roleNoun(o.role) } });
    }
    case 'animate': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (o.role !== 'enemy' || (o.behavior && o.behavior.kind !== 'static' && !(o.behavior.kind === 'enemy' && o.behavior.archetype === undefined))) return fail('reject.not_applicable');
      if (o.pinned.includes('archetype') || o.pinned.includes('behavior')) return fail('reject.pinned');
      const b = objBBox(o);
      const host = o.rel.rests_on ? obj(w, o.rel.rests_on) : floorBelow(w, (b[0] + b[2]) / 2, b[3] - 0.25, 1)?.o;
      const run = flatRun(w, host, (b[0] + b[2]) / 2);
      if (!run || run.x1 - run.x0 < EDIT_BOUNDS.animate_min_host_c) return fail('reject.not_applicable');
      o.behavior = { kind: 'enemy', archetype: 'walker', spiky: false, params: { speed: EDIT_BOUNDS.animate_walker_speed, ledge_aware: true } };
      return out({ touched: [o.id], ghost: { before: [r4(b)], after: [r4([run.x0, b[1], run.x1, b[3]])] } });
    }
    case 'set_par': {
      const fast = ctx.report?.fastest_ms ?? 0;
      const par = op.par_ms ?? (fast > 0 ? Math.ceil((1.3 * fast) / 500) * 500 : null);
      if (!par) return fail('reject.not_applicable');
      w.st.par_ms = par;
      return out({ touched: [], args: { time: `${Math.floor(par / 60000)}:${String(Math.round((par % 60000) / 1000)).padStart(2, '0')}` } });
    }

    // ---------------- C · Challenge ----------------
    case 'widen_gap': {
      const g = parseGap(op.gap);
      if (!g) return fail('reject.not_applicable');
      const a = obj(w, g.a);
      const b = obj(w, g.b);
      if (!a || !b || a.shape.k !== 'surface' || b.shape.k !== 'surface') return fail('reject.not_applicable');
      const cells = Math.round(op.cells);
      const lim = TIER_RANK[ctx.tier] >= 3 ? EDIT_BOUNDS.widen_gap.hard : EDIT_BOUNDS.widen_gap.normal;
      if (cells < 1 || cells > lim) return fail('reject.out_of_bounds');
      const ea = segEnds(a.shape.segs);
      const eb = segEnds(b.shape.segs);
      const gap = eb.x0 - ea.x1;
      if (gap < 1) return fail('reject.not_applicable');
      // runway: the flat stretch of a before its right edge
      let runway = 0;
      for (let x = ea.x1 - 0.5; x > ea.x0 && topAt(a, x) === ea.y1 && runway < 6; x -= 1) runway++;
      if (gap + cells > gMax(ctx.profile, runway) - 1) return fail('reject.out_of_bounds', { cells });
      const before = objBBox(b);
      if (objLength(b) - cells < EDIT_BOUNDS.landing_min_c) return fail('reject.out_of_bounds');
      const r = trimSurface(b, 'left', cells);
      if (isFail(r)) return r;
      return out({ touched: [b.id], trim: r, ghost: { before: [r4(before)], after: [r4(objBBox(b))] }, args: { cells } });
    }
    case 'add_spikes': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      const host = s.host ? obj(w, s.host) : undefined;
      if (!host || s.x0 === null || s.x1 === null) return fail('reject.not_applicable');
      const face: Face = s.face ?? 'top';
      const len = s.x1 - s.x0;
      if (len < EDIT_BOUNDS.add_spikes.len_c[0] || len > EDIT_BOUNDS.add_spikes.len_c[1]) return fail('reject.out_of_bounds');
      const strip: Shape = face === 'top' || face === 'bottom' ? { k: 'strip', a: [q16(s.x0), q16(s.y)], b: [q16(s.x1), q16(s.y)] } : { k: 'strip', a: [q16(s.x), q16(s.x0)], b: [q16(s.x), q16(s.x1)] };
      const tmp = designerObj('tmp', 'spikes', strip);
      const r = objBBox(tmp);
      if (w.objs.some((o) => isKid(o) && o.id !== host.id && !isFloor(o) && !isWallLike(o) && rectGap(objBBox(o), r) < EDIT_BOUNDS.add_spikes.undrawn_clear_c)) return fail('reject.drawn_face');
      if (!farFromSpawns(w, r, EDIT_BOUNDS.add_spikes.spawn_clear_c)) return fail('reject.too_close');
      if (face === 'top') {
        const hb = objBBox(host);
        if (hb[2] - hb[0] - len < EDIT_BOUNDS.add_spikes.landing_min_c) return fail('reject.out_of_bounds');
      }
      const id = addedId('spk', rec.id);
      addObject(w, designerObj(id, 'spikes', strip, { rel: { attached: { host: host.id, face }, points: face === 'top' ? 'up' : face === 'bottom' ? 'down' : face } }));
      return out({ touched: [id], added: [id], adds: [{ what: 'hazard', n: 1 }], ghost: { before: [], after: [r4(r)] } });
    }
    case 'add_enemy': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      const allowed: readonly string[] = TIER_RANK[ctx.tier] >= 3 ? ['walker', 'hopper', 'flyer', 'shooter', 'chaser', 'crusher'] : ['walker', 'hopper'];
      if (!allowed.includes(op.archetype)) return fail('reject.out_of_bounds');
      const e = EDIT_BOUNDS.add_enemy;
      const host = s.host ? obj(w, s.host) : floorBelow(w, s.x, s.y - 0.5, 1)?.o;
      const flyer = op.archetype === 'flyer';
      const y = flyer ? s.y : host ? topAt(host, s.x) ?? s.y : s.y;
      const r: Rect = [s.x - 0.75, y - 1.25, s.x + 0.75, y];
      if (!farFromSpawns(w, r, e.spawn_clear_c)) return fail('reject.too_close');
      if (flyer) {
        if (occupied(w, [s.x - 1.5, y - 2.5, s.x + 1.5, y + 0.5], new Set())) return fail('reject.not_empty');
      } else {
        const run = flatRun(w, host, s.x);
        const needFlat = op.archetype === 'hopper' ? e.hopper_flat_c : op.archetype === 'walker' || op.archetype === 'chaser' ? e.walker_flat_c : 3;
        if (!run || run.x1 - run.x0 < needFlat) return fail('reject.not_applicable');
        if (op.archetype === 'hopper' && headroom(w, s.x, y) < e.hopper_headroom_c) return fail('reject.not_applicable');
      }
      const id = addedId('en', rec.id);
      const params: EnemyParams = op.archetype === 'walker' ? { speed: ENEMIES.walker.speed, ledge_aware: true } : op.archetype === 'chaser' ? { speed: ENEMIES.chaser.speed, sight: ENEMIES.chaser.sight } : op.archetype === 'hopper' ? { interval: ENEMIES.hopper.interval, forward: false } : op.archetype === 'flyer' ? { pattern: 'horizontal', range: 3, speed: ENEMIES.flyer.speed } : op.archetype === 'shooter' ? { interval: ENEMIES.shooter.interval, facing: 'toward_player' } : { warn: ENEMIES.crusher.warn };
      addObject(w, designerObj(id, 'enemy', { k: 'body', bbox: r4(r) }, { behavior: { kind: 'enemy', archetype: op.archetype, spiky: false, params }, rel: host && !flyer ? { rests_on: host.id } : {} }));
      w.st.fitted = [...w.st.fitted, id].sort();
      return out({ touched: [id], added: [id], adds: [{ what: 'enemy', n: 1 }], ghost: { before: [], after: [r4(r)] }, args: { what: op.archetype } });
    }
    case 'add_hazard': {
      const s = slotOf(op.slot);
      if (isFail(s)) return s;
      if (op.kind !== 'saw' && TIER_RANK[ctx.tier] < 3) return fail('reject.out_of_bounds');
      const id = addedId('hz', rec.id);
      if (op.kind === 'lava') {
        if (s.x0 === null || s.x1 === null) return fail('reject.not_applicable');
        const r: Rect = [s.x0, s.y, s.x1, s.y + 1];
        addObject(w, designerObj(id, 'lava', { k: 'body', bbox: r4(r) }));
        return out({ touched: [id], added: [id], adds: [{ what: 'hazard', n: 1 }], ghost: { before: [], after: [r4(r)] }, args: { what: 'lava' } });
      }
      const rr = 1;
      const r: Rect = [s.x - rr, s.y - rr, s.x + rr, s.y + rr];
      if (w.objs.some((o) => isKid(o) && rectGap(objBBox(o), r) < EDIT_BOUNDS.add_hazard.ink_clear_c && o.collision !== 'none')) return fail('reject.not_empty');
      if (op.kind === 'saw') {
        const cells = clamp(Math.round(s.w ?? 4), 0, EDIT_BOUNDS.add_hazard.saw_path_max_c);
        addObject(w, designerObj(id, 'saw', { k: 'body', bbox: r4(r) }, { behavior: { kind: 'saw', radius: 1, dir: cells ? 'up' : 'none', cells, speed: HAZARDS.saw.speed } }));
      } else {
        addObject(w, designerObj(id, 'saw', { k: 'body', bbox: r4([s.x - 0.25, s.y - 0.25, s.x + 0.25, s.y + 0.25]) }, { behavior: { kind: 'firebar', balls: 4, speed_deg_s: HAZARDS.firebar.speed, phase: 0 } }));
      }
      return out({ touched: [id], added: [id], adds: [{ what: 'hazard', n: 1 }], ghost: { before: [], after: [r4(r)] }, args: { what: op.kind } });
    }
    case 'make_crumble': {
      const o = need(w, op.surface);
      if (isFail(o)) return o;
      if (o.shape.k !== 'surface' || o.role !== 'platform' || isDynamic(o)) return fail('reject.not_applicable');
      if (objLength(o) > EDIT_BOUNDS.make_crumble_max_c) return fail('reject.out_of_bounds');
      const b = objBBox(o);
      if (spawnPoints(w).some(([x, y]) => x >= b[0] - 0.5 && x <= b[2] + 0.5 && Math.abs(y - b[1]) <= 0.6)) return fail('reject.not_applicable');
      if (w.objs.some((q) => q.role === 'goal' && q.rel.rests_on === o.id)) return fail('reject.not_applicable');
      o.behavior = { kind: 'crumble', delay_s: 0.5, respawn_s: HAZARDS.crumble.respawn_s };
      return out({ touched: [o.id], ghost: { before: [r4(b)], after: [r4(b)] } });
    }
    case 'set_timer': {
      const xs = (op as EditOp & { x_seconds?: number }).x_seconds;
      if (typeof xs === 'number') {
        w.st.timer_s = clamp(Math.round(xs), 10, 300);
        return out({ touched: [], args: { seconds: w.st.timer_s } });
      }
      if (!ctx.rules.timer_pressure) return fail('reject.not_applicable');
      const k = [1.5, 1.75, 2.0].reduce((a, b) => (Math.abs(b - op.k) < Math.abs(a - op.k) ? b : a));
      const fast = ctx.report?.fastest_ms ?? 0;
      if (fast <= 0) return fail('reject.not_applicable');
      w.st.timer_s = Math.ceil((k * fast) / 1000);
      return out({ touched: [], args: { seconds: w.st.timer_s } });
    }
    case 'reprise':
      return reprise(w, op, ctx, rec);

    // ---------------- K · Kid ----------------
    case 'make_mine': {
      const o = need(w, op.target);
      if (isFail(o)) return o;
      if (o.origin !== 'designer' && o.origin !== 'draft') return out({ touched: [o.id], noop: true });
      o.origin = 'kid';
      o.role_by = 'kid';
      w.st.added = w.st.added.filter((x) => x !== o.id);
      const r = r4(objBBox(o));
      return out({ touched: [o.id], ghost: { before: [r], after: [r] } });
    }
  }
}

/** N3: put a strip on a host face, or a body's feet on a host top (the face is explicit, never guessed). */
export function snapTo(w: Work, o: SceneObject, h: SceneObject, face: Face): Result {
  const before = r4(objBBox(o));
  const bound = o.role === 'spikes' ? EDIT_BOUNDS.snap_max_c.spikes : 3;
  if (o.shape.k === 'strip') {
    const s = o.shape;
    const horiz = face === 'top' || face === 'bottom';
    let a = s.a;
    let b = s.b;
    if (horiz) {
      let x0 = Math.min(s.a[0], s.b[0]);
      let x1 = Math.max(s.a[0], s.b[0]);
      const hb = objBBox(h);
      x0 = Math.max(x0, hb[0]);
      x1 = Math.min(x1, hb[2]);
      if (x1 - x0 < 0.5) return fail('reject.not_applicable');
      let y: number | null;
      if (face === 'top') {
        // spikes on slopes: clip to the flat seg under the strip's middle
        if (h.shape.k === 'surface') {
          const mid = (x0 + x1) / 2;
          const flat = h.shape.segs.find((g) => g.slope === 0 && mid >= g.a[0] && mid <= g.b[0]);
          // clip to the flat under the strip when it carries most of it; on uneven (unstraightened) ground the
          // strip keeps its length and sits at the height under its middle
          if (flat && Math.min(x1, flat.b[0]) - Math.max(x0, flat.a[0]) >= 0.6 * (x1 - x0)) {
            x0 = Math.max(x0, flat.a[0]);
            x1 = Math.min(x1, flat.b[0]);
            y = flat.a[1];
          } else y = topAt(h, mid);
        } else y = topAt(h, (x0 + x1) / 2);
      } else {
        y = h.shape.k === 'surface' ? (h.shape.fill === 'to_top' ? surfaceYAt(h.shape.segs, (x0 + x1) / 2) : (surfaceYAt(h.shape.segs, (x0 + x1) / 2) ?? 0) + 1) : h.shape.k === 'wall' ? h.shape.y1 : null;
      }
      if (y === null || Math.abs(y - s.a[1]) > bound + 1e-6) return fail('reject.out_of_bounds', { cells: bound });
      a = [q16(x0), q16(y)];
      b = [q16(x1), q16(y)];
    } else {
      if (h.shape.k !== 'wall') return fail('reject.not_applicable');
      const x = face === 'left' ? h.shape.x : h.shape.x + (h.shape.w ?? 1);
      let y0 = Math.max(Math.min(s.a[1], s.b[1]), h.shape.y0);
      let y1 = Math.min(Math.max(s.a[1], s.b[1]), h.shape.y1);
      if (y1 - y0 < 0.5) {
        y0 = h.shape.y0;
        y1 = Math.min(h.shape.y1, y0 + Math.max(1, Math.abs(s.b[1] - s.a[1])));
      }
      if (Math.abs(x - s.a[0]) > bound + 1e-6) return fail('reject.out_of_bounds', { cells: bound });
      a = [q16(x), q16(y0)];
      b = [q16(x), q16(y1)];
    }
    const dx = a[0] - s.a[0];
    const dy = a[1] - s.a[1];
    o.shape = { k: 'strip', a, b };
    o.rel = { ...o.rel, attached: { host: h.id, face }, points: face === 'top' ? 'up' : face === 'bottom' ? 'down' : face };
    return out({ touched: [o.id], moved: [{ id: o.id, dx, dy }], ghost: { before: [before], after: [r4(objBBox(o))] }, args: { host: roleNoun(h.role), facing: face === 'top' ? 'up' : face === 'bottom' ? 'down' : face } });
  }
  if (face !== 'top') return fail('reject.not_applicable');
  const b = objBBox(o);
  const cx = (b[0] + b[2]) / 2;
  const y = topAt(h, clamp(cx, objBBox(h)[0] + 0.01, objBBox(h)[2] - 0.01));
  if (y === null) return fail('reject.not_applicable');
  const dy = q16(y - b[3]);
  if (Math.abs(dy) > bound + 1e-6) return fail('reject.out_of_bounds', { cells: bound });
  const moved: Move[] = [];
  for (const id of carriedGroup(w, o.id)) {
    const q = obj(w, id)!;
    if (q.id !== o.id && q.rel.part_of !== o.id) continue;
    q.shape = translateShape(q.shape, 0, dy);
    moved.push({ id, dx: 0, dy });
  }
  o.rel = { ...o.rel, rests_on: h.id };
  return out({ touched: [o.id], moved, ghost: { before: [before], after: [r4(objBBox(o))] }, args: { host: roleNoun(h.role) } });
}

/** C9: copy a drawn setpiece's hazards and enemies onto an empty stretch later on, escalated. */
function reprise(w: Work, op: Extract<EditOp, { op: 'reprise' }>, ctx: Ctx, rec: RecMeta): Result {
  const b = EDIT_BOUNDS.reprise;
  if (w.world.screens < b.min_screens || w.st.reprised) return fail('reject.budget');
  const sp = w.setpieces.find((s) => s.name === op.setpiece);
  const s = parseSlot(op.slot);
  if (!sp || !s || !s.host) return fail('reject.not_applicable');
  const host = obj(w, s.host);
  if (!host) return fail('reject.not_applicable');
  const members = sp.ids.map((id) => obj(w, id)).filter((o): o is SceneObject => !!o && (o.role === 'spikes' || o.role === 'enemy' || o.role === 'saw'));
  if (!members.length) return fail('reject.not_applicable');
  const x0 = Math.min(...members.map((m) => objBBox(m)[0]));
  const span = Math.max(...members.map((m) => objBBox(m)[2])) - x0;
  const run = flatRun(w, host, s.x);
  if (!run || run.x1 - run.x0 < Math.max(b.min_empty_c, span + 2)) return fail('reject.not_applicable');
  const base = Math.max(run.x0 + 1, Math.min(s.x, run.x1 - span - 1));
  const ids: string[] = [];
  const after: Rect[] = [];
  members.forEach((m, k) => {
    const mb = objBBox(m);
    const off = mb[0] - x0;
    const id = addedId('rep', rec.id, k + 1);
    let shape: Shape;
    if (m.role === 'spikes') {
      const len = Math.max(1, mb[2] - mb[0]) + (op.escalation === 'narrower' ? 1 : 0);
      shape = { k: 'strip', a: [q16(base + off), q16(run.y)], b: [q16(base + off + len), q16(run.y)] };
    } else {
      const wd = mb[2] - mb[0];
      const ht = mb[3] - mb[1];
      shape = { k: 'body', bbox: r4([base + off, run.y - ht, base + off + wd, run.y]) };
    }
    const beh: Behavior | null = m.behavior ? JSON.parse(JSON.stringify(m.behavior)) : m.role === 'enemy' ? { kind: 'enemy', archetype: 'walker', spiky: false, params: { speed: 2, ledge_aware: true } } : null;
    if (op.escalation === 'faster' && beh && beh.kind === 'enemy') {
      const g = GRIDS.walker_speed.grid as readonly number[];
      const v = beh.params?.speed ?? 2;
      beh.params = { ...(beh.params ?? {}), speed: gridStep(g, v, 1) ?? v };
    }
    const o = designerObj(id, m.role, shape, { behavior: beh, rel: m.role === 'spikes' ? { attached: { host: host.id, face: 'top' }, points: 'up' } : { rests_on: host.id } });
    addObject(w, o);
    if (m.role === 'enemy') w.st.fitted = [...w.st.fitted, id].sort();
    ids.push(id);
    after.push(objBBox(o));
  });
  if (op.escalation === 'plus_saw' || op.escalation === 'plus_spikes') {
    const id = addedId('rep', rec.id, 99);
    const mid = base + span / 2;
    if (op.escalation === 'plus_saw') addObject(w, designerObj(id, 'saw', { k: 'body', bbox: r4([mid - 1, run.y - 4.5, mid + 1, run.y - 2.5]) }, { behavior: { kind: 'saw', radius: 1, dir: 'none', cells: 0, speed: 3 } }));
    else addObject(w, designerObj(id, 'spikes', { k: 'strip', a: [q16(base + span + 1), q16(run.y)], b: [q16(base + span + 3), q16(run.y)] }, { rel: { attached: { host: host.id, face: 'top' }, points: 'up' } }));
    ids.push(id);
  }
  w.st.reprised = true;
  void ctx;
  return out({ touched: ids, added: ids, adds: [{ what: 'hazard', n: ids.length }], ghost: { before: [], after: after.map(r4) }, args: { setpiece: sp.name } });
}

/** Clamp an op's numeric params to the vocabulary bounds for a tier (whoever proposed it). */
export function clampOp(op: EditOp, tier: Tier): EditOp {
  const o = JSON.parse(JSON.stringify(op)) as EditOp;
  const ci = (v: number, lo: number, hi: number): number => clamp(Math.round(v), lo, hi);
  switch (o.op) {
    case 'nudge': {
      o.dx = ci(o.dx, -3, 3);
      o.dy = ci(o.dy, -3, 3);
      while (Math.abs(o.dx) + Math.abs(o.dy) > EDIT_BOUNDS.nudge.max_manhattan_c) {
        if (Math.abs(o.dx) >= Math.abs(o.dy)) o.dx -= Math.sign(o.dx);
        else o.dy -= Math.sign(o.dy);
      }
      break;
    }
    case 'trim':
      o.cells = ci(o.cells, 1, 2);
      break;
    case 'extend':
      o.cells = ci(o.cells, 1, 3);
      break;
    case 'add_step':
      o.w = ci(o.w, 2, 3);
      break;
    case 'add_spring':
      o.strength = clamp(o.strength, 0.6, 1.4);
      break;
    case 'add_coin_trail':
      o.n = ci(o.n, 3, 7);
      break;
    case 'widen_gap':
      o.cells = ci(o.cells, 1, TIER_RANK[tier] >= 3 ? 2 : 1);
      break;
    case 'shrink_landing':
      o.cells = ci(o.cells, 1, 2);
      break;
    case 'shift_platform': {
      const lim = TIER_RANK[tier] >= 3 ? 2 : 1;
      o.dx = ci(o.dx, -lim, lim);
      o.dy = ci(o.dy, -lim, lim);
      break;
    }
    case 'set_timer':
      o.k = [1.5, 1.75, 2.0].reduce((a, b) => (Math.abs(b - o.k) < Math.abs(a - o.k) ? b : a));
      break;
    case 'straighten':
      if (o.max_shift != null) o.max_shift = clamp(o.max_shift, 0, 0.85);
      break;
    case 'clear_spawn':
      if (o.start_dx != null) o.start_dx = clamp(o.start_dx, -4, 4);
      break;
    default:
      break;
  }
  return o;
}

export { isWallLike, isFloor };
