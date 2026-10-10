/**
 * Grouping (§3.3, `core/scene/group.ts`), which runs before roles.
 *
 * Pieces: a coloured component is one piece. A black (or pencil/draft) component that contains terrain-sized
 * strokes is split per stroke, so a pole on a floor or a wall on a ledge stays its own object [B F1]. Glyph-sized
 * strokes that touch terrain stay fused with it and carry a detach hint, which normalize turns into a visible U3
 * `detach` edit ("I split your word from the ground") [B F3].
 *
 * Then, in order: 7 collinear fragments, 4 text clusters, 5 arrows (merges); 1 containment, 2 flag and pole,
 * 3 trunk (part relations). Ids: 'o' + min component id, then 'o<cid>_<k>' for further pieces of one component.
 */
import { GROUPING } from '../params.ts';
import type { Dir4, InkColor, InkDoc, InkStroke, Origin } from '../types.gen.ts';
import { computeGeo } from '../ink/features.ts';
import type { Geo } from '../ink/features.ts';
import { strokeBBox, strokeCentrelines, strokeLength, strokeMedianW, strokePts } from '../ink/stroke.ts';
import {
  dist, distPolyPoly, pointInPoly, rdp, rectCenter, rectGap, rectGrow, rectInside, segAngle, turnAngle,
} from '../util/geom.ts';
import type { P, Rect } from '../util/geom.ts';

export interface DetachHint {
  branch: string; // stroke id
  into: string | null; // piece id of the text cluster it joins, or null for a new sign
}

export interface Piece {
  id: string;
  cids: number[];
  strokes: InkStroke[];
  geo: Geo;
  color: InkColor;
  origin: Origin;
  order: number;
  kind: 'plain' | 'text' | 'arrow';
  partOf: string | null;
  parts: string[];
  arrow?: { dir: Dir4; tail: P; head: P };
  flagPole?: boolean; // a green piece with its pole (H4)
  gamma?: boolean; // an all-green Γ flag with its own pole
  poleOf?: string; // this piece is the pole of that flag
  trunkOf?: string;
  detach: DetachHint[];
  fusedGlyphs: string[]; // glyph strokes kept fused in this terrain piece
}

const TERRAIN_INK: ReadonlySet<InkColor> = new Set<InkColor>(['black', 'pencil', 'draft']);

function maxSide(r: Rect): number {
  return Math.max(r[2] - r[0], r[3] - r[1]);
}

function isGlyphStroke(s: InkStroke): boolean {
  return maxSide(strokeBBox(s)) <= GROUPING.text_max_side_c && s.kind !== 'blob';
}

function majorityOrigin(strokes: readonly InkStroke[]): Origin {
  const n = new Map<Origin, number>();
  for (const s of strokes) n.set(s.origin, (n.get(s.origin) ?? 0) + strokeLength(s) + 0.01);
  let best: Origin = 'kid';
  let bv = -1;
  for (const [o, v] of n) if (v > bv) {
    best = o;
    bv = v;
  }
  return best;
}

/** The kid's (or a prompt draft's) chip on a piece: labelled pieces are exact and skip the guessing rules. */
export function labelOf(p: Piece): string | null {
  for (const s of p.strokes) if (s.label) return s.label;
  return null;
}

function touches(a: InkStroke, b: InkStroke): boolean {
  const tol = 0.5 * Math.max(strokeMedianW(a), strokeMedianW(b));
  if (rectGap(strokeBBox(a), strokeBBox(b)) > tol) return false;
  return distPolyPoly(strokeCentrelines(a), strokeCentrelines(b)) - (strokeMedianW(a) + strokeMedianW(b)) / 2 <= tol;
}

function mkPiece(id: string, cids: number[], strokes: InkStroke[], order: number): Piece {
  return {
    id, cids, strokes, geo: computeGeo(strokes), color: strokes[0].color, origin: majorityOrigin(strokes), order,
    kind: 'plain', partOf: null, parts: [], detach: [], fusedGlyphs: [],
  };
}

/** A piece for arbitrary strokes (used to re-shape an object after a re-label). */
export function pieceFromStrokes(id: string, cids: number[], strokes: InkStroke[]): Piece {
  return mkPiece(id, cids, strokes, 0);
}

/** Split components into pieces (see the module comment). */
export function splitPieces(ink: InkDoc): Piece[] {
  const byId = new Map(ink.strokes.map((s) => [s.id, s] as const));
  const pieces: Piece[] = [];
  let order = 0;
  for (const c of ink.components) {
    const strokes = c.stroke_ids.map((id) => byId.get(id)).filter((s): s is InkStroke => !!s);
    if (!strokes.length) continue;
    const terrain = strokes.filter((s) => !isGlyphStroke(s));
    if (!TERRAIN_INK.has(c.color) || strokes.length === 1 || !terrain.length || strokes.some((s) => s.stamp)) {
      pieces.push(mkPiece(`o${c.id}`, [c.id], strokes, order++));
      continue;
    }
    // terrain strokes: one piece each, longest first gets the primary id
    const sorted = [...terrain].sort((a, b) => strokeLength(b) - strokeLength(a));
    const groups = new Map<InkStroke, InkStroke[]>();
    for (const t of sorted) groups.set(t, [t]);
    const loose: InkStroke[] = [];
    for (const g of strokes.filter((s) => isGlyphStroke(s))) {
      const host = sorted.find((t) => touches(t, g));
      if (host) groups.get(host)!.push(g);
      else loose.push(g);
    }
    const ids: string[] = [];
    sorted.forEach((t, k) => {
      const id = k === 0 ? `o${c.id}` : `o${c.id}_${k + 1}`;
      ids.push(id);
      const ss = groups.get(t)!;
      const p = mkPiece(id, [c.id], ss.sort((a, b) => strokes.indexOf(a) - strokes.indexOf(b)), order++);
      p.fusedGlyphs = ss.filter((s) => s !== t).map((s) => s.id);
      pieces.push(p);
    });
    // loose glyphs (touching other glyphs only) become their own pieces
    let k = sorted.length;
    for (const g of loose) pieces.push(mkPiece(`o${c.id}_${++k}`, [c.id], [g], order++));
  }
  return pieces;
}

// ---- merges ------------------------------------------------------------------------------------

function mergeInto(a: Piece, b: Piece): void {
  a.cids = [...new Set([...a.cids, ...b.cids])].sort((x, y) => x - y);
  a.strokes = [...a.strokes, ...b.strokes];
  a.geo = computeGeo(a.strokes);
  a.fusedGlyphs.push(...b.fusedGlyphs);
  a.detach.push(...b.detach);
}

function idRank(p: Piece): [number, number] {
  return [Math.min(...p.cids), p.order];
}

function lowerId(a: Piece, b: Piece): [Piece, Piece] {
  const ra = idRank(a);
  const rb = idRank(b);
  return ra[0] < rb[0] || (ra[0] === rb[0] && ra[1] <= rb[1]) ? [a, b] : [b, a];
}

/** Rule 7: flat same-ink fragments with Δy ≤ 0.3 and gap ≤ 0.6 form one surface [M fail 5]. */
function mergeCollinear(pieces: Piece[]): Piece[] {
  const flat = (p: Piece): boolean => TERRAIN_INK.has(p.color) && !p.geo.isDot && Math.abs(p.geo.angle) <= 12 && p.geo.straight >= 0.85 && p.geo.len >= 0.5 && p.geo.aspect >= 2.5;
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      const a = pieces[i];
      if (!flat(a)) continue;
      for (let j = i + 1; j < pieces.length; j++) {
        const b = pieces[j];
        if (!flat(b) || a.color !== b.color || labelOf(a) !== labelOf(b)) continue;
        // height difference where they meet (the left piece's right end vs the right piece's left end)
        const [L, R2] = a.geo.core[0] <= b.geo.core[0] ? [a, b] : [b, a];
        const endY = (p: Piece, right: boolean): number => {
          let best: P | null = null;
          for (const st of p.strokes) for (const q of st.pts) if (!best || (right ? q[0] > best[0] : q[0] < best[0])) best = [q[0], q[1]];
          return best ? best[1] : p.geo.cy;
        };
        const dy = Math.min(Math.abs(a.geo.cy - b.geo.cy), Math.abs(endY(L, true) - endY(R2, false)));
        const gap = Math.max(0, Math.max(a.geo.core[0], b.geo.core[0]) - Math.min(a.geo.core[2], b.geo.core[2]));
        // fragments that touch or overlap join too (a ground drawn in several pen strokes is one surface)
        if (dy <= GROUPING.collinear_max_dy_c && gap <= GROUPING.collinear_max_gap_c) {
          const [keep, drop] = lowerId(a, b);
          mergeInto(keep, drop);
          pieces.splice(pieces.indexOf(drop), 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return pieces;
}

function isGlyphPiece(p: Piece): boolean {
  return p.geo.diam <= GROUPING.text_max_side_c && !p.strokes.some((s) => s.stamp || s.label);
}

function spikeLike(p: Piece): boolean {
  return p.geo.teeth >= 3 && p.geo.zigN >= 1.5;
}

/** Rule 4: text clusters. Same ink, max side ≤ 1.6, bottoms aligned within 0.6, gaps ≤ 1.0. */
function clusterText(pieces: Piece[]): Piece[] {
  // a flat dash is a tiny ledge, not a letter (stepping stones must never become a sign)
  const dash = (p: Piece): boolean => p.geo.straight >= 0.9 && Math.abs(p.geo.angle) <= 20 && p.geo.bbox[3] - p.geo.bbox[1] <= 0.7;
  const cand = pieces.filter((p) => isGlyphPiece(p) && !p.geo.isDot && !dash(p) && p.color !== 'blue' && !(p.color !== 'black' && spikeLike(p)));
  const used = new Set<Piece>();
  const clusters: Piece[][] = [];
  const sorted = [...cand].sort((a, b) => a.geo.bbox[0] - b.geo.bbox[0]);
  for (const p of sorted) {
    if (used.has(p)) continue;
    const cl = [p];
    used.add(p);
    let grew = true;
    while (grew) {
      grew = false;
      for (const q of sorted) {
        if (used.has(q) || q.color !== p.color) continue;
        const near = cl.some((r) => {
          const gapX = Math.max(0, Math.max(r.geo.bbox[0], q.geo.bbox[0]) - Math.min(r.geo.bbox[2], q.geo.bbox[2]));
          return gapX <= GROUPING.text_max_gap_c && Math.abs(r.geo.bbox[3] - q.geo.bbox[3]) <= GROUPING.text_bottom_align_c;
        });
        if (near) {
          cl.push(q);
          used.add(q);
          grew = true;
        }
      }
    }
    clusters.push(cl);
  }
  for (const cl of clusters) {
    const single = cl.length === 1 ? cl[0] : null;
    if (single) {
      const ok = single.color === 'black' && single.geo.corners >= GROUPING.text_single_min_corners && !single.geo.closed && !spikeLike(single);
      if (!ok) continue;
    }
    // i-dots and exclamation dots inside the cluster's box join it
    let box: Rect = cl[0].geo.bbox;
    for (const q of cl) box = [Math.min(box[0], q.geo.bbox[0]), Math.min(box[1], q.geo.bbox[1]), Math.max(box[2], q.geo.bbox[2]), Math.max(box[3], q.geo.bbox[3])];
    const grown = rectGrow(box, 0.6);
    for (const d of pieces) {
      if (!d.geo.isDot || d.color !== cl[0].color || cl.includes(d) || d.color === 'blue') continue;
      if (rectInside(d.geo.bbox, grown)) cl.push(d);
    }
    const root = cl.reduce((a, b) => lowerId(a, b)[0]);
    for (const q of cl) {
      if (q === root) continue;
      mergeInto(root, q);
      pieces.splice(pieces.indexOf(q), 1);
    }
    root.kind = 'text';
  }
  return pieces;
}

/** Glyph strokes fused into terrain that line up with a text cluster (or with each other) get detach hints. */
function detachHints(pieces: Piece[], strokesById: Map<string, InkStroke>): void {
  const texts = pieces.filter((p) => p.kind === 'text');
  for (const p of pieces) {
    if (!p.fusedGlyphs.length || labelOf(p)) continue; // a labelled piece is exact: its fused glyphs (eyes) stay
    const left: string[] = [];
    const fused = p.fusedGlyphs.map((id) => strokesById.get(id)).filter((s): s is InkStroke => !!s);
    for (const g of fused) {
      const gb = strokeBBox(g);
      const into = texts.find((t) => {
        const gapX = Math.max(0, Math.max(t.geo.bbox[0], gb[0]) - Math.min(t.geo.bbox[2], gb[2]));
        return gapX <= GROUPING.text_max_gap_c && Math.abs(t.geo.bbox[3] - gb[3]) <= 1.2 && t.color === g.color;
      });
      const peers = fused.filter((o) => o !== g && rectGap(strokeBBox(o), gb) <= GROUPING.text_max_gap_c).length;
      const area = (gb[2] - gb[0]) * (gb[3] - gb[1]);
      if (area > GROUPING.detach_max_branch_area_c2) left.push(g.id);
      else if (into) p.detach.push({ branch: g.id, into: into.id });
      else if (peers >= 1) p.detach.push({ branch: g.id, into: null });
      else left.push(g.id);
    }
    p.fusedGlyphs = left;
  }
}

/** Rule 5: arrows. A straight shaft (len ≥ 1.5, straight ≥ 0.9) with 1-2 short heads at one end at 20-70°. */
function findArrows(pieces: Piece[]): Piece[] {
  const [hmin, hmax] = GROUPING.arrow_head_angle_deg;
  // single-stroke arrows
  for (const p of pieces) {
    if (p.kind !== 'plain' || p.strokes.length !== 1 || p.strokes[0].kind !== 'line' || p.color === 'blue' || labelOf(p)) continue;
    const simp = rdp(strokePts(p.strokes[0]), 0.12);
    if (simp.length < 3) continue;
    let si = -1;
    let sl = 0;
    for (let k = 1; k < simp.length; k++) {
      const L = dist(simp[k - 1], simp[k]);
      if (L > sl) {
        sl = L;
        si = k;
      }
    }
    if (sl < GROUPING.arrow_shaft_min_len_c) continue;
    const before = si - 1; // shaft = simp[si-1] → simp[si]
    const headAt = (end: 'a' | 'b'): boolean => {
      const segs = end === 'b' ? simp.slice(si) : simp.slice(0, before + 1).reverse();
      if (segs.length < 2 || segs.length > 3) return false;
      const shaftEnd = end === 'b' ? simp[si] : simp[before];
      const shaftStart = end === 'b' ? simp[before] : simp[si];
      for (let k = 1; k < segs.length; k++) {
        const L = dist(segs[k - 1], segs[k]);
        if (L > GROUPING.arrow_head_max_len_c || L < 0.2) return false;
      }
      const t = turnAngle(shaftStart, shaftEnd, segs[1]);
      return t >= 180 - hmax && t <= 180 - hmin;
    };
    const atB = headAt('b');
    const atA = !atB && headAt('a');
    if (!atA && !atB) continue;
    const head = atB ? simp[si] : simp[before];
    const tail = atB ? simp[before] : simp[si];
    p.kind = 'arrow';
    p.arrow = { dir: dirOf(tail, head), tail, head };
  }
  // shaft + separate head strokes
  for (const s of pieces) {
    if (s.kind !== 'plain' || s.strokes.length !== 1 || s.color === 'blue' || labelOf(s)) continue;
    const g = s.geo;
    if (g.len < GROUPING.arrow_shaft_min_len_c || g.straight < GROUPING.arrow_shaft_min_straight) continue;
    const pts = strokePts(s.strokes[0]);
    const ends: P[] = [pts[0], pts[pts.length - 1]];
    for (let e = 0; e < 2; e++) {
      const end = ends[e];
      const other = ends[1 - e];
      const heads = pieces.filter((h) => {
        if (h === s || h.color !== s.color || h.kind !== 'plain' || labelOf(h) || h.geo.len > GROUPING.arrow_head_max_len_c || h.geo.len < 0.2) return false;
        const hp = strokePts(h.strokes[0]);
        const near = Math.min(dist(hp[0], end), dist(hp[hp.length - 1], end));
        if (near > 0.45) return false;
        const far = dist(hp[0], end) <= dist(hp[hp.length - 1], end) ? hp[hp.length - 1] : hp[0];
        const t = turnAngle(other, end, far);
        return t >= 180 - hmax && t <= 180 - hmin;
      });
      if (heads.length >= 1 && heads.length <= 2) {
        for (const h of heads) {
          mergeInto(s, h);
          pieces.splice(pieces.indexOf(h), 1);
        }
        s.kind = 'arrow';
        s.arrow = { dir: dirOf(other, end), tail: other, head: end };
        break;
      }
    }
  }
  return pieces;
}

export function dirOf(from: P, to: P): Dir4 {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'down' : 'up';
}

// ---- part relations ----------------------------------------------------------------------------

function isPoleLike(p: Piece): boolean {
  const g = p.geo;
  // thin and at most a screen-third tall: a tower with a flag on top stays a tower
  return Math.abs(g.angle) >= GROUPING.pole_min_angle_deg && g.straight >= GROUPING.pole_min_straight && g.len >= GROUPING.pole_min_len_c && !g.closed && g.w <= 0.9 && g.core[3] - g.core[1] <= 10;
}

/** Rule 1: containment. A piece whose centre is inside a closed loop and fits its bbox (+0.2) is a part [B F8]. */
function containment(pieces: Piece[]): void {
  // creature-sized loops only: a coin inside a drawn room is not part of the room
  const loops = pieces.filter((p) => p.geo.closed && p.geo.outline && p.kind === 'plain' && p.geo.diam <= 5);
  for (const p of pieces) {
    if (p.partOf || p.kind !== 'plain' || labelOf(p)) continue;
    if (p.color === 'blue' && !loops.some((l) => l.color === 'blue')) continue;
    const c = rectCenter(p.geo.bbox);
    const host = loops
      .filter((l) => l !== p && l.geo.outline && pointInPoly(c, l.geo.outline) && rectInside(p.geo.bbox, rectGrow(l.geo.bbox, GROUPING.containment_grow_c)) && l.geo.enclosed > p.geo.area)
      .sort((a, b) => a.geo.enclosed - b.geo.enclosed)[0];
    if (!host || host.partOf === p.id) continue;
    p.partOf = host.id;
    host.parts.push(p.id);
  }
}

/** Rule 2: flag and pole. A green glyph within 0.4 cell of the top 40% of a near-vertical stroke [B F1]. */
function flagPole(pieces: Piece[]): void {
  // labelled flags (a kid chip or a prompt draft): any ink, paired with a piece labelled 'pole' at the top 40%
  for (const f of pieces) {
    const fl = labelOf(f);
    if (f.partOf || (fl !== 'goal' && fl !== 'checkpoint')) continue;
    let best: Piece | null = null;
    let bd = Infinity;
    for (const v of pieces) {
      if (v === f || v.partOf || labelOf(v) !== 'pole') continue;
      const vb = v.geo.core;
      const topCut = vb[1] + (vb[3] - vb[1]) * GROUPING.flag_pole_top_frac;
      const top = strokePts(v.geo.longest).filter((p) => p[1] <= topCut + 1e-9);
      if (!top.length) continue;
      const d = distPolyPoly(f.strokes.flatMap((s) => strokeCentrelines(s)), top) - (f.geo.w + v.geo.w) / 2;
      if (d <= GROUPING.flag_pole_dist_c && d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best) {
      best.partOf = f.id;
      best.poleOf = f.id;
      f.parts.push(best.id);
      f.flagPole = true;
    }
  }
  for (const f of pieces) {
    if (f.color !== 'green' || f.partOf || f.flagPole) continue;
    const fl = labelOf(f);
    if (fl && fl !== 'goal' && fl !== 'checkpoint') continue;
    // all-green Γ: a green piece that contains its own straight vertical stroke
    const own = f.strokes.find((s) => {
      if (s.kind !== 'line') return false;
      const pts = strokePts(s);
      const simp = rdp(pts, 0.12);
      return simp.some((q, k) => k > 0 && dist(simp[k - 1], q) >= GROUPING.pole_min_len_c && Math.abs(segAngle(simp[k - 1], q)) >= GROUPING.pole_min_angle_deg);
    });
    if (own && f.geo.bbox[3] - f.geo.bbox[1] >= GROUPING.pole_min_len_c && f.strokes.length >= 1 && f.geo.diam >= 1.5) {
      f.gamma = true;
      f.flagPole = true;
      continue;
    }
    let best: Piece | null = null;
    let bd = Infinity;
    const fArea = (f.geo.bbox[2] - f.geo.bbox[0]) * (f.geo.bbox[3] - f.geo.bbox[1]);
    for (const v of pieces) {
      if (v === f || v.partOf || v.color === 'green' || !isPoleLike(v) || (labelOf(v) && labelOf(v) !== 'pole')) continue;
      // a big green loop centred over the stroke's top is a tree crown on its trunk, not a flag [B F2]
      const fw = f.geo.bbox[2] - f.geo.bbox[0];
      if (fArea > 6 && f.geo.closed && Math.abs(f.geo.cx - v.geo.cx) < 0.35 * fw) continue;
      const vb = v.geo.core;
      const topCut = vb[1] + (vb[3] - vb[1]) * GROUPING.flag_pole_top_frac;
      const top = strokePts(v.geo.longest).filter((p) => p[1] <= topCut + 1e-9);
      if (!top.length) continue;
      const d = distPolyPoly(f.strokes.flatMap((s) => strokeCentrelines(s)), top) - (f.geo.w + v.geo.w) / 2;
      if (d <= GROUPING.flag_pole_dist_c && d < bd) {
        bd = d;
        best = v;
      }
    }
    if (best) {
      best.partOf = f.id;
      best.poleOf = f.id;
      f.parts.push(best.id);
      f.flagPole = true;
    }
  }
}

/** Rule 3: trunk. Near-vertical black strokes whose tops touch the underside of a closed loop join it [B F2]. */
function trunks(pieces: Piece[]): void {
  for (const t of pieces) {
    if (t.partOf || !TERRAIN_INK.has(t.color) || !isPoleLike(t) || (labelOf(t) && labelOf(t) !== 'decoration')) continue;
    const top: P = [t.geo.cx, t.geo.core[1]];
    const crown = pieces.find((l) => {
      if (l === t || !l.geo.closed || !l.geo.outline || l.partOf) return false;
      const b = l.geo.bbox;
      if (top[0] < b[0] - 0.3 || top[0] > b[2] + 0.3) return false;
      return Math.abs(top[1] - b[3]) <= 0.8 || pointInPoly(top, l.geo.outline);
    });
    if (!crown) continue;
    t.partOf = crown.id;
    t.trunkOf = crown.id;
    crown.parts.push(t.id);
  }
}

/** Every grouping rule, in order. */
export function groupPieces(ink: InkDoc): Piece[] {
  const strokesById = new Map(ink.strokes.map((s) => [s.id, s] as const));
  let pieces = splitPieces(ink);
  pieces = mergeCollinear(pieces);
  pieces = clusterText(pieces);
  detachHints(pieces, strokesById);
  pieces = findArrows(pieces);
  containment(pieces);
  flagPole(pieces);
  trunks(pieces);
  // a stable order: by first component, then piece order
  return pieces.sort((a, b) => {
    const ra = idRank(a);
    const rb = idRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1];
  });
}
