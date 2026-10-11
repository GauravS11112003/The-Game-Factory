/**
 * LevelV2 assembly (§2): world, resolved rules, source, ink, objects, setpieces, edits, compiled, design, meta.
 * Deterministic: the id derives from the ink, created_at is a fixed placeholder (the server stamps real ids and
 * times at publish), so the same inputs give a byte-identical level in the browser and in Node.
 */
import { WORLD } from '../params.ts';
import { profileHash } from '../sim/profiles.ts';
import type {
  Band, DesignBlock, EditRecord, GameRules, InkDoc, LevelV2, LibraryType, MessageRef, PlaytestReport, SceneObject, Tier,
} from '../types.gen.ts';
import type { Work } from '../edits/work.ts';
import { hash8 } from '../util/ids.ts';
import { CORE_VERSION } from '../util/version.ts';
import type { Compiled } from './compile.ts';
import { levelHash } from './hash.ts';

export const PLACEHOLDER_TIME = '2026-01-01T00:00:00Z';

/** GameRules with every default filled in (the resolved snapshot a level carries, §2.3). */
export function resolveRules(r: GameRules | null | undefined): GameRules {
  const x: GameRules = r ?? { version: 1 };
  const profile = x.physics_profile ?? 'v2-standard';
  return {
    version: Math.max(1, Math.round(x.version ?? 1)),
    physics_profile: profile,
    profile_hash: profileHash(profile),
    abilities: { run: x.abilities?.run ?? true, stomp: x.abilities?.stomp ?? true, double_jump: x.abilities?.double_jump ?? false, fast_fall: x.abilities?.fast_fall ?? true },
    lives: x.lives ?? 'off',
    hearts: Math.min(3, Math.max(1, Math.round(x.hearts ?? 1))),
    theme: x.theme ?? 'sketchbook',
    music: x.music ?? true,
    timer_pressure: x.timer_pressure ?? false,
    camera: x.camera ?? 'follow',
    default_dial: x.default_dial ?? 'polished',
    default_band: x.default_band ?? 'normal',
    player_type: x.player_type ?? null,
    ...(x.guidance ? { guidance: x.guidance } : {}),
  };
}

export function worldOf(ink: InkDoc): { cell: 16; screens: number; w: number; h: 27 } {
  const screens = Math.min(WORLD.max_screens, Math.max(1, Math.round(ink.world.screens || 1)));
  return { cell: 16, screens, w: WORLD.screen_w * screens, h: 27 };
}

export function levelIdFor(ink: InkDoc): string {
  return 'lvl_' + hash8({ s: ink.strokes.map((s) => [s.id, s.color, s.pts.length, s.pts[0] ?? null]), w: ink.world.screens, p: ink.parent?.level_id ?? null });
}

/** Objects as stored in a level: internal hint keys removed. */
export function cleanObjects(objs: readonly SceneObject[]): SceneObject[] {
  return objs.map((o) => {
    const c: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('x_')) c[k] = v;
    return c as unknown as SceneObject;
  });
}

function bandOf(C: number): Band {
  return C < 0.05 ? 'trivial' : C < 0.3 ? 'easy' : C < 1 ? 'normal' : C < 3 ? 'hard' : 'expert';
}

export function designBlock(r: PlaytestReport | null, tier: Tier, w: Work, note: string | null, source: DesignBlock['source']): DesignBlock {
  const C = r ? Math.max(0, r.C) : 0;
  return {
    tier,
    band: r?.band ?? bandOf(C),
    C: Math.round(C * 1000) / 1000,
    score: Math.max(0, Math.min(100, Math.round(r?.score ?? 0))),
    fastest_ms: Math.round(r?.fastest_ms ?? 0),
    par_ms: Math.round(w.st.par_ms ?? r?.par_ms ?? 0),
    casual_clear_s: Math.round((r?.casual_clear_s ?? 0) * 10) / 10,
    segments: (r?.segments ?? []).map((s) => ({ from: s.from, to: s.to, E: s.E, T_ms: Math.round(s.T_ms), F_s: s.F_s, actions: s.actions })),
    flags: r?.flags ?? [],
    solvable: r?.solvable ?? false,
    reach: {},
    designer_note: note,
    source,
  };
}

export interface AssembleInput {
  ink: InkDoc;
  rules: GameRules;
  library: LibraryType[];
  parent: LevelV2 | null;
}

export function assembleLevel(a: AssembleInput, w: Work, comp: Compiled, edits: EditRecord[], report: PlaytestReport | null, tier: Tier, warnings: MessageRef[], note: string | null = null, source: DesignBlock['source'] = 'none'): LevelV2 {
  const ink = a.ink;
  const world = worldOf(ink);
  const libIds = new Set(w.objs.filter((o) => o.lib).map((o) => `${o.lib!.type_id}@${o.lib!.version}`));
  const level: LevelV2 = {
    format: 'dal-level',
    schema_version: 2,
    core_min: CORE_VERSION,
    id: levelIdFor(ink),
    version: 1,
    game_id: a.parent?.game_id ?? null,
    parent_id: a.parent?.id ?? ink.parent?.level_id ?? null,
    order_index: 0,
    title: (w.title ?? a.parent?.title ?? 'My level').slice(0, 80) || 'My level',
    author: '',
    created_at: PLACEHOLDER_TIME,
    license: 'CC-BY-4.0',
    world,
    rules: a.rules,
    source: { kind: ink.source, prompt: null, pack_id: null, sheets: (ink.sheets ?? []).map((s) => ({ index: s.index, photo_url: s.photo_url ?? null, qr: s.qr ?? null })) },
    ink: {
      strokes: ink.strokes, components: ink.components, character: ink.character ?? null, typed_rules: ink.typed_rules ?? [],
      rules_ink: ink.rules_ink ?? [], noise: ink.noise ?? { count: 0 },
    },
    objects: cleanObjects(w.objs),
    setpieces: w.setpieces,
    edits,
    compiled: { tiles: comp.tiles, entities: comp.entities, triggers: comp.triggers, sprites: { player: null, objects: {} } },
    design: designBlock(report, tier, w, note, source),
    embedded_library: a.library.filter((l) => libIds.has(`${l.id}@${l.version}`)),
    meta: { transcript: '', intent: w.intent ?? null, safety: w.safety ?? 'unchecked', level_hash: '', core_version: CORE_VERSION, warnings, build: null },
  };
  level.meta.level_hash = levelHash(level);
  return level;
}

/** A minimal level for sandbox analysis: gameplay blocks plus objects and setpieces (the bot names them). */
export function lightLevel(a: AssembleInput, comp: Compiled, w: Work | null = null): LevelV2 {
  const world = worldOf(a.ink);
  const level: LevelV2 = {
    format: 'dal-level', schema_version: 2, core_min: CORE_VERSION, id: 'sandbox', version: 1, title: 'sandbox', author: '',
    created_at: PLACEHOLDER_TIME, world, rules: a.rules, source: { kind: a.ink.source, sheets: [] },
    objects: w ? cleanObjects(w.objs) : [], setpieces: w ? w.setpieces : [],
    compiled: { tiles: comp.tiles, entities: comp.entities, triggers: comp.triggers, sprites: { player: null, objects: {} } },
    meta: { level_hash: '', core_version: CORE_VERSION },
  };
  level.meta.level_hash = levelHash(level);
  return level;
}
