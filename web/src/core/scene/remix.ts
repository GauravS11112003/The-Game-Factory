/**
 * Object-level remix (§6.5, `core/scene/remix.ts`).
 *
 * - `remixDiff(parent, ink)`: new ink components are matched to the parent's objects. A component whose strokes are
 *   the parent's own strokes (a canvas remix carries them with origin 'parent'; a paper remix gets them merged in by
 *   `withParentInk`) matches exactly. Any other component matches a parent object of the same role family when their
 *   drawn boxes overlap with IoU ≥ 0.3 or their centres lie within 1 cell (a retrace). Matching is one-to-one,
 *   best first (exact, then IoU, then centre distance, then ids). Unmatched components are the kid's new objects.
 * - `withParentInk(ink, parent)`: a paper remix scan holds only the new marks (the parent prints in gray, which the
 *   scanner drops), yet every screen inherits the parent. The parent's strokes join the ink with origin 'parent' and
 *   `p_`-prefixed ids, so the remix level is self-contained and the parent's objects keep their ids. Canvas remixes
 *   already carry the parent strokes and are returned unchanged.
 * - `applyRemixIds(objects, ...)`: perceiveHeuristic renames matched parent-origin objects to the parent's ids (a
 *   match is the same object and keeps its id) and moves any new object off an id the parent already owns.
 * N10 dedupe (normalize step 9) then drops retraced duplicates, keeping the parent's: re-scanning an untouched remix
 * sheet yields 0 new objects and an unchanged coin count.
 */
import { REMIX } from '../params.ts';
import type { InkComponent, InkDoc, InkStroke, LevelV2, SceneObject } from '../types.gen.ts';
import { computeComponents } from '../ink/index.ts';
import { strokeBBox } from '../ink/stroke.ts';
import { rectCenter } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';
import { roleFamily } from './roles.ts';

export const PARENT_PREFIX = 'p_';

function unionRect(a: Rect | null, b: Rect): Rect {
  return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;
}

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: Rect): number => Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]));
  return inter / (area(a) + area(b) - inter);
}

function shapeRect(o: SceneObject): Rect {
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
      return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0 - 0.5, x1, y1 + 0.5];
    }
    case 'strip':
      return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]) - 0.6, Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
    case 'body':
      return [s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3]];
    case 'point':
      return [s.p[0] - 0.45, s.p[1] - 0.45, s.p[0] + 0.45, s.p[1] + 0.45];
    case 'wall':
      return [s.x, s.y0, s.x + (s.w ?? 1), s.y1];
  }
}

/** Strip a paper-remix prefix (the parent's own stroke id). */
function parentStrokeId(id: string): string {
  return id.startsWith(PARENT_PREFIX) ? id.slice(PARENT_PREFIX.length) : id;
}

/** The parent's top-level objects, each with its drawn box (ink when the parent carries it, else its shape). */
function parentTargets(parent: LevelV2): { o: SceneObject; box: Rect; strokes: Set<string> }[] {
  const objs = parent.objects ?? [];
  const byId = new Map(objs.map((o) => [o.id, o] as const));
  const strokes = new Map((parent.ink?.strokes ?? []).map((s) => [s.id, s] as const));
  const rootOf = (o: SceneObject): SceneObject => {
    let cur = o;
    const seen = new Set<string>();
    while (cur.rel.part_of && byId.has(cur.rel.part_of) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.rel.part_of)!;
    }
    return cur;
  };
  const out = new Map<string, { o: SceneObject; box: Rect | null; strokes: Set<string> }>();
  for (const o of objs) {
    const root = rootOf(o);
    if (root.role === 'decoration' && root.origin === 'designer') continue;
    const t = out.get(root.id) ?? { o: root, box: null, strokes: new Set<string>() };
    for (const sid of o.strokes) {
      t.strokes.add(sid);
      const s = strokes.get(sid);
      if (s) t.box = unionRect(t.box, strokeBBox(s));
    }
    out.set(root.id, t);
  }
  return [...out.values()].map((t) => ({ o: t.o, box: t.box ?? shapeRect(t.o), strokes: t.strokes }));
}

interface Cand {
  cids: number[];
  family: string;
  box: Rect;
  strokes: string[];
  parentOrigin: boolean;
}

/** Match new-ink objects (or bare components) to parent objects; one-to-one, best first. */
export function matchToParent(parent: LevelV2, ink: InkDoc, objects: readonly SceneObject[] | null): Map<number, string> {
  const targets = parentTargets(parent);
  const strokeById = new Map(ink.strokes.map((s) => [s.id, s] as const));
  const boxOf = (ids: readonly string[]): Rect => {
    let r: Rect | null = null;
    for (const id of ids) {
      const s = strokeById.get(id);
      if (s) r = unionRect(r, strokeBBox(s));
    }
    return r ?? [0, 0, 0, 0];
  };
  const cands: Cand[] = [];
  if (objects) {
    for (const o of objects) {
      if (o.rel.part_of || !o.components.length) continue;
      const ids = [...o.strokes];
      const cids = new Set(o.components);
      for (const p of objects) if (p.rel.part_of === o.id) {
        ids.push(...p.strokes);
        for (const c of p.components) cids.add(c);
      }
      cands.push({ cids: [...cids].sort((a, b) => a - b), family: roleFamily(o.role), box: boxOf(ids), strokes: ids, parentOrigin: o.origin === 'parent' });
    }
  } else {
    for (const c of ink.components) {
      cands.push({ cids: [c.id], family: '', box: [c.bbox[0], c.bbox[1], c.bbox[2], c.bbox[3]], strokes: c.stroke_ids, parentOrigin: c.stroke_ids.every((id) => strokeById.get(id)?.origin === 'parent') });
    }
  }
  // priority: 2 = the parent's own stroke ids; 1 = parent-origin ink matched by geometry (a paper scan re-ids the
  // parent's strokes, e.g. `p1..`); 0 = a kid retrace (same role family, IoU ≥ 0.3 or centres ≤ 1 cell)
  type Pair = { ci: number; ti: number; pri: number; exact: number; iou: number; d: number };
  const pairs: Pair[] = [];
  cands.forEach((c, ci) => {
    targets.forEach((t, ti) => {
      const own = c.strokes.filter((id) => t.strokes.has(parentStrokeId(id)) && (strokeById.get(id)?.origin === 'parent' || id.startsWith(PARENT_PREFIX))).length;
      if (own > 0) {
        pairs.push({ ci, ti, pri: 2, exact: own / Math.max(1, c.strokes.length), iou: 1, d: 0 });
        return;
      }
      const v = iou(c.box, t.box);
      const [ax, ay] = rectCenter(c.box);
      const [bx, by] = rectCenter(t.box);
      const d = Math.hypot(ax - bx, ay - by);
      if (c.parentOrigin) {
        // the parent's own ink, re-scanned or re-numbered: the same geometry, any role the heuristic gave it
        if (v >= 0.5 || (d <= REMIX.match_center_c && v >= REMIX.match_iou * 0.5)) pairs.push({ ci, ti, pri: 1, exact: 0, iou: v, d });
        return;
      }
      if (c.family && c.family !== roleFamily(t.o.role)) return;
      if (v >= REMIX.match_iou || d <= REMIX.match_center_c) pairs.push({ ci, ti, pri: 0, exact: 0, iou: v, d });
    });
  });
  pairs.sort((p, q) => q.pri - p.pri || q.exact - p.exact || q.iou - p.iou || p.d - q.d || p.ci - q.ci || (targets[p.ti].o.id < targets[q.ti].o.id ? -1 : 1));
  const usedC = new Set<number>();
  const usedT = new Set<number>();
  const out = new Map<number, string>();
  for (const p of pairs) {
    if (usedC.has(p.ci) || usedT.has(p.ti)) continue;
    usedC.add(p.ci);
    usedT.add(p.ti);
    for (const cid of cands[p.ci].cids) out.set(cid, targets[p.ti].o.id);
  }
  return out;
}

/** Paper remix: merge the parent's strokes (origin 'parent', `p_` ids) and components into the scanned ink. */
export function withParentInk(ink: InkDoc, parent: LevelV2 | null | undefined): InkDoc {
  if (!parent?.ink?.strokes?.length) return ink;
  if (!ink.parent || ink.parent.level_id !== parent.id) return ink;
  if (ink.strokes.some((s) => s.origin === 'parent' || s.id.startsWith(PARENT_PREFIX))) return ink;
  const w = ink.world.w;
  const keep = new Set<string>();
  const pStrokes: InkStroke[] = [];
  for (const s of parent.ink.strokes) {
    const b = strokeBBox(s);
    if (b[0] >= w) continue; // a shorter remix world drops what lies past its right edge
    keep.add(s.id);
    const x = s as InkStroke & { x_opens?: string };
    const copy: InkStroke & { x_opens?: string } = { ...s, id: PARENT_PREFIX + s.id, origin: 'parent' };
    if (typeof x.x_opens === 'string') copy.x_opens = PARENT_PREFIX + x.x_opens;
    pStrokes.push(copy);
  }
  if (!pStrokes.length) return ink;
  const offset = (ink.components ?? []).reduce((m, c) => Math.max(m, c.id), 0);
  const src = parent.ink.components?.length ? parent.ink.components : computeComponents(parent.ink.strokes);
  const pComps: InkComponent[] = [];
  for (const c of src) {
    const ids = c.stroke_ids.filter((id) => keep.has(id)).map((id) => PARENT_PREFIX + id);
    if (!ids.length) continue;
    pComps.push({ ...c, id: c.id + offset, stroke_ids: ids });
  }
  return { ...ink, strokes: [...ink.strokes, ...pStrokes], components: [...(ink.components ?? []), ...pComps] };
}

function renameIn(objs: SceneObject[], from: string, to: string): void {
  for (const o of objs) {
    if (o.id === from) o.id = to;
    const r = o.rel;
    if (r.part_of === from) r.part_of = to;
    if (r.rests_on === from) r.rests_on = to;
    if (r.refers_to === from) r.refers_to = to;
    if (r.attached && r.attached.host === from) r.attached = { ...r.attached, host: to };
    if (r.parts) r.parts = r.parts.map((p) => (p === from ? to : p));
  }
}

/** Remix ids (§6.5): parent-origin objects take their parent object's id; new objects never reuse a parent id. */
export function applyRemixIds(objects: SceneObject[], parent: LevelV2, ink: InkDoc): void {
  const m = matchToParent(parent, ink, objects);
  const parentIds = new Set((parent.objects ?? []).map((o) => o.id));
  const rename = new Map<string, string>();
  for (const o of objects) {
    if (o.rel.part_of || o.origin !== 'parent') continue;
    const pid = o.components.map((c) => m.get(c)).find((x): x is string => !!x);
    if (pid && pid !== o.id && ![...rename.values()].includes(pid)) rename.set(o.id, pid);
  }
  const taken = new Set(rename.values());
  // move a new object (or an unmatched parent piece) off an id the parent owns, deterministically
  const tmp = new Map<string, string>();
  for (const o of objects) {
    if (rename.has(o.id)) continue;
    if (taken.has(o.id) || (parentIds.has(o.id) && o.origin !== 'parent')) {
      let id = `${o.id}k`;
      while (objects.some((q) => q.id === id) || taken.has(id) || parentIds.has(id)) id += 'k';
      tmp.set(o.id, id);
      taken.add(id);
    }
  }
  // two phases so swaps never collide: everything to a unique temporary id, then to its final id
  const all = [...tmp.entries(), ...rename.entries()];
  all.forEach(([from], i) => renameIn(objects, from, `__remix_${i}`));
  all.forEach(([, to], i) => renameIn(objects, `__remix_${i}`, to));
}
