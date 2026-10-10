/**
 * Speculative DESIGN and pick transfer (D9, §3.8). A plan made on the Ink build's menu is carried to the
 * Understood menu by stable candidate id: every pick whose cid still exists is kept. If ≥ 70% transfer and no role
 * on the route or a setpiece changed, the orchestrator applies it at once; otherwise it asks for DESIGN #2.
 */
import type { Candidate, DesignPlanJson, SceneGraph, SceneObject } from '../types.gen.ts';
import { parseGap, parseSlot } from '../edits/slots.ts';
import { roleFamily } from '../scene/roles.ts';

const ROUTE_FAMILIES = new Set(['terrain', 'hazard', 'enemy', 'flag', 'spring', 'door']);

function objIndex(g: SceneGraph): Map<string, SceneObject> {
  return new Map((g.objects ?? []).map((o) => [o.id, o] as const));
}

function refsExist(v: unknown, idx: Map<string, SceneObject>): boolean {
  if (typeof v !== 'string') return true;
  const s = parseSlot(v);
  if (s) return !s.host || idx.has(s.host);
  const gp = parseGap(v);
  if (gp) return idx.has(gp.a) && idx.has(gp.b);
  return true;
}

export function transferPlan(plan: DesignPlanJson, oldMenu: Candidate[], newMenu: Candidate[], oldG: SceneGraph, newG: SceneGraph):
  { plan: DesignPlanJson; ratio: number; routeRolesChanged: boolean } {
  const newCids = new Set(newMenu.map((c) => c.cid));
  const idxNew = objIndex(newG);
  const idxOld = objIndex(oldG);
  const picks = (plan.picks ?? []).filter((p) => newCids.has(p.cid));
  const ratio = (plan.picks ?? []).length ? picks.length / plan.picks.length : 1;
  const repair_choices = (plan.repair_choices ?? []).filter((r) => newCids.has(r.cid));
  const vetoes = (plan.vetoes ?? []).filter((v) => {
    const target = v.edit_id.split(':')[1] ?? '';
    return idxNew.has(target) || target === 'start';
  });
  const novel = (plan.novel ?? []).filter((n) => Object.values(n).every((v) => refsExist(v, idxNew)) && (!('target' in n) || idxNew.has(n.target)));
  // route and setpiece roles: terrain, hazards, enemies, flags... a family change there invalidates taste picks
  const setIds = new Set([...(oldG.setpieces ?? []), ...(newG.setpieces ?? [])].flatMap((s) => s.ids));
  const oldTargets = new Set<string>();
  for (const c of oldMenu) for (const v of Object.values(c.op)) if (typeof v === 'string' && idxOld.has(v)) oldTargets.add(v);
  let routeRolesChanged = false;
  for (const [id, o] of idxOld) {
    const n = idxNew.get(id);
    if (!n) {
      if (ROUTE_FAMILIES.has(roleFamily(o.role)) && o.collision !== 'none') routeRolesChanged = true;
      continue;
    }
    const fo = roleFamily(o.role);
    const fn = roleFamily(n.role);
    if (fo === fn && o.collision === n.collision) continue;
    if (setIds.has(id) || oldTargets.has(id) || ROUTE_FAMILIES.has(fo) || ROUTE_FAMILIES.has(fn)) routeRolesChanged = true;
  }
  return {
    plan: { ...plan, picks, repair_choices, vetoes, novel, asks: plan.asks ?? [], critique: plan.critique ?? [] },
    ratio: Math.round(ratio * 1000) / 1000,
    routeRolesChanged,
  };
}
