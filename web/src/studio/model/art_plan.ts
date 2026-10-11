/**
 * v7 art jobs as StudioEdits (docs/v7/CONTRACTS_V7.md §2, §5): which objects a job draws, how a finished job item
 * becomes `set_art` / `set_backdrop` edits, and the edits behind the restyle card's "Use the new look" / "Keep the old
 * one". Pure; the editor (editor/art_director.ts) does the requests, polling and UI.
 *
 * Two kinds of job:
 * - `single` (recognize → art, Try again, Redraw): the new variants join the object's list, the object keeps playing
 *   what it plays now, and `asked: false` opens the compare card.
 * - `restyle` (the copilot's art_prompt, Restyle everything, Make it real): objects already on AI art switch to the new
 *   variant 0 right away; objects on their sketch get the variants and `asked: false`; the old variants stay until the
 *   maker confirms on the restyle card.
 * Ground lines (physics shape `line`) get a terrain skin and use it straight away (it is how the land looks).
 */
import type { ArtJobItem, ArtJobStatus, ArtVariant, StudioEdit } from '../../core/types.gen.ts';
import { sceneOf } from './doc.ts';
import { normalizeArt, normalizeBackdrop, normalizeTerrain, normalizeVariants, type SArt, type SDoc, type SObj } from './types.ts';

export type JobKind = 'restyle' | 'single';

export interface JobPlan {
  kind: JobKind;
  scene: string;
  objects: string[];
  backdrop: boolean;
}

/** Key of a job item (the backdrop has no object id). */
export const itemKey = (it: Pick<ArtJobItem, 'object_id'>): string => it.object_id ?? '@backdrop';

export const isGround = (o: Pick<SObj, 'physics'>): boolean => o.physics.shape === 'line';

/** Can Claude draw this object? It needs the maker's strokes. */
export const isDrawn = (o: SObj): boolean => o.drawing.strokes.length > 0 && o.drawing.w > 0 && o.drawing.h > 0;

/**
 * Every drawn object of a scene, the biggest first (so a cap keeps the ones that matter), at most `max` (the job
 * body's limit). Templates and hidden things are included: they show up in play.
 */
export function artTargets(doc: SDoc, sceneId: string, max = 80): string[] {
  const sc = sceneOf(doc, sceneId);
  return sc.objects
    .filter(isDrawn)
    .map((o) => ({ id: o.id, area: o.drawing.w * o.drawing.h * o.scale * o.scale }))
    .sort((a, b) => b.area - a.area)
    .slice(0, max)
    .map((x) => x.id);
}

/** Items finished since the last poll (done or failed), in the order the server lists them. */
export function newlyFinished(status: Pick<ArtJobStatus, 'items'>, seen: Set<string>): ArtJobItem[] {
  return (status.items ?? []).filter((it) => (it.status === 'done' || it.status === 'failed') && !seen.has(itemKey(it)));
}

/** Objects of the job still being drawn (queued, drawing or reviewing). */
export function stillDrawing(status: Pick<ArtJobStatus, 'items'> | null, plan: JobPlan): string[] {
  if (!status || !Array.isArray(status.items) || !status.items.length) return plan.objects.slice();
  const finished = new Set(status.items.filter((i) => i.status === 'done' || i.status === 'failed').map(itemKey));
  return plan.objects.filter((id) => !finished.has(id));
}

/** Fresh variants with ids that do not clash with the object's old ones (servers often number them v1, v2, v3). */
export function freshVariants(old: ArtVariant[], fresh: ArtVariant[]): ArtVariant[] {
  const taken = new Set(old.map((v) => v.id));
  return fresh.map((v) => {
    let id = v.id;
    for (let k = 2; taken.has(id); k++) id = `${v.id.slice(0, 32)}-${k}`;
    taken.add(id);
    return id === v.id ? v : { ...v, id };
  });
}

/** Newest first, no duplicates, at most 6 (the spec's limit). */
export function mergeVariants(old: ArtVariant[], fresh: ArtVariant[]): ArtVariant[] {
  const out: ArtVariant[] = [];
  for (const v of [...fresh, ...old]) if (!out.some((o) => o.id === v.id)) out.push(v);
  return out.slice(0, 6);
}

const artData = (a: SArt): Record<string, unknown> => ({ use: a.use, chosen: a.chosen, variants: a.variants, terrain: a.terrain, asked: a.asked });

export interface ItemResult {
  edits: StudioEdit[];
  /** The ids (after renaming) of the variants this item brought, per object: the compare card shows these. */
  fresh: string[];
}

/** One finished job item → the edits that store its art (nothing for failed items or objects that are gone). */
export function itemEdits(doc: SDoc, plan: JobPlan, item: ArtJobItem): ItemResult {
  if (item.status !== 'done') return { edits: [], fresh: [] };
  if (!item.object_id) {
    const b = normalizeBackdrop(item.backdrop);
    return { edits: b ? [{ action: 'set_backdrop', data: b as unknown as Record<string, unknown> }] : [], fresh: [] };
  }
  const o = sceneOf(doc, plan.scene).objects.find((x) => x.id === item.object_id);
  if (!o || !item.art) return { edits: [], fresh: [] };
  const old = o.art ?? null;
  const oldVariants = old?.variants ?? [];
  const got = freshVariants(oldVariants, normalizeVariants(item.art.variants, 4));
  const terrain = normalizeTerrain(item.art.terrain) ?? old?.terrain ?? null;
  if (!got.length && !normalizeTerrain(item.art.terrain)) return { edits: [], fresh: [] };
  const variants = mergeVariants(oldVariants, got);
  let next: SArt;
  if (isGround(o) && terrain) {
    next = normalizeArt({ use: 'ai', chosen: got[0]?.id ?? old?.chosen ?? null, variants, terrain, asked: true });
  } else if (plan.kind === 'restyle' && old?.use === 'ai' && got.length) {
    next = normalizeArt({ use: 'ai', chosen: got[0].id, variants, terrain, asked: true });
  } else {
    const keepChosen = old?.use === 'ai' && old.chosen && variants.some((v) => v.id === old.chosen);
    next = normalizeArt({ use: old?.use ?? 'sketch', chosen: keepChosen ? old!.chosen : got[0]?.id ?? null, variants, terrain, asked: false });
  }
  return { edits: [{ action: 'set_art', target: o.id, scene: plan.scene, data: artData(next) }], fresh: got.map((v) => v.id) };
}

/**
 * "Keep the old one": every object the restyle touched gets its old art back (or none), and the backdrop, art
 * direction, theme and look go back to what they were.
 */
export function revertEdits(before: SDoc, now: SDoc, plan: JobPlan, o: { theme?: boolean } = {}): StudioEdit[] {
  const edits: StudioEdit[] = [];
  const oldScene = sceneOf(before, plan.scene);
  const nowScene = sceneOf(now, plan.scene);
  for (const id of plan.objects) {
    const cur = nowScene.objects.find((x) => x.id === id);
    if (!cur) continue;
    const was = oldScene.objects.find((x) => x.id === id)?.art ?? null;
    if (!was && !cur.art) continue;
    edits.push({ action: 'set_art', target: id, scene: plan.scene, data: artData(was ?? normalizeArt({})) });
  }
  if (plan.backdrop) edits.push({ action: 'set_backdrop', data: (before.backdrop ?? {}) as unknown as Record<string, unknown> });
  edits.push({ action: 'set_art_direction', data: (before.art_direction ?? {}) as unknown as Record<string, unknown> });
  if (o.theme) edits.push({ action: 'set_theme', data: { ...before.theme } as Record<string, unknown> });
  if ((before.look ?? 'game') !== (now.look ?? 'game')) edits.push({ action: 'set_look', data: { look: before.look ?? 'game' } });
  return edits;
}

/**
 * "Use the new look": every object that got new variants plays the first of them, keeps only the new ones, and
 * counts as asked; ground keeps its new skin. `fresh` = the variant ids each object got in this restyle.
 */
export function confirmEdits(now: SDoc, plan: JobPlan, fresh: Map<string, string[]>): StudioEdit[] {
  const edits: StudioEdit[] = [];
  const sc = sceneOf(now, plan.scene);
  for (const id of plan.objects) {
    const o = sc.objects.find((x) => x.id === id);
    const ids = fresh.get(id) ?? [];
    if (!o?.art) continue;
    const variants = o.art.variants.filter((v) => ids.includes(v.id));
    if (!variants.length && !(isGround(o) && o.art.terrain)) continue;
    const chosen = variants.some((v) => v.id === o.art!.chosen) ? o.art.chosen : variants[0]?.id ?? null;
    edits.push({ action: 'set_art', target: id, scene: plan.scene, data: artData(normalizeArt({ use: 'ai', chosen, variants, terrain: o.art.terrain, asked: true })) });
  }
  return edits;
}

/** The compare card's choice as one `set_art`: a variant id plays it; null keeps the maker's drawing. */
export function chooseEdit(sceneId: string, objId: string, variantId: string | null): StudioEdit {
  return variantId
    ? { action: 'set_art', target: objId, scene: sceneId, data: { use: 'ai', chosen: variantId, asked: true } }
    : { action: 'set_art', target: objId, scene: sceneId, data: { use: 'sketch', asked: true } };
}

/** Objects in a scene whose newest variants the maker has not judged yet (compare card queue). */
export function unasked(doc: SDoc, sceneId: string): string[] {
  return sceneOf(doc, sceneId).objects.filter((o) => o.art && !o.art.asked && o.art.variants.length > 0 && !isGround(o)).map((o) => o.id);
}
