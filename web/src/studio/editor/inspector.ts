/**
 * The object inspector (docs/v6/CONTRACTS_V6.md §6), no code ever: name and kind (with archetype suggestions and
 * "make it act like a …"), who controls it, Body, Behaviours (catalog cards with generated controls), Rules (sentence
 * cards), Items & stats, Tags, Joints ("attach…" then click), template / hidden, layer, save as block. Every control
 * goes through the same StudioEdit path as the copilot.
 */
import type { StudioEdit } from '../../core/types.gen.ts';
import { h, toast } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import { v4 } from '../../app/v4api.ts';
import { BEHAVIORS, CATALOG } from '../model/catalog.ts';
import { behaviorText } from '../model/describe.ts';
import { allCounters, allTags, displayName, worldToLocal } from '../model/doc.ts';
import { archetypeEdits, archetypeFor, cleanName } from '../model/edits.ts';
import type { SObj, Vec } from '../model/types.ts';
import { sicon } from './icons.ts';
import { COMMON_TAGS, paramControl, paramLabel, type ParamCtx } from './params.ts';
import { addRuleButton, rulesList } from './rules_ui.ts';
import type { Studio } from './studio.ts';
import { btn, iconButton, menu, numberControl, popover, row, section, segmented, textInput, toggle } from './ui.ts';

const KIND_EMOJI: Record<string, string> = {
  player: '🏃', hero: '🧝', car: '🚗', wheel: '🛞', ship: '🚀', fighter: '🥊', enemy: '👾', projectile: '💥', coin: '🪙', ground: '⛰️',
  platform: '🧱', crate: '📦', ball: '⚽', hazard: '🔥', goal: '🏁', spawner: '🥚', zone: '⬚', decoration: '🌼',
};

export function kindEmoji(kind: string): string {
  return KIND_EMOJI[kind] ?? '✏️';
}

/** Edit one object through update_object (the shared copilot path). */
function upd(s: Studio, id: string, data: Record<string, unknown>, o: { coalesce?: string; quiet?: boolean; label?: string } = {}): void {
  s.apply([{ action: 'update_object', target: id, data }], { label: o.label ?? 'inspector', ...o });
}

export function objectInspector(s: Studio, o: SObj): HTMLElement {
  const ctx: ParamCtx = { studio: s, selfId: o.id };
  const id = o.id;

  // ---- header: name, kind, archetypes ----
  const name = textInput({ value: o.name, placeholder: displayName({ ...o, name: '' }), max: 32, cls: 'st-name-in', label: t('studio.insp.name'),
    onInput: (v, done) => upd(s, id, { name: v }, done ? {} : { coalesce: `name:${id}`, quiet: true }) });
  const kinds = CATALOG.archetypes.map((a) => a.kind);
  const kind = textInput({ value: o.kind === 'thing' ? '' : o.kind, placeholder: t('studio.insp.kind_ph'), max: 24, list: kinds, label: t('studio.insp.kind'),
    onInput: (v, done) => { if (done) upd(s, id, { kind: v.trim() || 'thing' }); } });
  const arch = archetypeFor(o.kind);
  const actsLike = arch && !arch.behaviors.every((b) => o.behaviors.some((x) => x.type === b.type)) || (arch && arch.physics.body && o.physics.body !== arch.physics.body)
    ? h('button', { type: 'button', class: 'st-callout', onclick: () => s.apply(archetypeEdits(s.doc, s.sceneId, id, arch!.kind), { label: 'archetype' }) },
      sicon('wand'), h('span', null, t('studio.insp.act_like', { label: arch!.label.toLowerCase() })))
    : null;
  const quick = o.kind === 'thing'
    ? h('div', { class: 'st-quick' }, h('span', { class: 'st-quick-label' }, t('studio.insp.what_is_it')),
      ...['player', 'ground', 'platform', 'coin', 'enemy', 'car', 'goal', 'hazard'].map((k) => h('button', {
        type: 'button', class: 'st-qchip', onclick: () => s.apply(archetypeEdits(s.doc, s.sceneId, id, k), { label: 'archetype' }),
      }, h('span', { class: 'emo' }, kindEmoji(k)), archetypeFor(k)?.label ?? k)),
      h('button', { type: 'button', class: 'st-qchip more', onclick: (e: MouseEvent) => menu(e.currentTarget as HTMLElement, CATALOG.archetypes.map((a) => ({
        label: `${kindEmoji(a.kind)}  ${a.label}`, onPick: () => s.apply(archetypeEdits(s.doc, s.sceneId, id, a.kind), { label: 'archetype' }),
      })), { search: true }) }, t('studio.insp.more')))
    : null;
  const head = h('div', { class: 'st-insp-head' },
    h('div', { class: 'st-insp-avatar', 'aria-hidden': 'true' }, kindEmoji(o.kind)),
    h('div', { class: 'st-insp-names' }, name, h('div', { class: 'st-kind-row' }, kind)));

  // ---- controlled by ----
  const control = row(t('studio.insp.controlled_by'), segmented([
    { value: 0, label: t('studio.insp.nobody') }, { value: 1, label: t('studio.insp.p1') }, { value: 2, label: t('studio.insp.p2') },
  ], o.player, (v) => upd(s, id, { player: v }), { cls: 'small' }));

  // ---- body ----
  const p = o.physics;
  const body = h('div', { class: 'st-stack' },
    h('div', { class: 'st-body-cards' }, ...([
      ['none', 'eye', 'studio.body.none', 'studio.body.none_sub'],
      ['static', 'rect', 'studio.body.static', 'studio.body.static_sub'],
      ['dynamic', 'gravity', 'studio.body.dynamic', 'studio.body.dynamic_sub'],
      ['kinematic', 'bolt', 'studio.body.kinematic', 'studio.body.kinematic_sub'],
    ] as const).map(([v, ico, l, sub]) => h('button', {
      type: 'button', class: `st-body-card${p.body === v ? ' on' : ''}`, 'aria-pressed': String(p.body === v), disabled: p.shape === 'line' && v !== 'static',
      onclick: () => upd(s, id, { physics: { body: v } }),
    }, sicon(ico), h('span', { class: 'st-body-t' }, t(l)), h('span', { class: 'st-body-s' }, t(sub))))),
    row(t('studio.body.shape'), segmented([
      { value: 'auto', label: t('studio.body.shape_auto') }, { value: 'box', label: t('studio.body.shape_box') },
      { value: 'circle', label: t('studio.body.shape_circle') }, { value: 'line', label: t('studio.body.shape_line') },
    ], p.shape, (v) => upd(s, id, { physics: { shape: v } }), { cls: 'small' }), { help: t('studio.body.shape_help'), stack: true }),
    p.body === 'none' ? null : h('div', { class: 'st-stack' },
      p.body === 'dynamic' ? row(t('studio.body.weight'), numberControl({ value: p.density, min: 0.05, max: 10, step: 0.05, onInput: (v, done) => upd(s, id, { physics: { density: v } }, { coalesce: `dens:${id}`, quiet: !done }) }), { stack: true }) : null,
      row(t('studio.body.grip'), numberControl({ value: p.friction, min: 0, max: 2, step: 0.05, onInput: (v, done) => upd(s, id, { physics: { friction: v } }, { coalesce: `fric:${id}`, quiet: !done }) }), { stack: true }),
      row(t('studio.body.bounce'), numberControl({ value: p.bounce, min: 0, max: 1.5, step: 0.05, onInput: (v, done) => upd(s, id, { physics: { bounce: v } }, { coalesce: `bnc:${id}`, quiet: !done }) }), { stack: true }),
      p.body === 'dynamic' ? row(t('studio.body.gravity'), numberControl({ value: p.gravity_scale, min: -5, max: 5, step: 0.1, onInput: (v, done) => upd(s, id, { physics: { gravity_scale: v } }, { coalesce: `grav:${id}`, quiet: !done }) }), { stack: true, help: t('studio.body.gravity_help') }) : null,
      p.body === 'dynamic' ? row(t('studio.body.no_tip'), toggle(p.fixed_rotation, (v) => upd(s, id, { physics: { fixed_rotation: v } }))) : null,
      row(t('studio.body.ghost'), toggle(p.sensor, (v) => upd(s, id, { physics: { sensor: v } })), { help: t('studio.body.ghost_help') })));

  // ---- behaviours ----
  const behaviours = h('div', { class: 'st-stack' },
    ...o.behaviors.map((b) => {
      const e = BEHAVIORS.get(b.type);
      const on = b.off !== true;
      const params = (e?.params ?? []).map((ps) => row(paramLabel(ps), paramControl(ps, b.params?.[ps.name], ctx, (v, done) =>
        s.apply([{ action: 'update_behavior', target: id, data: { id: b.id, params: { [ps.name]: v } } }], { label: 'behaviour', coalesce: `beh:${id}:${b.id}:${ps.name}`, quiet: !done })),
      { stack: ps.type === 'number' || ps.type === 'int' || ps.type === 'vec' || ps.type === 'choice' }));
      return h('div', { class: `st-beh${on ? '' : ' off'}` },
        h('div', { class: 'st-beh-head' },
          h('span', { class: 'st-beh-title', title: e?.help ?? '' }, e?.label ?? b.type),
          toggle(on, (v) => s.apply([{ action: 'update_behavior', target: id, data: { id: b.id, off: !v } }], { label: 'behaviour' }), t('studio.beh.on')),
          iconButton('close', t('studio.beh.remove'), () => s.apply([{ action: 'remove_behavior', target: id, data: { id: b.id } }], { label: 'behaviour' }), { cls: 'small' })),
        e?.help ? h('p', { class: 'st-beh-help' }, e.help) : null,
        params.length ? h('details', { class: 'st-beh-params' }, h('summary', null, behaviorText(b) === e?.label ? t('studio.beh.tune') : behaviorText(b).replace(`${e?.label} `, '')), ...params) : null);
    }),
    addBehaviorButton(s, o));

  // ---- items & stats ----
  const counters = Object.entries(o.counters);
  const items = h('div', { class: 'st-stack' },
    counters.length ? h('div', { class: 'st-counters' }, ...counters.map(([k, v]) => counterRow(s, k, v, (name, value) => {
      const patch: Record<string, number | null> = {};
      if (name !== k) patch[k] = null;
      if (name) patch[name] = value;
      s.apply([{ action: 'set_counters', target: id, data: { counters: patch } }], { label: 'items', coalesce: `cnt:${id}:${k}`, quiet: name === k });
    }, () => s.apply([{ action: 'set_counters', target: id, data: { counters: { [k]: null } } }], { label: 'items' })))) : h('p', { class: 'st-empty-note' }, t('studio.items.empty')),
    addCounterButton(s, Object.keys(o.counters), (n) => s.apply([{ action: 'set_counters', target: id, data: { counters: { [n]: n === 'health' ? 3 : n === 'fuel' ? 100 : 0 } } }], { label: 'items' })));

  // ---- tags ----
  const tagIn = h('input', { type: 'text', class: 'st-text st-tag-in', placeholder: t('studio.tags.add_ph'), maxLength: 24, 'aria-label': t('studio.tags.add_ph') });
  const dl = h('datalist', { id: `st-tags-${id}` }, ...[...new Set([...allTags(s.doc), ...COMMON_TAGS])].filter((x) => !o.tags.includes(x)).map((x) => h('option', { value: x })));
  tagIn.setAttribute('list', dl.id);
  tagIn.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const n = cleanName(tagIn.value);
      if (n && !o.tags.includes(n)) upd(s, id, { tags: [...o.tags, n] });
      tagIn.value = '';
    }
  };
  const tags = h('div', { class: 'st-tags' },
    ...o.tags.map((tg) => h('span', { class: 'st-tag' }, tg, h('button', { type: 'button', 'aria-label': t('studio.tags.remove', { tag: tg }), onclick: () => upd(s, id, { tags: o.tags.filter((x) => x !== tg) }) }, sicon('close')))),
    o.tags.length < 8 ? tagIn : null, dl);

  // ---- joints ----
  const joints = h('div', { class: 'st-stack' },
    ...o.joints.map((j, i) => {
      const other = s.object(j.to);
      return h('div', { class: 'st-joint' }, h('span', { class: 'st-joint-type' }, t(`studio.joint.${j.type}`)),
        h('span', { class: 'st-joint-to' }, other ? displayName(other) : t('studio.joint.not_drawn', { id: j.to })),
        j.type === 'wheel' || j.type === 'hinge' ? h('label', { class: 'st-mini' }, toggle(j.motor === true, (v) => upd(s, id, { joints: o.joints.map((x, k) => (k === i ? { ...x, motor: v } : x)) }), t('studio.joint.motor')), t('studio.joint.motor')) : null,
        iconButton('close', t('studio.joint.remove'), () => upd(s, id, { joints: o.joints.filter((_, k) => k !== i) }), { cls: 'small' }));
    }),
    o.joints.length < 8 ? attachButton(s, o) : null);

  // ---- more ----
  const more = h('div', { class: 'st-stack' },
    row(t('studio.insp.template'), toggle(o.template, (v) => upd(s, id, { template: v })), { help: t('studio.insp.template_help') }),
    row(t('studio.insp.hidden'), toggle(o.hidden, (v) => upd(s, id, { hidden: v })), { help: t('studio.insp.hidden_help') }),
    row(t('studio.insp.layer'), h('div', { class: 'st-row-btns' },
      iconButton('dn', t('studio.sel.back'), () => s.shiftLayer(-1)), h('span', { class: 'st-layer-n' }, String(o.layer)), iconButton('up', t('studio.sel.forward'), () => s.shiftLayer(1)))),
    h('div', { class: 'st-row-btns wrap' },
      btn(t('studio.sel.duplicate'), () => s.duplicateSelection(), { icon: 'copy' }),
      btn(t('studio.insp.save_block'), () => saveAsBlock(o), { icon: 'stamp' }),
      btn(t('studio.sel.delete'), () => s.deleteSelection(), { icon: 'trash', cls: 'danger' })));

  return h('div', { class: 'st-insp' },
    head, actsLike, quick,
    section('control', t('studio.sec.control'), 'person', control, { open: true }),
    section('body', t('studio.sec.body'), 'body', body, { open: true }),
    section('behaviours', t('studio.sec.behaviours'), 'bolt', behaviours, { open: true, count: o.behaviors.length }),
    section('rules', t('studio.sec.rules'), 'rule', h('div', { class: 'st-stack' }, rulesList(ctx, id, o.rules), addRuleButton(ctx, id)), { open: true, count: o.rules.length }),
    section('items', t('studio.sec.items'), 'bag', items, { open: counters.length > 0, count: counters.length }),
    section('tags', t('studio.sec.tags'), 'tag', tags, { open: o.tags.length > 0, count: o.tags.length }),
    section('joints', t('studio.sec.joints'), 'joint', joints, { open: o.joints.length > 0, count: o.joints.length }),
    section('more', t('studio.sec.more'), 'sliders', more, { open: false }));
}

function addBehaviorButton(s: Studio, o: SObj): HTMLElement {
  const b = h('button', { type: 'button', class: 'st-add' }, sicon('plus'), t('studio.beh.add'));
  b.onclick = () => menu(b, CATALOG.behaviors.filter((e) => !o.behaviors.some((x) => x.type === e.type)).map((e) => ({
    label: e.label, sub: e.help, group: t(`studio.beh.group.${e.group ?? 'world'}`),
    onPick: () => s.apply([{ action: 'add_behavior', target: o.id, data: { type: e.type } }], { label: 'behaviour' }),
  })).sort((a, c) => (a.group ?? '').localeCompare(c.group ?? '')), { search: true, title: t('studio.beh.add'), width: 300 });
  return b;
}

export function counterRow(s: Studio, name: string, value: number, onChange: (name: string, value: number) => void, onRemove: () => void): HTMLElement {
  let n = name;
  let v = value;
  return h('div', { class: 'st-counter' },
    textInput({ value: name, max: 24, list: allCounters(s.doc), cls: 'st-counter-name', label: t('studio.items.name'), onInput: (x, done) => { if (done) { const c = cleanName(x); if (c && c !== n) { onChange(c, v); n = c; } } } }),
    numberControl({ value, slider: false, onInput: (x) => { v = x; onChange(n, x); } }),
    iconButton('close', t('studio.items.remove'), onRemove, { cls: 'small' }));
}

export function addCounterButton(s: Studio, have: string[], add: (name: string) => void): HTMLElement {
  const b = h('button', { type: 'button', class: 'st-add' }, sicon('plus'), t('studio.items.add'));
  b.onclick = () => {
    const sugg = [...new Set(['health', 'coins', 'keys', 'fuel', 'ammo', 'score', 'lives', 'gems', ...allCounters(s.doc)])].filter((x) => !have.includes(x)).slice(0, 14);
    const input = h('input', { type: 'text', class: 'st-text', placeholder: t('studio.items.new_ph'), maxLength: 24, 'aria-label': t('studio.items.new_ph') });
    const go = (name: string): void => {
      const n = cleanName(name);
      if (!n) { input.classList.add('bad'); return; }
      pop.close();
      add(n);
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') go(input.value); };
    const pop = popover(b, h('div', { class: 'st-addc' }, h('div', { class: 'st-chip-pop-label' }, t('studio.items.add')), input,
      h('div', { class: 'st-quick' }, ...sugg.map((x) => h('button', { type: 'button', class: 'st-qchip', onclick: () => go(x) }, x)))), { width: 260 });
    window.setTimeout(() => input.focus(), 20);
  };
  return b;
}

function attachButton(s: Studio, o: SObj): HTMLElement {
  const b = h('button', { type: 'button', class: 'st-add' }, sicon('link'), t('studio.joint.attach'));
  b.onclick = () => menu(b, (['wheel', 'hinge', 'rope', 'weld', 'spring'] as const).map((type) => ({
    label: t(`studio.joint.${type}`), sub: t(`studio.joint.${type}_sub`),
    onPick: () => s.startPick({
      prompt: t('studio.joint.pick', { name: displayName(o) }),
      filter: (x) => x.id !== o.id,
      onPick: (otherId) => {
        const self = s.object(o.id);
        const other = s.object(otherId);
        if (!self || !other) return;
        const at = worldToLocal(self, [other.x, other.y]).map((v) => Math.round(v)) as Vec;
        const data: Record<string, unknown> = { type, to: otherId, at: type === 'rope' || type === 'spring' ? [0, 0] : at, to_at: [0, 0], motor: type === 'wheel' };
        if (type === 'rope' || type === 'spring') data.length = Math.round(Math.hypot(other.x - self.x, other.y - self.y));
        const edits: StudioEdit[] = [{ action: 'add_joint', target: o.id, data }];
        if (type === 'wheel' && other.physics.body !== 'dynamic') edits.push({ action: 'update_object', target: otherId, data: { physics: { body: 'dynamic', shape: 'circle', friction: 1.2 } } });
        if (self.physics.body === 'static' && (type === 'wheel' || type === 'hinge')) edits.push({ action: 'update_object', target: o.id, data: { physics: { body: 'dynamic' } } });
        s.apply(edits, { label: 'joint' });
        s.select([o.id]);
      },
    }),
  })), { title: t('studio.joint.how') });
  return b;
}

async function saveAsBlock(o: SObj): Promise<void> {
  try {
    await v4.createBlock({ name: displayName(o).slice(0, 40), kind: 'object', object: o as never, description: behaviorText({ type: o.behaviors[0]?.type ?? '', params: {} }) || null });
    toast(t('studio.insp.saved_block'));
  } catch {
    toast(t('studio.insp.block_failed'));
  }
}

/** Several things selected: bulk actions. */
export function multiInspector(s: Studio, objs: SObj[]): HTMLElement {
  const ids = objs.map((o) => o.id);
  const all = (data: Record<string, unknown>): void => { s.apply(ids.map((id) => ({ action: 'update_object' as const, target: id, data })), { label: 'inspector' }); };
  const body = objs.every((o) => o.physics.body === objs[0].physics.body) ? objs[0].physics.body : null;
  return h('div', { class: 'st-insp' },
    h('div', { class: 'st-insp-head' }, h('div', { class: 'st-insp-avatar' }, String(objs.length)), h('div', { class: 'st-insp-names' }, h('div', { class: 'st-insp-title' }, t('studio.multi.title', { n: objs.length })), h('div', { class: 'st-insp-sub' }, objs.slice(0, 4).map(displayName).join(', ') + (objs.length > 4 ? '…' : '')))),
    h('div', { class: 'st-row-btns wrap pad' },
      btn(t('studio.sel.merge'), () => s.mergeSelection(), { icon: 'merge', cls: 'primary', title: t('studio.sel.merge_help') }),
      btn(t('studio.sel.duplicate'), () => s.duplicateSelection(), { icon: 'copy' }),
      btn(t('studio.sel.delete'), () => s.deleteSelection(), { icon: 'trash', cls: 'danger' })),
    section('m-body', t('studio.sec.body'), 'body', segmented([
      { value: 'none', label: t('studio.body.none') }, { value: 'static', label: t('studio.body.static') }, { value: 'dynamic', label: t('studio.body.dynamic') }, { value: 'kinematic', label: t('studio.body.kinematic') },
    ], body as string, (v) => all({ physics: { body: v } }), { cls: 'small' })),
    section('m-kind', t('studio.multi.make_all'), 'wand', h('div', { class: 'st-quick' }, ...['coin', 'enemy', 'platform', 'hazard', 'crate', 'decoration'].map((k) => h('button', {
      type: 'button', class: 'st-qchip', onclick: () => s.apply(ids.flatMap((id) => archetypeEdits(s.doc, s.sceneId, id, k)), { label: 'archetype' }),
    }, h('span', { class: 'emo' }, kindEmoji(k)), archetypeFor(k)?.label ?? k)))));
}
