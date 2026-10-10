/**
 * Engine dev page (web/dev.html): mounts a Starter World fixture with
 * keyboard controls, a fixture dropdown, a debug toggle, the solver verdict
 * and the feed-card thumbnail. No backend needed.
 */
import { mountGame, renderThumbnail, type GameHandle } from '../game/index';
import { solve } from '../solver/solve';
import type { Level } from '../types';
import { FIXTURES } from './fixtures';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing in dev.html`);
  return el as T;
}

const stage = $<HTMLDivElement>('stage');
const select = $<HTMLSelectElement>('fixture');
const debugBox = $<HTMLInputElement>('debug');
const restartBtn = $<HTMLButtonElement>('restart');
const solverOut = $<HTMLElement>('solver');
const log = $<HTMLElement>('log');
const thumbs = $<HTMLElement>('thumbs');

let handle: GameHandle | null = null;

function logLine(text: string): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  log.prepend(li);
  while (log.children.length > 12) log.lastElementChild?.remove();
}

function showSolver(level: Level): void {
  const t0 = performance.now();
  const r = solve(level);
  const ms = (performance.now() - t0).toFixed(1);
  solverOut.textContent = r.solvable
    ? `solvable ✓  (${r.reachable.length} standing cells, ${ms} ms)`
    : `unsolvable: ${r.reason}  (${r.reachable.length} standing cells, ${ms} ms)`;
  solverOut.className = r.solvable ? 'ok' : 'bad';
}

function mount(level: Level): void {
  handle?.destroy();
  stage.replaceChildren();
  handle = mountGame(stage, level, { debug: debugBox.checked, assetBase: '' });
  handle.on('ready', () => logLine(`ready: ${level.title}`));
  handle.on('coin', (p) => logLine(`coin ${p.id} (${p.count}/${p.total})`));
  handle.on('die', (p) => logLine(`die #${p.deaths}`));
  handle.on('win', (p) => logLine(`win in ${(p.timeMs / 1000).toFixed(1)}s, ${p.coins}/${p.total} coins, ${p.deaths} deaths`));
  showSolver(level);
  location.hash = select.value;
}

for (const f of FIXTURES) {
  const opt = document.createElement('option');
  opt.value = f.name;
  opt.textContent = `${f.level.title} (${f.name})`;
  select.append(opt);
}

for (const f of FIXTURES) {
  const card = document.createElement('figure');
  const canvas = renderThumbnail(f.level, 240);
  const cap = document.createElement('figcaption');
  cap.textContent = f.level.title;
  card.append(canvas, cap);
  card.addEventListener('click', () => {
    select.value = f.name;
    mount(f.level);
  });
  thumbs.append(card);
}

const initial = FIXTURES.find((f) => f.name === location.hash.slice(1)) ?? FIXTURES[0];
if (!initial) {
  solverOut.textContent = 'no fixtures found in shared/fixtures/levels';
} else {
  select.value = initial.name;
  mount(initial.level);
}

select.addEventListener('change', () => {
  const f = FIXTURES.find((x) => x.name === select.value);
  if (f) mount(f.level);
});
debugBox.addEventListener('change', () => {
  const f = FIXTURES.find((x) => x.name === select.value);
  if (f) mount(f.level);
});
restartBtn.addEventListener('click', () => handle?.restart());

// Console hook for poking the engine from devtools: __dal.mount(levelJson), __dal.FIXTURES, __dal.solve(level).
(window as unknown as { __dal: unknown }).__dal = { mount, FIXTURES, solve, handle: () => handle };
