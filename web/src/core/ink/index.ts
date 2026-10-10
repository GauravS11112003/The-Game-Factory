/**
 * InkDoc helpers (lane B, §3.2). The InkDoc is the only thing that crosses from seeing to building.
 * Canvas strokes arrive already resampled (0.125 cell) and RDP-simplified by the editor; this module
 * normalizes them (1/64 quantization, one width per point, taps as 0.875-cell dots) and computes components:
 * unions of same-colour strokes that touch (gap ≤ 0.5·w). A stamped stroke is always its own component; two dots
 * never unite (each tap is its own coin), nor do two strokes carrying different `label`s.
 */
import { CANVAS, WORLD } from '../params.ts';
import type { InkComponent, InkDoc, InkStroke, TypedRule, World } from '../types.gen.ts';
import { clamp, distPolyPoly, q16, q64, rectGap } from '../util/geom.ts';
import type { P } from '../util/geom.ts';
import { computeGeo, featuresOf } from './features.ts';
import { strokeBBox, strokeCentrelines, strokeInkArea, strokeLength, strokeMedianW, strokeWidths } from './stroke.ts';

export { computeGeo, featuresOf } from './features.ts';
export type { Geo } from './features.ts';
export * from './stroke.ts';

/** Normalize one stroke: 1/64 points, a width per point, taps → dots, degenerate lines → dots. */
export function normalizeStroke(s: InkStroke, world: { w: number; h?: number }): InkStroke {
  const h = world.h ?? WORLD.h;
  const pts = s.pts.map((p) => [q64(clamp(p[0], 0, world.w)), q64(clamp(p[1], 0, h))] as [number, number]);
  let kind = s.kind;
  let w = strokeWidths({ ...s, pts });
  if (kind === 'line' && pts.length >= 1) {
    const L = strokeLength({ ...s, pts, kind: 'line' });
    if (pts.length === 1 || L < 4 / 16) {
      // a tap: < 4 px of movement (§3.2)
      kind = 'dot';
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      pts.splice(0, pts.length, [q64(cx), q64(cy)]);
      w = [Math.max(CANVAS.tap_dot_c, s.w[0] ?? 0)];
    }
  }
  if (kind === 'dot') w = [q64(w[0] ?? CANVAS.tap_dot_c)];
  else if (kind === 'blob') w = [q64(w[0] ?? 0.5)];
  else w = w.map((x) => q64(Math.max(1 / 64, x)));
  const out: InkStroke = { ...s, kind, pts, w, closed: kind === 'dot' ? true : kind === 'blob' ? true : !!s.closed };
  return out;
}

/** Union-find components over same-colour touching strokes (§3.2). Ids 1..n in order of first stroke. */
export function computeComponents(strokes: readonly InkStroke[]): InkComponent[] {
  const n = strokes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const boxes = strokes.map((s) => strokeBBox(s));
  const lines = strokes.map((s) => strokeCentrelines(s) as P[]);
  const widths = strokes.map((s) => strokeMedianW(s));
  for (let i = 0; i < n; i++) {
    const a = strokes[i];
    if (a.stamp) continue;
    for (let j = i + 1; j < n; j++) {
      const b = strokes[j];
      if (b.stamp || a.color !== b.color) continue;
      // two taps are two coins, however close (N9: every blue dot is a coin); two chips with different roles are
      // two things (a kid's label, or a prompt draft's exact role) — they never fuse into one component
      if (a.kind === 'dot' && b.kind === 'dot') continue;
      if (a.label && b.label && a.label !== b.label) continue;
      const tol = 0.5 * Math.max(widths[i], widths[j]);
      if (rectGap(boxes[i], boxes[j]) > tol) continue;
      const d = distPolyPoly(lines[i], lines[j]) - (widths[i] + widths[j]) / 2;
      if (d <= tol) unite(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const roots = [...groups.keys()].sort((a, b) => a - b);
  return roots.map((r, k) => {
    const idx = groups.get(r)!;
    const ss = idx.map((i) => strokes[i]);
    const g = computeGeo(ss);
    return {
      id: k + 1,
      color: ss[0].color,
      stroke_ids: ss.map((s) => s.id),
      bbox: [q16(g.bbox[0]), q16(g.bbox[1]), q16(g.bbox[2]), q16(g.bbox[3])],
      area: Math.round(ss.reduce((a, s) => a + strokeInkArea(s), 0) * 1000) / 1000,
      f: featuresOf(g),
    };
  });
}

/** Build an InkDoc from editor strokes (§11.3b). */
export function inkFromStrokes(strokes: InkStroke[], world: World, o?: { character?: InkStroke[]; typed_rules?: TypedRule[] }): InkDoc {
  const screens = clamp(Math.round(world.screens || 1), 1, WORLD.max_screens);
  const w = WORLD.screen_w * screens;
  const seen = new Set<string>();
  const norm: InkStroke[] = [];
  strokes.forEach((s, i) => {
    if (!s || !Array.isArray(s.pts) || !s.pts.length) return;
    let id = typeof s.id === 'string' && s.id ? s.id : `s${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    norm.push(normalizeStroke({ ...s, id, sheet: s.sheet ?? 0, origin: s.origin ?? 'kid', w: s.w ?? [] }, { w, h: WORLD.h }));
  });
  const character = o?.character?.length ? { strokes: o.character.map((s) => normalizeStroke(s, { w: 16, h: 16 })) } : null;
  return {
    v: 2,
    source: 'canvas',
    world: { screens, w, h: 27 },
    strokes: norm,
    components: computeComponents(norm),
    character,
    typed_rules: (o?.typed_rules ?? []).map((r) => ({ text: String(r.text ?? '').slice(0, 300), target: r.target ?? null })),
    rules_ink: [],
    sheets: Array.from({ length: screens }, (_, i) => ({ index: i, photo_url: null, qr: null, warnings: [] })),
    noise: { count: 0 },
    parent: null,
  };
}

/**
 * Make sure an InkDoc carries components with features computed by this module (C-1: the definitions live in one
 * place). Paper components keep their grouping (one connected blob per component); their `f`, `bbox` and `area`
 * are recomputed from the strokes. Rules-box strokes (`rules_ink`) are never part of a component.
 */
export function ensureComponents(ink: InkDoc): InkDoc {
  const rules = new Set(ink.rules_ink ?? []);
  const strokes = (ink.strokes ?? []).filter((s) => !rules.has(s.id));
  if (!ink.components || !ink.components.length) return { ...ink, components: computeComponents(strokes) };
  const byId = new Map(strokes.map((s) => [s.id, s] as const));
  const components = ink.components.map((c) => {
    const ss = c.stroke_ids.map((id) => byId.get(id)).filter((s): s is InkStroke => !!s);
    if (!ss.length) return c;
    const g = computeGeo(ss);
    return {
      ...c,
      bbox: [q16(g.bbox[0]), q16(g.bbox[1]), q16(g.bbox[2]), q16(g.bbox[3])] as [number, number, number, number],
      area: Math.round(ss.reduce((a, s) => a + strokeInkArea(s), 0) * 1000) / 1000,
      f: featuresOf(g),
    };
  }).filter((c) => c.stroke_ids.some((id) => byId.has(id)));
  return { ...ink, components };
}

/** Stroke lookup by id. */
export function strokeIndex(ink: InkDoc): Map<string, InkStroke> {
  const m = new Map<string, InkStroke>();
  for (const s of ink.strokes) m.set(s.id, s);
  return m;
}
