/**
 * Heuristic grammar H1-H22 (§3.3, `core/scene/grammar.ts`). Each rule scores a glyph 0-1; role = argmax,
 * `alt` = the next two roles. Kid labels and stamps always win with confidence 1.0. Unknown ink becomes
 * non-colliding decoration with an "Is this right?" chip, unless it is surface-like (D5).
 * Two passes: context-free rules first, then the rules that need surfaces (H9 strip, H10 lava, H14 cloud,
 * H17 ceiling, H19 wall, H20 door) and the flag convention (rightmost flag = goal, others checkpoints).
 */
import { GRAMMAR, PERCEPTION, WORLD } from '../params.ts';
import type { AskKind, LibRef, LibraryType, Role, RoleAlt } from '../types.gen.ts';
import { fitSurface, surfaceYAt } from '../build/fit.ts';
import type { SurfaceFit } from '../build/fit.ts';
import { overlap1, rectH, rectW } from '../util/geom.ts';
import { calibrate } from './calibration.ts';
import type { RuleId } from './calibration.ts';
import type { Piece } from './group.ts';
import { roleAllowed, stampRole } from './roles.ts';
import { matchSymbol } from './symbol.ts';

export interface Score {
  role: Role;
  conf: number;
  rule: RuleId;
  ask?: AskKind;
  lib?: LibRef; // H21 symbol match: the library type this glyph is
}

export interface Guess {
  role: Role;
  conf: number;
  rule: RuleId;
  alt: RoleAlt[];
  ask: AskKind | null;
  byKid: boolean; // label or stamp
  lib: LibRef | null; // H21 chamfer match against a library symbol
}

export interface SurfInfo {
  piece: Piece;
  role: 'ground' | 'platform' | 'ceiling';
  fit: SurfaceFit;
}

export interface GrammarResult {
  guesses: Map<string, Guess>;
  fits: Map<string, SurfaceFit>;
  surfaces: SurfInfo[];
}

const TERRAIN_INK = new Set(['black', 'pencil', 'draft']);

/** A zigzag (≥ 3 reversals of ≥ 0.5 cell) is never a surface, however well six snapped segments trace it. */
function zigzaggy(p: Piece): boolean {
  return p.geo.reversals >= 3 && p.geo.zigAmp >= 0.5;
}

function surfaceLike(p: Piece, fit: SurfaceFit | undefined): boolean {
  const s = GRAMMAR.H17_surface;
  return !!fit && TERRAIN_INK.has(p.color) && Math.abs(p.geo.angle) <= s.max_angle_deg && Math.max(p.geo.len, rectW(p.geo.core)) >= s.min_len_c && fit.residual <= s.max_residual_c && p.kind === 'plain' && !p.geo.isDot && !zigzaggy(p);
}

function topAt(si: SurfInfo, x: number): number | null {
  return surfaceYAt(si.fit.fitted, x);
}

function context(p: Piece, all: readonly Piece[], worldH: number) {
  const below = (dy: number) =>
    all.filter((q) => q !== p && !q.partOf && overlap1(q.geo.bbox[0], q.geo.bbox[2], p.geo.bbox[0], p.geo.bbox[2]) > 0 && q.geo.bbox[1] >= p.geo.bbox[3] - 0.2 && q.geo.bbox[1] <= p.geo.bbox[3] + dy);
  return { below, worldH };
}

/** Pass-1 rules (no surface context). */
function pass1(p: Piece, all: readonly Piece[], fit: SurfaceFit | undefined, worldW: number, worldH: number, library: readonly LibraryType[]): Score[] {
  const g = p.geo;
  const out: Score[] = [];
  const add = (role: Role, conf: number, rule: RuleId, ask?: AskKind): void => {
    out.push({ role, conf: calibrate(rule, conf), rule, ask });
  };
  const bw = rectW(g.bbox);
  const bh = rectH(g.bbox);
  const bboxArea = bw * bh;
  // H21 (any ink): a glyph that matches a library type's registered symbol (chamfer ≤ 0.12 cell, same ink)
  if (library.length && g.diam <= 6 && p.kind === 'plain' && !p.strokes.some((s) => s.label || s.stamp)) {
    const m = matchSymbol(p.strokes, [...library]);
    if (m) out.push({ role: 'library_tag', conf: calibrate('H21', GRAMMAR.H21_library.conf), rule: 'H21', lib: { type_id: m.type_id, version: m.version } });
  }
  if (p.kind === 'text') add('text', GRAMMAR.H15_text.conf, 'H15');
  if (p.kind === 'arrow' && p.color !== 'blue') add('arrow', GRAMMAR.H16_arrow.conf, 'H16');
  switch (p.color) {
    case 'blue': {
      if (g.isDot || (g.closed && g.diam <= GRAMMAR.H1_coin.loop_max_diam_c) || (g.diam <= GRAMMAR.H1_coin.loop_max_diam_c && g.fill >= 0.35)) add('coin', GRAMMAR.H1_coin.conf, 'H1');
      const loopDiam = g.outline ? Math.max(...[rectW(bboxOfPts(g.outline)), rectH(bboxOfPts(g.outline))]) : 0;
      if (g.closed && loopDiam <= GRAMMAR.H2_key.loop_max_diam_c && g.diam - loopDiam >= GRAMMAR.H2_key.stem_min_c && g.aspect >= GRAMMAR.H2_key.min_aspect) add('key', GRAMMAR.H2_key.conf, 'H2');
      if (g.diam >= 0.7 && (g.corners >= 8 || (g.closed && g.bumps >= GRAMMAR.H3_big_coin.star_points && g.circ < 0.65))) add('big_coin', GRAMMAR.H3_big_coin.conf, 'H3');
      if (!out.length) add(g.diam <= 2 ? 'coin' : 'decoration', 0.45, 'H22', 'is_this_right');
      break;
    }
    case 'green': {
      const area = bboxArea;
      if (p.flagPole) add('goal', GRAMMAR.H4_flag_pole.conf, 'H4');
      else if (area <= GRAMMAR.H5_small_flag.max_area_c2 && (g.corners >= GRAMMAR.H5_small_flag.min_corners || g.closed)) add('goal', GRAMMAR.H5_small_flag.conf, 'H5');
      if ((g.closed && area > GRAMMAR.H6_tree.min_area_c2) || p.parts.length > 0 && !p.flagPole) add('decoration', GRAMMAR.H6_tree.conf, 'H6');
      if (!out.length) add('decoration', 0.5, 'H22', 'is_this_right');
      break;
    }
    case 'red': {
      const encl = g.enclosed;
      if (g.closed && g.circ >= GRAMMAR.H7_enemy.min_circ && encl >= GRAMMAR.H7_enemy.area_c2[0] && encl <= GRAMMAR.H7_enemy.area_c2[1] && g.spokes < GRAMMAR.H11_saw.min_ticks) {
        const c = Math.min(GRAMMAR.H7_enemy.conf_max, 0.8 + (p.parts.length ? GRAMMAR.H7_enemy.parts_bonus : 0));
        add('enemy', Math.max(GRAMMAR.H7_enemy.conf_min, c), 'H7');
      }
      const z = GRAMMAR.H8_spikes_zigzag;
      if (g.zigN >= z.min_zig_per_c && g.teeth >= z.min_teeth && g.zigAmp >= z.zig_amp_c[0] && g.zigAmp <= z.zig_amp_c[1]) add('spikes', z.conf, 'H8');
      if (g.closed && g.spokes >= GRAMMAR.H11_saw.min_ticks) add('saw', GRAMMAR.H11_saw.conf, 'H11');
      if (!out.length && g.isDot) add('decoration', 0.45, 'H22', 'is_this_right');
      if (!out.length && !g.closed && g.straight < 0.9 && g.len >= 1) add('spikes', 0.45, 'H22', 'is_this_right');
      if (!out.length && g.closed) add('enemy', 0.5, 'H22', 'is_this_right');
      break;
    }
    default: {
      // black, pencil, draft
      if (p.kind !== 'plain') break;
      if (g.closed && g.spokes >= GRAMMAR.H13_sun.min_spokes) add('decoration', GRAMMAR.H13_sun.conf, 'H13');
      const zz = GRAMMAR.H12_black_zigzag;
      if (g.zigN >= zz.min_zig_per_c && g.teeth >= 3 && !surfaceLike(p, fit)) {
        add('decoration', zz.conf_decoration, 'H12', 'grass_or_spikes');
        add('spikes', zz.conf_spikes_alt, 'H12', 'grass_or_spikes');
      }
      if (g.closed && g.fill >= 0.4 && g.bbox[3] >= worldH - 0.75) add('ground', GRAMMAR.H18_ground_mass.conf, 'H18');
      // H21: a circle 1-2.5 across with one inner glyph (a circled letter)
      const lc = GRAMMAR.H21_library;
      if (g.closed && g.diam >= lc.circle_diam_c[0] && g.diam <= lc.circle_diam_c[1] && p.parts.length === 1 && g.circ >= 0.6) add('library_tag', library.length ? lc.conf : 0.5, 'H21', 'is_library');
      if (surfaceLike(p, fit)) {
        const s = GRAMMAR.H17_surface;
        const yMax = g.core[3];
        const yMin = g.core[1];
        const span = rectW(g.core);
        let role: Role = 'platform';
        if (yMax >= worldH * (1 - s.ground_bottom_frac) || (span >= WORLD.screen_w * s.ground_min_screen_span && yMax >= worldH * 0.5)) role = 'ground';
        else if (yMin <= worldH * s.ceiling_top_frac) role = 'ceiling'; // refined in pass 2
        add(role, s.conf, 'H17');
      }
      // a short flat dash (< 2 cells) is offered as a ledge re-label, below the unknown default (D5)
      if (!surfaceLike(p, fit) && Math.abs(g.angle) <= 30 && g.straight >= 0.8 && g.len >= 0.75 && g.len < GRAMMAR.H17_surface.min_len_c) add('platform', 0.28, 'H22');
      const w = GRAMMAR.H19_wall;
      if (Math.abs(g.angle) >= w.min_angle_deg && g.len >= w.min_len_c && g.straight >= 0.7 && !p.poleOf && !p.trunkOf) add('wall', w.conf_floating, 'H19');
      // a drawn box (outlined or filled) is a solid block
      if (g.closed && !p.parts.length && bh >= 1.5 && bw >= 1 && g.circ < 0.85 && g.spokes < 5 && g.bumps < 4 && g.bbox[3] < worldH - 0.75) add('wall', 0.7, 'H19');
      break;
    }
  }
  // H14: bumpy loop in the top 40% (any ink); context check in pass 2
  if (g.closed && g.bumps >= GRAMMAR.H14_cloud.min_bumps && g.cy <= worldH * GRAMMAR.H14_cloud.top_frac) add('decoration', GRAMMAR.H14_cloud.conf, 'H14');
  if (!out.length || out.every((x) => x.conf < GRAMMAR.H22_unknown.conf)) {
    // H22: nothing matched → non-colliding decoration with a chip, unless surface-like (D5)
    const u = PERCEPTION.unknown_surface_like;
    if (TERRAIN_INK.has(p.color) && fit && fit.residual <= u.max_residual_c && g.len >= u.min_len_c && Math.abs(g.angle) <= u.max_angle_deg && !zigzaggy(p)) add(g.core[3] >= worldH * 0.75 ? 'ground' : 'platform', 0.6, 'H17');
    else add('unknown', GRAMMAR.H22_unknown.conf, 'H22', 'is_this_right');
  }
  return out;
}

function bboxOfPts(pts: readonly [number, number][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

function best(scores: Score[]): { top: Score; alt: RoleAlt[] } {
  const byRole = new Map<Role, Score>();
  for (const s of scores) {
    const cur = byRole.get(s.role);
    if (!cur || s.conf > cur.conf) byRole.set(s.role, s);
  }
  const ranked = [...byRole.values()].sort((a, b) => b.conf - a.conf || a.rule.localeCompare(b.rule));
  return { top: ranked[0], alt: ranked.slice(1, 3).map((s) => ({ role: s.role, conf: Math.round(s.conf * 100) / 100 })) };
}

/** Run the grammar on the top-level pieces. */
export function runGrammar(pieces: Piece[], world: { w: number; h?: number }, library: readonly LibraryType[]): GrammarResult {
  const worldH = world.h ?? WORLD.h;
  const fits = new Map<string, SurfaceFit>();
  const top = pieces.filter((p) => !p.partOf);
  for (const p of top) {
    if (!TERRAIN_INK.has(p.color) || p.kind !== 'plain' || p.geo.isDot) continue;
    if (Math.abs(p.geo.angle) > 60 || Math.max(p.geo.len, rectW(p.geo.core)) < 1.5) continue;
    fits.set(p.id, fitSurface(p.strokes, 'floor', world.w));
  }
  const scores = new Map<string, Score[]>();
  for (const p of top) scores.set(p.id, pass1(p, pieces, fits.get(p.id), world.w, worldH, library));
  const pick = (p: Piece): Role => best(scores.get(p.id)!).top.role;
  // surfaces after pass 1
  const surfaces: SurfInfo[] = [];
  for (const p of top) {
    const r = pick(p);
    if (r !== 'ground' && r !== 'platform' && r !== 'ceiling') continue;
    let fit = fits.get(p.id);
    if (r === 'ceiling') fit = fitSurface(p.strokes, 'ceiling', world.w);
    if (!fit) fit = fitSurface(p.strokes, 'floor', world.w);
    fits.set(p.id, fit);
    surfaces.push({ piece: p, role: r, fit });
  }
  const floors = surfaces.filter((s) => s.role !== 'ceiling');
  const walls = top.filter((p) => pick(p) === 'wall');
  const ctxBelow = (p: Piece, dy: number) => context(p, top, worldH).below(dy);
  // ---- pass 2 ----
  for (const p of top) {
    const sc = scores.get(p.id)!;
    const g = p.geo;
    const add = (role: Role, conf: number, rule: RuleId, ask?: AskKind): void => {
      sc.push({ role, conf: calibrate(rule, conf), rule, ask });
    };
    // H17 ceiling: needs something hanging under it, or capping two walls; otherwise it is a platform
    const cur = best(sc).top;
    if (cur.role === 'ceiling') {
      const hanging = ctxBelow(p, 1.2).some((q) => q.color === 'red' || q.color === 'black');
      const capped = walls.filter((w) => Math.abs(w.geo.core[1] - g.core[3]) <= 0.8 && w.geo.cx >= g.core[0] - 0.8 && w.geo.cx <= g.core[2] + 0.8).length >= 2;
      if (!hanging && !capped) {
        const i = sc.findIndex((s) => s.role === 'ceiling');
        sc[i] = { ...sc[i], role: 'platform' };
        const si = surfaces.find((s) => s.piece === p);
        if (si) {
          si.role = 'platform';
          si.fit = fitSurface(p.strokes, 'floor', world.w);
          fits.set(p.id, si.fit);
        }
      }
    }
    if (p.color === 'red') {
      // H9: straight red line parallel to and within 1.5 of a surface face
      if (g.straight >= GRAMMAR.H9_spikes_flat.min_straight && !g.closed) {
        const horiz = Math.abs(g.angle) <= 30;
        const near = horiz
          ? surfaces.some((s) => {
            const [a, b] = s.fit.span;
            if (overlap1(a, b, g.core[0], g.core[2]) < 0.4 * Math.max(0.5, rectW(g.core))) return false;
            const y = topAt(s, g.cx);
            if (y === null) return false;
            return s.role === 'ceiling' ? Math.abs(g.core[1] - y) <= GRAMMAR.H9_spikes_flat.max_face_dist_c : y - g.core[3] >= -0.6 && y - g.core[3] <= GRAMMAR.H9_spikes_flat.max_face_dist_c;
          })
          : walls.some((w) => Math.abs(w.geo.cx - g.cx) <= GRAMMAR.H9_spikes_flat.max_face_dist_c + w.geo.w && overlap1(w.geo.core[1], w.geo.core[3], g.core[1], g.core[3]) > 0.4 * rectH(g.core));
        if (near) add('spikes', GRAMMAR.H9_spikes_flat.conf, 'H9');
      }
      // H10: a red line or blob inside a pit (between two surface ends, below their tops)
      const inPit = floors.some((l) => floors.some((r) => {
        if (l === r) return false;
        const le = l.fit.span[1];
        const rs = r.fit.span[0];
        if (rs - le < 1 || g.cx < le - 0.3 || g.cx > rs + 0.3) return false;
        const ly = topAt(l, le - 0.5);
        const ry = topAt(r, rs + 0.5);
        if (ly === null || ry === null) return false;
        return g.core[1] >= Math.min(ly, ry) - 0.3;
      }));
      const lavaShape = (g.straight >= 0.85 && Math.abs(g.angle) <= 25) || (g.closed && g.fill >= 0.3) || g.zigN < 1.5;
      if (inPit && lavaShape) add('lava', GRAMMAR.H10_lava.conf, 'H10');
    }
    // H14 cloud: no surface within 2 cells below
    const cloud = sc.findIndex((s) => s.rule === 'H14');
    if (cloud >= 0 && floors.some((s) => {
      const y = topAt(s, g.cx);
      return y !== null && y >= g.bbox[3] && y - g.bbox[3] <= GRAMMAR.H14_cloud.clear_below_c;
    })) sc.splice(cloud, 1);
    // H19 wall: bottom within 0.6 of a surface or the world bottom → grounded (0.85)
    if (best(sc).top.role === 'wall') {
      const bottom = g.core[3] + g.w / 2;
      const grounded = bottom >= worldH - GRAMMAR.H19_wall.max_base_gap_c || floors.some((s) => {
        const y = topAt(s, g.cx);
        return y !== null && Math.abs(y - bottom) <= GRAMMAR.H19_wall.max_base_gap_c;
      }) || surfaces.some((s) => s.role === 'ceiling' && Math.abs((topAt(s, g.cx) ?? -99) - (g.core[1] - g.w / 2)) <= 0.6);
      if (grounded) add('wall', GRAMMAR.H19_wall.conf, 'H19');
    }
  }
  // H20: a floor-to-ceiling bar while the level has exactly one key → door (ask)
  const keys = top.filter((p) => best(scores.get(p.id)!).top.role === 'key');
  if (keys.length === 1) {
    for (const p of top) {
      if (best(scores.get(p.id)!).top.role !== 'wall') continue;
      const g = p.geo;
      const topY = g.core[1] - g.w / 2;
      const capped = topY <= 0.75 || surfaces.some((s) => s.role !== 'ground' && Math.abs((topAt(s, g.cx) ?? -99) + (s.role === 'ceiling' ? 0 : 1) - topY) <= 0.8);
      if (capped) scores.get(p.id)!.push({ role: 'door', conf: calibrate('H20', GRAMMAR.H20_door.conf), rule: 'H20', ask: 'is_door' });
    }
  }
  // flags: the rightmost flag is the goal; the others are checkpoints (perceive.md flag convention)
  const flags = top.filter((p) => best(scores.get(p.id)!).top.role === 'goal');
  if (flags.length > 1) {
    const right = flags.reduce((a, b) => (b.geo.cx > a.geo.cx ? b : a));
    for (const f of flags) {
      if (f === right) continue;
      const sc = scores.get(f.id)!;
      const s = best(sc).top;
      sc.push({ role: 'checkpoint', conf: s.conf, rule: s.rule });
      const i = sc.indexOf(s);
      sc[i] = { ...s, conf: Math.max(0, s.conf - 0.2) };
    }
  }
  // H6: a lone green tree is less certain (it might be the goal)
  const greens = top.filter((p) => p.color === 'green');
  if (greens.length === 1) {
    const sc = scores.get(greens[0].id)!;
    for (let i = 0; i < sc.length; i++) if (sc[i].rule === 'H6') sc[i] = { ...sc[i], conf: calibrate('H6', GRAMMAR.H6_tree.conf_only_green) };
    if (!sc.some((s) => s.role === 'goal')) sc.push({ role: 'goal', conf: 0.5, rule: 'H5' });
  }
  const guesses = new Map<string, Guess>();
  for (const p of top) {
    const kidRole = p.strokes.find((s) => s.label)?.label ?? null;
    const stamp = p.strokes.find((s) => s.stamp)?.stamp ?? null;
    const { top: t, alt } = best(scores.get(p.id)!.filter((s) => roleAllowed(p.color, s.role)).length ? scores.get(p.id)!.filter((s) => roleAllowed(p.color, s.role)) : scores.get(p.id)!);
    if (kidRole) guesses.set(p.id, { role: kidRole, conf: 1, rule: 'LABEL', alt: [], ask: null, byKid: true, lib: null });
    else if (stamp) guesses.set(p.id, { role: stampRole(stamp), conf: 1, rule: 'STAMP', alt: [], ask: null, byKid: true, lib: null });
    else {
      const ask = t.ask ?? (t.conf < PERCEPTION.ask_conf && t.role !== 'decoration' && t.role !== 'text' ? 'is_this_right' : null);
      const lib = t.role === 'library_tag' && t.lib ? t.lib : null;
      guesses.set(p.id, { role: t.role, conf: Math.round(t.conf * 100) / 100, rule: t.rule, alt, ask: lib ? null : ask ?? null, byKid: false, lib });
    }
  }
  return { guesses, fits, surfaces };
}
