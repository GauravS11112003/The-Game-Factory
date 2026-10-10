/**
 * buildArt: (level, ink, theme, seed) → ArtDoc (PLAN_V2 §7.3-7.5). One art pipeline for play, preview, thumbnails,
 * seeds and goldens. Art and collision both come from the fitted shapes: terrain strokes are top-aligned onto the
 * compiled tiles, every collision top gets ink above it, every stroke is drawn by some recipe (never dropped).
 */
import type { Entity, InkDoc, InkStroke, LevelInk, LevelV2, SceneObject, Theme } from '../types.gen.ts';
import { ART } from '../params.ts';
import type { ArtDoc, ArtLava, ArtLayer, ArtPath, ArtSprite } from './types.ts';
import { cleanStroke, simplify } from './clean.ts';
import type { CleanStroke } from './clean.ts';
import { CELL, circlePts, flat, hash32, rng, wobble } from './geom.ts';
import type { V } from './geom.ts';
import { buildParallax } from './parallax.ts';
import { buildPlayerArt } from './player.ts';
import { buildSprite, emitStroke } from './sprites.ts';
import type { SpriteSource } from './sprites.ts';
import { baseStyles, emitMarker, inkForOrigin, StyleBook } from './styles.ts';
import type { InkFor } from './styles.ts';
import { alignSurface, alignWall, decodeGrid, lavaRuns, pitRuns, solidEdges, solidRegions, uncoveredTops } from './terrain.ts';
import type { Grid } from './terrain.ts';

const D = ART.depths;

export interface BuildArtOptions {
  theme?: Theme;
  seed: number;
  boilFrame?: 0 | 1 | 2;
}

function strokesOf(ink: InkDoc | LevelInk | null | undefined, level: LevelV2): InkStroke[] {
  if (ink && Array.isArray(ink.strokes)) return ink.strokes;
  return level.ink?.strokes ?? [];
}

export function characterOf(ink: InkDoc | LevelInk | null | undefined, level: LevelV2): InkStroke[] | null {
  const c = ink?.character ?? level.ink?.character ?? null;
  return c && c.strokes.length ? c.strokes : null;
}

function isTerrain(o: SceneObject, entityIds: Set<string>): boolean {
  if (entityIds.has(o.id)) return false;
  if (o.collision !== 'solid' && o.collision !== 'one_way') return false;
  if (o.shape.k !== 'surface' && o.shape.k !== 'wall') return false;
  const k = o.behavior?.kind;
  return !k || k === 'static';
}

function layer(id: string, depth: number, scroll: number, paths: ArtPath[], opacity?: number): ArtLayer {
  return opacity === undefined ? { id, depth, scroll, paths } : { id, depth, scroll, paths, opacity };
}

function moveSpritePaths(s: ArtSprite): ArtPath[] {
  const [ax, ay] = s.anchor;
  return s.paths.map((p) => {
    const pts = p.pts.slice();
    for (let i = 0; i + 1 < pts.length; i += 2) {
      pts[i] = Math.round((pts[i] + ax) * 64) / 64;
      pts[i + 1] = Math.round((pts[i + 1] + ay) * 64) / 64;
    }
    const out: ArtPath = { ...p, pts, object_id: p.object_id ?? s.id };
    delete out.pivot;
    return out;
  });
}

function jitter(paths: ArtPath[], frame: number, salt: number): void {
  const amp = ART.boil.amp_px / CELL;
  paths.forEach((p, k) => {
    const r = rng((hash32(`${frame}:${salt}:${k}`) ^ 0x5bd1e995) >>> 0);
    for (let i = 0; i + 1 < p.pts.length; i += 2) {
      p.pts[i] = Math.round((p.pts[i] + (r() * 2 - 1) * amp) * 64) / 64;
      p.pts[i + 1] = Math.round((p.pts[i + 1] + (r() * 2 - 1) * amp) * 64) / 64;
    }
  });
}

function terrainFills(g: Grid, out: ArtPath[]): { lava: ArtLava[] } {
  const { mass, light } = solidRegions(g);
  for (const p of mass) out.push({ pts: p, closed: true, style: 'ground_tint' });
  for (const p of light) out.push({ pts: p, closed: true, style: 'ground_tint' });
  for (const p of mass) out.push({ pts: p, closed: true, style: 'ground_hatch' });
  for (const p of light) out.push({ pts: p, closed: true, style: 'hatch_light' });
  // one-way: a dotted underside, 3 dots per cell ("you can jump through")
  const per = ART.oneway_dots_per_cell;
  for (let r = 0; r < g.h; r++)
    for (let c = 0; c < g.w; c++) {
      if (g.rows[r][c] !== '=') continue;
      for (let i = 0; i < per; i++) out.push({ pts: circlePts(c + (i + 0.5) / per, r + 0.62, 1.1 / CELL, 8), closed: true, style: 'oneway_dot' });
    }
  // lava fill (its animated wavy top is drawn by the engine)
  const lava: ArtLava[] = [];
  for (const run of lavaRuns(g)) {
    out.push({ pts: [run.x0, run.y + 0.2, run.x1, run.y + 0.2, run.x1, run.y + run.depth, run.x0, run.y + run.depth], closed: true, style: 'lava_fill' });
    lava.push({ x0: run.x0, x1: run.x1, y: run.y });
  }
  // legacy full-cell hazards (migrated v1 only)
  for (let r = 0; r < g.h; r++)
    for (let c = 0; c < g.w; c++) {
      if (g.rows[r][c] !== 'X') continue;
      const box = [c, r, c + 1, r, c + 1, r + 1, c, r + 1];
      out.push({ pts: box, closed: true, style: 'legacy_hazard' });
      out.push({ pts: box, closed: true, style: 'legacy_outline' });
    }
  return { lava };
}

function abyss(g: Grid, out: ArtPath[], seed: number): void {
  // a pit always has an abyss scribble at the world bottom, so falls are never invisible (§7.1 rule 6)
  const r = rng(seed ^ 0xabcd);
  for (const [c0, c1] of pitRuns(g)) {
    for (let row = 0; row < 2; row++) {
      const pts: [number, number][] = [];
      for (let x = c0 + 0.1; x <= c1 - 0.1; x += 0.33) pts.push([x, g.h - 0.25 - row * 0.4 - (pts.length % 2 ? 0.3 : 0) - r() * 0.1]);
      if (pts.length > 1) out.push({ pts: flat(pts), closed: false, style: 'abyss' });
    }
  }
}

/** Objects whose applied `use_library` edit kept the kid's own drawing ("Use my new drawing", F-4 / B-2). */
function ownArtIds(level: LevelV2): Set<string> {
  const out = new Set<string>();
  for (const e of level.edits ?? []) {
    const op = e.op as { op?: string; target?: string; x_own_art?: boolean };
    if (e.status === 'applied' && op.op === 'use_library' && op.x_own_art && typeof op.target === 'string') out.add(op.target);
  }
  return out;
}

/**
 * §8.1 library instances: an object that is an instance of a library type (`obj.lib`) is drawn with the type's art
 * (`level.embedded_library`), scaled uniformly into the instance's body box with its feet on the box bottom (B-2), so
 * a circled letter or a matched paper symbol plays as the creature it names. Null when the object keeps its own
 * drawing, has no body box, or the type is not embedded.
 */
function libraryArt(obj: SceneObject, level: LevelV2, own: Set<string>): InkStroke[] | null {
  if (!obj.lib || own.has(obj.id) || obj.shape.k !== 'body') return null;
  const t = (level.embedded_library ?? []).find((x) => x.id === obj.lib!.type_id && x.version === obj.lib!.version)
    ?? (level.embedded_library ?? []).find((x) => x.id === obj.lib!.type_id);
  const art = t?.art?.strokes ?? [];
  if (!art.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of art) for (const q of s.pts) {
    x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
  }
  if (!(x1 >= x0 && y1 >= y0)) return null;
  const [bx0, by0, bx1, by1] = obj.shape.bbox;
  const aw = Math.max(1e-3, x1 - x0);
  const ah = Math.max(1e-3, y1 - y0);
  const k = Math.min((bx1 - bx0) / aw, (by1 - by0) / ah);
  if (!(k > 0)) return null;
  const ox = (bx0 + bx1) / 2 - ((x0 + x1) / 2) * k;
  const oy = by1 - y1 * k; // feet on the box bottom
  const r = (v: number): number => Math.round(v * 64) / 64;
  return art.map((s, i) => ({
    ...s, id: `${obj.id}~lib${i}`, origin: obj.origin, sheet: s.sheet ?? 0,
    pts: s.pts.map((q) => [r(q[0] * k + ox), r(q[1] * k + oy)] as [number, number]),
    w: s.w.map((w) => Math.max(0.08, Math.min(0.9, w * Math.sqrt(k)))),
  }));
}

export function buildArt(level: LevelV2, ink: InkDoc | LevelInk | null | undefined, o: BuildArtOptions): ArtDoc {
  const theme: Theme = o.theme ?? level.rules?.theme ?? 'sketchbook';
  const seed = (o.seed ^ hash32(level.id ?? 'level')) >>> 0;
  const b = new StyleBook(theme);
  baseStyles(b);
  const g = decodeGrid(level);
  const strokes = strokesOf(ink, level);
  const strokeById = new Map(strokes.map((s) => [s.id, s]));
  const objects = level.objects ?? [];
  const objById = new Map(objects.map((x) => [x.id, x]));
  const entities: Entity[] = level.compiled?.entities ?? [];
  const entityIds = new Set(entities.map((e) => e.id));
  const consumed = new Set<string>();
  const usedStrokes = new Set<string>();
  const ownArt = ownArtIds(level);

  // ---- entity sprites (the kid's strokes, every part included) ----
  const sprites: ArtSprite[] = [];
  for (const e of entities) {
    const obj = objById.get(e.sprite ?? '') ?? objById.get(e.id) ?? null;
    const src: SpriteSource = { obj, strokes: [], partRoles: new Map() };
    const libStrokes = obj ? libraryArt(obj, level, ownArt) : null;
    if (obj && libStrokes) {
      // the type's drawing stands in for the glyph; the glyph's strokes (and its parts) are consumed, not redrawn
      const ids = new Set<string>([obj.id, ...(obj.rel.parts ?? [])]);
      for (const x of objects) if (x.rel.part_of && ids.has(x.rel.part_of)) ids.add(x.id);
      for (const id of ids) {
        const part = objById.get(id);
        if (!part) continue;
        consumed.add(id);
        for (const sid of part.strokes) usedStrokes.add(sid);
      }
      for (const s of libStrokes) {
        src.strokes.push(s);
        src.partRoles.set(s.id, obj.role);
      }
    } else if (obj) {
      const ids = new Set<string>([obj.id, ...(obj.rel.parts ?? [])]);
      for (const x of objects) if (x.rel.part_of && ids.has(x.rel.part_of)) ids.add(x.id);
      for (const id of ids) {
        const part = objById.get(id);
        if (!part) continue;
        consumed.add(id);
        for (const sid of part.strokes) {
          const s = strokeById.get(sid);
          if (!s || usedStrokes.has(sid)) continue;
          usedStrokes.add(sid);
          src.strokes.push(s);
          src.partRoles.set(sid, part.role);
        }
      }
    }
    try {
      const sp = buildSprite(e, src, b, seed);
      if (sp) sprites.push(sp);
    } catch {
      // the engine's entity guard reports it; the art never takes the level down
    }
  }

  // ---- terrain: aligned kid strokes over the hatched solid cells ----
  const terrainPaths: ArtPath[] = [];
  const { lava } = terrainFills(g, terrainPaths);
  abyss(g, terrainPaths, seed);
  const aligned: CleanStroke[] = [];
  const terrainStrokePaths: ArtPath[] = [];
  let alignMax = 0;
  const terrainObjs = objects.filter((x) => !consumed.has(x.id) && isTerrain(x, entityIds));
  for (const obj of terrainObjs) {
    consumed.add(obj.id);
    const ink_: InkFor = inkForOrigin(obj.origin);
    let cs = obj.strokes
      .map((sid) => strokeById.get(sid))
      .filter((s): s is InkStroke => !!s && !usedStrokes.has(s.id))
      .map((s) => {
        usedStrokes.add(s.id);
        return cleanStroke(s, { rdpEps: 0 });
      })
      .filter((c) => c.v.length > 0);
    // align with the width the line is finally drawn at (pencil is thinner, blue-line drafts are 2 px)
    if (ink_ === 'pencil') cs = cs.map((c) => ({ ...c, v: c.v.map((p) => [p[0], p[1], Math.max(1.6, p[2] * 0.55)] as V) }));
    if (ink_ === 'blue_line') cs = cs.map((c) => ({ ...c, v: c.v.map((p) => [p[0], p[1], 2] as V) }));
    const res =
      obj.shape.k === 'wall'
        ? alignWall(obj, cs, g)
        : alignSurface(obj, cs, g, obj.shape.k === 'surface' && obj.shape.fill === 'to_top' ? 'bottom' : 'top');
    alignMax = Math.max(alignMax, res.residualPx);
    for (const c of res.strokes) {
      aligned.push(c);
      const simple = simplify(c, 0.03);
      const em = ink_ === 'pencil' ? { ...simple, v: simple.v.map((p) => [p[0], p[1], p[2] / 0.55] as V) } : simple;
      emitStroke(terrainStrokePaths, b, em, ink_, 'terrain', seed ^ hash32(c.id), { object_id: obj.id });
    }
  }
  // every collision top has art above it: trace the uncovered runs in marker, top edge on the surface
  const runs = uncoveredTops(g, aligned);
  const wr = rng(seed ^ 0x77);
  const traceW = 7;
  for (const run of runs) {
    const pts = run.pts.slice();
    if (pts.length < 2) continue;
    // inset the ends by 2 px so the round caps end at the cell edges
    const inset = 2 / CELL;
    pts[0] = [pts[0][0] + inset, pts[0][1] + ((pts[1][1] - pts[0][1]) * inset) / Math.max(1e-6, pts[1][0] - pts[0][0])];
    const n = pts.length - 1;
    pts[n] = [pts[n][0] - inset, pts[n][1] - ((pts[n][1] - pts[n - 1][1]) * inset) / Math.max(1e-6, pts[n][0] - pts[n - 1][0])];
    let v: V[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const [ax, ay] = pts[i - 1];
        const [bx, by] = pts[i];
        const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 0.25));
        for (let k = 1; k <= steps; k++) v.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, traceW]);
      } else v.push([pts[0][0], pts[0][1], traceW]);
    }
    // centreline half a width below the top (slope-aware), then a ≤ 0.35 px wobble
    v = v.map((p, i) => {
      const a = v[Math.max(0, i - 1)];
      const c = v[Math.min(v.length - 1, i + 1)];
      const cos = Math.abs(c[0] - a[0]) / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1);
      return [p[0], p[1] + traceW / 2 / CELL / Math.max(0.4, cos), p[2] * (0.92 + wr() * 0.16)] as V;
    });
    v = wobble(v, 0.35, wr, 2.5);
    emitMarker(terrainStrokePaths, v, false, b.marker('black'));
  }
  // side faces: traced in marker when no terrain was drawn (migrated / fixture levels), else a faint graphite edge
  const traced = terrainObjs.length === 0;
  for (const e of solidEdges(g)) {
    if (traced) {
      let v: V[] = [];
      const [[ax, ay], [bx, by]] = e.pts;
      const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 0.25));
      for (let k = 0; k <= steps; k++) v.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps, 5.5]);
      v = wobble(v, 0.7, wr, 2);
      emitMarker(terrainStrokePaths, v, false, b.marker('black'));
    } else terrainStrokePaths.push({ pts: flat(e.pts), closed: false, style: 'edge_faint' });
  }

  // ---- everything else the kid drew: decoration, signs, lava strokes ----
  const decoPaths: ArtPath[] = [];
  const signPaths: ArtPath[] = [];
  const coinEntities = entities.filter((e) => e.type === 'coin');
  for (const obj of objects) {
    if (consumed.has(obj.id)) continue;
    const list = obj.strokes.map((sid) => strokeById.get(sid)).filter((s): s is InkStroke => !!s && !usedStrokes.has(s.id));
    if (!list.length) continue;
    for (const s of list) usedStrokes.add(s.id);
    if (obj.role === 'coin') {
      // a coin dot whose coin entity was de-duplicated nearby is already drawn as the house coin
      const [cx, cy] = obj.shape.k === 'point' ? obj.shape.p : [list[0].pts[0][0], list[0].pts[0][1]];
      if (coinEntities.some((e) => e.type === 'coin' && Math.hypot(e.x - cx, e.y - cy) <= 0.75)) continue;
    }
    const ink_ = inkForOrigin(obj.origin);
    const target = obj.role === 'text' || obj.role === 'arrow' ? signPaths : obj.role === 'lava' ? terrainStrokePaths : decoPaths;
    const mode = target === signPaths ? 'sign' : target === terrainStrokePaths ? 'terrain' : 'decor';
    for (const s of list) {
      const c = cleanStroke(s, { minDotPx: obj.role === 'decoration' ? 4 : undefined });
      emitStroke(target, b, c, ink_, mode, seed ^ hash32(s.id), { object_id: obj.id });
    }
  }
  let orphans = 0;
  for (const s of strokes) {
    if (usedStrokes.has(s.id)) continue;
    usedStrokes.add(s.id);
    const c = cleanStroke(s);
    const ink_ = inkForOrigin(s.origin);
    if (objects.length === 0) emitStroke(terrainStrokePaths, b, c, ink_, 'terrain', seed ^ hash32(s.id));
    else {
      orphans++;
      emitStroke(decoPaths, b, c, ink_, 'decor', seed ^ hash32(s.id));
    }
  }

  // ---- player and static entity layers (thumbnails, SVG); the engine animates the sprites instead ----
  const player = buildPlayerArt(characterOf(ink, level), b, seed);
  const entPaths: ArtPath[] = [];
  for (const s of sprites) entPaths.push(...moveSpritePaths(s));
  const start = entities.find((e) => e.type === 'player_start') as Extract<Entity, { type: 'player_start' }> | undefined;
  const sx = start?.x ?? 2;
  const sy = start?.y ?? 22;
  const playerPaths = moveSpritePaths({ id: 'player', type: 'player', source: player.source, designer: false, anchor: [sx, sy], bbox: player.bbox, paths: player.paths, eyes: [], object_ids: [] });

  const par = buildParallax(level.id ?? 'level', theme, level.world, g, entities);
  const boilFrame = o.boilFrame ?? 0;
  if (boilFrame) {
    jitter(decoPaths, boilFrame, 1);
    jitter(signPaths, boilFrame, 2);
    jitter(terrainStrokePaths, boilFrame, 3);
    jitter(entPaths, boilFrame, 4);
  }
  const layers: ArtLayer[] = [
    layer('paper', D.paper, 0, []),
    layer('far', D.far, ART.parallax.far, par.far),
    layer('clouds', D.far + 1, ART.parallax.far, par.clouds),
    layer('mid', D.mid, ART.parallax.mid, par.mid),
    layer('decoration', D.decoration, 1, decoPaths, ART.decoration_opacity),
    layer('signs', D.decoration + 1, 1, signPaths, ART.sign_opacity),
    layer('terrain', D.terrain, 1, [...terrainPaths, ...terrainStrokePaths]),
    layer('entities', D.entities, 1, entPaths),
    layer('player', D.player, 1, playerPaths),
    layer('foreground', D.foreground, ART.parallax.fg, par.fg),
  ];
  return {
    v: 1, level_id: level.id ?? 'level', theme, seed, world: level.world, boilFrame, styles: b.styles, layers, sprites,
    player, lava,
    stats: {
      align_max_px: Math.round(alignMax * 100) / 100,
      uncovered_tops: 0,
      traced_runs: runs.length,
      strokes_without_object: orphans,
    },
  };
}
