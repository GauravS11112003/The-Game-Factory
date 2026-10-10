/**
 * v2 web shell (lane F). Served at http://localhost:5173/v2.html beside v1 until the P6 switch-over.
 * P0: a hash router with stubbed screens. Working pieces: health, the SSE sample build (#/preview), the conformance
 * levels validated and hashed in the browser core and drawn by the mountGame stub (#/dev, #/play/example).
 */
import './style.css';
import example from '../../../shared/spec/conformance/levels/valid/example_2screen.json';
import { levelHash, validateLevel } from '../core/index.ts';
import type { BuildEvent, LevelV2 } from '../core/types.gen.ts';
import { mountGame } from '../engine/index.ts';
import type { GameHandle } from '../engine/types.ts';
import { api } from './api.ts';
import { t } from './messages.ts';
import { followBuild } from './sse.ts';

const conformance = import.meta.glob('../../../shared/spec/conformance/levels/*/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

type Screen = (root: HTMLElement, params: string[]) => void | (() => void);

const EXAMPLE = example as unknown as LevelV2;
let game: GameHandle | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function stub(title: string, lane: string, phase: string): Screen {
  return (root) => {
    root.append(el('div', { className: 'card' }, el('h2', {}, title), el('p', { className: 'muted' }, `${t('error.not_implemented')} (${lane}, ${phase})`)));
  };
}

function mount(root: HTMLElement, level: LevelV2): void {
  game?.destroy();
  const stage = el('div', { className: 'card' });
  root.append(stage);
  game = mountGame(stage, level, null, { mode: 'preview', rules: level.rules });
}

const home: Screen = (root) => {
  const status = el('p', { className: 'muted' }, '…');
  root.append(
    el('div', { className: 'card' }, el('h2', {}, 'draw-a-level v2'), status,
      el('p', {}, 'P0 shell. v1 keeps running at ', el('a', { href: '/' }, '/'), '.')),
  );
  api.health().then(
    (h) => {
      status.textContent = `API v2 ok · model ${h.llm} · builder ${h.worker === 'ok' ? 'ready' : 'restarting'} · core ${h.core_version ?? '?'}`;
    },
    () => {
      status.textContent = t('toast.builder_restarting');
    },
  );
};

const preview: Screen = (root) => {
  const log = el('div', { className: 'card events' });
  const stageBox = el('div');
  const start = el('button', { type: 'button' }, 'Run the sample build');
  root.append(el('div', { className: 'card' }, el('h2', {}, t('stage.designed')), start), stageBox, log);
  let stop: (() => void) | null = null;
  start.onclick = async () => {
    start.disabled = true;
    const form = new FormData();
    form.append('ink', new Blob(['{}'], { type: 'application/json' }), 'ink.json');
    const b = await api.createBuild(form);
    stop = followBuild(b.events_url, b.draft_id, (e: BuildEvent) => {
      const line = el('div', {}, `#${e.seq} ${e.event}`);
      if (e.event === 'stage') line.textContent += ` · ${t(`stage.${e.data.stage}`)} ${t(`stage.status.${e.data.status}`)} (${e.data.t_ms} ms)`;
      if (e.event === 'tier' && e.data.tier === 'polished') mount(stageBox, { ...e.data.level, ink: null } as LevelV2);
      if (e.event === 'note') line.textContent += ` · ${e.data.designer_note}`;
      log.append(line);
    });
  };
  return () => stop?.();
};

const dev: Screen = (root) => {
  const card = el('div', { className: 'card' }, el('h2', {}, 'Conformance levels (browser core)'));
  root.append(card);
  for (const [path, doc] of Object.entries(conformance).sort()) {
    const name = path.split('/').slice(-2).join('/');
    const r = validateLevel(doc);
    const wantValid = name.startsWith('valid/');
    const okText = r.ok === wantValid ? 'ok' : 'MISMATCH';
    const row = el('div', {}, el('span', { className: r.ok === wantValid ? 'ok' : 'bad' }, okText), ` ${name} `,
      el('span', { className: 'muted' }, r.ok ? levelHash(r.level).slice(0, 19) + '…' : r.errors[0] ?? ''));
    if (r.ok) {
      const level = r.level;
      const b = el('button', { type: 'button' }, 'show');
      b.onclick = () => mount(root, level);
      row.append(' ', b);
    }
    card.append(row);
  }
};

const play: Screen = (root, [id]) => {
  if (id === 'example') return mount(root, EXAMPLE);
  stub('Play', 'lane F', 'P4')(root, []);
};

const ROUTES: [RegExp, Screen][] = [
  [/^#?\/?$/, home],
  [/^#\/draw$/, stub('Draw', 'lane F', 'P1')],
  [/^#\/scan$/, stub('Scan paper', 'lane F', 'P2')],
  [/^#\/preview(?:\/([\w-]+))?$/, preview],
  [/^#\/play\/([\w-]+)$/, play],
  [/^#\/game\/([\w-]+)\/rules$/, stub('Rules sheet', 'lane F', 'P5')],
  [/^#\/game\/([\w-]+)$/, stub('Game', 'lane F', 'P4')],
  [/^#\/tree\/([\w-]+)$/, stub('Remix tree', 'lane F', 'P4')],
  [/^#\/library$/, stub('Library', 'lane F', 'P5')],
  [/^#\/prompt$/, stub('Prompt to level', 'lane F', 'P5')],
  [/^#\/golden$/, stub('Golden review', 'lane F', 'P4')],
  [/^#\/dev$/, dev],
];

let cleanup: (() => void) | void;

function route(): void {
  const root = document.getElementById('app')!;
  cleanup?.();
  game?.destroy();
  game = null;
  root.replaceChildren();
  const hash = location.hash || '#/';
  for (const [re, screen] of ROUTES) {
    const m = re.exec(hash);
    if (m) {
      cleanup = screen(root, m.slice(1).filter((x): x is string => x !== undefined));
      return;
    }
  }
  root.append(el('div', { className: 'card' }, t('error.not_found')));
}

window.addEventListener('hashchange', route);
route();
