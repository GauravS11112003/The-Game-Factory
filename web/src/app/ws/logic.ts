/**
 * Rules as cards (docs/v4/CONTRACTS_V4.md §2): a RuleV4 becomes "When you press space → flip gravity".
 * Sentences come from core.describeRule when lane A exports it (and its keys exist), else from the local fallback in
 * model.ts. Written rules go through core.parseLogic (offline keyword parser) or POST /logic/parse, whichever answers;
 * neither being there yet is a calm "not ready", never a crash.
 * Switching a game-wide rule off parks it on this device (RuleV4 has no "off" field yet) so it can come back.
 */
import * as core from '../../core/index.ts';
import type { GameMode, LogicParseBody, LogicParseResult, MessageRef, RuleV4 } from '../../core/types.gen.ts';
import { h, icon } from '../dom.ts';
import { hasMessage, t, tRef } from '../messages.ts';
import { v4 } from '../v4api.ts';
import { fallbackRuleParts, isMode } from './model.ts';
import { iconBtn, modeName } from './ui.ts';

// ---- the core, when lane A has exported these (looked up by name so the app builds either way) ------------------------

const CORE = core as unknown as Record<string, unknown>;

function coreFn<F>(name: string): F | null {
  const f = CORE[name];
  return typeof f === 'function' ? (f as F) : null;
}

type DescribeRule = (rule: RuleV4) => MessageRef[];
type ParseLogic = (sentences: string[], entityIds: string[]) => LogicParseResult;

/** One sentence per part of a rule. */
export function ruleParts(rule: RuleV4): MessageRef[] {
  const describe = coreFn<DescribeRule>('describeRule');
  if (describe) {
    try {
      const refs = describe(rule);
      if (Array.isArray(refs) && refs.length && refs.every((r) => r && typeof r.key === 'string' && hasMessage(r.key))) return refs;
    } catch {
      /* not implemented yet: the local sentences below */
    }
  }
  return fallbackRuleParts(rule);
}

export function ruleSentence(rule: RuleV4): string {
  return ruleParts(rule).map(tRef).join(', ');
}

function parseLocal(sentences: string[], entityIds: string[]): LogicParseResult | null {
  const parse = coreFn<ParseLogic>('parseLogic');
  if (!parse) return null;
  try {
    const r = parse(sentences, entityIds);
    return r && Array.isArray(r.rules) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Written rules → RuleV4[]. `prefer: 'server'` asks POST /logic/parse first (Claude when a key is set), then the core
 * parser; `'local'` the other way round (instant, for live cards while typing). Throws ApiError when neither answers.
 */
export async function parseRules(sentences: string[], o: { gameId?: string | null; entityIds?: string[]; prefer?: 'server' | 'local' } = {}): Promise<LogicParseResult> {
  const list = sentences.map((s) => s.trim()).filter(Boolean).slice(0, 12);
  if (!list.length) return { rules: [], mode: null, unknown: [], source: 'keywords' };
  const ids = o.entityIds ?? [];
  const server = (): Promise<LogicParseResult> =>
    v4.parseLogic({ sentences: list as LogicParseBody['sentences'], game_id: o.gameId ?? null, entity_ids: ids });
  if (o.prefer === 'local') {
    const local = parseLocal(list, ids);
    if (local) return local;
    return server();
  }
  try {
    return await server();
  } catch (e) {
    const local = parseLocal(list, ids);
    if (local) return local;
    throw e;
  }
}

// ---- cards -------------------------------------------------------------------------------------------------------------

export interface RuleCardOptions {
  /** Shown greyed, with "Switch on". */
  off?: boolean;
  onToggle?: () => void;
  onDelete?: () => void;
  /** Where it came from ("From the block Zappy"), shown small. */
  from?: string | null;
}

/** "When you press space" / "→ flip gravity" with optional switch and delete buttons. */
export function ruleCard(rule: RuleV4, o: RuleCardOptions = {}): HTMLElement {
  const [when, ...then] = ruleParts(rule);
  const text = [when, ...then].map(tRef);
  const actions = h('div', { class: 'w-rule-actions' },
    o.onToggle ? h('button', {
      type: 'button', class: 'w-btn small', 'aria-pressed': String(!o.off), onclick: o.onToggle,
    }, t(o.off ? 'gw.rule_switch_on' : 'gw.rule_switch_off')) : '',
    o.onDelete ? iconBtn('trash', t('gw.rule_delete'), o.onDelete) : '');
  return h('div', { class: `w-rule${o.off ? ' off' : ''}`, role: 'group', 'aria-label': text.join(', ') },
    h('div', { class: 'w-rule-body' },
      h('div', { class: 'w-rule-when' }, icon('flag'), h('span', null, text[0] ?? '')),
      ...text.slice(1).map((s) => h('div', { class: 'w-rule-do' }, h('span', { class: 'w-rule-arrow', 'aria-hidden': 'true' }, '→'), h('span', null, s))),
      h('div', { class: 'row wrap' },
        rule.once ? h('span', { class: 'w-chip plain' }, t('gw.rule.once')) : '',
        o.off ? h('span', { class: 'w-chip plain' }, t('gw.rule_off_here')) : '',
        o.from ? h('span', { class: 'small muted' }, o.from) : '')),
    o.onToggle || o.onDelete ? actions : '');
}

/** What a parse found besides rules: a game mode it heard, and the sentences it could not turn into rules. */
export function parseExtras(r: LogicParseResult, o: { onMode?: (m: GameMode) => void; unknownKey?: string } = {}): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (r.mode && isMode(r.mode)) {
    const m = r.mode;
    out.push(h('div', { class: 'w-rule-note' }, icon('star'), h('span', null, t('gw.rule_heard_mode', { mode: modeName(m) })),
      o.onMode ? h('button', { type: 'button', class: 'w-btn small', onclick: () => o.onMode?.(m) }, t('gw.rule_use_mode', { mode: modeName(m) })) : ''));
  }
  for (const u of r.unknown) {
    out.push(h('div', { class: 'w-rule-note unknown' }, icon('question'), h('span', null, t(o.unknownKey ?? 'gw.rule_unknown', { text: u }))));
  }
  return out;
}

// ---- live cards for typed sentences (the draw screen's Rules panel) ----------------------------------------------------

const cache = new Map<string, Promise<LogicParseResult | null>>();

/** One sentence parsed once per session (local parser first, then the server); null when neither is there. */
export function parseOne(text: string): Promise<LogicParseResult | null> {
  const key = text.trim().toLowerCase();
  const have = cache.get(key);
  if (have) return have;
  const p = parseRules([text], { prefer: 'local' }).catch(() => {
    cache.delete(key); // try again next time (the server may be back)
    return null;
  });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(key, p);
  return p;
}

/** Cards for each typed sentence, filled in as the parser answers. */
export function typedRuleCards(texts: string[], o: { onMode?: (m: GameMode) => void } = {}): HTMLElement {
  const box = h('div', { class: 'w-rule-cards', 'aria-live': 'polite' });
  if (!texts.length) return box;
  box.append(h('p', { class: 'small muted' }, t('studio4.rules_reading')));
  void Promise.all(texts.map((s) => parseOne(s))).then((results) => {
    const kids: HTMLElement[] = [];
    let any = false;
    results.forEach((r, i) => {
      if (!r) return;
      any = true;
      if (r.rules.length) for (const rule of r.rules) kids.push(ruleCard(rule));
      kids.push(...parseExtras({ ...r, unknown: r.rules.length || r.mode ? [] : [texts[i]] }, { onMode: o.onMode, unknownKey: 'studio4.rule_other' }));
    });
    if (!any) {
      box.replaceChildren(h('p', { class: 'small muted' }, t('studio4.rules_offline')));
      return;
    }
    box.replaceChildren(h('h4', { class: 'w-h4' }, t('studio4.rules_cards')), ...kids);
  });
  return box;
}

// ---- rules switched off on this device ---------------------------------------------------------------------------------

const PARK = 'dal.v4.parked.';

export const parked = {
  get(gameId: string): RuleV4[] {
    try {
      const v = JSON.parse(localStorage.getItem(PARK + gameId) ?? '[]') as RuleV4[];
      return Array.isArray(v) ? v.filter((r) => r && typeof r.id === 'string' && r.when && Array.isArray(r.then)) : [];
    } catch {
      return [];
    }
  },
  set(gameId: string, rules: RuleV4[]): void {
    try {
      if (rules.length) localStorage.setItem(PARK + gameId, JSON.stringify(rules));
      else localStorage.removeItem(PARK + gameId);
    } catch {
      /* storage off: the rule is simply gone for this session */
    }
  },
};
