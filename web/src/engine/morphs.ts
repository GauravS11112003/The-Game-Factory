/**
 * Morphs for a level swap (PLAN_V2 §7.10 dial and Keep/Undo): when the caller passes none, they are derived by
 * diffing the two levels: moved objects slide back from where they were, added pieces sketch themselves in (pencil
 * reveal), removed ones erase.
 */
import type { Entity, LevelV2, Morph, RectCells, SceneObject } from '../core/types.gen.ts';

function entityBox(e: Entity): RectCells {
  switch (e.type) {
    case 'spikes':
      return [Math.min(e.x0, e.x1), e.y - 0.6, Math.max(e.x0, e.x1), e.y];
    case 'door':
      return [e.x, e.y, e.x + e.w, e.y + e.h];
    case 'moving_platform':
    case 'crumble':
    case 'falling_platform':
      return [e.x, e.y, e.x + e.w, e.y + 1];
    case 'enemy':
      return [e.x - e.w / 2, e.y - e.h, e.x + e.w / 2, e.y];
    case 'goal':
      return e.trigger;
    case 'checkpoint':
    case 'spring':
    case 'player_start':
      return [e.x - 0.5, e.y - 1, e.x + 0.5, e.y];
    default:
      return [e.x - 0.5, e.y - 0.5, e.x + 0.5, e.y + 0.5];
  }
}

function objectBox(o: SceneObject): RectCells | null {
  const s = o.shape;
  switch (s.k) {
    case 'surface': {
      if (!s.segs.length) return null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const g of s.segs)
        for (const p of [g.a, g.b]) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
      return [x0, y0, x1, y1 + 1];
    }
    case 'wall':
      return [s.x - 0.5, s.y0, s.x + 0.5, s.y1];
    case 'body':
      return s.bbox;
    case 'point':
      return [s.p[0] - 0.5, s.p[1] - 0.5, s.p[0] + 0.5, s.p[1] + 0.5];
    case 'strip':
      return [Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]) - 0.5, Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1])];
  }
}

const moved = (a: RectCells, b: RectCells): boolean => Math.abs(a[0] - b[0]) > 1 / 32 || Math.abs(a[1] - b[1]) > 1 / 32;

export function deriveMorphs(prev: LevelV2, next: LevelV2): Morph[] {
  if (prev.id !== next.id) return [];
  const out: Morph[] = [];
  const pe = new Map(prev.compiled.entities.map((e) => [e.id, e]));
  const ne = new Map(next.compiled.entities.map((e) => [e.id, e]));
  for (const [id, e] of ne) {
    if (e.type === 'player_start') continue;
    const old = pe.get(id);
    const to = entityBox(e);
    if (!old) out.push({ object_id: id, from: to, to, kind: 'appear' });
    else {
      const from = entityBox(old);
      if (moved(from, to)) out.push({ object_id: id, from, to, kind: 'move' });
    }
  }
  for (const [id, e] of pe) if (!ne.has(id) && e.type !== 'player_start') out.push({ object_id: id, from: entityBox(e), to: entityBox(e), kind: 'vanish' });
  const po = new Map((prev.objects ?? []).map((o) => [o.id, o]));
  const no = new Map((next.objects ?? []).map((o) => [o.id, o]));
  for (const [id, o] of no) {
    if (ne.has(id) || pe.has(id)) continue;
    if (o.collision !== 'solid' && o.collision !== 'one_way') continue;
    const to = objectBox(o);
    if (!to) continue;
    const old = po.get(id);
    if (!old) out.push({ object_id: id, from: to, to, kind: 'appear' });
    else {
      const from = objectBox(old);
      if (from && moved(from, to)) out.push({ object_id: id, from, to, kind: 'move' });
    }
  }
  for (const [id, o] of po) {
    if (no.has(id) || pe.has(id) || ne.has(id)) continue;
    const b = objectBox(o);
    if (b) out.push({ object_id: id, from: b, to: b, kind: 'vanish' });
  }
  return out.slice(0, 40);
}
