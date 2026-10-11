/**
 * The workspace's "Send to" tab (docs/v4/CONTRACTS_V4.md §6 connectors): the game zip, a Phaser project, Tiled maps,
 * a Minecraft datapack, and "build it in my Minecraft world now" over RCON. The RCON password field is type=password
 * and lives only in the form: it is sent once with the request and never stored.
 */
import type { MinecraftResult } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { h, saveBlob, toast } from '../dom.ts';
import { hasMessage, kidText, t } from '../messages.ts';
import { v4 } from '../v4api.ts';
import type { GwCtx } from './gw_ctx.ts';
import { btn, calm, note } from './ui.ts';

interface Download {
  title: string;
  help: string;
  url: string;
  file: string;
  working?: string;
  done?: string;
}

function downloadRow(d: Download): HTMLElement {
  const b = btn(t('send.download'), { cls: 'small', icon: 'share' }) as HTMLButtonElement;
  b.setAttribute('aria-label', t('send.download_what', { what: d.title }));
  b.onclick = async () => {
    b.disabled = true;
    const close = d.working ? toast(d.working, { ms: 60_000 }) : null;
    try {
      saveBlob(await api.pdf(d.url), d.file);
      if (d.done) toast(d.done);
    } catch (e) {
      toast(calm(e));
    } finally {
      close?.();
      b.disabled = false;
    }
  };
  return h('div', { class: 'gw-send-row' }, h('div', null, h('strong', null, d.title), h('span', { class: 'small muted' }, d.help)), b);
}

export function sendPanel(ctx: GwCtx, panel: HTMLElement): void {
  const id = ctx.game.id;
  const rows: Download[] = [
    { title: t('export.game'), help: t('export.game_help'), url: api.exportUrl('game', id), file: `${id}.zip` },
    { title: t('export.phaser'), help: t('export.phaser_help'), url: `${api.exportUrl('game', id)}/phaser`, file: `${id}-phaser.zip`, working: t('export.phaser_working'), done: t('export.phaser_done') },
    { title: t('send.tiled'), help: t('send.tiled_help'), url: v4.tiledUrl(id), file: `${id}-tiled.zip`, working: t('send.packing') },
    { title: t('send.mc_pack'), help: t('send.mc_pack_help'), url: v4.minecraftUrl(id), file: `${id}-datapack.zip`, working: t('send.packing') },
  ];
  panel.append(h('div', { class: 'gw-send' }, ...rows.map(downloadRow)), minecraftLive(ctx));
}

/** The live Minecraft form: host, port, RCON password, which level, and an optional spot to build at. */
function minecraftLive(ctx: GwCtx): HTMLElement {
  const uid = `mc${Math.random().toString(36).slice(2, 7)}`;
  const field = (label: string, input: HTMLElement, hint?: string): HTMLElement =>
    h('label', { class: 'w-field' }, h('span', null, label), input, hint ? h('span', { class: 'small muted' }, hint) : '');
  const host = h('input', { type: 'text', name: 'host', value: 'localhost', maxLength: 120, autocomplete: 'off', spellcheck: false });
  const port = h('input', { type: 'number', name: 'port', value: '25575', min: '1', max: '65535', inputMode: 'numeric' });
  const password = h('input', { type: 'password', name: 'rcon', required: true, maxLength: 200, autocomplete: 'off', id: `${uid}-pw` });
  const levels = ctx.game.levels;
  const sel = ctx.levelCard();
  const which = h('select', { name: 'level' },
    ...levels.map((l, i) => h('option', { value: l.id, selected: l.id === sel?.id }, `${i + 1}. ${kidText(l.title || t('ui.untitled'))}`)));
  const xyz = ['x', 'y', 'z'].map((a) => h('input', { type: 'number', name: a, placeholder: a, 'aria-label': t('send.mc_origin_axis', { axis: a }), inputMode: 'numeric' }));
  const go = btn(t('send.mc_go'), { cls: 'primary', icon: 'play', type: 'submit' }) as HTMLButtonElement;
  const out = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'gw-mc', autocomplete: 'off' },
    h('h3', { class: 'w-h4' }, t('send.mc_live')),
    note(t('send.mc_live_help')),
    h('div', { class: 'w-row3' }, field(t('send.mc_host'), host), field(t('send.mc_port'), port), field(t('send.mc_password'), password)),
    levels.length ? field(t('send.mc_level'), which) : note(t('export.no_levels')),
    h('details', null, h('summary', { class: 'small' }, t('send.mc_origin')), h('div', { class: 'w-row3' }, ...xyz), note(t('send.mc_origin_help'))),
    h('div', { class: 'row wrap' }, go),
    out);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!password.value) {
      password.focus();
      return;
    }
    const nums = xyz.map((x) => (x.value.trim() === '' ? null : Math.round(Number(x.value))));
    const origin = nums.every((n) => n !== null && Number.isFinite(n)) ? (nums as [number, number, number]) : null;
    go.disabled = true;
    out.replaceChildren(note(t('send.mc_sending')));
    let r: MinecraftResult;
    try {
      r = await v4.minecraftLive(ctx.game.id, {
        host: host.value.trim() || 'localhost', port: Math.max(1, Math.min(65535, Math.round(Number(port.value)) || 25575)),
        password: password.value, level_id: levels.length ? which.value : null, origin,
      });
    } catch (err) {
      if (!ctx.gone()) out.replaceChildren(h('p', { class: 'w-note warn' }, calm(err)));
      return;
    } finally {
      go.disabled = false;
    }
    if (ctx.gone()) return;
    const key = r.message_key && hasMessage(r.message_key) ? r.message_key : r.ok ? 'send.mc_ok' : 'send.mc_failed';
    out.replaceChildren(
      h('p', { class: `w-note ${r.ok ? 'ok' : 'warn'}` }, t(key, { n: r.commands })),
      r.untranslated?.length ? h('div', null, note(t('send.mc_untranslated')),
        h('ul', { class: 'gw-untranslated' }, ...r.untranslated.slice(0, 20).map((u) => h('li', null, kidText(u))))) : '');
  };
  return form;
}
