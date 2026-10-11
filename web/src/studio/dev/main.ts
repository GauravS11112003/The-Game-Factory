/**
 * Dev page for the Studio runtime (web/studio-dev.html): pick a template, override its theme, toggle 2 players, and
 * watch events and counters. "Theme gallery" renders one sketch and every background in each preset theme.
 * Serve with `npx vite --port 5191` in web/ and open /studio-dev.html (#<template> picks one).
 */
import type { Drawing, GameDoc, StudioTheme } from '../../core/types.gen.ts';
import { mountRuntime, type RuntimeHandle } from '../runtime/index.ts';
import { renderBackground, renderDrawing, THEMES } from '../theme/index.ts';

const files = import.meta.glob('../../../../shared/studio/templates/*.json', { eager: true, import: 'default' }) as Record<string, GameDoc>;
const templates = Object.entries(files).map(([path, doc]) => ({ name: path.split('/').pop()!.replace('.json', ''), doc }))
  .sort((a, b) => (a.name === 'blank' ? 1 : b.name === 'blank' ? -1 : a.name.localeCompare(b.name)));

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const tplSel = $<HTMLSelectElement>('tpl');
const themeSel = $<HTMLSelectElement>('theme');
const stage = $<HTMLDivElement>('stage');
const log = $<HTMLUListElement>('log');
const countersPre = $<HTMLPreElement>('counters');
const help = $<HTMLParagraphElement>('help');

const HELP: Record<string, string> = {
  hill_climb: '→ / D gas, ← / A brake and reverse; in the air they tilt the car. Collect fuel cans, do not land on your roof.',
  fighter: 'Move ← → / A D, jump ↑ / W / Space, punch E / Enter, fireball Q / Shift. 2 players: P1 WASD + F G, P2 arrows + L K.',
  space_shooter: '↑ thrust, ← → turn, Space shoots. 200 points wins.',
  platformer: '← → run, ↑ / W / Space jump. Squash slimes by landing on them, reach the green flag.',
  physics_puzzle: 'Drag the bird back with the mouse and let go. Knock out every pig.',
  catch: '← → move the basket. Catch 25 stars, dodge the bombs.',
  flappy: 'Space, ↑ or tap to flap. 15 pipes wins.',
  top_down: 'Arrows / WASD to walk. Find a key, open the vault, grab the treasure. Bats chase you.',
  runner: 'Jump with ↑ / W / Space (double jump). 100 points wins.',
  blank: 'An empty canvas.',
};

for (const t of templates) tplSel.append(new Option(t.name, t.name));
for (const th of THEMES) themeSel.append(new Option(th.name ?? th.id ?? '?', th.id ?? ''));
const fromHash = location.hash.slice(1);
if (templates.some((t) => t.name === fromHash)) tplSel.value = fromHash;

let handle: RuntimeHandle | null = null;
let paused = false;

function current(): GameDoc {
  const t = templates.find((x) => x.name === tplSel.value) ?? templates[0];
  const doc = JSON.parse(JSON.stringify(t.doc)) as GameDoc;
  const th = THEMES.find((x) => x.id === themeSel.value);
  if (th) doc.theme = JSON.parse(JSON.stringify(th)) as StudioTheme;
  if ($<HTMLInputElement>('p2').checked) for (const s of doc.scenes) s.world = { ...s.world, players: 2 };
  return doc;
}

function addLog(text: string): void {
  const li = document.createElement('li');
  li.textContent = `${(performance.now() / 1000).toFixed(1)}s ${text}`;
  log.prepend(li);
  while (log.childElementCount > 80) log.lastElementChild?.remove();
}

function mount(): void {
  handle?.stop();
  log.textContent = '';
  paused = false;
  help.textContent = HELP[tplSel.value] ?? '';
  location.hash = tplSel.value;
  handle = mountRuntime(stage, current(), {
    muted: $<HTMLInputElement>('muted').checked,
    onEvent: (e) => {
      if (e.type === 'counter') return;
      addLog(`${e.type}${e.object ? ` ${e.object}` : ''}${e.text ? ` "${e.text}"` : ''}${e.scene ? ` [${e.scene}]` : ''}`);
    },
  });
  (window as unknown as { rt: RuntimeHandle }).rt = handle;
  stage.querySelector<HTMLElement>('.rt-root')?.focus();
}

setInterval(() => {
  if (handle) countersPre.textContent = JSON.stringify(handle.counters(), (_, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v), 1);
}, 250);

tplSel.addEventListener('change', mount);
themeSel.addEventListener('change', mount);
$('p2').addEventListener('change', mount);
$('muted').addEventListener('change', mount);
$('remount').addEventListener('click', mount);
$('restart').addEventListener('click', () => handle?.restart());
$('pause').addEventListener('click', () => {
  paused = !paused;
  handle?.setPaused(paused);
});

// ---- theme gallery: one sketch + background in every preset --------------------------------------------

function sampleDrawing(): Drawing {
  const circle = (cx: number, cy: number, r: number): [number, number][] =>
    Array.from({ length: 18 }, (_, i) => [cx + Math.cos((i / 18) * Math.PI * 2) * r, cy + Math.sin((i / 18) * Math.PI * 2) * r] as [number, number]);
  return {
    w: 300,
    h: 160,
    strokes: [
      { points: [[-140, 60], [-60, 10], [0, 40], [70, -10], [140, 50]], color: '#1f1b18', width: 8, closed: false },
      { points: [[-120, -60], [-40, -60], [-40, 0], [-120, 0]], color: '#1f1b18', width: 6, closed: true },
      { points: circle(40, -40, 32) as [[number, number], ...[number, number][]], color: '#e4572e', width: 6, closed: true },
      { points: [[100, -70], [130, -20], [70, -20]], color: '#2e86ab', width: 6, closed: true, fill: '#9fd3e6' },
      { points: [[-20, 70]], color: '#3bb273', width: 14 },
    ],
  } as Drawing;
}

$('gal').addEventListener('click', () => {
  const g = $<HTMLDivElement>('gallery');
  g.textContent = '';
  const d = sampleDrawing();
  for (const th of THEMES) {
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 270;
    const ctx = c.getContext('2d')!;
    const t0 = performance.now();
    renderBackground(ctx, th, { width: 3200, height: 900 }, { x: 400, y: 0, zoom: 0.3 }, { w: 480, h: 270 });
    const img = renderDrawing(d, th, { scale: 1, pad: 8 });
    ctx.drawImage(img, 240 - img.width / 2, 150 - img.height / 2);
    const ms = performance.now() - t0;
    const f = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = `${th.name} · ${th.stroke?.style} · ${th.background?.style} · ${ms.toFixed(0)} ms`;
    f.append(c, cap);
    g.append(f);
  }
});

mount();

// ---- headless helpers for scripted playtests (they work even while the tab is hidden) -------------------
interface DevRunner { world: unknown; state: string; game: { isBooted: boolean; headlessStep(t: number, d: number): void } }
let fakeTime = 1e6;
const dev = {
  runner: (): DevRunner | null => (stage.querySelector('.rt-root') as (HTMLElement & { __runtime?: DevRunner }) | null)?.__runtime ?? null,
  key: (code: string, type: 'keydown' | 'keyup'): boolean => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true })),
  /** Advance the game n frames of 1/60 s; `bot(world, i)` runs before each frame and may return false to stop. */
  step(n: number, bot?: (w: never, i: number) => unknown): number {
    for (let i = 0; i < n; i++) {
      const r = dev.runner();
      if (!r) return i;
      if (!r.game.isBooted) continue; // stepping a game before it boots would drop its scene
      if (bot && r.world && bot(r.world as never, i) === false) return i;
      fakeTime += 1000 / 60;
      r.game.headlessStep(fakeTime, 1000 / 60);
    }
    return n;
  },
  /** Mount a template and resolve once its world exists. */
  async load(name: string): Promise<void> {
    tplSel.value = name;
    mount();
    for (let k = 0; k < 100 && !dev.runner()?.world; k++) {
      await new Promise((r) => setTimeout(r, 50));
      if (dev.runner()?.game.isBooted) dev.step(1);
    }
  },
};
(window as unknown as { studioDev: typeof dev }).studioDev = dev;
