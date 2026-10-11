/**
 * #/new[?mode=] — New game (docs/v4/CONTRACTS_V4.md §7): name it, pick what kind of game it is (GameRules.mode) and
 * how to start (draw, scan, describe, or the empty workspace). Making a game needs a profile; the maker joins it as
 * owner, and a non-platformer mode is saved into the game's rules before the first level.
 */
import { api, ApiError } from '../api.ts';
import { collab } from '../collab/api.ts';
import { h, icon, toast } from '../dom.ts';
import { ensurePlayer } from '../identity.ts';
import { t } from '../messages.ts';
import { navigate } from '../router.ts';
import { DEFAULT_RULES } from '../rules.ts';
import type { Shell } from '../shell.ts';
import { MODES } from './workspace.ts';
import type { GameMode } from '../../core/types.gen.ts';

type Start = 'draw' | 'scan' | 'describe' | 'workspace';

const SVGNS = 'http://www.w3.org/2000/svg';

/** A tiny ink sketch of each mode (stroke paths on a 64×40 card). */
const SKETCH: Record<GameMode, { d: string; color: string }[]> = {
  platformer: [
    { d: 'M2 34h22M32 34h30M38 24h12', color: '#1f1b18' },
    { d: 'M24 34l2-5 2 5 2-5 2 5', color: '#e0453a' },
    { d: 'M8 30c6-12 14-14 20-12', color: '#6a5acd' },
  ],
  topdown: [
    { d: 'M4 4h56v32H4zM24 4v18M40 18v18M4 24h12', color: '#1f1b18' },
    { d: 'M48 10a2 2 0 100 .1', color: '#2c7be5' },
    { d: 'M10 12h8M14 8v8', color: '#6a5acd' },
  ],
  runner: [
    { d: 'M2 32h60M40 22h10', color: '#1f1b18' },
    { d: 'M20 32l2-5 2 5M50 32l2-5 2 5', color: '#e0453a' },
    { d: 'M6 20h10M8 16h8M10 24h8', color: '#6a5acd' },
  ],
  flappy: [
    { d: 'M18 0v14M18 26v14M44 0v8M44 20v20', color: '#1f1b18' },
    { d: 'M6 22c4-6 8-6 12-2M28 16c4-4 8-4 12 0', color: '#6a5acd' },
  ],
};

function sketch(mode: GameMode): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 40');
  svg.setAttribute('class', 'ws-mode-sketch');
  svg.setAttribute('aria-hidden', 'true');
  for (const s of SKETCH[mode]) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', s.d);
    p.setAttribute('stroke', s.color);
    svg.append(p);
  }
  return svg;
}

export function newGameScreen(root: HTMLElement, query: URLSearchParams, shell: Shell): () => void {
  let disposed = false;
  let busy = false;
  const q = query.get('mode');
  let mode: GameMode = (MODES as string[]).includes(q ?? '') ? (q as GameMode) : 'platformer';
  let start: Start = 'draw';

  const name = h('input', { id: 'ng-name', type: 'text', class: 'text ws-name-in', maxLength: 40, placeholder: t('new.name_placeholder'), autocomplete: 'off' });
  const err = h('p', { class: 'small bad', role: 'alert' });
  name.oninput = () => { err.textContent = ''; };
  const modes = h('div', { class: 'ws-mode-cards', role: 'radiogroup', 'aria-labelledby': 'ng-mode-h' });
  const starts = h('div', { class: 'ws-start-cards', role: 'radiogroup', 'aria-labelledby': 'ng-start-h' });
  const go = h('button', { type: 'submit', class: 'pill primary big' }, icon('plus'), t('new.create'));

  function render(): void {
    modes.replaceChildren(...MODES.map((m) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(m === mode), class: `ws-mode-card${m === mode ? ' on' : ''}`,
      onclick: () => { mode = m; render(); },
    }, sketch(m), h('span', { class: 'ws-tile-title' }, t(`mode.${m}`)), h('span', { class: 'ws-tile-sub' }, t(`mode.${m}_sub`)))));
    const opt = (s: Start, ico: string, title: string, sub: string): HTMLElement => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(s === start), class: `ws-tile${s === start ? ' on' : ''}`,
      onclick: () => { start = s; render(); },
    }, icon(ico), h('span', { class: 'ws-tile-title' }, t(title)), h('span', { class: 'ws-tile-sub' }, t(sub)));
    starts.replaceChildren(
      opt('draw', 'marker', 'ws.start_draw', 'ws.start_draw_sub'),
      opt('scan', 'camera', 'ws.start_scan', 'ws.start_scan_sub'),
      opt('describe', 'pencil', 'ws.start_describe', 'ws.start_describe_sub'),
      opt('workspace', 'rules', 'new.start_empty', 'new.start_empty_sub'));
  }

  const form = h('form', { class: 'ws-page ws-new-page' },
    h('h1', { class: 'ws-hello' }, h('span', { class: 'marker-underline' }, t('new.title'))),
    h('section', { class: 'ws-new-sec' }, h('label', { for: 'ng-name', class: 'ws-h2' }, t('new.name_label')), name, err),
    h('section', { class: 'ws-new-sec' }, h('h2', { id: 'ng-mode-h', class: 'ws-h2' }, t('new.mode_label')), modes),
    h('section', { class: 'ws-new-sec' }, h('h2', { id: 'ng-start-h', class: 'ws-h2' }, t('new.start_label')), starts),
    h('div', { class: 'row' }, go));

  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = name.value.trim();
    if (!title) {
      err.textContent = t('new.need_name');
      name.focus();
      return;
    }
    if (busy) return;
    busy = true;
    go.disabled = true;
    try {
      const p = await ensurePlayer();
      const g = await api.createGame(title, p.name);
      await collab.join(g.id).catch(() => null);
      if (mode !== 'platformer') {
        const rules = (await api.rules(g.id).catch(() => null)) ?? DEFAULT_RULES;
        await api.putRules(g.id, { ...rules, mode }).catch(() => null);
      }
      if (disposed) return;
      shell.noteGame(g.id, g.title);
      const id = encodeURIComponent(g.id);
      navigate(start === 'draw' ? `#/draw?new=1&game=${id}` : start === 'scan' ? `#/scan?game=${id}` : start === 'describe' ? `#/prompt?game=${id}` : `#/game/${id}`);
    } catch (e2) {
      toast(t(e2 instanceof ApiError ? e2.messageKey : 'collab.need_profile'));
    } finally {
      busy = false;
      go.disabled = false;
    }
  };

  render();
  root.append(form);
  name.focus();
  return () => {
    disposed = true;
  };
}
