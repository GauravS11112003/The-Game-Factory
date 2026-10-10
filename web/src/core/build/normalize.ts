/**
 * Normalize order (§3.7), deterministic; every step emits stable-id EditRecords through the Runner:
 *   1. U-edits from merge, the kid and the library (+ heuristic U3 detach cards)
 *   2. N1 straighten every surface (1-row rises become 1:2 ramps, never vertical steps)
 *   3. N2 close_gap and N11 join_seam
 *   4. N6 set_collision
 *   5. N3 snap, then N4 orient: spikes, enemies, keys, checkpoints, springs, doors
 *   6. N5 form_goal
 *   7. N12 fix_behavior and the structural validator
 *   8. N7 place_start, then N8 clear_spawn
 *   9. N10 dedupe (remix only)
 *  10. N13 fit_creature
 */
import { EDIT_BOUNDS, PERCEPTION, VALIDATOR, WORLD } from '../params.ts';
import type { CellXY, EditOp, EditRecord, Face, MessageRef, SceneObject, Stage } from '../types.gen.ts';
import { objectInkBBox } from '../scene/perceive.ts';
import { isWallLike, isFloor } from '../edits/apply.ts';
import { floorBelow, isDynamic, isSurface, obj, objBBox, overlapFrac, topAt } from '../edits/work.ts';
import type { Work } from '../edits/work.ts';
import { overlap1, q16, rectGap } from '../util/geom.ts';
import type { Rect } from '../util/geom.ts';
import { Grid, rasterize } from './compile.ts';
import { segsSpan } from './fit.ts';
import type { Runner } from './runner.ts';

export interface NormalizeOut {
  warnings: MessageRef[];
}

function surfEnds(o: SceneObject): { x0: number; y0: number; x1: number; y1: number } | null {
  if (o.shape.k !== 'surface' || !o.shape.segs.length) return null;
  const s = [...o.shape.segs].sort((a, b) => a.a[0] - b.a[0]);
  return { x0: s[0].a[0], y0: s[0].a[1], x1: s[s.length - 1].b[0], y1: s[s.length - 1].b[1] };
}

function family(o: SceneObject): string {
  return o.role === 'ceiling' ? 'ceiling' : o.role === 'ground' || o.role === 'platform' ? 'floor' : 'other';
}

/** Spike host (§3.3): a parallel face within 1.5 cells with ≥ 40% overlap, else the nearest surface below within 3. */
export function spikeHost(w: Work, o: SceneObject, ink: Rect | null): { host: SceneObject; face: Face } | null {
  if (o.shape.k !== 'strip') return null;
  const drawn = ink ?? objBBox(o);
  const vertical = Math.abs(o.shape.a[0] - o.shape.b[0]) < Math.abs(o.shape.a[1] - o.shape.b[1]);
  const S = PERCEPTION.spikes_host;
  type C = { host: SceneObject; face: Face; d: number; pri: number };
  const cands: C[] = [];
  const len = vertical ? drawn[3] - drawn[1] : drawn[2] - drawn[0];
  for (const h of w.objs) {
    if (h === o || h.rel.part_of || !(isFloor(h) || isWallLike(h) || (isSurface(h) && h.shape.k === 'surface' && h.shape.fill === 'to_top' && h.collision === 'solid'))) continue;
    const hb = objBBox(h);
    if (!vertical) {
      const ov = overlap1(hb[0], hb[2], drawn[0], drawn[2]) / Math.max(0.5, len);
      if (ov < S.min_overlap) continue;
      const mid = (Math.max(hb[0], drawn[0]) + Math.min(hb[2], drawn[2])) / 2;
      const top = h.shape.k === 'surface' && h.shape.fill === 'to_top' ? null : topAt(h, mid);
      if (top !== null) {
        const d = Math.abs(top - drawn[3]);
        if (d <= S.max_perp_c) cands.push({ host: h, face: 'top', d, pri: 0 });
      }
      let bottom: number | null = null;
      if (h.shape.k === 'surface') {
        const y = topAt({ ...h, shape: { ...h.shape, fill: 'one_row' } }, mid);
        bottom = y === null ? null : h.shape.fill === 'to_top' ? y : h.shape.fill === 'one_row' ? y + 1 : null;
      } else if (h.shape.k === 'wall') bottom = h.shape.y1 < w.world.h ? h.shape.y1 : null;
      if (bottom !== null) {
        const d = Math.abs(drawn[1] - bottom);
        if (d <= S.max_perp_c) cands.push({ host: h, face: 'bottom', d, pri: 1 });
      }
    } else if (h.shape.k === 'wall') {
      const ov = overlap1(hb[1], hb[3], drawn[1], drawn[3]) / Math.max(0.5, len);
      if (ov < S.min_overlap) continue;
      const dl = Math.abs(drawn[2] - h.shape.x);
      const dr = Math.abs(drawn[0] - (h.shape.x + (h.shape.w ?? 1)));
      if (dl <= S.max_perp_c) cands.push({ host: h, face: 'left', d: dl, pri: 0 });
      if (dr <= S.max_perp_c) cands.push({ host: h, face: 'right', d: dr, pri: 0 });
    }
  }
  cands.sort((a, b) => a.d - b.d || a.pri - b.pri || (a.host.id < b.host.id ? -1 : 1));
  if (cands.length) return { host: cands[0].host, face: cands[0].face };
  // nearest surface below within 3 cells
  const cx = (drawn[0] + drawn[2]) / 2;
  const f = floorBelow(w, cx, drawn[3] - 0.25, S.below_max_c, new Set([o.id]));
  return f ? { host: f.o, face: 'top' } : null;
}

/** Host below a standing thing: within 3 cells with ≥ 50% overlap (§3.3 enemy host). */
export function standHost(w: Work, o: SceneObject, maxDy: number): SceneObject | null {
  const b = objBBox(o);
  const exclude = new Set([o.id, ...(o.rel.parts ?? [])]);
  let best: { h: SceneObject; d: number } | null = null;
  for (const h of w.objs) {
    if (exclude.has(h.id) || h.rel.part_of || !(isFloor(h) || isWallLike(h))) continue;
    const hb = objBBox(h);
    const ov = overlapFrac([b[0], 0, b[2], 1], [hb[0], 0, hb[2], 1]);
    if (ov < PERCEPTION.enemy_host.min_overlap && !(b[2] - b[0] > hb[2] - hb[0] && ov > 0)) continue;
    const t = topAt(h, Math.min(Math.max((b[0] + b[2]) / 2, hb[0] + 0.01), hb[2] - 0.01));
    if (t === null) continue;
    const d = t - b[3];
    if (d < -1.0 || d > maxDy) continue;
    const ad = Math.abs(d);
    if (!best || ad < best.d) best = { h, d: ad };
  }
  return best?.h ?? null;
}

function startBody(at: CellXY): Rect {
  return [at[0] - 0.375, at[1] - 1.75, at[0] + 0.375, at[1]];
}

function ceilingTop(w: Work, c: number, r: number): boolean {
  const f = floorBelow(w, c + 0.5, r - 0.25, 0.5);
  if (f && f.o.role === 'ceiling') return true;
  // the top of a mass that hangs from row 0 (a cave roof)
  return w.objs.some((o) => o.shape.k === 'surface' && o.shape.fill === 'to_top' && o.collision !== 'none' && (() => {
    const s = segsSpan(o.shape.segs);
    return c >= s[0] && c < s[1];
  })() && r <= (topAt({ ...o, shape: { ...o.shape, fill: 'one_row' } }, c + 0.5) ?? 0));
}

/** The §3.3 start rule on the current terrain. */
export function computeStart(w: Work, g: Grid): CellXY {
  const near = obj(w, w.st.start_near) ?? w.objs.find((o) => o.role === 'start_marker' && !o.rel.part_of && (o.role_by === 'stamp' || o.role_by === 'kid' || o.role_by === 'model'));
  const free = (c: number, r: number): number => {
    let k = 0;
    while (k < 6 && r - 1 - k >= 0 && !g.floor(c, r - 1 - k)) k++;
    return k;
  };
  if (near) {
    const b = objBBox(near);
    const cx = Math.floor((b[0] + b[2]) / 2);
    for (const dc of [0, 1, -1, 2, -2]) {
      const c = cx + dc;
      if (c < 0 || c >= g.w) continue;
      for (let r = Math.max(2, Math.floor(b[1])); r < g.h; r++) {
        if (g.floor(c, r)) {
          if (g.standable(c, r) && !ceilingTop(w, c, r)) return [c + 0.5, r];
          break;
        }
      }
    }
  }
  const S = PERCEPTION.start;
  for (const span of [S.leftmost_cols, 16, g.w]) {
    let best: CellXY | null = null;
    for (let c = 1; c < Math.min(g.w, span); c++) {
      for (let r = g.h - 1; r >= 2; r--) {
        if (!g.standable(c, r) || free(c, r) < S.min_free_rows || ceilingTop(w, c, r)) continue;
        if (!best || r > best[1]) best = [c + 0.5, r];
        break;
      }
    }
    if (best) return best;
  }
  return [2, WORLD.ground_top_row_default];
}

function hazardsNear(w: Work, at: CellXY): { hazards: SceneObject[]; patrols: SceneObject[] } {
  const body = startBody(at);
  const C = EDIT_BOUNDS.clear_spawn;
  const hazards: SceneObject[] = [];
  const patrols: SceneObject[] = [];
  for (const o of w.objs) {
    if (o.rel.part_of) continue;
    if (o.role === 'spikes' || o.role === 'lava' || o.role === 'saw' || (o.role === 'enemy' && (!o.behavior || o.behavior.kind !== 'enemy' || o.behavior.archetype !== 'walker'))) {
      if (rectGap(objBBox(o), body) < C.hazard_min_c) hazards.push(o);
    } else if (o.role === 'enemy') {
      const b = objBBox(o);
      const patrol: Rect = [b[0] - 3, b[1], b[2] + 3, b[3]];
      if (rectGap(patrol, body) < C.patrol_min_c) patrols.push(o);
    }
  }
  return { hazards, patrols };
}

/** N8: move the start ≤ 4 cells along its surface; otherwise trim the patrol. Never deletes a hazard [B F11]. */
export function computeClearSpawn(w: Work, g: Grid): { dx: number; trimmed: string[] } | null {
  const at = w.st.start;
  if (!at) return null;
  const now = hazardsNear(w, at);
  if (!now.hazards.length && !now.patrols.length) return null;
  const row = Math.round(at[1]);
  const C = EDIT_BOUNDS.clear_spawn;
  let best: { dx: number; bad: number } | null = null;
  for (let k = 1; k <= C.move_start_max_c; k++) {
    for (const s of [1, -1]) {
      const dx = s * k;
      const c = Math.floor(at[0] + dx);
      if (!g.standable(c, row)) continue;
      // contiguous along the same surface
      let ok = true;
      for (let j = 1; j < k; j++) if (!g.standable(Math.floor(at[0] + s * j), row)) ok = false;
      if (!ok) continue;
      const h = hazardsNear(w, [at[0] + dx, at[1]]);
      const bad = h.hazards.length * 10 + h.patrols.length;
      if (!best || bad < best.bad) best = { dx, bad };
      if (bad === 0) break;
    }
    if (best && best.bad === 0) break;
  }
  const curBad = now.hazards.length * 10 + now.patrols.length;
  const dx = best && best.bad < curBad ? best.dx : 0;
  const after = hazardsNear(w, [at[0] + dx, at[1]]);
  const trimmed = after.patrols.map((o) => o.id).sort();
  if (!dx && !trimmed.length) return null;
  return { dx, trimmed };
}

/** Available room for a move path from an object, clipped at solids and the world (N12). */
function moveRoom(w: Work, o: SceneObject, dir: string, g: Grid): number {
  const b = objBBox(o);
  const step = (k: number): Rect => (dir === 'left' ? [b[0] - k, b[1], b[0] - k + 1, b[3]] : dir === 'right' ? [b[2] + k - 1, b[1], b[2] + k, b[3]] : dir === 'up' ? [b[0], b[1] - k, b[2], b[1] - k + 1] : [b[0], b[3] + k - 1, b[2], b[3] + k]);
  let k = 0;
  for (; k < 20; k++) {
    const r = step(k + 1);
    if (r[0] < 0 || r[2] > w.world.w || r[1] < 0 || r[3] > w.world.h) break;
    let hit = false;
    for (let c = Math.floor(r[0]); c < Math.ceil(r[2]) && !hit; c++) for (let rr = Math.floor(r[1]); rr < Math.ceil(r[3]) && !hit; rr++) if (g.blocks(c, rr)) hit = true;
    if (hit) break;
  }
  return k;
}

export function normalize(R: Runner, stage: Stage, inputEdits: readonly EditRecord[]): NormalizeOut {
  const warnings: MessageRef[] = [];
  const ctx = R.ctx;
  const auto = { by: 'auto' as const, stage, tier: 'faithful' as const };
  // 1. U-edits (merge, kid, library, parser) in their input order, then the heuristic detach cards
  for (const e of inputEdits) {
    if (e.class !== 'U') continue;
    R.run(e.op, { by: e.by, stage: e.stage, tier: 'faithful', cls: 'U', reason_text: e.reason_text ?? null, reason_key: e.reason_key, reason_args: e.reason_args, depends_on: e.depends_on, recordFailures: true, cid: e.cid ?? null });
  }
  // U7 library instances (§8.1): editor stamps carry `lib` on their stroke, H21 symbol matches set it on the object;
  // a pinned version that the game library no longer holds stays a non-colliding tag with a warning (never silently
  // swapped for another version: levels pin their version)
  for (const o of [...R.w.objs]) {
    if (!o.lib || o.rel.part_of || o.role_by === 'library') continue;
    const t = ctx.library.find((l) => l.id === o.lib!.type_id && l.version === o.lib!.version);
    if (!t) {
      warnings.push({ key: 'warning.library_missing', args: { about: o.id } });
      continue;
    }
    R.run({ op: 'use_library', target: o.id, type_id: t.id, version: t.version }, { by: 'library', stage, tier: 'faithful', cls: 'U', recordFailures: true, reason_args: { name: t.name } });
  }
  // kid key → door chips (F-1): `x_opens` on a key stroke names the door stroke
  if (ctx.ink) {
    for (const s of ctx.ink.strokes) {
      const doorStroke = (s as typeof s & { x_opens?: string }).x_opens;
      if (typeof doorStroke !== 'string') continue;
      const key = R.w.objs.find((o) => o.strokes.includes(s.id));
      const door = R.w.objs.find((o) => o.strokes.includes(doorStroke));
      if (key && door && key !== door) R.run({ op: 'link', key: key.id, door: door.id }, { by: 'kid', stage, tier: 'faithful', cls: 'U', recordFailures: true });
    }
  }
  for (const o of [...R.w.objs]) {
    const hints = (o as SceneObject & { x_detach?: { branch: string; into: string | null }[] }).x_detach ?? [];
    for (const h of hints) R.run({ op: 'detach', target: o.id, branch: h.branch }, { by: 'heuristic', stage: 'ink', tier: 'faithful', cls: 'U' });
  }
  // H16: offline, an arrow whose tail touches a ledge means "this ledge moves" (cells = shaft length); the model's
  // own binding for that ledge, or any kid binding, wins
  const bound = new Set(inputEdits.filter((e) => e.op.op === 'bind' && e.status !== 'undone').map((e) => (e.op as { target: string }).target));
  for (const a of [...R.w.objs]) {
    if (a.role !== 'arrow' || !a.rel.refers_to || a.origin === 'designer' || !a.rel.points || a.rel.points === 'none') continue;
    const t = obj(R.w, a.rel.refers_to);
    if (!t || t.role !== 'platform' || t.behavior || bound.has(t.id)) continue;
    const ab = objBBox(a);
    const cells = Math.max(2, Math.min(12, Math.round(Math.max(ab[2] - ab[0], ab[3] - ab[1]))));
    R.run({ op: 'bind', target: t.id, behavior: { kind: 'move', dir: a.rel.points, cells, speed: 2, mode: 'pingpong' } }, { by: 'heuristic', stage: 'ink', tier: 'faithful', cls: 'U', reason_key: 'understand.moves', reason_args: { dir: a.rel.points, cells } });
  }
  // 2. N1 straighten every surface
  const straightened: string[] = [];
  for (const o of R.w.objs) {
    if (o.shape.k !== 'surface' || !o.strokes.length || o.rel.part_of || o.collision === 'none' || o.role_by === 'library') continue;
    const a = R.run({ op: 'straighten', target: o.id, max_shift: 0.85 }, { ...auto, group: 'tidy_lines' });
    if (a && a.rec.status === 'applied') straightened.push(a.rec.id);
  }
  for (const r of R.records) if (straightened.includes(r.id) && r.reason_key === 'norm.straightened') {
    r.reason_key = 'norm.tidy_lines';
    r.reason_args = { ...(r.reason_args ?? {}), n: straightened.length };
  }
  // 3. N2 close_gap and N11 join_seam
  const surfs = R.w.objs.filter((o) => o.shape.k === 'surface' && !o.rel.part_of && o.collision !== 'none' && !isDynamic(o));
  for (const a of surfs) {
    for (const b of surfs) {
      if (a === b || family(a) !== family(b)) continue;
      const ea = surfEnds(a);
      const eb = surfEnds(b);
      if (!ea || !eb) continue;
      const gap = eb.x0 - ea.x1;
      const dy = Math.abs(eb.y0 - ea.y1);
      const seam = Math.round(ea.x1 / WORLD.screen_w) * WORLD.screen_w;
      const atSeam = ctx.ink?.source === 'paper' && Math.abs(ea.x1 - seam) <= EDIT_BOUNDS.join_seam.max_c && Math.abs(eb.x0 - seam) <= EDIT_BOUNDS.join_seam.max_c && seam > 0;
      // ends that touch or overlap by a hair still join at a paper seam (C-6 §3); elsewhere a real gap is needed
      if (gap <= 0 && !(atSeam && dy > 1e-6)) continue;
      if (atSeam && dy <= EDIT_BOUNDS.join_seam.max_dy_c) R.run({ op: 'join_seam', a: a.id, b: b.id }, { ...auto, group: 'tidy_lines', depends_on: straightened });
      else if (gap <= EDIT_BOUNDS.close_gap.max_gap_c && dy <= EDIT_BOUNDS.close_gap.max_dy_c && a.role === b.role) R.run({ op: 'close_gap', a: a.id, b: b.id }, { ...auto, group: 'tidy_lines' });
    }
  }
  // 4. N6 set_collision: thin floating platforms are one-way; filled or wall-attached ones stay solid
  for (const o of R.w.objs) {
    if (o.role !== 'platform' || o.shape.k !== 'surface' || o.rel.part_of || o.collision === 'none' || isDynamic(o)) continue;
    const strokes = ctx.ink ? ctx.ink.strokes.filter((s) => o.strokes.includes(s.id)) : [];
    const wMed = strokes.length ? strokes.map((s) => [...s.w].sort((x, y) => x - y)[s.w.length >> 1] ?? 0.5).sort((x, y) => x - y)[strokes.length >> 1] : 0.5;
    const filled = strokes.some((s) => s.kind === 'blob');
    const b = objBBox(o);
    const onWall = R.w.objs.some((q) => isWallLike(q) && rectGap(objBBox(q), b) <= 0.3);
    const inkBelow = R.w.objs.some((q) => q !== o && !q.rel.part_of && q.collision !== 'none' && q.role !== 'spikes' && overlap1(objBBox(q)[0], objBBox(q)[2], b[0], b[2]) > 0.5 && objBBox(q)[1] >= b[3] - 0.05 && objBBox(q)[1] - b[3] <= 0.5);
    const want = !filled && !onWall && !inkBelow && wMed <= 0.9 ? 'one_way' : 'solid';
    if (want !== o.collision) R.run({ op: 'set_collision', target: o.id, mode: want }, { ...auto, group: 'platforms' });
  }
  // 5. N3 snap, then N4 orient
  const hint = (id: string): { host: string; face: Face } | null => {
    for (const e of inputEdits) if (e.op.op === 'snap' && e.op.target === id && e.status === 'applied') return { host: e.op.host, face: e.op.face };
    return null;
  };
  for (const o of [...R.w.objs]) {
    if (o.rel.part_of || o.origin === 'designer') continue;
    const h = hint(o.id);
    if (o.role === 'spikes' && o.shape.k === 'strip') {
      const drawn = ctx.ink ? objectInkBBox(o, ctx.ink) : null;
      const found = h && obj(R.w, h.host) ? { host: obj(R.w, h.host)!, face: h.face } : spikeHost(R.w, o, drawn);
      if (!found) continue;
      const a = R.run({ op: 'snap', target: o.id, host: found.host.id, face: found.face }, { ...auto, group: 'snap_hazards', by: h ? 'model' : 'auto' });
      if (a?.rec.status === 'applied' && found.face !== 'top') {
        const facing = found.face === 'bottom' ? 'down' : found.face;
        R.run({ op: 'orient', target: o.id, facing }, { ...auto, group: 'snap_hazards', depends_on: [a.rec.id] });
      }
      continue;
    }
    if (o.role === 'enemy' || o.role === 'checkpoint' || o.role === 'spring' || o.role === 'door' || o.role === 'key') {
      if (o.role === 'enemy' && o.behavior?.kind === 'enemy' && o.behavior.archetype === 'flyer') continue;
      // a flag on a pole is grounded by its pole foot (N5 form_goal); snapping the cloth would sink the pole
      if (o.role === 'checkpoint' && (o.rel.parts ?? []).some((pid) => obj(R.w, pid)?.role === 'pole')) continue;
      const max = o.role === 'key' ? 1 : EDIT_BOUNDS.snap_max_c.enemy;
      const host = h && obj(R.w, h.host) ? obj(R.w, h.host)! : standHost(R.w, o, max);
      if (!host) continue;
      R.run({ op: 'snap', target: o.id, host: host.id, face: 'top' }, { ...auto, group: o.role === 'enemy' ? 'creatures' : 'snap_hazards', reason_key: o.role === 'enemy' ? 'norm.enemy_grounded' : 'norm.snapped' });
    }
  }
  // 6. N5 form_goal (goals and checkpoint flags: the pole is scenery, the flag is grounded)
  for (const o of [...R.w.objs]) {
    if ((o.role !== 'goal' && o.role !== 'checkpoint') || o.rel.part_of) continue;
    const pole = (o.rel.parts ?? []).map((id) => obj(R.w, id)).find((p) => p && (p.role === 'pole' || p.shape.k === 'wall'));
    R.run({ op: 'form_goal', flag: o.id, pole: pole?.id ?? null }, { ...auto, required: o.role === 'goal', reason_key: pole ? 'norm.pole_scenery' : 'norm.goal_grounded' });
  }
  // 7. N12 fix_behavior + the structural validator
  let g = rasterize(R.w);
  for (const o of [...R.w.objs]) {
    const b = o.behavior;
    if (!b) continue;
    if ((b.kind === 'move' || b.kind === 'crumble' || b.kind === 'falling') && o.role === 'ground' && objBBox(o)[2] - objBBox(o)[0] > PERCEPTION.ground_no_move_screen_frac * WORLD.screen_w) {
      R.run({ op: 'fix_behavior', target: o.id, param: 'kind', value: null }, { ...auto, by: 'validator', skipInvariants: true, reason_key: 'norm.ground_stays', required: true });
      continue;
    }
    if (b.kind === 'move') {
      const room = moveRoom(R.w, o, b.dir, g);
      const want = Math.min(b.cells, room);
      if (want < VALIDATOR.min_path_c) R.run({ op: 'fix_behavior', target: o.id, param: 'cells', value: null }, { ...auto, by: 'validator', skipInvariants: true, reason_key: 'norm.behavior_dropped', required: true });
      else if (want !== b.cells) R.run({ op: 'fix_behavior', target: o.id, param: 'cells', value: want }, { ...auto, by: 'validator', skipInvariants: true, reason_key: 'norm.behavior_fixed', reason_args: { cells: want }, required: true });
    }
  }
  // keys and doors pair up; an orphan key becomes a coin (+ a warning the UI turns into an Ask card)
  const keys = R.w.objs.filter((o) => o.role === 'key' && !o.rel.part_of);
  const doors = R.w.objs.filter((o) => o.role === 'door' && !o.rel.part_of);
  if (keys.length === 1 && doors.length === 1 && !keys[0].rel.refers_to) R.run({ op: 'link', key: keys[0].id, door: doors[0].id }, { by: 'validator', stage, tier: 'faithful', cls: 'U' });
  for (const k of R.w.objs.filter((o) => o.role === 'key' && !o.rel.part_of)) {
    if (k.rel.refers_to && obj(R.w, k.rel.refers_to)?.role === 'door') continue;
    R.run({ op: 'set_role', target: k.id, role: 'coin' }, { by: 'validator', stage, tier: 'faithful', cls: 'U', reason_key: 'norm.key_to_coin' });
    warnings.push({ key: 'ask.which_door', args: { about: k.id } });
  }
  for (const d of R.w.objs.filter((o) => o.role === 'door' && !o.rel.part_of)) {
    if (d.rel.refers_to && obj(R.w, d.rel.refers_to)?.role === 'key') continue;
    R.run({ op: 'set_role', target: d.id, role: 'wall' }, { by: 'validator', stage, tier: 'faithful', cls: 'U', reason_key: 'understand.role' });
  }
  // exactly one goal: extra flags become checkpoints (rightmost wins); none → a pencil goal at the right end
  const goals = R.w.objs.filter((o) => o.role === 'goal' && !o.rel.part_of).sort((a, b) => objBBox(b)[0] - objBBox(a)[0]);
  for (const x of goals.slice(1)) R.run({ op: 'set_role', target: x.id, role: 'checkpoint' }, { by: 'validator', stage, tier: 'faithful', cls: 'U' });
  if (!goals.length) {
    g = rasterize(R.w);
    let at: CellXY | null = null;
    for (let c = g.w - 2; c >= g.w / 2 && !at; c--) for (let r = g.h - 1; r >= 2; r--) if (g.standable(c, r)) {
      at = [c + 0.5, r];
      break;
    }
    if (at) {
      const op = { op: 'form_goal', flag: 'e_goal', pole: null, x_at: at } as EditOp;
      if (!R.isUndone(op)) {
        R.w.objs.push({
          id: 'e_goal', components: [], strokes: [], role: 'goal', conf: 1, role_by: 'designer', origin: 'designer',
          shape: { k: 'body', bbox: [q16(at[0] - 0.5), q16(at[1] - 2.5), q16(at[0] + 1), q16(at[1])] }, collision: 'trigger', rel: {},
          behavior: null, pinned: [], alt: [], lib: null, text: null,
        });
        R.w.st.added.push('e_goal');
      }
      R.run(op, { by: 'validator', stage, tier: 'faithful', required: true, reason_key: 'norm.goal_added' });
    }
  }
  // same-type entities within 0.5 cell → dedupe
  const pickups = R.w.objs.filter((o) => (o.role === 'coin' || o.role === 'big_coin') && !o.rel.part_of);
  for (let i = 0; i < pickups.length; i++) for (let j = i + 1; j < pickups.length; j++) {
    const a = pickups[i];
    const b = pickups[j];
    if (a.role === b.role && rectGap(objBBox(a), objBBox(b)) < VALIDATOR.same_type_min_dist_c - 0.4 && a.role === 'coin') {
      const [keep, drop] = a.origin === 'parent' || a.id < b.id ? [a, b] : [b, a];
      R.run({ op: 'dedupe', keep: keep.id, drop: drop.id }, { ...auto });
    }
  }
  // 8. N7 place_start, then N8 clear_spawn
  g = rasterize(R.w);
  const at = computeStart(R.w, g);
  R.run({ op: 'place_start', at }, { ...auto, required: true, reason_key: 'norm.start_placed' });
  const cs = computeClearSpawn(R.w, g);
  if (cs) R.run({ op: 'clear_spawn', start_dx: cs.dx, trimmed: cs.trimmed }, { ...auto, reason_key: cs.dx ? 'norm.spawn_moved' : 'norm.patrol_trimmed', reason_args: { cells: Math.abs(cs.dx) } });
  // 9. N10 dedupe (remix): same type within 0.75 → keep the parent's
  if (ctx.ink?.parent) {
    const objs = R.w.objs.filter((o) => !o.rel.part_of && o.role !== 'decoration' && o.role !== 'text' && o.role !== 'unknown');
    for (let i = 0; i < objs.length; i++) for (let j = i + 1; j < objs.length; j++) {
      const a = objs[i];
      const b = objs[j];
      if (a.role !== b.role || (a.origin === 'parent') === (b.origin === 'parent')) continue;
      if (rectGap(objBBox(a), objBBox(b)) > EDIT_BOUNDS.dedupe_max_c) continue;
      const [keep, drop] = a.origin === 'parent' ? [a, b] : [b, a];
      R.run({ op: 'dedupe', keep: keep.id, drop: drop.id }, { ...auto });
    }
  }
  // 10. N13 fit_creature
  for (const o of R.w.objs) {
    if (o.role !== 'enemy' || o.rel.part_of || o.origin === 'designer') continue;
    R.run({ op: 'fit_creature', target: o.id }, { ...auto, group: 'creatures' });
  }
  return { warnings };
}
