/**
 * Digests for the DESIGN / REFINE / CRITIC prompts (§3.10): the model sees the menu and the bot's facts, never raw
 * geometry. Compact, line-oriented, deterministic text.
 *   graph_digest  objects (id, role, how sure, where, collision, behaviour, pinned), setpieces, intent, wish
 *   level_digest  C/band/score, times, segments E/T/F, route table (action, w/h/φ frames, p_death, setpiece),
 *                 flags, alts groups, slots the novel ops may use
 *   menu_rows     cid · summary · tiers · dC · dT · cost · fixes (+ alts group)
 */
import type { BuildResult } from '../index.ts';
import type { Candidate, SceneObject } from '../types.gen.ts';
import { objBBox } from '../edits/work.ts';
import { fmt } from '../util/geom.ts';
import { gatherSites } from './sites.ts';
import { resume } from './context.ts';
import { slotId } from '../edits/slots.ts';

function where(o: SceneObject): string {
  const b = objBBox(o);
  return `x${fmt(b[0], 1)}-${fmt(b[2], 1)} y${fmt(b[1], 1)}-${fmt(b[3], 1)}`;
}

function behaviour(o: SceneObject): string {
  const b = o.behavior;
  if (!b) return '';
  switch (b.kind) {
    case 'enemy':
      return ` ${b.archetype}${b.spiky ? ' spiky' : ''}${b.params?.speed != null ? ` v${b.params.speed}` : ''}`;
    case 'move':
      return ` moves ${b.dir} ${b.cells} @${b.speed}`;
    case 'saw':
      return ` saw${b.cells ? ` ${b.dir} ${b.cells}` : ''}`;
    default:
      return ` ${b.kind}`;
  }
}

export function digest(r: BuildResult, menu: Candidate[]): { graph_digest: string; level_digest: string; menu_rows: string } {
  const g = r.graph;
  const objs = (g.objects ?? []).filter((o) => !o.rel.part_of);
  const lines: string[] = [];
  lines.push(`objects ${objs.length} (kid ${objs.filter((o) => o.origin === 'kid' || o.origin === 'parent').length})`);
  for (const o of objs) {
    const parts = o.rel.parts?.length ? ` parts:${o.rel.parts.length}` : '';
    const rel = o.rel.attached ? ` on ${o.rel.attached.host}.${o.rel.attached.face}` : o.rel.rests_on ? ` on ${o.rel.rests_on}` : '';
    const pin = o.pinned.length ? ` pinned:${o.pinned.join(',')}` : '';
    lines.push(`${o.id} ${o.role} ${o.role_by}:${fmt(o.conf)} ${o.origin} ${where(o)} ${o.collision}${behaviour(o)}${rel}${parts}${pin}${o.text ? ` "${o.text.slice(0, 40)}"` : ''}`);
  }
  for (const s of g.setpieces ?? []) lines.push(`setpiece "${s.name}" ${s.kind} [${s.ids.join(',')}] by ${s.by}`);
  lines.push(`intent: ${g.intent ?? '-'}; wish: ${g.difficulty_wish ?? 'none'}; title: ${g.title ?? '-'}`);
  const rep = r.report;
  const L: string[] = [];
  L.push(`screens ${r.level.world.screens}; C ${fmt(rep.C, 3)} (${rep.band}, score ${rep.score}); C_skilled ${fmt(rep.C_skilled, 3)}; fastest ${fmt(rep.fastest_ms / 1000, 1)} s; par ${fmt(rep.par_ms / 1000, 1)} s; casual clear ${fmt(rep.casual_clear_s, 1)} s${rep.approx ? '; APPROX (bot unavailable)' : ''}`);
  L.push(`solvable ${rep.solvable}${rep.reason ? ` (${rep.reason})` : ''}; engaged enemies ${rep.engaged_enemies}; actions/screen ${fmt(rep.actions_per_screen, 1)}`);
  for (const s of rep.segments) L.push(`segment ${s.id} ${s.from}→${s.to} E ${fmt(s.E, 3)} T ${fmt(s.T_ms / 1000, 1)} s F ${fmt(s.F_s, 1)} s actions ${s.actions}`);
  for (const s of rep.route) {
    if (s.kind === 'walk') continue;
    L.push(`route ${s.i} ${s.kind} ${fmt(s.from[0], 1)},${fmt(s.from[1], 1)}→${fmt(s.to[0], 1)},${fmt(s.to[1], 1)} w ${fmt(s.w_f, 1)} h ${fmt(s.h_f, 1)} φ ${s.phi_f === null ? '-' : fmt(s.phi_f, 1)} p_death ${fmt(s.p_death_casual, 3)}${s.blind ? ' blind' : ''}${s.setpiece ? ` [${s.setpiece}]` : ''} ${s.segment}`);
  }
  for (const f of rep.flags) L.push(`flag ${f.id} ${f.code} ${f.severity}${f.at ? ` at ${fmt(f.at[0], 1)},${fmt(f.at[1], 1)}` : ''}${f.object_ids?.length ? ` [${f.object_ids.join(',')}]` : ''}`);
  const groups = new Map<string, Candidate[]>();
  for (const c of menu) if (c.alts) groups.set(c.alts, [...(groups.get(c.alts) ?? []), c]);
  for (const [k, v] of groups) L.push(`alts ${k}: ${v.map((c) => `${c.cid} (cost ${fmt(c.intent_cost)})`).join(' | ')}`);
  try {
    const res = resume(r, 'hard');
    const sites = gatherSites(res.w, rep);
    const show = (k: keyof typeof sites.slots, n: number): void => {
      const ss = sites.slots[k].slice(0, n);
      if (ss.length) L.push(`slots ${k}: ${ss.map((s) => slotId(s)).join(' ')}`);
    };
    show('cp', 6);
    show('risk', 6);
    show('enemy', 6);
    show('spikes', 6);
  } catch {
    /* digests never fail a build */
  }
  const M: string[] = [];
  for (const c of menu) {
    M.push(`${c.cid} · ${c.summary_key}${c.summary_args && Object.keys(c.summary_args).length ? `(${Object.entries(c.summary_args).map(([k, v]) => `${k}=${v}`).join(',')})` : ''} · ${c.tiers.join('/')} · dC ${fmt(c.dC, 3)}${c.measured ? '' : '~'} · dT ${fmt(c.dT_s, 1)} · cost ${fmt(c.intent_cost)}${c.fixes?.length ? ` · fixes ${c.fixes.join(',')}` : ''}${c.alts ? ` · alts ${c.alts}` : ''}`);
  }
  return { graph_digest: lines.join('\n'), level_digest: L.join('\n'), menu_rows: M.join('\n') };
}
