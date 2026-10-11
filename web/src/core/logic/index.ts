/** v4 logic (lane A, docs/v4/CONTRACTS_V4.md §2.4-§5): the written-rules parser, rule cards and pickup rules. */
import { V4 } from '../params.ts';
import type { BPickup, LevelV2, LogicParseResult, RuleDo, RuleV4, SceneObject, TypedRule } from '../types.gen.ts';
import { parseLogic } from './parse.ts';

export { describeRule, LOGIC_MESSAGE_KEYS } from './describe.ts';
export { isLogicSentence, parseLogic, singular } from './parse.ts';
export type { ParseLogicOptions } from './parse.ts';

/** Sentences of one typed rule, split like the v2 rules parser does (an "@<component> " prefix is dropped). */
export function splitSentences(text: string): string[] {
  return String(text ?? '').slice(0, 600).split(/[.!?\n;]+/).map((s) => s.trim().replace(/^@\d+\s+/, '')).filter(Boolean);
}

const ROLE_NOUNS: Record<string, string[]> = {
  door: ['door', 'gate'], key: ['key'], spring: ['spring', 'trampoline'], enemy: ['monster', 'enemy', 'bad guy'], checkpoint: ['checkpoint'],
  goal: ['flag', 'goal', 'finish'], saw: ['saw'], big_coin: ['big coin'], start_marker: ['start'],
};
const BEHAVIOR_NOUNS: Record<string, string[]> = { portal: ['portal'], zone: ['zone'], npc: ['npc', 'friend', 'sign'] };

/**
 * What a written rule may name in a scene (§2.4): every object id, plus a noun for each role (or v4 primitive) that
 * exactly one object has ("door" → o7). The build and the v2 rules parser use the same table, so a sentence is
 * either logic in both or in neither.
 */
export function logicTargets(objects: readonly SceneObject[]): { ids: string[]; aliases: Record<string, string> } {
  const objs = objects.filter((o) => !o.rel?.part_of);
  const ids = objs.map((o) => o.id);
  const by = new Map<string, string[]>();
  const put = (noun: string, id: string): void => {
    const l = by.get(noun) ?? [];
    l.push(id);
    by.set(noun, l);
  };
  for (const o of objs) {
    for (const n of ROLE_NOUNS[o.role] ?? []) put(n, o.id);
    const b = o.behavior?.kind;
    if (b) for (const n of BEHAVIOR_NOUNS[b] ?? []) put(n, o.id);
    if (o.behavior?.kind === 'zone') put(o.behavior.effect.replace('_', ' '), o.id);
  }
  const aliases: Record<string, string> = {};
  for (const [n, l] of by) if (l.length === 1) aliases[n] = l[0];
  return { ids, aliases };
}

/** logicTargets for one typed rule: a rule typed while a stroke was selected (`target` component) names it "this". */
export function typedRuleTargets(objects: readonly SceneObject[], target?: number | null): { ids: string[]; aliases: Record<string, string> } {
  const t = logicTargets(objects);
  if (typeof target === 'number' && target > 0) {
    const objs = objects.filter((o) => !o.rel?.part_of);
    const o = objs.find((x) => x.id === `o${target}`) ?? objs.find((x) => x.components.includes(target));
    if (o) {
      t.aliases.this = o.id;
      t.aliases.that = o.id;
    }
  }
  return t;
}

/** Rules from typed rules (§2.4, offline): every sentence of every typed rule, ids r1, r2, … across all of them. */
export function typedRulesLogic(typed: readonly TypedRule[], objects: readonly SceneObject[]): LogicParseResult {
  const out: LogicParseResult = { rules: [], mode: null, unknown: [], source: 'keywords' };
  for (const tr of typed ?? []) {
    const sentences = splitSentences(tr?.text ?? '');
    if (!sentences.length) continue;
    const t = typedRuleTargets(objects, tr.target);
    const r = parseLogic(sentences, t.ids, { aliases: t.aliases });
    if (r.mode) out.mode = r.mode;
    out.unknown.push(...r.unknown);
    // ids run across typed rules (rules link by counter name, never by id)
    for (const rule of r.rules) out.rules.push({ ...rule, id: `r${out.rules.length + 1}` });
  }
  return out;
}

/** Ids of the rules compile writes for pickup effects (they come back from the behaviours on every build). */
export const PICKUP_RULE_PREFIX = 'pk_';

/**
 * A built level's own rules (typed or model-parsed, without the pickup rules), for rebuilding it with the same logic
 * (BuildInput.logic); null when it has none, so a rebuild parses its typed rules again.
 */
export function levelLogic(lv: LevelV2): RuleV4[] | null {
  const own = (lv.compiled?.logic ?? []).filter((r) => !r.id.startsWith(PICKUP_RULE_PREFIX));
  return own.length ? own : null;
}

/** The rule a pickup's ready-made effect compiles to (§5): {when: collect target, then: [effect action]}. */
export function pickupRule(id: string, b: BPickup): RuleV4 | null {
  const eff = b.effect ?? 'none';
  if (eff === 'none') return null;
  const s = b.seconds === undefined ? 5 : b.seconds;
  const E = V4.pickup_effects;
  let a: RuleDo;
  switch (eff) {
    case 'speed': a = s === null ? { kind: 'speed', times: E.speed } : { kind: 'speed', times: E.speed, seconds: s }; break;
    case 'jump': a = s === null ? { kind: 'jump_power', times: E.jump } : { kind: 'jump_power', times: E.jump, seconds: s }; break;
    case 'flip': a = { kind: 'flip_gravity' }; break;
    case 'heart': a = { kind: 'heal' }; break;
    case 'score': a = { kind: 'add_score', n: E.score }; break;
    case 'freeze': a = { kind: 'freeze_enemies', seconds: s ?? 5 }; break;
    case 'low_gravity': a = s === null ? { kind: 'gravity', times: E.low_gravity } : { kind: 'gravity', times: E.low_gravity, seconds: s }; break;
    default: return null;
  }
  return { id: `${PICKUP_RULE_PREFIX}${id.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 40), when: { kind: 'collect', target: id }, then: [a] };
}
