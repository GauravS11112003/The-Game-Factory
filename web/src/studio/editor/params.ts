/**
 * Controls generated from catalog ParamSpecs (docs/v6/CONTRACTS_V6.md §6): number slider + field, bool switch, choice
 * segmented / select, key picker, target / object / template / tag pickers that list the scene's objects and tags,
 * a counter-name combobox and two fields for vectors. Shared by behaviour cards, rule chips and the game panel.
 */
import { h } from '../../app/dom.ts';
import { t, tMaybe } from '../../app/messages.ts';
import { CATALOG, type ParamSpec } from '../model/catalog.ts';
import { targetText } from '../model/describe.ts';
import { allCounters, allTags, displayName } from '../model/doc.ts';
import { sicon } from './icons.ts';
import type { Studio } from './studio.ts';
import { menu, numberControl, segmented, select, textInput, toggle, type MenuItem } from './ui.ts';

export interface ParamCtx {
  studio: Studio;
  /** The object the behaviour / rule belongs to (so "this" can be offered and itself skipped in lists). */
  selfId?: string | null;
  /** Event targets may be "anything". */
  allowAny?: boolean;
  /** Counter subjects may be "the game". */
  allowGame?: boolean;
}

export const COMMON_TAGS = ['player', 'enemy', 'coin', 'wall', 'ground', 'hazard', 'goal', 'projectile', 'wheel', 'fighter', 'crate', 'door', 'key'];

/** "hill_climb" → "hill climb", ">=" → "≥". */
export function optionText(v: string): string {
  const ops: Record<string, string> = { '>=': '≥', '<=': '≤', '==': '=', '!=': '≠' };
  if (ops[v]) return ops[v];
  return tMaybe(`studio.opt.${v}`) ?? v.replace(/_/g, ' ');
}

export function paramLabel(p: ParamSpec): string {
  return p.label ?? p.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Menu items for a target param: keywords, then objects, then tags. */
export function targetItems(ctx: ParamCtx, current: unknown, pick: (v: string) => void, o: { keywords?: boolean } = {}): MenuItem[] {
  const s = ctx.studio;
  const items: MenuItem[] = [];
  const kw: string[] = [];
  if (o.keywords !== false) {
    if (ctx.selfId !== undefined) kw.push('self', 'other');
    kw.push('player');
    if (s.scene.world.players === 2) kw.push('player1', 'player2');
    if (ctx.allowAny) kw.push('any');
    if (ctx.allowGame) kw.push('game');
  }
  for (const k of kw) items.push({ label: cap(targetText(k, s.doc, s.sceneId)), group: t('studio.pick.who'), on: current === k, onPick: () => pick(k) });
  for (const ob of s.scene.objects) {
    if (ob.id === ctx.selfId) continue;
    items.push({ label: displayName(ob), sub: ob.kind !== 'thing' ? ob.kind : undefined, group: t('studio.pick.objects'), on: current === ob.id, onPick: () => pick(ob.id) });
  }
  const tags = [...new Set([...allTags(s.doc), ...COMMON_TAGS])].sort();
  for (const tg of tags) items.push({ label: t('studio.pick.any_tag', { tag: tg }), sub: t('studio.pick.tag_sub'), group: t('studio.pick.groups'), on: current === tg, icon: 'tag', onPick: () => pick(tg) });
  return items;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A control for one param. `onChange(v, done)`: done = false while scrubbing / typing. */
export function paramControl(p: ParamSpec, value: unknown, ctx: ParamCtx, onChange: (v: unknown, done: boolean) => void): HTMLElement {
  const v = value === undefined ? p.default : value;
  const s = ctx.studio;
  switch (p.type) {
    case 'number':
    case 'int':
      return numberControl({ value: typeof v === 'number' ? v : Number(v) || 0, min: p.min, max: p.max, int: p.type === 'int', onInput: (n, done) => onChange(n, done) });
    case 'bool':
      return toggle(v === true, (b) => onChange(b, true), paramLabel(p));
    case 'choice': {
      const opts = (p.options ?? []).map((o) => ({ value: o, label: optionText(o) }));
      if (opts.length <= 4 && opts.every((o) => o.label.length <= 9)) return segmented(opts, String(v), (x) => onChange(x, true), { cls: 'small', label: paramLabel(p) });
      return select(opts, String(v), (x) => onChange(x, true), paramLabel(p));
    }
    case 'key':
      return select(CATALOG.keys.names.map((k) => ({ value: k, label: cap(t(`studio.key.${k}`)) })), String(v), (x) => onChange(x, true), paramLabel(p));
    case 'target':
    case 'object': {
      const b = h('button', { type: 'button', class: 'st-picker' }, h('span', null, cap(targetText(v, s.doc, s.sceneId))), sicon('down'));
      b.onclick = () => menu(b, targetItems(ctx, v, (x) => onChange(x, true), { keywords: p.type === 'target' }), { search: true });
      return b;
    }
    case 'template': {
      const b = h('button', { type: 'button', class: 'st-picker' }, h('span', null, cap(targetText(v || '', s.doc, s.sceneId))), sicon('down'));
      b.onclick = () => menu(b, templateItems(ctx, v, (x) => onChange(x, true), p.default === 'default'), { search: s.scene.objects.length > 8 });
      return b;
    }
    case 'tag':
      return textInput({ value: String(v ?? ''), list: [...new Set([...allTags(s.doc), ...COMMON_TAGS])], max: 24, onInput: (x, done) => onChange(x.trim().toLowerCase(), done), label: paramLabel(p) });
    case 'counter':
      return textInput({ value: String(v ?? ''), list: allCounters(s.doc), max: 24, placeholder: t('studio.param.counter_ph'), onInput: (x, done) => onChange(x.trim().toLowerCase(), done), label: paramLabel(p) });
    case 'vec': {
      const arr = Array.isArray(v) ? (v as number[]) : [0, 0];
      const cur: [number, number] = [Number(arr[0]) || 0, Number(arr[1]) || 0];
      const f = (i: 0 | 1): HTMLElement => numberControl({ value: cur[i], slider: false, onInput: (n, done) => { cur[i] = n; onChange([cur[0], cur[1]], done); } });
      return h('div', { class: 'st-vec' }, h('span', { class: 'st-vec-l' }, 'x'), f(0), h('span', { class: 'st-vec-l' }, 'y'), f(1));
    }
    default:
      return textInput({ value: String(v ?? ''), max: 200, onInput: (x, done) => onChange(x, done), label: paramLabel(p) });
  }
}

/** Template picker items: the default dot, the scene's templates, and other objects (picking one makes it a template). */
export function templateItems(ctx: ParamCtx, current: unknown, pick: (v: string) => void, allowDefault: boolean): MenuItem[] {
  const s = ctx.studio;
  const items: MenuItem[] = [];
  if (allowDefault) items.push({ label: cap(t('studio.tgt.default')), on: current === 'default', onPick: () => pick('default') });
  for (const o of s.scene.objects.filter((x) => x.template)) items.push({ label: displayName(o), group: t('studio.pick.templates'), on: current === o.id, onPick: () => pick(o.id) });
  for (const o of s.scene.objects.filter((x) => !x.template && x.id !== ctx.selfId)) {
    items.push({
      label: displayName(o), sub: t('studio.pick.make_template'), group: t('studio.pick.from_drawing'), on: current === o.id,
      onPick: () => {
        s.apply([{ action: 'update_object', target: o.id, data: { template: true } }], { label: 'template' });
        pick(o.id);
      },
    });
  }
  return items;
}
