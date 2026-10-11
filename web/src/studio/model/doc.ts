/**
 * GameDoc geometry and bookkeeping for the Studio (docs/v6/CONTRACTS_V6.md §2, §6): stroke bounding boxes, recentring
 * an object on its drawing's bbox centre, local ↔ world transforms, hit tests, fresh ids, merge/split, stroke smoothing
 * and simplification. Everything is pure: functions return new objects and never mutate their inputs.
 */
import type { Stroke } from '../../core/types.gen.ts';
import type { SDoc, SObj, SScene, Vec } from './types.ts';
import { normalizeObject } from './types.ts';

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

const r1 = (v: number): number => Math.round(v * 10) / 10;

// ---- boxes -----------------------------------------------------------------------------------------------------

export function pointsBox(points: Iterable<Vec | number[]>): Box | null {
  let b: Box | null = null;
  for (const p of points) {
    const x = p[0];
    const y = p[1];
    if (!b) b = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      if (x < b.minX) b.minX = x;
      if (y < b.minY) b.minY = y;
      if (x > b.maxX) b.maxX = x;
      if (y > b.maxY) b.maxY = y;
    }
  }
  return b;
}

export function strokesBox(strokes: Stroke[]): Box | null {
  let b: Box | null = null;
  for (const s of strokes) {
    const sb = pointsBox(s.points);
    if (sb) b = b ? unionBox(b, sb) : sb;
  }
  return b;
}

export function unionBox(a: Box, b: Box): Box {
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function expandBox(b: Box, by: number): Box {
  return { minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by };
}

export function boxesTouch(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

export function boxContains(outer: Box, inner: Box): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export const boxCenter = (b: Box): Vec => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
export const boxSize = (b: Box): Vec => [b.maxX - b.minX, b.maxY - b.minY];

// ---- transforms -------------------------------------------------------------------------------------------------

const RAD = Math.PI / 180;

/** Object-local px → world px (scale, then rotate clockwise by `rotation` degrees, then translate). */
export function localToWorld(o: Pick<SObj, 'x' | 'y' | 'rotation' | 'scale'>, p: Vec): Vec {
  const c = Math.cos(o.rotation * RAD);
  const s = Math.sin(o.rotation * RAD);
  const x = p[0] * o.scale;
  const y = p[1] * o.scale;
  return [o.x + x * c - y * s, o.y + x * s + y * c];
}

export function worldToLocal(o: Pick<SObj, 'x' | 'y' | 'rotation' | 'scale'>, p: Vec): Vec {
  const c = Math.cos(-o.rotation * RAD);
  const s = Math.sin(-o.rotation * RAD);
  const dx = p[0] - o.x;
  const dy = p[1] - o.y;
  return [(dx * c - dy * s) / o.scale, (dx * s + dy * c) / o.scale];
}

/** The four corners of the object's local bbox, in world px (clockwise from top left). */
export function worldCorners(o: SObj): Vec[] {
  const hw = Math.max(o.drawing.w, 1) / 2;
  const hh = Math.max(o.drawing.h, 1) / 2;
  return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as Vec[]).map((p) => localToWorld(o, p));
}

export function worldBox(o: SObj): Box {
  return pointsBox(worldCorners(o))!;
}

export function selectionBox(objs: SObj[]): Box | null {
  let b: Box | null = null;
  for (const o of objs) b = b ? unionBox(b, worldBox(o)) : worldBox(o);
  return b;
}

// ---- strokes ----------------------------------------------------------------------------------------------------

export function mapStroke(s: Stroke, f: (p: Vec) => Vec, widthScale = 1): Stroke {
  const out: Stroke = { ...s, points: s.points.map((p) => { const q = f(p as Vec); return [r1(q[0]), r1(q[1])]; }) as Stroke['points'] };
  if (widthScale !== 1) out.width = Math.min(80, Math.max(0.5, r1((s.width ?? 6) * widthScale)));
  return out;
}

/**
 * Recentre: the drawing's bbox centre becomes local (0, 0), `x, y` moves so nothing shifts on screen, and `w, h` is
 * the bbox size. Objects without strokes keep their box.
 */
export function recentre(o: SObj): SObj {
  const b = strokesBox(o.drawing.strokes);
  if (!b) return o;
  const [cx, cy] = boxCenter(b);
  const [w, h] = boxSize(b);
  const moved = Math.abs(cx) > 1e-6 || Math.abs(cy) > 1e-6;
  const strokes = moved ? o.drawing.strokes.map((s) => mapStroke(s, (p) => [p[0] - cx, p[1] - cy])) : o.drawing.strokes;
  const [x, y] = moved ? localToWorld(o, [cx, cy]) : [o.x, o.y];
  return { ...o, x: r1(x), y: r1(y), drawing: { strokes, w: r1(w), h: r1(h) } };
}

/** A new object from strokes in world px: centred on their bbox, strokes stored relative to it. */
export function objectFromWorldStrokes(id: string, strokes: Stroke[], extra: Partial<SObj> = {}): SObj {
  const base = normalizeObject({ id, kind: 'thing' });
  return recentre({ ...base, ...extra, id, x: 0, y: 0, rotation: 0, scale: 1, drawing: { strokes, w: 0, h: 0 } });
}

/** The object's strokes in world px (widths scaled with the object). */
export function worldStrokes(o: SObj): Stroke[] {
  return o.drawing.strokes.map((s) => mapStroke(s, (p) => localToWorld(o, p), o.scale));
}

/** Add world-space strokes to an object (it is recentred afterwards). */
export function addWorldStrokes(o: SObj, strokes: Stroke[]): SObj {
  const local = strokes.map((s) => mapStroke(s, (p) => worldToLocal(o, p), 1 / o.scale));
  return recentre({ ...o, drawing: { ...o.drawing, strokes: [...o.drawing.strokes, ...local] } });
}

/** Ramer-Douglas-Peucker. */
export function simplify(points: Vec[], eps: number): Vec[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(points[i], points[a], points[b]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Catmull-Rom through the points (`steps` samples per segment); short polylines are returned as they are. */
export function smooth(points: Vec[], steps = 4, closed = false): Vec[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const at = (i: number): Vec => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out: Vec[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/** A raw pen path → a clean stroke path: drop jitter (RDP), then smooth, then thin out again; ≤ 2000 points. */
export function cleanPath(raw: Vec[], zoom = 1): Vec[] {
  const dedup: Vec[] = [];
  for (const p of raw) {
    const q = dedup[dedup.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.4 / zoom) dedup.push(p);
  }
  if (dedup.length < 3) return dedup.map((p) => [r1(p[0]), r1(p[1])] as Vec);
  const coarse = simplify(dedup, 1.4 / zoom);
  const fine = simplify(smooth(coarse, 5), 0.35 / zoom);
  const out = fine.length > 2000 ? simplify(fine, 2 / zoom).slice(0, 2000) : fine;
  return out.map((p) => [r1(p[0]), r1(p[1])] as Vec);
}

export function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a local point to a stroke's ink (0 inside a closed or filled shape). */
export function strokeDistance(s: Stroke, p: Vec): number {
  const pts = s.points as Vec[];
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) - (s.width ?? 6) / 2;
  if ((s.closed || s.fill) && pts.length > 2 && pointInPolygon(p, pts)) return 0;
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1], pts[i]));
  if (s.closed && pts.length > 2) d = Math.min(d, segDist(p, pts[pts.length - 1], pts[0]));
  return d - (s.width ?? 6) / 2;
}

/** Index of the topmost stroke within `tol` world px of the point, or -1. */
export function strokeAt(o: SObj, world: Vec, tol: number): number {
  const p = worldToLocal(o, world);
  for (let i = o.drawing.strokes.length - 1; i >= 0; i--) if (strokeDistance(o.drawing.strokes[i], p) <= tol / o.scale) return i;
  return -1;
}

/** Does a world point hit the object? Ink first; empty boxes (zones) and small drawings by their box. */
export function hitObject(o: SObj, world: Vec, tol: number): 'ink' | 'box' | null {
  if (strokeAt(o, world, tol) >= 0) return 'ink';
  const p = worldToLocal(o, world);
  const hw = o.drawing.w / 2 + tol / o.scale;
  const hh = o.drawing.h / 2 + tol / o.scale;
  if (Math.abs(p[0]) <= hw && Math.abs(p[1]) <= hh) return 'box';
  return null;
}

/** Objects in draw order (layer, then array order); the last one is on top. */
export function drawOrder(objs: SObj[]): SObj[] {
  return objs.map((o, i) => ({ o, i })).sort((a, b) => a.o.layer - b.o.layer || a.i - b.i).map((x) => x.o);
}

/** The topmost object under a world point: an ink hit beats a box hit; templates and hidden objects still count. */
export function pickObject(objs: SObj[], world: Vec, tol: number): SObj | null {
  const order = drawOrder(objs).reverse();
  for (const o of order) if (hitObject(o, world, tol) === 'ink') return o;
  // box hits: prefer the smallest box (a coin over the big hill it sits on)
  let best: SObj | null = null;
  let bestArea = Infinity;
  for (const o of order) {
    if (hitObject(o, world, tol) !== 'box') continue;
    const a = Math.max(1, o.drawing.w * o.scale) * Math.max(1, o.drawing.h * o.scale);
    if (a < bestArea) { best = o; bestArea = a; }
  }
  return best;
}

// ---- ids and lookups --------------------------------------------------------------------------------------------

export function allObjectIds(doc: SDoc): Set<string> {
  const s = new Set<string>();
  for (const sc of doc.scenes) for (const o of sc.objects) s.add(o.id);
  return s;
}

/** `prefix` + the smallest n ≥ 1 that is not taken (ids match ^[A-Za-z0-9_-]{1,40}$). */
export function freshId(prefix: string, taken: Set<string>): string {
  const p = (prefix.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'o').slice(0, 30);
  for (let n = 1; ; n++) {
    const id = `${p}${n}`;
    if (!taken.has(id)) return id;
  }
}

export function validId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id);
}

export function sceneOf(doc: SDoc, sceneId: string | null | undefined): SScene {
  return doc.scenes.find((s) => s.id === sceneId) ?? doc.scenes[0];
}

export function findObject(doc: SDoc, sceneId: string, id: string): SObj | undefined {
  return sceneOf(doc, sceneId).objects.find((o) => o.id === id);
}

export function displayName(o: Pick<SObj, 'id' | 'name' | 'kind'>): string {
  if (o.name) return o.name;
  if (o.kind && o.kind !== 'thing') return o.kind.charAt(0).toUpperCase() + o.kind.slice(1);
  return o.id;
}

/** Every tag used in the doc, sorted. */
export function allTags(doc: SDoc): string[] {
  const s = new Set<string>();
  for (const sc of doc.scenes) for (const o of sc.objects) for (const t of o.tags) s.add(t);
  return [...s].sort();
}

/** Every counter name the doc mentions (game, objects, HUD, behaviour params, rules). */
export function allCounters(doc: SDoc): string[] {
  const s = new Set<string>(['score', 'lives', 'health', 'coins']);
  for (const k of Object.keys(doc.counters)) s.add(k);
  for (const i of doc.hud.items) s.add(i.counter);
  for (const sc of doc.scenes) for (const o of sc.objects) {
    for (const k of Object.keys(o.counters)) s.add(k);
    for (const b of o.behaviors) for (const k of ['item', 'fuel_counter', 'shots_counter']) {
      const v = b.params?.[k];
      if (typeof v === 'string' && v) s.add(v);
    }
  }
  return [...s].sort();
}

/** Replace one scene in a doc (immutably). */
export function withScene(doc: SDoc, scene: SScene): SDoc {
  return { ...doc, scenes: doc.scenes.map((s) => (s.id === scene.id ? scene : s)) };
}

/** Replace objects by id in one scene (immutably). */
export function withObjects(doc: SDoc, sceneId: string, objs: SObj[]): SDoc {
  const sc = sceneOf(doc, sceneId);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const ids = new Set(sc.objects.map((o) => o.id));
  const objects = sc.objects.map((o) => byId.get(o.id) ?? o);
  for (const o of objs) if (!ids.has(o.id)) objects.push(o);
  return withScene(doc, { ...sc, objects });
}

export function withoutObjects(doc: SDoc, sceneId: string, ids: Iterable<string>): SDoc {
  const sc = sceneOf(doc, sceneId);
  const drop = new Set(ids);
  return withScene(doc, { ...sc, objects: sc.objects.filter((o) => !drop.has(o.id)) });
}

// ---- merge / split ---------------------------------------------------------------------------------------------

/** The object without its v7 AI art (its drawing became a different picture). */
export function withoutArt(o: SObj): SObj {
  if (o.art === undefined) return o;
  const { art: _art, ...rest } = o;
  return rest;
}

/**
 * Merge objects into the first one (its id and settings win); every stroke keeps its place on screen. Joints that
 * pointed at a merged-away object now point at the survivor (and joints to itself are dropped).
 */
export function mergeObjects(doc: SDoc, sceneId: string, ids: string[]): { doc: SDoc; id: string | null } {
  const sc = sceneOf(doc, sceneId);
  const objs = ids.map((id) => sc.objects.find((o) => o.id === id)).filter((o): o is SObj => !!o);
  if (objs.length < 2) return { doc, id: objs[0]?.id ?? null };
  const [first, ...rest] = objs;
  const strokes = [...worldStrokes(first), ...rest.flatMap(worldStrokes)];
  // a merged drawing is a new picture: Claude's art for the first part no longer fits its box
  const survivor = recentre({ ...withoutArt(first), x: 0, y: 0, rotation: 0, scale: 1, drawing: { strokes, w: 0, h: 0 } });
  const gone = new Set(rest.map((o) => o.id));
  const fix = (o: SObj): SObj => {
    if (!o.joints.some((j) => gone.has(j.to))) return o;
    return { ...o, joints: o.joints.map((j) => (gone.has(j.to) ? { ...j, to: first.id } : j)).filter((j) => j.to !== o.id) };
  };
  const objects = sc.objects.filter((o) => !gone.has(o.id)).map((o) => fix(o.id === first.id ? survivor : o));
  return { doc: withScene(doc, { ...sc, objects }), id: first.id };
}

/** Split an object into one object per stroke; the first stroke keeps the id and settings, the rest are new things. */
export function splitObject(doc: SDoc, sceneId: string, id: string): { doc: SDoc; ids: string[] } {
  const sc = sceneOf(doc, sceneId);
  const o = sc.objects.find((x) => x.id === id);
  if (!o || o.drawing.strokes.length < 2) return { doc, ids: o ? [o.id] : [] };
  const taken = allObjectIds(doc);
  const ws = worldStrokes(o);
  const head = recentre({ ...withoutArt(o), x: 0, y: 0, rotation: 0, scale: 1, drawing: { strokes: [ws[0]], w: 0, h: 0 } });
  const parts = ws.slice(1).map((s) => {
    const nid = freshId('o', taken);
    taken.add(nid);
    return objectFromWorldStrokes(nid, [s], { layer: o.layer });
  });
  const objects: SObj[] = [];
  for (const x of sc.objects) {
    if (x.id === id) objects.push(head, ...parts);
    else objects.push(x);
  }
  return { doc: withScene(doc, { ...sc, objects }), ids: [head.id, ...parts.map((p) => p.id)] };
}

// ---- stroke shapes for the line / rect / circle tools -----------------------------------------------------------

export function rectPoints(a: Vec, b: Vec): Vec[] {
  return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map((p) => [r1(p[0]), r1(p[1])] as Vec);
}

export function ellipsePoints(a: Vec, b: Vec, n = 40): Vec[] {
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2;
  const ry = Math.abs(b[1] - a[1]) / 2;
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([r1(cx + rx * Math.cos(t)), r1(cy + ry * Math.sin(t))]);
  }
  return out;
}

/** Snap the end of a line to 15° steps from its start. */
export function snapAngle(a: Vec, b: Vec, step = 15): Vec {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ang = Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / (step * RAD)) * step * RAD;
  return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
}

/** Make the drag box square (shift held), keeping the corner at `a`. */
export function squareFrom(a: Vec, b: Vec): Vec {
  const d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  return [a[0] + Math.sign(b[0] - a[0] || 1) * d, a[1] + Math.sign(b[1] - a[1] || 1) * d];
}
