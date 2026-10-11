/**
 * The Game panel (docs/v6/CONTRACTS_V6.md §6), shown when nothing is selected: world presets, gravity (strength and
 * direction), camera, edges, world size, players, themes (preset gallery + "describe a theme…"), HUD, game counters,
 * and the game-wide and level rules. Everything is a StudioEdit.
 */
import type { HudItem, StudioTheme } from '../../core/types.gen.ts';
import { h, toast } from '../../app/dom.ts';
import { t } from '../../app/messages.ts';
import { isOffline, studioApi } from '../../app/studio_api.ts';
import { CATALOG } from '../model/catalog.ts';
import { allCounters, displayName } from '../model/doc.ts';
import { normalizeTheme } from '../model/types.ts';
import { sicon } from './icons.ts';
import { artStyleSection } from './look_panel.ts';
import { addCounterButton, counterRow } from './inspector.ts';
import { targetItems, type ParamCtx } from './params.ts';
import { addRuleButton, rulesList } from './rules_ui.ts';
import type { Studio } from './studio.ts';
import { iconButton, menu, numberControl, row, section, segmented, textInput, toggle } from './ui.ts';

const WORLD_EMOJI: Record<string, string> = {
  platformer: '🍄', 'top-down': '🗺️', 'hill climb racer': '🚙', 'space shooter': '🚀', 'vertical shooter': '🛩️', 'fighting game': '🥊',
  'physics puzzle': '🧩', 'endless runner': '🏃', 'catch game': '🧺',
};

type Dir = 'down' | 'up' | 'left' | 'right' | 'none';

function gravityParts(g: [number, number]): { dir: Dir; strength: number } {
  const [x, y] = g;
  const strength = Math.hypot(x, y);
  if (strength < 1e-6) return { dir: 'none', strength: 1 };
  if (Math.abs(y) >= Math.abs(x)) return { dir: y > 0 ? 'down' : 'up', strength };
  return { dir: x > 0 ? 'right' : 'left', strength };
}

function gravityVec(dir: Dir, k: number): [number, number] {
  const r = Math.round(k * 100) / 100;
  switch (dir) {
    case 'down': return [0, r];
    case 'up': return [0, -r];
    case 'left': return [-r, 0];
    case 'right': return [r, 0];
    default: return [0, 0];
  }
}

export function gamePanel(s: Studio): HTMLElement {
  const sc = s.scene;
  const w = sc.world;
  const ctx: ParamCtx = { studio: s, selfId: null, allowGame: true };
  const setWorld = (data: Record<string, unknown>, o: { coalesce?: string; quiet?: boolean } = {}): void => { s.apply([{ action: 'set_world', data }], { label: 'world', ...o }); };

  // ---- world presets ----
  const presets = h('div', { class: 'st-presets' }, ...CATALOG.worlds.map((p) => h('button', {
    type: 'button', class: `st-preset${w.kind === p.kind ? ' on' : ''}`, 'aria-pressed': String(w.kind === p.kind),
    onclick: () => setWorld({ kind: p.kind, gravity: p.gravity, camera: { ...p.camera }, edges: p.edges, width: p.width, height: p.height, players: p.players ?? 1 }),
  }, h('span', { class: 'st-preset-emo', 'aria-hidden': 'true' }, WORLD_EMOJI[p.kind] ?? '🎮'), h('span', { class: 'st-preset-t' }, p.kind))));

  // ---- gravity ----
  const gp = gravityParts(w.gravity);
  const gravity = h('div', { class: 'st-stack' },
    segmented<Dir>([
      { value: 'down', label: t('studio.grav.down') }, { value: 'up', label: t('studio.grav.up') }, { value: 'left', label: t('studio.grav.left') },
      { value: 'right', label: t('studio.grav.right') }, { value: 'none', label: t('studio.grav.none') },
    ], gp.dir, (d) => setWorld({ gravity: gravityVec(d, gp.strength || 1) }), { cls: 'small' }),
    gp.dir === 'none' ? null : row(t('studio.grav.strength'), numberControl({ value: Math.round(gp.strength * 100) / 100, min: 0.05, max: 4, step: 0.05, onInput: (v, done) => setWorld({ gravity: gravityVec(gp.dir, v) }, { coalesce: 'grav', quiet: !done }) }), { stack: true }));

  // ---- camera ----
  const cam = w.camera;
  const followName = cam.target ? displayName(s.object(cam.target) ?? { id: cam.target, name: '', kind: 'thing' }) : t('studio.cam.player1');
  const followBtn = h('button', { type: 'button', class: 'st-picker' }, h('span', null, followName), sicon('down'));
  followBtn.onclick = () => menu(followBtn, [
    { label: t('studio.cam.player1'), on: !cam.target, onPick: () => setWorld({ camera: { target: null } }) },
    ...targetItems(ctx, cam.target, (v) => setWorld({ camera: { target: v } }), { keywords: false }).filter((i) => !i.icon),
  ], { search: sc.objects.length > 8 });
  const camera = h('div', { class: 'st-stack' },
    segmented([
      { value: 'fixed', label: t('studio.cam.fixed') }, { value: 'follow', label: t('studio.cam.follow') }, { value: 'auto_scroll', label: t('studio.cam.scroll') },
    ], cam.mode, (v) => setWorld({ camera: { mode: v } }), { cls: 'small' }),
    cam.mode === 'follow' ? row(t('studio.cam.target'), followBtn) : null,
    cam.mode !== 'fixed' ? row(t('studio.cam.axis'), segmented([{ value: 'x', label: t('studio.cam.axis_x') }, { value: 'y', label: t('studio.cam.axis_y') }, { value: 'xy', label: t('studio.cam.axis_xy') }], cam.axis, (v) => setWorld({ camera: { axis: v } }), { cls: 'small' })) : null,
    cam.mode === 'auto_scroll' ? row(t('studio.cam.speed'), numberControl({ value: cam.speed, min: 0, max: 1000, step: 5, onInput: (v, done) => setWorld({ camera: { speed: v } }, { coalesce: 'camspeed', quiet: !done }) }), { stack: true }) : null,
    row(t('studio.cam.zoom'), numberControl({ value: cam.zoom, min: 0.25, max: 3, step: 0.05, onInput: (v, done) => setWorld({ camera: { zoom: v } }, { coalesce: 'camzoom', quiet: !done }) }), { stack: true }));

  // ---- edges, size, players ----
  const edges = segmented([
    { value: 'walls', label: t('studio.edges.walls') }, { value: 'floor', label: t('studio.edges.floor') }, { value: 'wrap', label: t('studio.edges.wrap') }, { value: 'none', label: t('studio.edges.none') },
  ], w.edges, (v) => setWorld({ edges: v }), { cls: 'small' });
  const size = h('div', { class: 'st-size' },
    numberControl({ value: w.width, min: 320, max: 40000, slider: false, int: true, onInput: (v, done) => { if (done) setWorld({ width: v }); } }),
    h('span', { class: 'st-size-x' }, '×'),
    numberControl({ value: w.height, min: 240, max: 20000, slider: false, int: true, onInput: (v, done) => { if (done) setWorld({ height: v }); } }));
  const players = segmented([{ value: 1, label: t('studio.players.one') }, { value: 2, label: t('studio.players.two') }], w.players, (v) => setWorld({ players: v }), { cls: 'small' });

  const world = h('div', { class: 'st-stack' },
    presets,
    row(t('studio.world.gravity'), gravity, { stack: true }),
    row(t('studio.world.camera'), camera, { stack: true }),
    row(t('studio.world.edges'), edges, { stack: true, help: t('studio.edges.help') }),
    row(t('studio.world.size'), size, { stack: true }),
    row(t('studio.world.players'), players));

  return h('div', { class: 'st-insp' },
    h('div', { class: 'st-insp-head' }, h('div', { class: 'st-insp-avatar game', 'aria-hidden': 'true' }, sicon('game')),
      h('div', { class: 'st-insp-names' }, h('div', { class: 'st-insp-title' }, t('studio.game.title')), h('div', { class: 'st-insp-sub' }, t('studio.game.sub', { scene: sc.name })))),
    section('g-world', t('studio.sec.world'), 'globe', world, { open: true }),
    section('g-art', t('studio.sec.art'), 'sparkle', artStyleSection(s), { open: true }),
    section('g-theme', t('studio.sec.theme'), 'palette', themeSection(s), { open: true, count: s.doc.theme.name ?? '' }),
    section('g-hud', t('studio.sec.hud'), 'hud', hudSection(s), { open: false, count: s.doc.hud.items.length }),
    section('g-counters', t('studio.sec.game_counters'), 'bag', gameCounters(s), { open: false, count: Object.keys(s.doc.counters).length }),
    section('g-rules', t('studio.sec.game_rules'), 'rule', h('div', { class: 'st-stack' }, rulesList(ctx, '@game', s.doc.rules), addRuleButton(ctx, '@game')), { open: s.doc.rules.length > 0, count: s.doc.rules.length }),
    section('g-scene-rules', t('studio.sec.scene_rules', { scene: sc.name }), 'rule', h('div', { class: 'st-stack' }, rulesList(ctx, '@scene', sc.rules), addRuleButton(ctx, '@scene')), { open: sc.rules.length > 0, count: sc.rules.length }));
}

function themeSection(s: Studio): HTMLElement {
  const current = s.doc.theme;
  const cards = s.themes.map((th) => themeCard(th, (current.id ?? null) === (th.id ?? null) && current.name === th.name, () => {
    if (th.id) s.apply([{ action: 'set_theme', data: { preset: th.id } }], { label: 'theme' });
    else s.apply([{ action: 'set_theme', data: { ...normalizeTheme(th) } as Record<string, unknown> }], { label: 'theme' });
  }));
  const isCustom = !s.themes.some((th) => th.id && th.id === current.id);
  if (isCustom) cards.unshift(themeCard(current, true, () => undefined));
  const input = h('input', { type: 'text', class: 'st-text', maxLength: 300, placeholder: t('studio.theme.describe_ph'), 'aria-label': t('studio.theme.describe_ph') });
  const go = h('button', { type: 'button', class: 'st-btn primary small' }, sicon('sparkle'), t('studio.theme.make'));
  const status = h('p', { class: 'st-sec-hint', 'aria-live': 'polite' });
  const run = async (): Promise<void> => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    go.disabled = true;
    status.textContent = t('studio.theme.making');
    try {
      const r = await studioApi.theme({ text, game_kind: s.scene.world.kind || null });
      s.apply([{ action: 'set_theme', data: { ...normalizeTheme(r.theme), id: r.theme.id ?? null } as Record<string, unknown> }], { label: 'theme' });
      status.textContent = '';
      input.value = '';
    } catch (e) {
      status.textContent = t(isOffline(e) ? 'studio.theme.offline' : 'studio.theme.failed');
    } finally {
      go.disabled = false;
    }
  };
  go.onclick = () => void run();
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') void run(); };
  return h('div', { class: 'st-stack' },
    h('div', { class: 'st-themes' }, ...cards),
    s.themes.length <= 1 ? h('p', { class: 'st-sec-hint' }, t('studio.theme.few')) : null,
    h('div', { class: 'st-theme-describe' }, input, go), status,
    row(t('studio.theme.recolor'), toggle(current.recolor === true, (v) => s.apply([{ action: 'set_theme', data: { recolor: v } }], { label: 'theme' })), { help: t('studio.theme.recolor_help') }));
}

function themeCard(th: StudioTheme, on: boolean, pick: () => void): HTMLElement {
  const pal = th.palette ?? {};
  const bg = pal.bg ?? '#f6f1e7';
  const colors = [pal.ink, pal.accent, pal.accent2, pal.good].filter((c): c is string => !!c);
  return h('button', { type: 'button', class: `st-theme${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: pick, title: th.name ?? '' },
    h('span', { class: 'st-theme-swatch', style: `background:${bg}` },
      h('span', { class: `st-theme-ink ${th.stroke?.style ?? 'marker'}`, style: `--ink:${pal.ink ?? '#1f1b18'};--acc:${pal.accent ?? '#e4572e'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'st-theme-dots' }, ...colors.map((c) => h('i', { style: `background:${c}` })))),
    h('span', { class: 'st-theme-name' }, th.name ?? '…'));
}

function hudSection(s: Studio): HTMLElement {
  const hud = s.doc.hud;
  const setHud = (items: HudItem[], extra: Partial<{ timer: boolean; title: string | null }> = {}, o: { coalesce?: string; quiet?: boolean } = {}): void => {
    s.apply([{ action: 'set_hud', data: { items, timer: extra.timer ?? hud.timer, title: extra.title !== undefined ? extra.title : hud.title } }], { label: 'hud', ...o });
  };
  const subjects = (it: HudItem, i: number): HTMLElement => {
    const subj = it.subject ?? 'game';
    const label = subj === 'game' ? t('studio.hud.game') : subj === 'player1' ? t('studio.tgt.player1') : subj === 'player2' ? t('studio.tgt.player2') : displayName(s.object(subj) ?? { id: subj, name: '', kind: 'thing' });
    const b = h('button', { type: 'button', class: 'st-picker small' }, h('span', null, label), sicon('down'));
    const set = (v: string): void => setHud(hud.items.map((x, j) => (j === i ? { ...x, subject: v } : x)));
    b.onclick = () => menu(b, [
      { label: t('studio.hud.game'), on: subj === 'game', onPick: () => set('game') },
      { label: t('studio.tgt.player1'), on: subj === 'player1', onPick: () => set('player1') },
      { label: t('studio.tgt.player2'), on: subj === 'player2', onPick: () => set('player2') },
      ...s.scene.objects.filter((o) => Object.keys(o.counters).length).map((o) => ({ label: displayName(o), on: subj === o.id, onPick: () => set(o.id) })),
    ]);
    return b;
  };
  const rows = hud.items.map((it, i) => h('div', { class: 'st-hud-item' },
    h('div', { class: 'st-hud-top' }, subjects(it, i),
      textInput({ value: it.counter, list: allCounters(s.doc), max: 24, cls: 'st-hud-counter', label: t('studio.hud.counter'), onInput: (v, done) => { if (done && v.trim()) setHud(hud.items.map((x, j) => (j === i ? { ...x, counter: v.trim().toLowerCase() } : x))); } }),
      iconButton('close', t('studio.hud.remove'), () => setHud(hud.items.filter((_, j) => j !== i)), { cls: 'small' })),
    segmented<NonNullable<HudItem['style']>>([
      { value: 'number', label: t('studio.hud.number') }, { value: 'bar', label: t('studio.hud.bar') }, { value: 'hearts', label: t('studio.hud.hearts') }, { value: 'icons', label: t('studio.hud.icons') },
    ], (it.style ?? 'number') as NonNullable<HudItem['style']>, (v) => setHud(hud.items.map((x, j) => (j === i ? { ...x, style: v } : x))), { cls: 'small' })));
  const add = h('button', { type: 'button', class: 'st-add', disabled: hud.items.length >= 8 }, sicon('plus'), t('studio.hud.add'));
  add.onclick = () => menu(add, allCounters(s.doc).map((c) => ({
    label: c, onPick: () => setHud([...hud.items, { subject: ['health', 'fuel', 'ammo', 'keys'].includes(c) ? 'player1' : 'game', counter: c, style: c === 'lives' ? 'hearts' : c === 'health' || c === 'fuel' ? 'bar' : 'number' }]),
  })), { title: t('studio.hud.add') });
  return h('div', { class: 'st-stack' },
    hud.items.length ? h('div', { class: 'st-stack' }, ...rows) : h('p', { class: 'st-empty-note' }, t('studio.hud.empty')),
    add,
    row(t('studio.hud.timer'), toggle(hud.timer, (v) => setHud(hud.items, { timer: v }))),
    row(t('studio.hud.title'), textInput({ value: hud.title ?? '', max: 40, placeholder: s.doc.title, label: t('studio.hud.title'), onInput: (v, done) => setHud(hud.items, { title: v.trim() || null }, done ? {} : { coalesce: 'hudtitle', quiet: true }) }), { stack: true }));
}

function gameCounters(s: Studio): HTMLElement {
  const entries = Object.entries(s.doc.counters);
  return h('div', { class: 'st-stack' },
    entries.length ? h('div', { class: 'st-counters' }, ...entries.map(([k, v]) => counterRow(s, k, v, (name, value) => {
      const patch: Record<string, number | null> = {};
      if (name !== k) patch[k] = null;
      patch[name] = value;
      s.apply([{ action: 'set_game_counters', data: { counters: patch } }], { label: 'counters', coalesce: `gc:${k}`, quiet: name === k });
    }, () => s.apply([{ action: 'set_game_counters', data: { counters: { [k]: null } } }], { label: 'counters' })))) : h('p', { class: 'st-empty-note' }, t('studio.counters.empty')),
    addCounterButton(s, entries.map(([k]) => k), (n) => {
      if (Object.keys(s.doc.counters).includes(n)) { toast(t('studio.counters.have')); return; }
      s.apply([{ action: 'set_game_counters', data: { counters: { [n]: n === 'lives' ? 3 : 0 } } }], { label: 'counters' });
    }));
}
