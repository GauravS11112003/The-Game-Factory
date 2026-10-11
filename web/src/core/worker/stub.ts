/// <reference types="node" />
/**
 * Canned worker results for DAL_CORE_STUB=1 (P0): contract-valid fixtures built from the §2.2 example level
 * (shared/spec/conformance/levels/valid/example_2screen.json), so lanes C, D and F can integrate before the
 * real core exists. level_hash is always real.
 */
import { readFileSync } from 'node:fs';
import type {
  BuildResultJson, Candidate, InkDoc, LevelPlan, LevelV2, PlaytestReport, RunVerdict, SceneGraph, TierSetJson, Tier,
  WorkerMethod,
} from '../types.gen.ts';
import { levelHash } from '../build/hash.ts';
import { CORE_VERSION } from '../util/version.ts';

const EXAMPLE_URL = new URL('../../../../shared/spec/conformance/levels/valid/example_2screen.json', import.meta.url);

let cachedLevel: LevelV2 | null = null;
export function exampleLevel(): LevelV2 {
  cachedLevel ??= JSON.parse(readFileSync(EXAMPLE_URL, 'utf8')) as LevelV2;
  return structuredClone(cachedLevel);
}

export function exampleInk(): InkDoc {
  const lv = exampleLevel();
  const ink = lv.ink!;
  return {
    v: 2, source: 'canvas', world: { screens: lv.world.screens, w: lv.world.w, h: 27 },
    strokes: ink.strokes, components: ink.components, character: ink.character ?? null,
    typed_rules: ink.typed_rules ?? [], rules_ink: ink.rules_ink ?? [],
    sheets: (lv.source.sheets ?? []).map((s) => ({ index: s.index, photo_url: s.photo_url ?? null, qr: s.qr ?? null, warnings: [] })),
    noise: ink.noise ?? { count: 0 }, parent: null,
  };
}

export function exampleGraph(): SceneGraph {
  const lv = exampleLevel();
  return {
    objects: lv.objects ?? [], setpieces: lv.setpieces ?? [], intent: lv.meta.intent ?? null, difficulty_wish: 'none',
    title: lv.title, safety: 'ok',
  };
}

export function exampleReport(level: LevelV2 = exampleLevel()): PlaytestReport {
  const d = level.design!;
  return {
    solvable: true, reason: null, frontier: null,
    route: [
      { i: 0, kind: 'runjump', from: [28.0, 22.0], to: [37.0, 22.0], frames: 41, w_f: 14.5, h_f: 22, phi_f: null, lethal: 1,
        p_death_casual: 0.02, p_death_skilled: 0.0, blind: false, segment: 'seg0', setpiece: null },
      { i: 1, kind: 'jump', from: [50.0, 22.0], to: [57.0, 22.0], frames: 33, w_f: 9.0, h_f: 12, phi_f: 30, lethal: 1,
        p_death_casual: 0.12, p_death_skilled: 0.01, blind: false, segment: 'seg1', setpiece: 'the spike hop' },
    ],
    segments: d.segments.map((s, i) => ({ id: `seg${i}`, from: s.from, to: s.to, E: s.E, A: 1 / (1 - Math.min(s.E, 0.9)), T_ms: s.T_ms, F_s: s.F_s, actions: s.actions })),
    C: d.C, F: d.segments.reduce((a, s) => a + s.F_s, 0), score: d.score, band: d.band, C_skilled: 0.03,
    fastest_ms: d.fastest_ms, par_ms: d.par_ms, casual_clear_s: d.casual_clear_s, flags: [],
    reachable: ['o1:2.00', 'o2:36.00', 'o3:40.00'], setpiece_order: ['the spike hop'],
    slots: {
      checkpoint: [{ id: 'slot.cp.3', x: 48, y: 22, host: 'o2', face: 'top', segment: 'seg0', tags: [] }],
      coin: [], risk: [{ id: 'slot.risk.2', x: 43.5, y: 14.5, host: 'o3', face: 'top', segment: 'seg1', tags: ['big_coin'] }],
      enemy: [{ id: 'slot.enemy.7', x: 80, y: 22, host: 'o2', face: 'top', x0: 74, x1: 88, segment: 'seg1', tags: ['flat'] }],
      hazard: [], spikes: [], step: [], spring: [], hint: [],
    },
    engaged_enemies: 1, actions_per_screen: 7.5, trace: [120, 2, 14, 6, 30, 2], level_hash: levelHash(level),
    core_version: CORE_VERSION, approx: false,
  };
}

export function exampleMenu(): Candidate[] {
  return [
    { cid: 'add_checkpoint:slot.cp.3:44aa01', generator: 'checkpoint', op: { op: 'add_checkpoint', slot: 'slot.cp.3' }, extra_ops: [],
      tiers: ['polished', 'normal', 'hard'], alts: null, summary_key: 'polish.checkpoint', summary_args: { seconds: 9 },
      dC: 0, dT_s: 0, dF_s: -3.2, drift: 0, intent_cost: 0.5, fixes: [], measured: true },
    { cid: 'animate:o5:1a2b3c', generator: 'animate', op: { op: 'animate', target: 'o5', archetype: 'walker' }, extra_ops: [],
      tiers: ['polished', 'normal', 'hard'], alts: null, summary_key: 'polish.monster_walks', summary_args: {},
      dC: 0.06, dT_s: 0.4, dF_s: 0.3, drift: 0, intent_cost: 0.5, fixes: [], measured: true },
    { cid: 'add_enemy:slot.enemy.7:5e6f70', generator: 'guard_flat', op: { op: 'add_enemy', slot: 'slot.enemy.7', archetype: 'walker' },
      extra_ops: [], tiers: ['normal', 'hard'], alts: null, summary_key: 'challenge.add_enemy', summary_args: { what: 'walker' },
      dC: 0.12, dT_s: 0.8, dF_s: 0.9, drift: 0, intent_cost: 1.0, fixes: [], measured: true },
  ];
}

export function exampleBuild(tier: Tier = 'polished'): BuildResultJson {
  const level = exampleLevel();
  if (level.design) level.design.tier = tier;
  return { graph: exampleGraph(), level, report: exampleReport(level), edits: level.edits ?? [], rejected: [], ms: 1 };
}

export function exampleTiers(): TierSetJson {
  return {
    faithful: exampleBuild('faithful'), polished: exampleBuild('polished'), normal: exampleBuild('normal'), hard: exampleBuild('hard'),
    reach: { polished: true, normal: true, hard: true }, why: null, menu: exampleMenu(),
  };
}

const EXAMPLE_PLAN: LevelPlan = {
  title: 'Lava Key Cave', theme: 'sketchbook', screens: 2, band: 'normal', kid_summary: 'Find the key, then hop over the lava.',
  safety_ok: true,
  sections: [
    { role: 'teach', beats: [{ kind: 'flat', length: 8, enemy: 'none', coins: 3, spikes: 'none' }, { kind: 'gap', width: 3, floor: 'lava' }] },
    { role: 'test', beats: [{ kind: 'key', place: 'high' }, { kind: 'checkpoint' }, { kind: 'gap', width: 5, floor: 'lava' }] },
    { role: 'finale', beats: [{ kind: 'door' }, { kind: 'goal', style: 'flag' }] },
  ],
};

const VERDICT: RunVerdict = { finished: true, frames: 907, time_ms: 15117, deaths: 0, coins: 1, big_coins: 1, stamps: ['clear', 'flawless'] };

export function stubResult(method: WorkerMethod, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'ping':
      return { core_version: CORE_VERSION, node: `node ${process.version}`, stub: true };
    case 'perceive_heuristic':
      return { graph: exampleGraph() };
    case 'merge_perception': {
      const lv = exampleLevel();
      return { edits: (lv.edits ?? []).filter((e) => e.class === 'U'), asks: [], setpieces: lv.setpieces ?? [], dropped: [], discarded: false };
    }
    case 'parse_rules':
      return { edits: [], asks: [] };
    case 'build':
      return exampleBuild(((params.tier as Tier | undefined) ?? 'faithful'));
    case 'build_tiers':
      return exampleTiers();
    case 'apply_plan':
      return { ...exampleTiers(), rejected: [] };
    case 'transfer_plan':
      return { plan: params.plan, ratio: 1, routeRolesChanged: false };
    case 'digest':
      return {
        graph_digest: 'o1 ground 0-30 | o2 ground 36-96 | o3 platform one-way 40-47 r17 | o4 spikes on o2 top 52-56 | o5 enemy static on o2 | o9 goal 91',
        level_digest: 'route: runjump 28→37 (w 14.5f) · jump over o4 (w 9f, p 0.12) | segments: seg0 E0.02 T7.3s, seg1 E0.12 T7.8s | flags: none',
        menu_rows: exampleMenu().map((c) => `${c.cid} · ${c.summary_key} · ${c.tiers[0]} · dC ${c.dC} · cost ${c.intent_cost}`).join('\n'),
      };
    case 'analyze':
      return { report: exampleReport() };
    case 'layout_plan':
      return { ink: exampleInk() };
    case 'keyword_plan':
      return { plan: EXAMPLE_PLAN };
    case 'remix_diff':
      return { matched: {}, added: [] };
    case 'migrate_v1':
      return { level: exampleLevel() };
    case 'verify_run':
      return VERDICT;
    case 'level_hash':
      return { hash: levelHash(params.level as LevelV2) };
    case 'art_svg':
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 432"><rect width="768" height="432" fill="#FBF6EA"/></svg>' };
    case 'generate_level':
      return { plan: EXAMPLE_PLAN, ink: exampleInk(), graph0: { objects: [] }, result: exampleBuild('faithful'), solvable: true, fixes: [], frontier_text: null, dropped: [], spans: [] };
    case 'rules_check':
      return { affected: [] };
    case 'library_check':
      return { updated: [], broken: [] };
    case 'parse_logic':
      return {
        rules: [{ id: 'r1', when: { kind: 'key', key: 'space' }, then: [{ kind: 'flip_gravity' }] }], mode: null,
        unknown: (Array.isArray(params.sentences) ? (params.sentences as unknown[]).map(String) : []).slice(1), source: 'keywords',
      };
  }
}
