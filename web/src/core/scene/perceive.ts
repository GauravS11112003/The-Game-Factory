/**
 * perceiveHeuristic (§3.3): InkDoc → G0, the deterministic first look that runs on every build in < 100 ms.
 * Grouping → grammar → one SceneObject per piece: role, confidence, re-label alternatives, the G0 shape (surfaces
 * keep their drawn per-column rows; N1 straighten fits them), the role's collision, part relations, kid chips.
 * Never drops ink: every component ends up in exactly one object (D3).
 */
import type { Behavior, InkDoc, InkStroke, LevelV2, LibraryType, Role, SceneGraph, SceneObject, Shape } from '../types.gen.ts';
import { PROMPT_LEVEL } from '../params.ts';
import { fitSurface, fitWall, surfaceYAt } from '../build/fit.ts';
import type { SurfaceFit } from '../build/fit.ts';
import { ensureComponents } from '../ink/index.ts';
import { strokeBBox } from '../ink/stroke.ts';
import { clamp, q16, rectCenter, rectGap } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';
import { runGrammar } from './grammar.ts';
import { groupPieces, pieceFromStrokes } from './group.ts';
import type { Piece } from './group.ts';
import { applyRemixIds, withParentInk } from './remix.ts';
import { DEFAULT_COLLISION, roleFamily, stampBehavior } from './roles.ts';

function qRect(r: Rect): [number, number, number, number] {
  return [q16(r[0]), q16(r[1]), q16(r[2]), q16(r[3])];
}

export function bodyShape(bbox: Rect): Shape {
  return { k: 'body', bbox: qRect(bbox) };
}

/** A spike strip's base line: along the long axis, on the side away from the teeth (refined by N3 snap). */
export function stripShape(p: Piece): Shape {
  const g = p.geo;
  if (Math.abs(g.angle) <= 45) {
    const base = g.straight >= 0.9 ? g.cy : g.bbox[3];
    return { k: 'strip', a: [q16(g.core[0]), q16(base)], b: [q16(g.core[2]), q16(base)] };
  }
  const x = g.straight >= 0.9 ? g.cx : g.cx;
  return { k: 'strip', a: [q16(x), q16(g.core[1])], b: [q16(x), q16(g.core[3])] };
}

export function shapeForRole(role: Role, p: Piece, worldW: number, fits?: Map<string, SurfaceFit>): Shape {
  switch (role) {
    case 'ground':
    case 'platform': {
      const f = fits?.get(p.id) ?? fitSurface(p.strokes, 'floor', worldW);
      return { k: 'surface', segs: f.raw, fill: role === 'ground' ? 'to_bottom' : 'one_row' };
    }
    case 'ceiling': {
      const f = fitSurface(p.strokes, 'ceiling', worldW);
      return { k: 'surface', segs: f.raw, fill: 'to_top' };
    }
    case 'wall':
    case 'door':
    case 'pole':
      return fitWall(p.strokes);
    case 'spikes':
      return stripShape(p);
    case 'coin':
      return p.geo.isDot || p.geo.diam <= 1.2 ? { k: 'point', p: [q16(p.geo.cx), q16(p.geo.cy)] } : bodyShape(p.geo.bbox);
    case 'start_marker':
      return { k: 'point', p: [q16(p.geo.cx), q16(p.geo.bbox[3])] };
    default:
      return p.geo.isDot ? { k: 'point', p: [q16(p.geo.cx), q16(p.geo.cy)] } : bodyShape(p.geo.bbox);
  }
}

function kidBehavior(p: Piece): { behavior: Behavior | null; pinned: string[] } {
  const rule = p.strokes.find((s) => s.rule)?.rule ?? null;
  if (rule) {
    const pinned = Object.keys(rule).filter((k) => k !== 'kind');
    if (rule.kind === 'enemy' || rule.kind === 'static') pinned.push('archetype');
    return { behavior: rule, pinned: [...new Set(pinned)].sort() };
  }
  const stamp = p.strokes.find((s) => s.stamp)?.stamp;
  if (stamp) {
    const b = stampBehavior(stamp);
    return { behavior: b, pinned: b && b.kind === 'enemy' ? ['archetype'] : [] };
  }
  return { behavior: null, pinned: [] };
}

export function perceiveHeuristic(inkIn: InkDoc, ctx: { library: LibraryType[]; parent: LevelV2 | null }): SceneGraph {
  // a paper remix scan inherits the parent's ink (§6.5); canvas remixes already carry it
  const ink = ensureComponents(withParentInk(inkIn, ctx.parent));
  const worldW = ink.world.w;
  const pieces = groupPieces(ink);
  const { guesses, fits } = runGrammar(pieces, { w: worldW, h: ink.world.h ?? 27 }, ctx.library ?? []);
  const byId = new Map(pieces.map((p) => [p.id, p] as const));
  const objects: SceneObject[] = [];
  for (const p of pieces) {
    let role: Role;
    let conf: number;
    let roleBy: SceneObject['role_by'] = 'heuristic';
    let alt: SceneObject['alt'] = [];
    let pinned: string[] = [];
    const root = p.partOf ? byId.get(p.partOf) : undefined;
    if (root) {
      const rg = guesses.get(rootOf(p, byId).id);
      if (p.poleOf) {
        role = 'pole';
        conf = 0.95;
      } else if (p.trunkOf) {
        role = 'decoration';
        conf = 0.8;
      } else {
        role = rg?.role ?? 'decoration';
        conf = Math.min(0.9, rg?.conf ?? 0.6);
        if (role === 'ground' || role === 'platform' || role === 'wall' || role === 'ceiling') role = 'decoration';
      }
    } else {
      const g = guesses.get(p.id)!;
      role = g.role;
      conf = g.conf;
      alt = g.alt;
      if (g.byKid) {
        roleBy = g.rule === 'STAMP' ? 'stamp' : 'kid';
        pinned = ['role'];
      }
    }
    const kb = kidBehavior(p);
    const shape = root && !p.poleOf ? (p.geo.isDot ? { k: 'point', p: [q16(p.geo.cx), q16(p.geo.cy)] } as Shape : bodyShape(p.geo.bbox)) : shapeForRole(role, p, worldW, fits);
    const obj: SceneObject = {
      id: p.id,
      components: [...p.cids],
      strokes: p.strokes.map((s) => s.id),
      role,
      conf: clamp(Math.round(conf * 100) / 100, 0, 1),
      role_by: roleBy,
      origin: p.origin,
      shape,
      collision: root ? 'none' : DEFAULT_COLLISION[role],
      rel: {},
      behavior: kb.behavior,
      pinned: [...new Set([...pinned, ...kb.pinned])].sort(),
      alt,
      lib: p.strokes.find((s) => s.lib)?.lib ?? (!root ? guesses.get(p.id)?.lib ?? null : null),
      text: null,
    };
    if (p.partOf) obj.rel.part_of = p.partOf;
    if (p.parts.length) obj.rel.parts = [...p.parts];
    if (p.arrow) obj.rel.points = p.arrow.dir;
    if (p.detach.length) (obj as SceneObject & { x_detach?: unknown }).x_detach = p.detach.map((d) => ({ branch: d.branch, into: d.into }));
    const ask = !root ? guesses.get(p.id)?.ask : null;
    if (ask) (obj as SceneObject & { x_ask?: string }).x_ask = ask;
    objects.push(obj);
  }
  // walls, poles and doors stand on the surface under their foot (bottom within 0.6 → the host's top line)
  const floors = objects.filter((o) => o.shape.k === 'surface' && o.shape.fill !== 'to_top' && o.collision !== 'none' && !o.rel.part_of);
  for (const o of objects) {
    if (o.shape.k !== 'wall') continue;
    const s = o.shape;
    const cx = s.x + (s.w ?? 1) / 2;
    let best: { id: string; y: number } | null = null;
    for (const f of floors) {
      if (f === o || f.shape.k !== 'surface') continue;
      const y = surfaceYAt(f.shape.segs, cx);
      if (y === null || Math.abs(y - s.y1) > 1.0 || y <= s.y0) continue;
      if (!best || Math.abs(y - s.y1) < Math.abs(best.y - s.y1)) best = { id: f.id, y };
    }
    if (best) {
      o.shape = { ...s, y1: Math.round(best.y) };
      o.rel.rests_on = best.id;
    } else if (s.y1 >= 26) o.shape = { ...s, y1: 27 };
  }
  // arrows refer to the nearest object within 2 cells of their tail (H16)
  for (const o of objects) {
    if (o.role !== 'arrow') continue;
    const p = byId.get(o.id)!;
    const tail = p.arrow?.tail ?? [p.geo.cx, p.geo.cy];
    const tr: Rect = [tail[0] - 0.01, tail[1] - 0.01, tail[0] + 0.01, tail[1] + 0.01];
    let best: SceneObject | null = null;
    let bd = Infinity;
    for (const q of objects) {
      if (q === o || q.role === 'text' || q.role === 'arrow' || q.rel.part_of) continue;
      const qp = byId.get(q.id);
      if (!qp) continue;
      const d = rectGap(qp.geo.bbox, tr);
      if (d <= 2 && d < bd) {
        bd = d;
        best = q;
      }
    }
    if (best) o.rel.refers_to = best.id;
  }
  // prompt drafts (§8.3 step 5): kid marker that overlaps a blue-line draft object of the same family (IoU ≥ 0.3)
  // replaces it — "your ground wins"; the draft stroke stays visible as scenery until the kid erases it
  draftReplaced(objects, byId);
  // remix: matched parent objects keep the parent's ids; new objects never take one (§6.5)
  if (ctx.parent) applyRemixIds(objects, ctx.parent, ink);
  return { objects, setpieces: [], intent: null, difficulty_wish: 'none', title: null, safety: 'unchecked' };
}

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: Rect): number => Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]));
  return inter / (area(a) + area(b) - inter);
}

/** "Your ground wins": a kid object over a draft object of the same role family turns the draft one into scenery. */
function draftReplaced(objects: SceneObject[], byId: Map<string, Piece>): void {
  const drafts = objects.filter((o) => o.origin === 'draft' && !o.rel.part_of && o.role !== 'decoration' && o.role !== 'text');
  if (!drafts.length) return;
  const kid = objects.filter((o) => o.origin === 'kid' && !o.rel.part_of && o.role !== 'decoration' && o.role !== 'unknown' && o.role !== 'text');
  for (const d of drafts) {
    const db = byId.get(d.id)?.geo.bbox;
    if (!db) continue;
    const fam = roleFamily(d.role);
    const hit = kid.find((k) => {
      const kb = byId.get(k.id)?.geo.bbox;
      return !!kb && roleFamily(k.role) === fam && iou(grow(db), grow(kb)) >= PROMPT_LEVEL.draft_replace_iou;
    });
    if (!hit) continue;
    d.role = 'decoration';
    d.collision = 'none';
    d.behavior = null;
    d.conf = 1;
    (d as SceneObject & { x_replaced_by?: string }).x_replaced_by = hit.id;
    for (const pid of d.rel.parts ?? []) {
      const p = objects.find((o) => o.id === pid);
      if (p) {
        p.role = 'decoration';
        p.collision = 'none';
      }
    }
  }
}

/** Thin strokes have near-zero boxes; compare them as at least half a cell thick. */
function grow(r: Rect): Rect {
  const cy = (r[1] + r[3]) / 2;
  const cx = (r[0] + r[2]) / 2;
  const hh = Math.max(0.5, (r[3] - r[1]) / 2);
  const hw = Math.max(0.5, (r[2] - r[0]) / 2);
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

function rootOf(p: Piece, byId: Map<string, Piece>): Piece {
  let cur = p;
  const seen = new Set<string>();
  while (cur.partOf && !seen.has(cur.id)) {
    seen.add(cur.id);
    const n = byId.get(cur.partOf);
    if (!n) break;
    cur = n;
  }
  return cur;
}

/** The ink bbox of an object's strokes (for ghosts and ink-relative checks). */
export function objectInkBBox(o: SceneObject, ink: InkDoc): Rect | null {
  let r: Rect | null = null;
  const ids = new Set(o.strokes);
  for (const s of ink.strokes) {
    if (!ids.has(s.id)) continue;
    const b = strokeBBox(s);
    r = r ? [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])] : b;
  }
  return r;
}

/** The G0 shape of a role for an object's strokes (U1 set_role re-shapes from the ink). */
export function shapeForStrokes(role: Role, id: string, cids: number[], strokes: InkStroke[], worldW: number): Shape {
  return shapeForRole(role, pieceFromStrokes(id, cids, strokes), worldW);
}

export { rectCenter };
