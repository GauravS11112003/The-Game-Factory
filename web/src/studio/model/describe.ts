/**
 * Plain-language sentences (docs/v6/CONTRACTS_V6.md §6): what a copilot edit changed ("Car can now: Drive"), what a
 * rule says ("When it touches an enemy → lose") and what a behaviour does. No code words reach the maker; every
 * sentence template is in shared/spec/messages-v6/editor.json (studio.*).
 */
import type { StudioEdit, StudioTheme } from '../../core/types.gen.ts';
import { t } from '../../app/messages.ts';
import { ACTIONS, BEHAVIORS, EVENTS, withDefaults } from './catalog.ts';
import { displayName, sceneOf } from './doc.ts';
import type { SDoc, SObj, SRule } from './types.ts';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const article = (w: string): string => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const fmt = (n: unknown): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n ?? '');
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
};
export const OP_TEXT: Record<string, string> = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠', '>': '>', '<': '<' };

/** Who an object id / tag / keyword refers to, in words ("this", "the player", "an enemy", "Car"). */
export function targetText(v: unknown, doc: SDoc | null, sceneId?: string): string {
  const s = typeof v === 'string' ? v : '';
  switch (s) {
    case '': return t('studio.tgt.none');
    case 'self': return t('studio.tgt.self');
    case 'other': return t('studio.tgt.other');
    case 'player': return t('studio.tgt.player');
    case 'player1': return t('studio.tgt.player1');
    case 'player2': return t('studio.tgt.player2');
    case 'any': return t('studio.tgt.any');
    case 'game': return t('studio.tgt.game');
    case 'default': return t('studio.tgt.default');
    default: {
      const o = doc ? objectAnywhere(doc, s, sceneId) : undefined;
      if (o) return displayName(o);
      return t('studio.tgt.tag', { article: article(s), tag: s });
    }
  }
}

/** Possessive form for counters ("its", "the game's", "Car's"). */
export function whoseText(v: unknown, doc: SDoc | null, sceneId?: string): string {
  const s = typeof v === 'string' ? v : 'self';
  if (s === 'self' || s === '') return t('studio.whose.self');
  if (s === 'game') return t('studio.whose.game');
  if (s === 'other') return t('studio.whose.other');
  if (s === 'player' || s === 'player1' || s === 'player2') return t('studio.whose.named', { name: targetText(s, doc, sceneId) });
  const o = doc ? objectAnywhere(doc, s, sceneId) : undefined;
  return t('studio.whose.named', { name: o ? displayName(o) : s });
}

function objectAnywhere(doc: SDoc, id: string, sceneId?: string): SObj | undefined {
  const first = sceneId ? sceneOf(doc, sceneId).objects.find((o) => o.id === id) : undefined;
  if (first) return first;
  for (const sc of doc.scenes) {
    const o = sc.objects.find((x) => x.id === id);
    if (o) return o;
  }
  return undefined;
}

const keyText = (k: unknown): string => t(`studio.key.${String(k)}`);

/** "When it bumps into an enemy" */
export function eventText(ev: { type: string; params?: Record<string, unknown> }, doc: SDoc | null, sceneId?: string): string {
  const p = withDefaults(EVENTS.get(ev.type), ev.params ?? {});
  const args: Record<string, unknown> = {
    with: targetText(p.with, doc, sceneId), key: p.key === undefined ? '' : keyText(p.key), seconds: fmt(p.seconds), tag: String(p.tag ?? ''),
    whose: whoseText(p.subject, doc, sceneId), counter: String(p.counter ?? ''), op: OP_TEXT[String(p.op)] ?? String(p.op ?? ''), value: fmt(p.value),
  };
  const key = `studio.ev.${ev.type}`;
  return EVENTS.has(ev.type) ? t(key, args) : t('studio.ev.unknown');
}

/** "win the game", "add 1 to the game's score" */
export function actionText(a: { type: string; params?: Record<string, unknown> }, doc: SDoc | null, sceneId?: string): string {
  if (!ACTIONS.has(a.type)) return t('studio.act.unknown');
  const p = withDefaults(ACTIONS.get(a.type), a.params ?? {});
  const tg = (k: string): string => targetText(p[k], doc, sceneId);
  const amount = typeof p.amount === 'number' ? p.amount : 1;
  switch (a.type) {
    case 'add':
      return t(amount < 0 ? 'studio.act.add_neg' : 'studio.act.add', { amount: fmt(Math.abs(amount)), whose: whoseText(p.subject, doc, sceneId), counter: String(p.counter) });
    case 'set': return t('studio.act.set', { whose: whoseText(p.subject, doc, sceneId), counter: String(p.counter), value: fmt(p.value) });
    case 'give': return t('studio.act.give', { amount: fmt(amount), item: String(p.item), to: tg('to') });
    case 'take': return t('studio.act.take', { amount: fmt(amount), item: String(p.item), from: tg('from') });
    case 'solid': return t(p.on === false ? 'studio.act.solid_off' : 'studio.act.solid', { target: tg('target') });
    case 'enable': return t(p.on === false ? 'studio.act.enable_off' : 'studio.act.enable', { target: tg('target'), behavior: behaviorWord(String(p.behavior ?? '')) });
    case 'spawn': return t(Number(p.count) > 1 ? 'studio.act.spawn_many' : 'studio.act.spawn', { count: fmt(p.count), template: targetText(p.template, doc, sceneId), at: tg('at') });
    case 'sound': return t('studio.act.sound', { name: t(`studio.sound.${String(p.name)}`) });
    case 'go_scene': {
      const sc = doc?.scenes.find((s) => s.id === p.scene);
      return sc || p.scene ? t('studio.act.go_scene', { scene: sc?.name ?? String(p.scene) }) : t('studio.act.go_scene_any');
    }
    default:
      return t(`studio.act.${a.type}`, {
        target: tg('target'), to: tg('to'), amount: fmt(amount), x: fmt(p.x), y: fmt(p.y), scale: fmt(p.scale), seconds: fmt(p.seconds), text: String(p.text ?? ''),
      });
  }
}

function behaviorWord(v: string): string {
  const e = BEHAVIORS.get(v);
  return e ? e.label.toLowerCase() : v || t('studio.tgt.none');
}

export function conditionText(c: { subject?: string; counter: string; op?: string; value?: number }, doc: SDoc | null, sceneId?: string): string {
  return t('studio.cond', { whose: whoseText(c.subject ?? 'self', doc, sceneId), counter: c.counter, op: OP_TEXT[c.op ?? '>='] ?? c.op, value: fmt(c.value ?? 0) });
}

/** "When it touches an enemy, if its coins ≥ 3 → win the game" */
export function ruleText(r: Pick<SRule, 'when' | 'conditions' | 'then'>, doc: SDoc | null, sceneId?: string): string {
  const when = eventText(r.when, doc, sceneId);
  const conds = (r.conditions ?? []).map((c) => conditionText(c, doc, sceneId));
  const then = (r.then ?? []).map((a) => actionText(a, doc, sceneId)).join(t('studio.rule.then_join'));
  return conds.length ? t('studio.rule.sentence_if', { when, conds: conds.join(t('studio.rule.and_join')), then }) : t('studio.rule.sentence', { when, then });
}

/** "Run and jump (jump power 900)": the label plus up to three params that differ from the catalog defaults. */
export function behaviorText(b: { type: string; params?: Record<string, unknown> }): string {
  const e = BEHAVIORS.get(b.type);
  if (!e) return b.type;
  const changed = e.params.filter((p) => b.params && p.name in b.params && JSON.stringify(b.params[p.name]) !== JSON.stringify(p.default)).slice(0, 3)
    .map((p) => `${(p.label ?? p.name).replace(/\s*\(.*\)$/, '').toLowerCase()} ${paramValueText(b.params![p.name])}`);
  return changed.length ? `${e.label} (${changed.join(', ')})` : e.label;
}

function paramValueText(v: unknown): string {
  if (typeof v === 'boolean') return v ? t('studio.yes') : t('studio.no');
  if (Array.isArray(v)) return v.map(fmt).join(', ');
  return fmt(v);
}

function countersText(c: unknown): string {
  if (!isObj(c)) return '';
  return Object.entries(c).map(([k, v]) => (v === null ? t('studio.counter.removed', { counter: k }) : t('studio.counter.value', { value: fmt(v), counter: k }))).join(', ');
}

const FIELD_WORD: Record<string, string> = {
  name: 'name', kind: 'kind', x: 'place', y: 'place', rotation: 'turn', scale: 'size', layer: 'layer', physics: 'body', behaviors: 'behaviours',
  rules: 'rules', counters: 'items', tags: 'tags', joints: 'joints', template: 'template', hidden: 'visibility', player: 'controls', drawing: 'box',
  gravity: 'gravity', camera: 'camera', edges: 'edges', width: 'size', height: 'size', players: 'players',
};

function fieldsText(data: Record<string, unknown>): string {
  const words: string[] = [];
  for (const k of Object.keys(data)) {
    const w = FIELD_WORD[k];
    if (w && !words.includes(w)) words.push(w);
  }
  return words.map((w) => t(`studio.field.${w}`)).join(', ');
}

/** One sentence per edit, for the "Changed N things" list. `before` names objects that an edit removed. */
export function describeEdit(e: StudioEdit, after: SDoc, before: SDoc | null, sceneId: string, themes: StudioTheme[] = []): string {
  const data = isObj(e.data) ? e.data : {};
  const sid = e.scene ?? sceneId;
  const objName = (id: unknown): string => {
    const s = typeof id === 'string' ? id : '';
    const o = objectAnywhere(after, s, sid) ?? (before ? objectAnywhere(before, s, sid) : undefined);
    return o ? displayName(o) : s || t('studio.tgt.none');
  };
  const behLabel = (): string => {
    const o = objectAnywhere(before ?? after, String(e.target ?? ''), sid) ?? objectAnywhere(after, String(e.target ?? ''), sid);
    const b = o?.behaviors.find((x) => x.id === data.id) ?? o?.behaviors.find((x) => x.type === data.type);
    const type = typeof data.type === 'string' ? data.type : b?.type ?? '';
    return BEHAVIORS.get(type)?.label ?? type;
  };
  const owner = (): string => {
    if (!e.target || e.target === '@game') return t('studio.owner.game');
    if (e.target === '@scene') return t('studio.owner.scene');
    return objName(e.target);
  };
  switch (e.action) {
    case 'set_world': {
      if (typeof data.kind === 'string' && data.kind) return t('studio.edit.world_kind', { kind: data.kind });
      const g = data.gravity;
      if (Array.isArray(g) && g[0] === 0 && g[1] === 0 && Object.keys(data).length === 1) return t('studio.edit.gravity_off');
      return t('studio.edit.world', { fields: fieldsText(data) || t('studio.field.settings') });
    }
    case 'set_theme': {
      if (typeof data.preset === 'string') {
        const th = themes.find((x) => x.id === data.preset);
        return t('studio.edit.theme_preset', { name: th?.name ?? data.preset });
      }
      return typeof data.name === 'string' ? t('studio.edit.theme_preset', { name: data.name }) : t('studio.edit.theme');
    }
    case 'set_hud': {
      const items = Array.isArray(data.items) ? data.items.filter(isObj).map((i) => String(i.label || i.counter)) : [];
      return items.length ? t('studio.edit.hud', { items: items.join(', ') }) : t('studio.edit.hud_clear');
    }
    case 'set_title': return t('studio.edit.title', { title: String(data.title ?? '') });
    case 'add_scene': return t('studio.edit.add_scene', { name: String(data.name ?? '') || t('studio.scene.new') });
    case 'update_object': {
      const existed = before ? !!objectAnywhere(before, String(e.target ?? ''), sid) : true;
      if (!existed) return t('studio.edit.create', { name: objName(e.target) });
      const keys = Object.keys(data);
      if (keys.length && keys.every((k) => k === 'kind' || k === 'name') && typeof data.kind === 'string') return t('studio.edit.is_now', { name: objName(e.target), kind: data.kind });
      if (typeof data.kind === 'string' && data.kind !== 'thing') return t('studio.edit.acts_like', { name: objName(e.target), kind: data.kind });
      return t('studio.edit.update', { name: objName(e.target), fields: fieldsText(data) || t('studio.field.settings') });
    }
    case 'delete_object': return t('studio.edit.delete', { name: objName(e.target) });
    case 'duplicate_object': {
      const n = typeof data.count === 'number' ? Math.max(1, Math.round(data.count)) : 1;
      return t(n > 1 ? 'studio.edit.duplicate_many' : 'studio.edit.duplicate', { count: n, name: objName(e.target) });
    }
    case 'add_behavior': return t('studio.edit.add_behavior', { name: objName(e.target), label: behLabel() });
    case 'update_behavior':
      if (data.off === true) return t('studio.edit.behavior_off', { name: objName(e.target), label: behLabel() });
      if (data.off === false) return t('studio.edit.behavior_on', { name: objName(e.target), label: behLabel() });
      return t('studio.edit.update_behavior', { name: objName(e.target), label: behLabel() });
    case 'remove_behavior': return t('studio.edit.remove_behavior', { name: objName(e.target), label: behLabel() });
    case 'add_rule': {
      const when = isObj(data.when) ? (data.when as { type: string; params?: Record<string, unknown> }) : { type: 'start' };
      const rule = { when, conditions: Array.isArray(data.conditions) ? data.conditions : [], then: Array.isArray(data.then) ? data.then : [] } as SRule;
      return t('studio.edit.add_rule', { owner: owner(), rule: ruleText(rule, after, sid) });
    }
    case 'update_rule': return t('studio.edit.update_rule', { owner: owner() });
    case 'remove_rule': return t('studio.edit.remove_rule', { owner: owner() });
    case 'add_joint': return t(`studio.edit.joint_${['wheel', 'hinge', 'rope', 'weld', 'spring'].includes(String(data.type)) ? String(data.type) : 'weld'}`, { name: objName(e.target), to: objName(data.to) });
    case 'set_counters': return t('studio.edit.counters', { name: objName(e.target), list: countersText(data.counters) });
    case 'set_game_counters': return t('studio.edit.game_counters', { list: countersText(data.counters) });
    case 'ask_draw': return t('studio.edit.ask_draw', { prompt: String(data.prompt ?? '') });
    default: return t('studio.edit.unknown');
  }
}

export function describeEdits(edits: StudioEdit[], after: SDoc, before: SDoc | null, sceneId: string, themes: StudioTheme[] = []): string[] {
  return edits.map((e) => describeEdit(e, after, before, sceneId, themes));
}
