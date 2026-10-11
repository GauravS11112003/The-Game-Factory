/**
 * Rule cards (docs/v6/CONTRACTS_V6.md §6): "When [it touches ▾] [an enemy ▾] if [its ▾ coins ≥ 3] → [Win ▾]".
 * Every chip is a dropdown from the catalog; + condition, + action, only once, on/off, delete. The maker's own words
 * (rule.text) sit above the sentence. All changes are update_rule / add_rule / remove_rule edits.
 */
import type { ActionDef, Condition, StudioEdit } from '../../core/types.gen.ts';
import { h } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import { ACTIONS, CATALOG, EVENTS, withDefaults, type ParamSpec } from '../model/catalog.ts';
import { OP_TEXT, ruleText, targetText, whoseText } from '../model/describe.ts';
import { allCounters } from '../model/doc.ts';
import type { SRule } from '../model/types.ts';
import { sicon } from './icons.ts';
import { optionText, paramControl, paramLabel, targetItems, templateItems, type ParamCtx } from './params.ts';
import { menu, popover, toggle, type MenuItem } from './ui.ts';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fmt = (n: unknown): string => (typeof n === 'number' ? String(Math.round(n * 100) / 100) : String(n ?? ''));

/** A sensible first action for a new rule, by event and scope. */
export function defaultAction(event: string, onObject: boolean): ActionDef {
  switch (event) {
    case 'start': return { type: 'say', params: { text: 'Go!', target: onObject ? 'self' : 'player', seconds: 2.5 } };
    case 'key_down': return { type: 'impulse', params: { target: onObject ? 'self' : 'player', x: 0, y: -600 } };
    case 'collide': case 'overlap': case 'timer': case 'every': case 'destroyed':
      return { type: 'add', params: { subject: 'game', counter: 'score', amount: 1 } };
    case 'counter': case 'all_gone': return { type: 'win', params: {} };
    case 'health_zero': case 'out_of_bounds': return { type: 'lose', params: {} };
    case 'clicked': return { type: 'destroy', params: { target: 'self' } };
    default: return { type: 'say', params: { text: 'Hi!', target: onObject ? 'self' : 'player', seconds: 2.5 } };
  }
}

/** The "+ Add rule" button: pick an event, get a rule with a starter action. */
export function addRuleButton(ctx: ParamCtx, owner: string): HTMLElement {
  const b = h('button', { type: 'button', class: 'st-add' }, sicon('plus'), t('studio.rules.add'));
  const onObject = owner !== '@game' && owner !== '@scene';
  b.onclick = () => menu(b, CATALOG.events
    .filter((e) => onObject || !['collide', 'overlap', 'leave', 'clicked', 'health_zero', 'destroyed', 'spawned', 'out_of_bounds'].includes(e.type))
    .map((e) => ({ label: e.label, onPick: () => ctx.studio.apply([{ action: 'add_rule', target: owner, data: { when: { type: e.type }, then: [defaultAction(e.type, onObject)] } }], { label: 'rule' }) })),
  { title: t('studio.rules.pick_event') });
  return b;
}

export function rulesList(ctx: ParamCtx, owner: string, rules: SRule[]): HTMLElement {
  const list = h('div', { class: 'st-rules' });
  if (!rules.length) list.append(h('p', { class: 'st-empty-note' }, t(owner === '@game' ? 'studio.rules.empty_game' : owner === '@scene' ? 'studio.rules.empty_scene' : 'studio.rules.empty')));
  for (const r of rules) list.append(ruleCard(ctx, owner, r));
  return list;
}

function ruleCard(ctx: ParamCtx, owner: string, r: SRule): HTMLElement {
  const s = ctx.studio;
  const upd = (data: Record<string, unknown>, o: { coalesce?: string; quiet?: boolean } = {}): void => {
    s.apply([{ action: 'update_rule', target: owner, data: { id: r.id, ...data } } as StudioEdit], { label: 'rule', ...o });
  };
  const evEntry = EVENTS.get(r.when.type);
  const evParams = withDefaults(evEntry, r.when.params);
  const onObject = owner !== '@game' && owner !== '@scene';
  const evCtx: ParamCtx = { ...ctx, allowAny: true };

  // when …
  const evChip = chip(evEntry?.label ?? r.when.type, 'event', (el) => menu(el, CATALOG.events.map((e) => ({
    label: e.label, on: e.type === r.when.type,
    onPick: () => upd({ when: { type: e.type, params: {} } }),
  }))));
  const whenRow = h('div', { class: 'st-rule-line' }, h('span', { class: 'st-rule-kw' }, t('studio.rules.when')), evChip,
    ...(evEntry?.params ?? []).map((p) => paramChip(p, evParams[p.name], evCtx, (v, done) => upd({ when: { type: r.when.type, params: { ...r.when.params, [p.name]: v } } }, done ? {} : { coalesce: `rule:${r.id}:ev:${p.name}`, quiet: true }))));

  // if …
  const condRows = r.conditions.map((c, i) => {
    const setC = (patch: Partial<Condition>, done = true): void => upd({ conditions: r.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)) }, done ? {} : { coalesce: `rule:${r.id}:c${i}`, quiet: true });
    const subj = chip(cap(whoseText(c.subject ?? 'self', s.doc, s.sceneId)), 'who', (el) => menu(el, [
      ...(onObject ? [{ label: cap(whoseText('self', s.doc)), on: c.subject === 'self', onPick: () => setC({ subject: 'self' }) }] : []),
      { label: cap(whoseText('game', s.doc)), on: c.subject === 'game', onPick: () => setC({ subject: 'game' }) },
      ...(onObject ? [{ label: cap(whoseText('other', s.doc)), on: c.subject === 'other', onPick: () => setC({ subject: 'other' }) }] : []),
      ...targetItems(ctx, c.subject, (v) => setC({ subject: v }), { keywords: false }).filter((x) => !x.icon),
    ], { search: s.scene.objects.length > 6 }));
    const counter = paramChip({ name: 'counter', type: 'counter', default: 'coins' }, c.counter, ctx, (v, done) => setC({ counter: String(v || 'coins') }, done));
    const op = chip(OP_TEXT[c.op ?? '>='] ?? '≥', 'op', (el) => menu(el, (['>=', '<=', '==', '!=', '>', '<'] as const).map((o) => ({ label: `${OP_TEXT[o]}  ${t(`studio.op.${opKey(o)}`)}`, on: c.op === o, onPick: () => setC({ op: o }) }))));
    const val = paramChip({ name: 'value', type: 'number', default: 0 }, c.value ?? 0, ctx, (v, done) => setC({ value: Number(v) }, done), true);
    return h('div', { class: 'st-rule-line' }, h('span', { class: 'st-rule-kw' }, i === 0 ? t('studio.rules.if') : t('studio.rules.and')), subj, counter, op, val,
      h('button', { type: 'button', class: 'st-x', title: t('studio.rules.remove_condition'), 'aria-label': t('studio.rules.remove_condition'), onclick: () => upd({ conditions: r.conditions.filter((_, j) => j !== i) }) }, sicon('close')));
  });

  // then …
  const actRows = r.then.map((a, i) => {
    const entry = ACTIONS.get(a.type);
    const params = withDefaults(entry, a.params);
    const setA = (next: ActionDef, done = true): void => upd({ then: r.then.map((x, j) => (j === i ? next : x)) }, done ? {} : { coalesce: `rule:${r.id}:a${i}`, quiet: true });
    const aChip = chip(entry?.label ?? a.type, 'action', (el) => menu(el, actionItems((type) => setA({ type, params: {} }), a.type), { search: true }));
    const actCtx: ParamCtx = { ...ctx, allowGame: true };
    return h('div', { class: 'st-rule-line' }, h('span', { class: 'st-rule-kw' }, i === 0 ? '→' : t('studio.rules.then')), aChip,
      ...(entry?.params ?? []).map((p) => paramChip(p, params[p.name], actCtx, (v, done) => setA({ type: a.type, params: { ...a.params, [p.name]: v } }, done))),
      r.then.length > 1 ? h('button', { type: 'button', class: 'st-x', title: t('studio.rules.remove_action'), 'aria-label': t('studio.rules.remove_action'), onclick: () => upd({ then: r.then.filter((_, j) => j !== i) }) }, sicon('close')) : null);
  });

  const addCond = h('button', { type: 'button', class: 'st-link', disabled: r.conditions.length >= 4 }, sicon('plus'), t('studio.rules.add_condition'));
  addCond.onclick = () => {
    const counters = allCounters(s.doc);
    upd({ conditions: [...r.conditions, { subject: onObject ? 'self' : 'game', counter: counters.includes('coins') ? 'coins' : counters[0] ?? 'coins', op: '>=', value: 1 }] });
  };
  const addAct = h('button', { type: 'button', class: 'st-link', disabled: r.then.length >= 8 }, sicon('plus'), t('studio.rules.add_action'));
  addAct.onclick = () => menu(addAct, actionItems((type) => upd({ then: [...r.then, { type, params: {} }] })), { search: true });

  const on = r.off !== true;
  const card = h('div', { class: `st-rule${on ? '' : ' off'}`, 'aria-label': ruleText(r, s.doc, s.sceneId) },
    r.text ? h('p', { class: 'st-rule-text' }, `“${r.text}”`) : null,
    whenRow, ...condRows, ...actRows,
    h('div', { class: 'st-rule-foot' }, addCond, addAct, h('span', { class: 'st-grow' }),
      h('label', { class: 'st-mini' }, toggle(r.once, (v) => upd({ once: v }), t('studio.rules.once')), t('studio.rules.once')),
      h('label', { class: 'st-mini' }, toggle(on, (v) => upd({ off: !v }), t('studio.rules.on')), t('studio.rules.on')),
      h('button', { type: 'button', class: 'st-ibtn danger', title: t('studio.rules.delete'), 'aria-label': t('studio.rules.delete'), onclick: () => s.apply([{ action: 'remove_rule', target: owner, data: { id: r.id } }], { label: 'rule' }) }, sicon('trash'))));
  return card;
}

function opKey(o: string): string {
  return ({ '>=': 'gte', '<=': 'lte', '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt' } as Record<string, string>)[o] ?? 'gte';
}

function actionItems(pick: (type: string) => void, current?: string): MenuItem[] {
  return CATALOG.actions.map((a) => ({ label: a.label, on: a.type === current, onPick: () => pick(a.type) }));
}

function chip(label: string, kind: string, open: (el: HTMLElement) => void): HTMLElement {
  const b = h('button', { type: 'button', class: `st-chip ${kind}` }, h('span', null, label), sicon('down', 'ico st-chip-caret'));
  b.onclick = (e) => { e.stopPropagation(); open(b); };
  return b;
}

/** A chip for one param: shows the value in words, opens the right picker. */
export function paramChip(p: ParamSpec, value: unknown, ctx: ParamCtx, onChange: (v: unknown, done: boolean) => void, bare = false): HTMLElement {
  const s = ctx.studio;
  const v = value === undefined ? p.default : value;
  const label = paramLabel(p).replace(/\s*\(.*\)$/, '').toLowerCase();
  const b = h('button', { type: 'button', class: 'st-chip param', title: paramLabel(p) });
  const keyed = (text: string): void => {
    b.replaceChildren(...(bare ? [] : [h('span', { class: 'st-chip-k' }, label)]), h('span', null, text));
  };
  switch (p.type) {
    case 'target':
    case 'object':
      b.append(h('span', null, targetText(v, s.doc, s.sceneId)));
      b.onclick = () => menu(b, targetItems(ctx, v, (x) => onChange(x, true), { keywords: p.type === 'target' }), { search: true });
      return b;
    case 'template':
      b.append(h('span', null, targetText(v || '', s.doc, s.sceneId)));
      b.onclick = () => menu(b, templateItems(ctx, v, (x) => onChange(x, true), true));
      return b;
    case 'key':
      b.append(h('span', null, t(`studio.key.${String(v)}`)));
      b.onclick = () => menu(b, CATALOG.keys.names.map((k) => ({ label: cap(t(`studio.key.${k}`)), on: k === v, onPick: () => onChange(k, true) })));
      return b;
    case 'choice':
      b.append(h('span', null, optionText(String(v))));
      b.onclick = () => menu(b, (p.options ?? []).map((o) => ({ label: cap(optionText(o)), on: o === v, onPick: () => onChange(o, true) })));
      return b;
    case 'bool':
      keyed(v === true ? t('studio.yes') : t('studio.no'));
      b.onclick = () => onChange(v !== true, true);
      return b;
    case 'vec':
      keyed(Array.isArray(v) ? `(${v.map(fmt).join(', ')})` : '(0, 0)');
      break;
    case 'counter':
    case 'tag':
    case 'string':
      if (p.type === 'string' && (p.name === 'text' || p.name === 'scene' || p.name === 'behavior')) b.append(h('span', null, v ? `“${String(v)}”` : '…'));
      else b.append(h('span', null, String(v ?? '') || '…'));
      break;
    default:
      keyed(fmt(v));
  }
  if (p.type === 'string' && p.name === 'scene') {
    b.onclick = () => menu(b, s.doc.scenes.map((sc) => ({ label: sc.name, on: sc.id === v, onPick: () => onChange(sc.id, true) })));
    b.replaceChildren(h('span', null, s.doc.scenes.find((sc) => sc.id === v)?.name ?? '…'));
    return b;
  }
  b.onclick = () => {
    let last = v;
    let committed = v;
    const ctl = paramControl(p, v, ctx, (x, done) => {
      last = x;
      if (done) { committed = x; onChange(x, true); }
      else onChange(x, false);
    });
    const pop = popover(b, h('div', { class: 'st-chip-pop' }, h('div', { class: 'st-chip-pop-label' }, paramLabel(p)), ctl), {
      onClose: () => { if (last !== committed) onChange(last, true); },
    });
    window.setTimeout(() => (pop.el.querySelector('input:not([type=range])') as HTMLInputElement | null)?.focus(), 20);
  };
  return b;
}
