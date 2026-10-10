/**
 * What the browser core worker does (runs in a Web Worker, or inline as a fallback). Pure: no DOM.
 * - `ink`: editor strokes → InkDoc (core.inkFromStrokes), typed rules bound to the selected stroke's component (§7.11);
 * - `hints`: ink → perceiveHeuristic → build(faithful, repairUnsolvable false) → role chips, reach halo, too-far
 *   markers, snap ghosts, goal reachability (§7.11), plus the level for ▶ test-play (§6.3);
 * - `build` / `menu` / `hash`: local preview rebuilds for Keep/Undo toggles and Fix it (§7.10 Toggles);
 * - `analyze`: the bot on one level (#/dev showcase);
 * - `rulesCheck` / `libraryCheck`: dry runs of a rules change (§8.2) or a new library version (§8.1) over a game's
 *   levels, with optional Faithful repairs;
 * - `plan`: prompt-to-level offline (§8.3): keyword planner → layout → a verified draft;
 * - `remix`: the object-level remix diff (§6.5) for "what I changed" outlines.
 */
import * as core from '../core/index.ts';
import { isNotImplemented } from '../core/util/errors.ts';
import { DERIVED, WORLD } from '../core/params.ts';
import type {
  CellXY, EditRecord, GameRules, InkDoc, InkStroke, LevelV2, LibraryType, MessageRef, PlaytestReport, RectCells, SceneGraph,
  SceneObject, World,
} from '../core/types.gen.ts';
import type {
  AnalyzeParams, AnalyzeResult, DryLevel, DryRow, HintsParams, HintsResult, InkParams, LibraryCheckParams, LocalBuildParams,
  LocalBuildResult, MenuResult, ObjHint, PlanParams, PlanResult, RemixParams, RemixResult, RulesCheckParams, SnapGhost, TooFar,
  VerifyParams, VerifyResult,
} from './core_types.ts';
import { generateLevel } from '../core/generate/index.ts';
import { inkFromLevel } from './ink.ts';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function worldOf(screens: number): World {
  return { cell: 16, screens, w: WORLD.screen_w * screens, h: 27 };
}

/** An InkDoc without components, for when the core cannot vectorize yet (the server re-derives what it needs). */
export function bareInk(p: InkParams): InkDoc {
  const world = worldOf(p.screens);
  return {
    v: 2, source: 'canvas', world: { screens: world.screens, w: world.w, h: 27 }, strokes: p.strokes, components: [],
    character: p.character.length ? { strokes: p.character } : null,
    typed_rules: p.rules.map((r) => ({ text: r.text, target: null })), rules_ink: [],
    sheets: Array.from({ length: p.screens }, (_, i) => ({ index: i, photo_url: null, qr: null, warnings: [] })),
    noise: { count: 0 }, parent: p.parent,
  };
}

export function makeInk(p: InkParams, allowBare = false): InkDoc {
  let ink: InkDoc;
  try {
    ink = core.inkFromStrokes(p.strokes, worldOf(p.screens), p.character.length ? { character: p.character } : undefined);
  } catch (e) {
    if (allowBare && isNotImplemented(e)) return bareInk(p);
    throw e;
  }
  const compOf = (strokeId: string | null): number | null => {
    if (!strokeId) return null;
    return ink.components.find((c) => c.stroke_ids.includes(strokeId))?.id ?? null;
  };
  ink.typed_rules = p.rules.filter((r) => r.text.trim()).map((r) => ({ text: r.text.trim(), target: compOf(r.strokeId) }));
  if (p.character.length && !ink.character) ink.character = { strokes: p.character };
  if (!ink.sheets?.length) ink.sheets = Array.from({ length: p.screens }, (_, i) => ({ index: i, photo_url: null, qr: null, warnings: [] }));
  ink.parent = p.parent;
  return ink;
}

// ---- tiles ---------------------------------------------------------------------------------------------------

export function decodeRow(row: string): string {
  let out = '';
  for (const m of row.matchAll(/([0-9]*)([.#=/\\abcd~X])/g)) out += m[2].repeat(m[1] ? Number(m[1]) : 1);
  return out;
}

const FLOOR_TOP: Record<string, number> = { '#': 0, '=': 0, '/': 0.5, '\\': 0.5, a: 0.75, b: 0.25, c: 0.25, d: 0.75 };

export function tileGrid(level: LevelV2): string[] {
  return level.compiled.tiles.rows.map(decodeRow);
}

/** Standable feet positions in a column (cells), top to bottom: a floor tile with open air above. */
export function standableYs(grid: string[], col: number): number[] {
  const ys: number[] = [];
  for (let r = 0; r < grid.length; r++) {
    const ch = grid[r][col];
    if (ch === undefined || !(ch in FLOOR_TOP)) continue;
    const above = r > 0 ? grid[r - 1][col] : '.';
    if (above === '.' || above === '~' || above === undefined) ys.push(r + FLOOR_TOP[ch]);
  }
  return ys;
}

/** Snap a tapped point to the nearest standable feet position below it (for "play from here", §6.3). */
export function snapStandable(level: LevelV2, at: CellXY): CellXY | null {
  const grid = tileGrid(level);
  const w = level.world.w;
  for (const dx of [0, -1, 1, -2, 2]) {
    const col = Math.floor(at[0]) + dx;
    if (col < 0 || col >= w) continue;
    const ys = standableYs(grid, col);
    const below = ys.filter((y) => y >= at[1] - 0.5);
    const y = below.length ? below[0] : ys[ys.length - 1];
    if (y !== undefined) return [col + 0.5, y];
  }
  return null;
}

// ---- hints ---------------------------------------------------------------------------------------------------

function bboxOfStrokes(ink: InkDoc, ids: string[]): RectCells | null {
  const set = new Set(ids);
  let r: RectCells | null = null;
  for (const s of ink.strokes) {
    if (!set.has(s.id)) continue;
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i];
      const h = (s.kind === 'dot' ? s.w[0] : s.w[Math.min(i, s.w.length - 1)] ?? 0.75) / 2;
      r = r ? [Math.min(r[0], p[0] - h), Math.min(r[1], p[1] - h), Math.max(r[2], p[0] + h), Math.max(r[3], p[1] + h)]
        : [p[0] - h, p[1] - h, p[0] + h, p[1] + h];
    }
  }
  return r;
}

function surfaceY(o: SceneObject, x: number): number | null {
  const sh = o.shape;
  if (sh.k === 'surface') {
    for (const s of sh.segs) {
      const xa = Math.min(s.a[0], s.b[0]);
      const xb = Math.max(s.a[0], s.b[0]);
      if (x >= xa - 0.5 && x <= xb + 0.5) {
        const t = s.b[0] === s.a[0] ? 0 : Math.max(0, Math.min(1, (x - s.a[0]) / (s.b[0] - s.a[0])));
        return s.a[1] + (s.b[1] - s.a[1]) * t;
      }
    }
    return sh.segs.length ? sh.segs[0].a[1] : null;
  }
  if (sh.k === 'wall') return sh.y0;
  if (sh.k === 'body') return sh.bbox[1];
  if (sh.k === 'strip') return Math.min(sh.a[1], sh.b[1]);
  if (sh.k === 'point') return sh.p[1];
  return null;
}

/**
 * `report.reachable` holds node keys. Two forms are read: "x,y[|…]" (cells) and "<surface id>:<x>[:…]" (the bot's
 * (surface, x) nodes, §4.1); the y comes from the surface's fitted shape, else from the tiles in that column.
 */
export function reachCells(report: PlaytestReport, level: LevelV2, objects: SceneObject[]): CellXY[] {
  const byId = new Map(objects.map((o) => [o.id, o]));
  let grid: string[] | null = null;
  const out = new Map<string, CellXY>();
  const add = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const cx = Math.floor(x);
    const key = `${cx}:${Math.round(y * 4)}`;
    if (!out.has(key)) out.set(key, [cx, y]);
  };
  for (const raw of report.reachable ?? []) {
    const k = String(raw).split('|')[0];
    const xy = /^\s*\[?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(k);
    if (xy) {
      add(Number(xy[1]), Number(xy[2]));
      continue;
    }
    const sx = /^([A-Za-z_][\w.-]*?):(-?\d+(?:\.\d+)?)/.exec(k);
    if (!sx) continue;
    const x = Number(sx[2]);
    const o = byId.get(sx[1]);
    let y = o ? surfaceY(o, x) : null;
    if (y === null) {
      grid ??= tileGrid(level);
      const ys = standableYs(grid, Math.floor(x));
      y = ys.length ? ys[0] : null;
    }
    if (y !== null) add(x, Math.round(y * 16) / 16);
  }
  if (!out.size) {
    for (const st of report.route ?? []) {
      add(st.from[0], st.from[1]);
      add(st.to[0], st.to[1]);
    }
    for (const p of report.frontier?.reached ?? []) add(p[0], p[1]);
  }
  return [...out.values()];
}

function nearestOnRect(r: RectCells, p: CellXY): CellXY {
  return [Math.max(r[0], Math.min(r[2], p[0])), Math.max(r[1], Math.min(r[3], p[1]))];
}

function tooFarMarkers(report: PlaytestReport, objs: Map<string, ObjHint>): TooFar[] {
  const out: TooFar[] = [];
  const b = report.frontier?.blocking;
  if (b) {
    const target = objs.get(b.to_object);
    const to: CellXY = target?.bbox ? nearestOnRect(target.bbox, b.from) : [b.from[0] + 4, b.from[1]];
    const gap = Math.abs(to[0] - b.from[0]);
    const runUp = b.kind === 'gap_too_wide' && gap <= DERIVED.g_max_expected.runway_3 + 0.5;
    out.push({ from: b.from, to, label: runUp ? 'needs_run_up' : 'too_far', blocking: true });
  }
  for (const st of report.route ?? []) {
    if (st.kind === 'runjump' && Math.abs(st.to[0] - st.from[0]) >= DERIVED.run_gap_c[0]) {
      out.push({ from: st.from, to: st.to, label: 'needs_run_up', blocking: false });
    }
  }
  return out;
}

function snapGhosts(level: LevelV2, objs: Map<string, ObjHint>): SnapGhost[] {
  const out: SnapGhost[] = [];
  const BAND = 9 / 16;
  for (const e of level.compiled.entities) {
    const o = objs.get(e.id);
    if (!o?.bbox) continue;
    const d = o.bbox;
    if (e.type === 'spikes') {
      // Side-facing strips sit on wall faces; their ghost is only drawn for floor and ceiling faces.
      if (e.facing !== 'up' && e.facing !== 'down') continue;
      const to: RectCells = e.facing === 'up' ? [e.x0, e.y - BAND, e.x1, e.y] : [e.x0, e.y, e.x1, e.y + BAND];
      const off = e.facing === 'up' ? Math.abs(to[3] - d[3]) : Math.abs(to[1] - d[1]);
      if (off > 0.3) out.push({ id: e.id, kind: 'spikes', from: d, to, facing: e.facing });
    } else if (e.type === 'enemy') {
      const to: RectCells = [e.x - e.w / 2, e.y - e.h, e.x + e.w / 2, e.y];
      if (Math.abs(to[3] - d[3]) > 0.3) out.push({ id: e.id, kind: 'enemy', from: d, to });
    }
  }
  return out;
}

export function hints(p: HintsParams): HintsResult {
  const t0 = now();
  const ink = makeInk(p);
  const parent = p.parentLevel ?? null;
  const graph0 = core.perceiveHeuristic(ink, { library: p.library, parent });
  const res = core.build({
    ink, graph0, edits: [], rules: p.rules_game, library: p.library, parent, tier: 'faithful', repairUnsolvable: false, seed: 1,
  });
  const objects = (res.graph.objects ?? graph0.objects).map<ObjHint>((o) => ({
    id: o.id, role: o.role, conf: o.conf, strokes: o.strokes, bbox: bboxOfStrokes(ink, o.strokes),
    alt: (o.alt ?? []).map((a) => a.role), pinned: o.role_by === 'kid' || o.role_by === 'stamp' || o.role_by === 'library',
    behavior: o.behavior ?? null, partOf: o.rel?.part_of ?? null,
  }));
  const byId = new Map(objects.map((o) => [o.id, o]));
  const goalIds = new Set(objects.filter((o) => o.role === 'goal').map((o) => o.id));
  const goalStrokes = objects.filter((o) => goalIds.has(o.id) || (o.partOf && goalIds.has(o.partOf))).flatMap((o) => o.strokes);
  const start = res.level.compiled.entities.find((e) => e.type === 'player_start');
  return {
    rev: p.rev, ms: now() - t0, objects, solvable: res.report.solvable, goalStrokes,
    reach: reachCells(res.report, res.level, res.level.objects?.length ? res.level.objects : res.graph.objects),
    start: start ? [start.x, start.y] : null,
    tooFar: tooFarMarkers(res.report, byId), snaps: snapGhosts(res.level, byId), level: res.level, ink, report: res.report,
  };
}

export function graph0(p: { ink: InkDoc }): SceneGraph {
  return core.perceiveHeuristic(p.ink, { library: [], parent: null });
}

export function localBuild(p: LocalBuildParams): LocalBuildResult {
  const r = core.build({ ...p, parent: null, repairUnsolvable: true });
  return { level: r.level, report: r.report, edits: r.edits, rejected: r.rejected, graph: r.graph, ms: r.ms };
}

export function menu(p: LocalBuildParams & { max: number }): MenuResult {
  const { max, ...input } = p;
  const base = core.build({ ...input, parent: null, repairUnsolvable: true });
  return { menu: core.candidates(base, { max }) };
}

export function hash(p: { level: LevelV2 }): string {
  return core.levelHash(p.level);
}

// ---- the bot and the dry runs ---------------------------------------------------------------------------------

export function analyzeLevel(p: AnalyzeParams): AnalyzeResult {
  const t0 = now();
  const report = core.analyze(p.level, { mode: p.mode });
  return { report, ms: now() - t0 };
}

const BASE_ABILITIES = { run: true, stomp: true, double_jump: false, fast_fall: true };

/**
 * A level's rules under new game rules: the gameplay fields come from the game (§8.2, the resolved snapshot), the
 * profile hash is recomputed so replays recorded under the new rules carry the right one.
 */
export function resolveRules(levelRules: GameRules, game: GameRules): GameRules {
  const profile = game.physics_profile ?? levelRules.physics_profile ?? 'v2-standard';
  let ph: string | null = null;
  try {
    ph = core.profileHash(profile);
  } catch {
    ph = levelRules.profile_hash ?? null;
  }
  return {
    ...levelRules, ...game, physics_profile: profile, profile_hash: ph,
    abilities: { ...BASE_ABILITIES, ...(levelRules.abilities ?? {}), ...(game.abilities ?? {}) },
  };
}

/** Why a rules change breaks a level that was solvable: the most specific sentence the evidence supports. */
function breakReason(before: GameRules, after: GameRules, route: PlaytestReport | null): string {
  const a = { ...BASE_ABILITIES, ...(before.abilities ?? {}) };
  const b = { ...BASE_ABILITIES, ...(after.abilities ?? {}) };
  const kinds = new Set((route?.route ?? []).map((s) => s.kind));
  if (a.run && !b.run && kinds.has('runjump')) return 'rules.needs_run';
  if (a.stomp && !b.stomp && kinds.has('stomp')) return 'rules.needs_stomp';
  if (a.double_jump && !b.double_jump) return 'rules.needs_double_jump';
  if (a.run && !b.run) return 'rules.needs_run';
  if ((before.physics_profile ?? 'v2-standard') !== (after.physics_profile ?? 'v2-standard')) return 'rules.profile_breaks';
  if ((after.lives ?? 'off') !== 'off' && (before.lives ?? 'off') === 'off') return 'rules.becomes_unsolvable';
  return 'rules.becomes_unsolvable';
}

function solvableOf(level: LevelV2): { ok: boolean; report: PlaytestReport | null } {
  try {
    const report = core.analyze(level, { mode: 'fast' });
    return { ok: report.solvable, report };
  } catch (e) {
    if (isNotImplemented(e)) throw e;
    return { ok: false, report: null };
  }
}

/** The intent records a level keeps across rebuilds (kid and perception understanding, kid edits). */
function intentEdits(level: LevelV2): EditRecord[] {
  return (level.edits ?? []).filter((e) => (e.class === 'U' || e.class === 'K') && e.status !== 'rejected');
}

function repairSentences(edits: EditRecord[]): MessageRef[] {
  const out: MessageRef[] = [];
  const seen = new Set<string>();
  for (const e of edits) {
    if (e.class !== 'R' || e.status !== 'applied' || !e.reason_key) continue;
    const k = `${e.reason_key}|${JSON.stringify(e.reason_args ?? {})}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: e.reason_key, args: e.reason_args ?? {} });
  }
  return out;
}

/** Faithful rebuild of a published level from its own ink (rules and library swapped in). */
function rebuildFaithful(level: LevelV2, rules: GameRules, library: LibraryType[], inkOverride?: InkDoc): { ok: boolean; repairs: MessageRef[] } {
  const ink = inkOverride ?? inkFromLevel(level);
  const graph0 = core.perceiveHeuristic(ink, { library, parent: null });
  const res = core.build({ ink, graph0, edits: intentEdits(level), rules, library, parent: null, tier: 'faithful', repairUnsolvable: true, seed: 1 });
  return { ok: res.report.solvable, repairs: repairSentences(res.edits) };
}

function hasInk(d: DryLevel): boolean {
  return (d.level.ink?.strokes?.length ?? 0) > 0;
}

/**
 * The rules dry run in the browser: the core's own re-verify helper (the same one the server's rules/check runs), so
 * the browser and the server list the same levels with the same reasons; the local fallback below covers cores
 * without it.
 */
export function rulesCheck(p: RulesCheckParams): DryRow[] {
  const helper = (core as { rulesCheck?: typeof core.rulesCheck }).rulesCheck;
  if (typeof helper === 'function') {
    const byId = new Map(p.levels.map((d) => [d.id, d]));
    const out = helper(p.levels.map((d) => d.level), p.rules, { repair: p.repair });
    return out.affected.map((a) => {
      const d = byId.get(a.level_id);
      return {
        level_id: a.level_id, title: d?.title ?? a.level_id, before: true, after: false, reason_key: a.reason_key,
        repairs: repairSentences(a.repairs ?? []), repaired: p.repair ? a.repairable ?? false : null, skipped: !!d && !hasInk(d),
      };
    });
  }
  return rulesCheckLocal(p).filter((r) => r.reason_key);
}

function rulesCheckLocal(p: RulesCheckParams): DryRow[] {
  return p.levels.map((d) => {
    const before = solvableOf(d.level);
    const rules = resolveRules(d.level.rules, p.rules);
    const after = solvableOf({ ...d.level, rules });
    const breaks = before.ok && !after.ok;
    const row: DryRow = {
      level_id: d.id, title: d.title, before: before.ok, after: after.ok,
      reason_key: breaks ? breakReason(d.level.rules, rules, before.report) : null, repairs: [], repaired: null, skipped: false,
    };
    if (breaks && p.repair) {
      if (!hasInk(d)) row.skipped = true;
      else {
        try {
          const r = rebuildFaithful(d.level, rules, d.level.embedded_library ?? []);
          row.repaired = r.ok;
          row.repairs = r.repairs;
        } catch (e) {
          if (isNotImplemented(e)) throw e;
          row.repaired = false;
        }
      }
    }
    return row;
  });
}

/** Strokes placed from a library type, re-pinned to the new version (§8.1 "Update levels to v3"). */
function inkWithVersion(level: LevelV2, typeId: string, version: number): InkDoc | null {
  const ink = inkFromLevel(level);
  let touched = false;
  ink.strokes = ink.strokes.map((s) => {
    if (s.lib?.type_id !== typeId || s.lib.version === version) return s;
    touched = true;
    return { ...s, lib: { type_id: typeId, version } };
  });
  return touched ? ink : null;
}

export function libraryCheck(p: LibraryCheckParams): DryRow[] {
  const library = [p.type, ...p.library.filter((t) => t.id !== p.type.id)];
  const out: DryRow[] = [];
  for (const d of p.levels) {
    const ink = inkWithVersion(d.level, p.type.id, p.type.version);
    if (!ink) continue; // this level does not use the type (or already uses this version)
    const before = solvableOf(d.level);
    const row: DryRow = { level_id: d.id, title: d.title, before: before.ok, after: false, reason_key: null, repairs: [], repaired: null, skipped: false };
    try {
      const graph0 = core.perceiveHeuristic(ink, { library, parent: null });
      const res = core.build({ ink, graph0, edits: intentEdits(d.level), rules: d.level.rules, library, parent: null, tier: 'faithful', repairUnsolvable: false, seed: 1 });
      row.after = res.report.solvable;
      if (!row.after) {
        row.reason_key = 'library.update_breaks';
        const fixed = rebuildFaithful(d.level, d.level.rules, library, ink);
        row.repaired = fixed.ok;
        row.repairs = fixed.repairs;
      }
    } catch (e) {
      if (isNotImplemented(e)) throw e;
      row.after = false;
      row.reason_key = 'library.update_breaks';
    }
    out.push(row);
  }
  return out;
}

// ---- prompt-to-level offline (§8.3) ----------------------------------------------------------------------------

export function plan(p: PlanParams): PlanResult {
  const t0 = now();
  const lp = p.plan ?? core.keywordPlan(p.prompt, p.screens);
  // The verified generator (§8.3 step 3): layout → Faithful build → bot → the deterministic fixer (≤ 3 easier beats),
  // then the greedy repair, so the draft is always playable.
  try {
    const g = generateLevel(lp, p.rules, p.seed, { tier: 'faithful', clamp: 'band', ink: 'draft' });
    if (!g.ink.sheets?.length) g.ink.sheets = Array.from({ length: g.ink.world.screens }, (_, i) => ({ index: i, photo_url: null, qr: null, warnings: [] }));
    return { plan: g.plan, ink: g.ink, level: g.result.level, solvable: g.result.report.solvable, fixes: g.fixes.length, ms: now() - t0 };
  } catch (e) {
    if (!isNotImplemented(e)) console.warn('generateLevel failed; laying the plan out without the fixer', e);
  }
  const ink = core.layoutPlan(lp, p.rules, p.seed);
  if (!ink.sheets?.length) ink.sheets = Array.from({ length: ink.world.screens }, (_, i) => ({ index: i, photo_url: null, qr: null, warnings: [] }));
  let level: LevelV2 | null = null;
  let solvable: boolean | null = null;
  try {
    const graph0 = core.perceiveHeuristic(ink, { library: [], parent: null });
    const res = core.build({ ink, graph0, edits: [], rules: p.rules, library: [], parent: null, tier: 'faithful', repairUnsolvable: true, seed: p.seed });
    level = res.level;
    solvable = res.report.solvable;
  } catch (e) {
    if (!isNotImplemented(e)) console.warn('draft build failed', e);
  }
  return { plan: lp, ink, level, solvable, fixes: 0, ms: now() - t0 };
}

// ---- remix diff (§6.5) ---------------------------------------------------------------------------------------

export function remix(p: RemixParams): RemixResult {
  const r = core.remixDiff(p.parent, p.ink);
  const added = new Set(r.added);
  // remixDiff numbers components on the ink as the build sees it (a paper remix gets the parent's ink merged in)
  const merged = core.ensureComponents(core.withParentInk(p.ink, p.parent));
  const own = new Set(p.ink.strokes.map((s) => s.id));
  const strokes = merged.components.filter((c) => added.has(c.id)).flatMap((c) => c.stroke_ids).filter((id) => own.has(id));
  return { added: strokes, matched: Object.keys(r.matched).length };
}

export type { InkStroke };

// ---- run verification (§8.4) ------------------------------------------------------------------------------------

export function verify(p: VerifyParams): VerifyResult {
  const v = core.verifyRun(p.level, p.replay, p.claimed ?? null) as ReturnType<typeof core.verifyRun> & { accepted?: boolean; reason?: string };
  const accepted = typeof v.accepted === 'boolean' ? v.accepted : v.finished;
  return {
    finished: v.finished, accepted, reason: v.reason ?? (accepted ? 'ok' : 'not_finished'), time_ms: v.time_ms, deaths: v.deaths,
    coins: v.coins, big_coins: v.big_coins, stamps: v.stamps,
  };
}
