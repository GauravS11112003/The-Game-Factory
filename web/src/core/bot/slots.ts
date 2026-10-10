/**
 * Slots: the only places the designer may add content (§3.5, D7). Every slot comes from the bot's real route and
 * explored graph, so additions land where play actually happens. Coordinates are cells: x is the centre, y the
 * feet line for grounded things (checkpoint, enemy, spring, step) and the centre for floating ones (coin, risk,
 * hazard, hint). Spikes slots carry the face and x0..x1 along it.
 *
 * Bounds applied here (EDIT_BOUNDS, §3.5): checkpoints on ≥ 3 flat cells, ≥ 3 cells from hazards and enemy paths,
 * none in the first 24 cells; enemies ≥ 6 cells from spawns, walkers/chasers on ≥ 8 flat cells, hoppers on ≥ 6
 * with ≥ 4 rows of headroom, flyers in 3 × 3 clear air; spikes 1-6 cells on undrawn faces leaving a landing ≥ 2,
 * ≥ 3 cells from spawns; hazards ≥ 1 cell clear of terrain.
 */
import { EDIT_BOUNDS } from '../params.ts';
import { CELL, T_EMPTY, T_LAVA, T_X, isSlope } from '../sim/tiles.ts';
import { firebarReach } from '../sim/world.ts';
import type { DCheckpoint, DEnemy, DSpikes } from '../sim/world.ts';
import type { Slot, Slots } from '../types.gen.ts';
import { objectsIn, r2 } from './context.ts';
import type { Ctx } from './context.ts';
import type { FrontierResult } from './frontier.ts';

const C = CELL;

function emptySlots(): Required<Slots> {
  return { checkpoint: [], coin: [], risk: [], enemy: [], hazard: [], spikes: [], step: [], spring: [], hint: [] };
}

export function computeSlots(ctx: Ctx, front: FrontierResult | null): Slots {
  const out = emptySlots();
  const { W, ex, steps } = ctx;
  const T = ex.sim.T;
  const level = ctx.level;
  const segOfX = (x: number): string | null => {
    for (const s of steps) {
      const lo = Math.min(s.takeoff[0], s.land[0]);
      const hi = Math.max(s.takeoff[0], s.land[0]);
      if (x >= lo - 8 && x <= hi + 8) return ctx.segs[s.seg]?.id ?? null;
    }
    return null;
  };
  const hostAt = (x: number, feet: number): string | null => {
    const ids = objectsIn(level, x / C - 0.5, feet / C - 0.5, x / C + 0.5, feet / C + 1, ['ground', 'platform', 'ceiling', 'wall']);
    if (ids.length) return ids[0];
    const p = T.pieceAt(x, feet);
    return p ? `S${p.comp}` : null;
  };
  const spawns: [number, number][] = [[W.start.x, W.start.y]];
  for (const i of W.checkpoints) spawns.push([(W.defs[i] as DCheckpoint).x, (W.defs[i] as DCheckpoint).y]);
  const nearSpawn = (x: number, y: number, cells: number): boolean => spawns.some(([sx, sy]) => Math.abs(sx - x) <= cells * C && Math.abs(sy - y) <= 4 * C);
  const hazardNear = (x: number, y: number, cells: number): boolean => {
    const r = cells * C;
    for (const d of W.defs) {
      if (d.k === 'spikes') {
        const b = (d as DSpikes).band;
        if (b[0] - r <= x && b[2] + r >= x && b[1] - r <= y && b[3] + r >= y - 28) return true;
      } else if (d.k === 'saw') {
        for (const p of d.path.pts) if (Math.abs(p[0] - x) <= r + d.r && Math.abs(p[1] - (y - 14)) <= r + d.r) return true;
      } else if (d.k === 'firebar') {
        const reach = firebarReach(d.balls);
        if (Math.abs(d.x - x) <= r + reach && Math.abs(d.y - (y - 14)) <= r + reach) return true;
      } else if (d.k === 'enemy') {
        const e = d as DEnemy;
        const x0 = (e.bounds ? e.bounds[0] : e.x - (e.arch === 'static' ? 0 : 4 * C)) - e.hw;
        const x1 = (e.bounds ? e.bounds[1] : e.x + (e.arch === 'static' ? 0 : 4 * C)) + e.hw;
        if (x0 - r <= x && x1 + r >= x && Math.abs(e.y - y) <= r + e.h) return true;
      }
    }
    const c0 = Math.floor((x - r) / C);
    const c1 = Math.floor((x + r) / C);
    const rr = Math.floor(y / C);
    for (let c = c0; c <= c1; c++) for (let k = rr - 2; k <= rr + 1; k++) if (T.at(c, k) === T_LAVA || T.at(c, k) === T_X) return true;
    return false;
  };
  /** Flat run of standable columns around column cx at feet row (exact same y). */
  const flatRun = (cx: number, feet: number): [number, number] => {
    const flat = (c: number): boolean => {
      for (const p of T.pieces[c] ?? []) if (!isSlope(p.code) && p.yl === feet) return T.at(c, Math.floor((feet - 1) / C)) === T_EMPTY && T.at(c, Math.floor((feet - 17) / C)) === T_EMPTY;
      return false;
    };
    if (!flat(cx)) return [cx, cx - 1];
    let a = cx;
    let b = cx;
    while (a - 1 >= 0 && flat(a - 1)) a--;
    while (b + 1 < T.w && flat(b + 1)) b++;
    return [a, b];
  };
  const airClear = (x: number, y: number, rc: number): boolean => {
    const c0 = Math.floor((x - rc * C) / C);
    const c1 = Math.floor((x + rc * C - 0.01) / C);
    const r0 = Math.floor((y - rc * C) / C);
    const r1 = Math.floor((y + rc * C - 0.01) / C);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r < 0 || T.at(c, r) !== T_EMPTY) return false;
    return true;
  };
  const coinTaken = (x: number, y: number): boolean => {
    for (const i of [...W.coins, ...W.bigs, ...W.keys]) {
      const d = W.defs[i] as { x: number; y: number };
      if (Math.abs(d.x - x) < 0.75 * C && Math.abs(d.y - y) < 0.75 * C) return true;
    }
    return false;
  };
  const push = (list: Slot[], kind: string, s: Omit<Slot, 'id'>): void => {
    list.push({ id: `slot.${kind}.${list.length}`, ...s });
  };

  // ---- checkpoints: flat ≥ 3 cells on the route, hazard-clear, not in the first 24 cells -------------------
  {
    const used = new Set<number>();
    const cand: { x: number; y: number; t: number; seg: string | null }[] = [];
    let t = 0;
    for (const s of steps) {
      for (const e of s.edges) {
        const n = e.to >= 0 ? ex.nodes[e.to] : null;
        t += e.frames;
        if (!n || n.surf[0] !== 'S') continue;
        const cx = Math.floor(n.x / C);
        if (used.has(cx)) continue;
        used.add(cx);
        const [a, b] = flatRun(cx, n.y);
        if (b - a + 1 < EDIT_BOUNDS.checkpoint.min_flat_c) continue;
        if (cx - a < 1 || b - cx < 1) continue;
        if (Math.abs(n.x - W.start.x) < EDIT_BOUNDS.checkpoint.none_before_c * C) continue;
        if (hazardNear(n.x, n.y, EDIT_BOUNDS.checkpoint.hazard_clear_c)) continue;
        if (W.checkpoints.some((i) => Math.abs((W.defs[i] as DCheckpoint).x - n.x) < 6 * C)) continue;
        cand.push({ x: cx * C + 8, y: n.y, t, seg: ctx.segs[s.seg]?.id ?? null });
      }
    }
    let last = -Infinity;
    const perScreen = new Map<number, number>();
    for (const c of cand) {
      if (c.x - last < 6 * C) continue;
      const sc = Math.floor(c.x / (48 * C));
      if ((perScreen.get(sc) ?? 0) >= 4) continue;
      perScreen.set(sc, (perScreen.get(sc) ?? 0) + 1);
      last = c.x;
      push(out.checkpoint, 'cp', { x: r2(c.x / C), y: r2(c.y / C), host: hostAt(c.x, c.y), face: 'top', segment: c.seg, tags: [`t:${r2(c.t / 60)}`] });
    }
  }

  // ---- coins: on the bot's actual arcs and above walked stretches ---------------------------------------
  for (const s of steps) {
    const jumpy = s.kind === 'jump' || s.kind === 'runjump' || s.kind === 'spring' || s.kind === 'stomp' || s.kind === 'drop';
    const seg = ctx.segs[s.seg]?.id ?? null;
    if (jumpy && s.path.length >= 4) {
      const n = Math.min(7, Math.max(3, Math.round(Math.abs(s.land[0] - s.takeoff[0]) / (1.25 * C))));
      for (let k = 0; k < n; k++) {
        const p = s.path[Math.min(s.path.length - 1, Math.round(((k + 1) * (s.path.length - 1)) / (n + 1)))];
        const cx = p[0];
        const cy = p[1] - 14;
        if (coinTaken(cx, cy) || !airClear(cx, cy, 0.4)) continue;
        push(out.coin, 'coin', { x: r2(cx / C), y: r2(cy / C), segment: seg, tags: ['arc', `action:${s.i}`, `n:${n}`, `k:${k}`] });
      }
    } else if (s.kind === 'walk' && !s.required) {
      const x0 = Math.min(s.takeoff[0], s.land[0]);
      const x1 = Math.max(s.takeoff[0], s.land[0]);
      for (let x = Math.ceil(x0 / (2 * C)) * 2 * C + 8; x <= x1; x += 2 * C) {
        const feet = ex.sim.supportY(x, s.takeoff[1] - 20, s.takeoff[1] + 20, s.takeoff[1] - 20);
        if (!Number.isFinite(feet)) continue;
        const cy = feet - 1.5 * C;
        if (coinTaken(x, cy) || !airClear(x, cy, 0.4)) continue;
        push(out.coin, 'coin', { x: r2(x / C), y: r2(cy / C), segment: seg, tags: ['trail', `action:${s.i}`] });
      }
    }
  }

  // ---- risk (big coins): above risky arcs, off-route high ground, risky explored jumps --------------------
  {
    for (const s of steps) {
      if (s.kind !== 'jump' && s.kind !== 'runjump' && s.kind !== 'spring') continue;
      const ax = s.path.length ? s.path[s.path.reduce((m, p, k, a) => (p[1] < a[m][1] ? k : m), 0)][0] : (s.takeoff[0] + s.land[0]) / 2;
      const ay = s.apexY - 14 - 1.5 * C;
      if (ay < C || coinTaken(ax, ay) || !airClear(ax, ay, 0.5)) continue;
      push(out.risk, 'risk', { x: r2(ax / C), y: r2(ay / C), segment: ctx.segs[s.seg]?.id ?? null, tags: ['over_arc', `p:${r2(Math.max(s.pc, 0.1))}`, `action:${s.i}`] });
    }
    if (ctx.mode === 'full') {
      const routeY = new Map<number, number>();
      for (const s of steps) for (const p of s.path) {
        const c = Math.floor(p[0] / C);
        routeY.set(c, Math.min(routeY.get(c) ?? Infinity, p[1]));
      }
      const seenSurf = new Set<string>();
      for (const n of ex.nodes) {
        if (ctx.routeNodes.has(n.i) || ctx.reach[n.i] !== 1 || seenSurf.has(n.surf)) continue;
        const ry = routeY.get(Math.floor(n.x / C));
        if (ry === undefined || ry - n.y < 3 * C) continue;
        if (!Number.isFinite(ctx.d2g[n.i])) continue; // the detour must come back
        seenSurf.add(n.surf);
        const cy = n.y - 1.25 * C;
        if (coinTaken(n.x, cy) || !airClear(n.x, cy, 0.4)) continue;
        push(out.risk, 'risk', { x: r2(n.x / C), y: r2(cy / C), host: n.surf, segment: segOfX(n.x), tags: ['high_detour'] });
      }
      // risky explored edges that leave the route and come back
      const risky = ex.edges.filter((e) => e.d >= EDIT_BOUNDS.big_coin_min_detour_p_death && e.to >= 0 && ctx.routeNodes.has(e.from) && !ctx.routeNodes.has(e.to) && Number.isFinite(ctx.d2g[e.to]));
      risky.sort((a, b) => b.d - a.d || a.i - b.i);
      for (const e of risky.slice(0, 6)) {
        const x = (e.takeoffX + e.landX) / 2;
        const y = e.apexY - 14;
        if (!Number.isFinite(y) || coinTaken(x, y) || !airClear(x, y, 0.4)) continue;
        push(out.risk, 'risk', { x: r2(x / C), y: r2(y / C), segment: segOfX(x), tags: ['risky_detour', `p:${r2(e.d)}`] });
      }
    }
  }

  // ---- enemies: flat route stretches; flyers in clear air above the route ------------------------------
  {
    const seen = new Set<string>();
    for (const s of steps) {
      for (const e of s.edges) {
        const n = e.to >= 0 ? ex.nodes[e.to] : null;
        if (!n || n.surf[0] !== 'S') continue;
        const [a, b] = flatRun(Math.floor(n.x / C), n.y);
        const len = b - a + 1;
        const k = `${a},${b},${n.y}`;
        if (len < 4 || seen.has(k)) continue;
        seen.add(k);
        const cx = ((a + b + 1) / 2) * C;
        if (nearSpawn(cx, n.y, EDIT_BOUNDS.add_enemy.spawn_clear_c)) continue;
        const tags: string[] = [];
        if (len >= EDIT_BOUNDS.add_enemy.walker_flat_c) tags.push('walker', 'chaser');
        if (len >= EDIT_BOUNDS.add_enemy.hopper_flat_c) {
          let head = true;
          for (let c = a; c <= b && head; c++) for (let r = 1; r <= EDIT_BOUNDS.add_enemy.hopper_headroom_c; r++) if (T.at(c, Math.floor(n.y / C) - r) !== T_EMPTY) head = false;
          if (head) tags.push('hopper', 'shooter');
        }
        if (!tags.length) continue;
        push(out.enemy, 'enemy', { x: r2(cx / C), y: r2(n.y / C), host: hostAt(cx, n.y), face: 'top', x0: a, x1: b + 1, w: len, segment: ctx.segs[s.seg]?.id ?? null, tags });
      }
    }
    for (const s of steps) {
      if (s.kind !== 'walk') continue;
      const mx = (s.takeoff[0] + s.land[0]) / 2;
      const fy = s.takeoff[1] - 3.5 * C;
      if (nearSpawn(mx, s.takeoff[1], EDIT_BOUNDS.add_enemy.spawn_clear_c) || !airClear(mx, fy, EDIT_BOUNDS.add_enemy.flyer_air_c / 2)) continue;
      push(out.enemy, 'enemy', { x: r2(mx / C), y: r2((fy + 8) / C), segment: ctx.segs[s.seg]?.id ?? null, tags: ['flyer'] });
    }
    // crushers: under ceilings the route walks beneath
    for (const s of steps) {
      if (s.kind !== 'walk') continue;
      const mx = Math.floor((s.takeoff[0] + s.land[0]) / 2 / C);
      const fr = Math.floor(s.takeoff[1] / C);
      for (let r = fr - 3; r >= Math.max(0, fr - 8); r--) {
        if (T.blocksHead(mx, r)) {
          if (r < fr - 3 && airClear(mx * C + 8, (r + 2) * C, 0.9)) {
            push(out.enemy, 'enemy', { x: r2(mx + 0.5), y: r2(r + 3), segment: ctx.segs[s.seg]?.id ?? null, tags: ['crusher'] });
          }
          break;
        }
      }
    }
  }

  // ---- hazards: saws / firebars over route arcs; lava in pits the route jumps -------------------------
  for (const s of steps) {
    if (s.kind !== 'jump' && s.kind !== 'runjump') continue;
    const mx = (s.takeoff[0] + s.land[0]) / 2;
    const seg = ctx.segs[s.seg]?.id ?? null;
    const above = s.apexY - 28 - 2 * C;
    if (above > C && airClear(mx, above, 1.0)) push(out.hazard, 'hazard', { x: r2(mx / C), y: r2(above / C), segment: seg, tags: ['saw', 'firebar', `action:${s.i}`] });
    // the pit under the arc
    const c0 = Math.floor(Math.min(s.takeoff[0], s.land[0]) / C) + 1;
    const c1 = Math.floor(Math.max(s.takeoff[0], s.land[0]) / C) - 1;
    if (c1 >= c0) {
      let pit = true;
      for (let c = c0; c <= c1 && pit; c++) if (T.pieces[c]?.some((p) => Math.min(p.yl, p.yr) <= s.takeoff[1] + 2 * C)) pit = false;
      if (pit) push(out.hazard, 'hazard', { x: r2((c0 + c1 + 1) / 2), y: r2(T.h - 1), x0: c0, x1: c1 + 1, w: c1 - c0 + 1, segment: seg, tags: ['lava', `action:${s.i}`] });
    }
  }

  // ---- spikes: undrawn top faces on walked stretches, leaving landings ≥ 2 ---------------------------------
  {
    const seen = new Set<string>();
    for (const s of steps) {
      for (const e of s.edges) {
        const n = e.to >= 0 ? ex.nodes[e.to] : null;
        if (!n || n.surf[0] !== 'S') continue;
        const [a, b] = flatRun(Math.floor(n.x / C), n.y);
        const k = `${a},${b},${n.y}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const len = b - a + 1;
        const landing = EDIT_BOUNDS.add_spikes.landing_min_c;
        if (len < 2 * landing + 1) continue;
        const sl = Math.min(EDIT_BOUNDS.add_spikes.len_c[1], len - 2 * landing);
        const x0 = a + Math.floor((len - sl) / 2);
        const x1 = x0 + sl;
        const mid = ((x0 + x1) / 2) * C;
        if (nearSpawn(mid, n.y, EDIT_BOUNDS.add_spikes.spawn_clear_c)) continue;
        if (W.spikes.some((i) => {
          const b2 = (W.defs[i] as DSpikes).band;
          return b2[0] < x1 * C + C && b2[2] > x0 * C - C && Math.abs(b2[3] - n.y) <= C;
        })) continue;
        push(out.spikes, 'spikes', { x: r2(mid / C), y: r2(n.y / C), host: hostAt(mid, n.y), face: 'top', x0, x1, w: sl, segment: ctx.segs[s.seg]?.id ?? null, tags: ['top'] });
      }
    }
  }

  // ---- step / spring: where the frontier blocks ------------------------------------------------------
  if (front?.fixAt) {
    const f = front.fixAt;
    const host = hostAt(f.x, f.y);
    if (f.kind === 'wall_too_tall' || f.kind === 'ledge_too_high' || f.kind === 'gap_too_wide' || f.kind === 'head_bonk' || f.kind === 'goal_unreachable') {
      push(out.step, 'step', { x: r2(f.x / C), y: r2(f.y / C), host, face: 'top', w: 2, tags: [f.kind, `dir:${f.dir}`] });
      push(out.spring, 'spring', { x: r2((f.x - f.dir * C) / C), y: r2(f.y / C), host, face: 'top', tags: [f.kind, `dir:${f.dir}`] });
    }
  }
  // tight or tall jumps on a solvable route can also take a step (repair R4 for tight windows)
  for (const s of steps) {
    if (!s.required || (s.kind !== 'jump' && s.kind !== 'runjump')) continue;
    const wmin = Math.min(s.win.w, s.win.h, s.win.phi ?? 999);
    if (wmin >= 4) continue;
    const dir = s.land[0] >= s.takeoff[0] ? 1 : -1;
    push(out.step, 'step', { x: r2(s.takeoff[0] / C), y: r2(s.takeoff[1] / C), host: hostAt(s.takeoff[0], s.takeoff[1]), face: 'top', w: 2, segment: ctx.segs[s.seg]?.id ?? null, tags: ['tight', `dir:${dir}`, `action:${s.i}`] });
  }

  // ---- hints: blind jumps and leaps of faith -----------------------------------------------------------
  for (const s of steps) {
    if (!s.blind) continue;
    const dir = s.land[0] >= s.takeoff[0] ? 'right' : 'left';
    const d2 = s.kind === 'drop' || s.kind === 'dropthrough' ? 'down' : dir;
    push(out.hint, 'hint', { x: r2(s.takeoff[0] / C), y: r2((s.takeoff[1] - 2 * C) / C), segment: ctx.segs[s.seg]?.id ?? null, tags: [`dir:${d2}`, `action:${s.i}`] });
  }
  return out;
}

export { emptySlots };
