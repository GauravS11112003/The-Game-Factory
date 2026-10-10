/**
 * Designer-grade playtest flags (§4.3). Severity: block stops publishing; hard is never introduced by a designer
 * output (I6) and Faithful repairs try to clear it; warn / info / target are "Heads up" cards. `fix_cids` are left
 * empty here; the design layer (lane B) fills them from its menu.
 */
import { FLAGS } from '../params.ts';
import { UNBOUNDED_F } from '../difficulty/model.ts';
import { CELL, T_LAVA } from '../sim/tiles.ts';
import { firebarReach } from '../sim/world.ts';
import type { DEnemy, DFirebar, DSaw, DSpikes, EntDef } from '../sim/world.ts';
import type { CellXY, Flag, FlagCode, Severity } from '../types.gen.ts';
import { objectsIn, r2 } from './context.ts';
import type { Ctx } from './context.ts';
import { template } from './envelope.ts';
import { frameCost } from './route.ts';

function flag(code: FlagCode, severity: Severity, n: number, at: CellXY | null, o: Partial<Flag> = {}): Flag {
  return { id: `${code}.${n}`, code, severity, frame: null, at, object_ids: [], fix_cids: [], message_key: `flag.${code}`, args: {}, ...o };
}

const challenging = (t: string): boolean => t === 'normal' || t === 'hard';

/** Is the entity drawn by the kid (not added by the designer)? */
function drawn(d: EntDef, origin: string | null | undefined): boolean {
  void d;
  return origin !== 'designer' && origin !== 'library' && origin !== 'draft';
}

export function originOf(ctx: Ctx, d: EntDef): string | null {
  const e = (ctx.level.compiled.entities ?? []).find((x) => x.id === d.id);
  return e?.origin ?? null;
}

/** Hazard / patrol distance (px) from a spawn point (feet x, y) to an entity. */
function spawnDistance(d: EntDef, x: number, y: number): { hazard: number; patrol: number } {
  const body = [x - 6, y - 28, x + 6, y];
  const boxDist = (b: number[]): number => {
    const dx = Math.max(b[0] - body[2], body[0] - b[2], 0);
    const dy = Math.max(b[1] - body[3], body[1] - b[3], 0);
    return Math.sqrt(dx * dx + dy * dy);
  };
  switch (d.k) {
    case 'spikes':
      return { hazard: boxDist((d as DSpikes).band), patrol: Infinity };
    case 'saw': {
      const s = d as DSaw;
      let m = Infinity;
      for (const p of s.path.pts) m = Math.min(m, boxDist([p[0] - s.rHit, p[1] - s.rHit, p[0] + s.rHit, p[1] + s.rHit]));
      return { hazard: m, patrol: Infinity };
    }
    case 'firebar': {
      const f = d as DFirebar;
      const reach = firebarReach(f.balls);
      return { hazard: boxDist([f.x - reach, f.y - reach, f.x + reach, f.y + reach]), patrol: Infinity };
    }
    case 'enemy': {
      const e = d as DEnemy;
      let x0 = e.x - e.hw;
      let x1 = e.x + e.hw;
      let y0 = e.y - e.h;
      let y1 = e.y;
      if (e.bounds && (e.arch === 'walker' || e.arch === 'chaser' || e.arch === 'hopper' || e.arch === 'flyer')) {
        x0 = e.bounds[0] - e.hw;
        x1 = e.bounds[1] + e.hw;
      } else if (e.arch === 'flyer') {
        const r = e.pattern === 'circle' ? e.radius * 2 : e.pattern === 'horizontal' ? e.range / 2 : 0;
        x0 -= r;
        x1 += r;
        if (e.pattern === 'vertical') {
          y0 -= e.range / 2;
          y1 += e.range / 2;
        }
      } else if (e.arch === 'walker' || e.arch === 'chaser') {
        x0 -= 4 * CELL;
        x1 += 4 * CELL;
      }
      return { hazard: Infinity, patrol: boxDist([x0, y0, x1, y1]) };
    }
    default:
      return { hazard: Infinity, patrol: Infinity };
  }
}

export function computeFlags(ctx: Ctx): Flag[] {
  const out: Flag[] = [];
  const { W, ex, steps, tier } = ctx;
  const T = ex.sim.T;
  let n = 0;
  // entity errors
  for (const er of W.errors) out.push(flag('entity_error', 'warn', n++, null, { object_ids: [er.id], args: { what: er.message } }));
  // per required action
  for (const s of steps) {
    const at: CellXY = [r2(s.takeoff[0] / CELL), r2(s.takeoff[1] / CELL)];
    const ids = s.edges[0]?.touched.map((t) => W.defs[t].id) ?? [];
    if (s.required) {
      const wmin = Math.min(s.win.w, s.win.h, s.win.phi ?? UNBOUNDED_F);
      if (wmin < FLAGS.tight_window_f) out.push(flag('tight_window', 'hard', n++, at, { frame: s.pressF >= 0 ? s.pressF : s.startF, args: { frames: r2(wmin) }, object_ids: ids }));
    }
    if (s.blind) {
      const isDrop = s.kind === 'drop' || s.kind === 'dropthrough';
      out.push(flag(isDrop ? 'leap_of_faith' : 'blind_jump', 'hard', n++, at, { frame: isDrop ? s.leaveF : s.pressF, args: { land_x: r2(s.land[0] / CELL) } }));
    }
    if (s.bonk && (s.kind === 'jump' || s.kind === 'runjump')) {
      const a = s.edges[0].act;
      const tpl = template(W.prof, a.speed, a.hold, a.dj);
      const lost = tpl.apex - (s.takeoff[1] - s.apexY);
      if (lost >= FLAGS.head_bonk_reach_loss_c * CELL) out.push(flag('head_bonk', 'warn', n++, at, { frame: s.pressF, args: { lost: r2(lost / CELL) } }));
    }
  }
  // spawn safety: start and checkpoints
  const spawns: { x: number; y: number; id: string }[] = [{ x: W.start.x, y: W.start.y, id: W.start.id ?? 'start' }];
  for (const i of W.checkpoints) {
    const d = W.defs[i] as { x: number; y: number; id: string };
    spawns.push({ x: d.x, y: d.y, id: d.id });
  }
  for (const sp of spawns) {
    const bad: string[] = [];
    for (const d of W.defs) {
      const dist = spawnDistance(d, sp.x, sp.y);
      if (dist.hazard <= FLAGS.spawn_unsafe.hazard_c * CELL || dist.patrol <= FLAGS.spawn_unsafe.patrol_c * CELL) bad.push(d.id);
    }
    // lava within 2 cells
    const c0 = Math.floor((sp.x - 2 * CELL) / CELL);
    const c1 = Math.floor((sp.x + 2 * CELL) / CELL);
    const r0 = Math.floor((sp.y - 2 * CELL - 28) / CELL);
    const r1 = Math.floor((sp.y + 2 * CELL) / CELL);
    let lava = false;
    for (let r = r0; r <= r1 && !lava; r++) for (let c = c0; c <= c1; c++) if (T.at(c, r) === T_LAVA) lava = true;
    if (bad.length || lava) out.push(flag('spawn_unsafe', 'hard', n++, [r2(sp.x / CELL), r2(sp.y / CELL)], { object_ids: [sp.id, ...bad] }));
  }
  // invisible lethal: crush deaths next to the route
  const crush = ex.deaths.filter((d) => d.cause === 'crush' && ctx.routeNodes.has(d.from));
  if (crush.length) out.push(flag('invisible_lethal', 'hard', n++, [r2(crush[0].x / CELL), r2(crush[0].y / CELL)], { args: { cause: 'crush' } }));
  // segments: long ones
  for (const s of ctx.segs) {
    if (s.F_s > FLAGS.long_segment.F_s || s.T_ms / 1000 > FLAGS.long_segment.T_s) {
      out.push(flag('long_segment', tier === 'faithful' ? 'warn' : 'hard', n++, null, { args: { segment: s.id, F_s: r2(s.F_s), T_s: r2(s.T_ms / 1000) } }));
    }
  }
  // trivial
  if (ctx.C < FLAGS.trivial_C && steps.length) out.push(flag('trivial', 'info', n++, null, { args: { C: r2(ctx.C) } }));
  // long flat stretches with no required action
  {
    let runCells = 0;
    let runF = 0;
    let at: CellXY | null = null;
    const flush = (): void => {
      if (at && (runCells >= FLAGS.long_flat.cells || runF / 60 > FLAGS.long_flat.seconds)) {
        out.push(flag('long_flat', challenging(tier) ? 'target' : 'info', n++, at, { args: { cells: r2(runCells), seconds: r2(runF / 60) } }));
      }
      runCells = 0;
      runF = 0;
      at = null;
    };
    for (const s of steps) {
      if (!s.required && (s.kind === 'walk' || s.kind === 'wait' || s.kind === 'ride')) {
        if (!at) at = [r2(s.takeoff[0] / CELL), r2(s.takeoff[1] / CELL)];
        runCells += Math.abs(s.land[0] - s.takeoff[0]) / CELL;
        runF += s.frames;
      } else flush();
    }
    flush();
  }
  // skippable setpieces: drawn hazards / enemies the route never comes within 2 cells of
  if (steps.length) {
    for (const d of W.defs) {
      if (d.k !== 'spikes' && d.k !== 'enemy' && d.k !== 'saw' && d.k !== 'firebar') continue;
      if (!drawn(d, originOf(ctx, d))) continue;
      if (ctx.entMin[d.i] <= FLAGS.skippable_setpiece_c * CELL || ctx.stomped.has(d.i)) continue;
      const p = d.k === 'spikes' ? [(d.band[0] + d.band[2]) / 2, d.band[3]] : d.k === 'saw' ? d.path.pts[0] : [d.x, d.y];
      out.push(flag('skippable_setpiece', challenging(tier) ? 'target' : 'info', n++, [r2(p[0] / CELL), r2(p[1] / CELL)], { object_ids: [d.id] }));
    }
  }
  // unreachable drawn pickups and platforms (full exploration only)
  if (ctx.mode === 'full' && !ex.approx) {
    for (const i of [...W.coins, ...W.bigs, ...W.keys]) {
      const d = W.defs[i] as { id: string; x: number; y: number } & EntDef;
      if (!drawn(d, originOf(ctx, d))) continue;
      if (!ex.touchedAll.has(i)) out.push(flag('unreachable_drawn', 'warn', n++, [r2(d.x / CELL), r2(d.y / CELL)], { object_ids: [d.id], args: { what: d.k } }));
    }
    for (const c of T.comps) {
      if (c.n < 2 || ex.surfSeen.has('S' + c.id)) continue;
      const p = T.pieces[c.c0].find((q) => q.comp === c.id);
      if (!p) continue;
      const y = Math.min(p.yl, p.yr);
      if (y >= W.hPx - CELL || y < 2 * CELL) continue;
      const objs = objectsIn(ctx.level, c.c0, y / CELL - 1, c.c1 + 1, y / CELL + 1, ['ground', 'platform', 'ceiling', 'wall']);
      const objOf = (id: string) => (ctx.level.objects ?? []).find((o) => o.id === id);
      if (objs.some((id) => objOf(id)?.role === 'ceiling' || objOf(id)?.role === 'wall')) continue;
      if (objs.length && objs.every((id) => objOf(id)?.origin === 'designer')) continue;
      out.push(flag('unreachable_drawn', 'warn', n++, [r2((c.c0 + c.c1 + 1) / 2), r2(y / CELL)], { object_ids: objs, args: { what: 'platform' } }));
    }
    for (const i of W.kin) {
      const d = W.defs[i];
      if (d.k !== 'moving_platform' && d.k !== 'crumble' && d.k !== 'falling_platform') continue;
      if (ex.surfSeen.has('K' + i)) continue;
      out.push(flag('unreachable_drawn', 'warn', n++, [r2(d.x / CELL), r2(d.y / CELL)], { object_ids: [d.id], args: { what: d.k } }));
    }
  }
  // softlock and dead ends (full exploration only)
  if (ctx.mode === 'full' && !ex.approx && ctx.steps.length) {
    const N = ex.nodes.length;
    const lethal = new Uint8Array(N);
    for (const d of ex.deaths) lethal[d.from] = 1;
    const hopeless = (i: number): boolean => ctx.reach[i] === 1 && !Number.isFinite(ctx.d2g[i]);
    // canDie propagates backwards among hopeless nodes
    const canDie = new Uint8Array(N);
    const q: number[] = [];
    for (let i = 0; i < N; i++) if (hopeless(i) && lethal[i]) {
      canDie[i] = 1;
      q.push(i);
    }
    while (q.length) {
      const v = q.pop() as number;
      for (const ei of ex.nodes[v].inc) {
        const u = ex.edges[ei].from;
        if (hopeless(u) && !canDie[u]) {
          canDie[u] = 1;
          q.push(u);
        }
      }
    }
    const seenSurf = new Set<string>();
    for (let i = 0; i < N; i++) {
      if (!hopeless(i) || canDie[i]) continue;
      const nd = ex.nodes[i];
      if (seenSurf.has(nd.surf)) continue;
      seenSurf.add(nd.surf);
      out.push(flag('softlock', tier === 'faithful' ? 'warn' : 'hard', n++, [r2(nd.x / CELL), r2(nd.y / CELL)]));
    }
    // dead ends: cost (frames) to get back onto the route
    const back = new Float64Array(N).fill(Infinity);
    const heap: number[] = [];
    for (const i of ctx.routeNodes) {
      back[i] = 0;
      heap.push(i);
    }
    // simple label-correcting relaxation over reversed edges (graphs are small)
    let guard = 0;
    while (heap.length && guard++ < 2_000_000) {
      const v = heap.pop() as number;
      for (const ei of ex.nodes[v].inc) {
        const e = ex.edges[ei];
        const nd = back[v] + frameCost(e);
        if (nd < back[e.from] - 1e-9) {
          back[e.from] = nd;
          heap.push(e.from);
        }
      }
    }
    const deadSurf = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      if (ctx.reach[i] !== 1 || ctx.routeNodes.has(i)) continue;
      if (!Number.isFinite(back[i]) || back[i] <= FLAGS.dead_end_s * 60) continue;
      const s = ex.nodes[i].surf;
      const prev = deadSurf.get(s);
      if (prev === undefined || back[prev] < back[i]) deadSurf.set(s, i);
    }
    for (const [, i] of deadSurf) {
      const nd = ex.nodes[i];
      out.push(flag('dead_end', 'info', n++, [r2(nd.x / CELL), r2(nd.y / CELL)], { args: { seconds: r2(back[i] / 60) } }));
    }
  }
  return out;
}
