import { h, icon } from './dom.ts';
import './agent-flow.css';

/** The first build shows the agent pipeline at work: each layer wires itself to the next, then steps aside. */
type AgentNode = { name: string; logo?: 'auth0' | 'photon' | 'vultr'; glyph?: string };
type AgentLayer = { caption: string; nodes: AgentNode[]; from?: number[] };

const LAYERS: AgentLayer[] = [
  { caption: 'Starting', nodes: [{ name: 'Initializing', glyph: 'star' }] },
  { caption: 'Signing in', nodes: [{ name: 'Auth0 initializing', logo: 'auth0' }] },
  { caption: 'Activating', nodes: [{ name: 'Game design', glyph: 'pencil' }, { name: 'Photon agent', logo: 'photon' }] },
  { caption: 'Game design team', from: [0], nodes: [{ name: 'UI design agent', glyph: 'grid' }, { name: 'Game physics agent', glyph: 'drop' },
    { name: 'Graphics design agent', glyph: 'camera' }, { name: 'Vultr agent', logo: 'vultr' }] },
  { caption: 'Saving', nodes: [{ name: 'Vultr agent', logo: 'vultr' }] },
  { caption: 'Vultr subtasks', nodes: [{ name: 'Data ingestion', glyph: 'next' }, { name: 'Multiplayer servers', glyph: 'person' },
    { name: 'Photon agent', logo: 'photon' }, { name: 'iMessage Bot', glyph: 'bot' }] },
  { caption: 'Handing off', nodes: [{ name: 'Photon agent', logo: 'photon' }] },
  { caption: 'Executing', nodes: [{ name: 'Photon server agent', logo: 'photon' }, { name: 'iMessage agent', glyph: 'share' }] },
];

const ENTER = 700;   // the next layer slides in
const DRAW = 700;    // lines are drawn toward it
const FLOW = 2600;   // signals travel along the lines
const SHIFT = 800;   // the old layer leaves and the new one takes its place
const STEP = ENTER + DRAW + FLOW + SHIFT;
const SVGNS = 'http://www.w3.org/2000/svg';

export function agentFlow(startedAt?: number): { element: HTMLElement; dispose: () => void } {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'agent-flow-wires');
  svg.setAttribute('aria-hidden', 'true');
  const caption = h('span', { class: 'agent-flow-caption' });
  const bar = h('span', { class: 'agent-flow-progress-bar' });
  const element = h('div', { class: 'agent-flow', role: 'img', 'aria-label': 'Agents are building your game' },
    svg, h('div', { class: 'agent-flow-head' }, h('span', { class: 'agent-flow-live', 'aria-hidden': 'true' }), caption),
    h('div', { class: 'agent-flow-progress', 'aria-hidden': 'true' }, bar));
  const timers: number[] = [];
  let wires: { path: SVGPathElement; dots: SVGCircleElement[]; from: HTMLElement; to: HTMLElement; length: number }[] = [];
  let left: HTMLElement | undefined;
  let right: HTMLElement | undefined;
  let frame = 0;
  let flowStart = 0;
  let disposed = false;

  const later = (ms: number, run: () => void) => { timers.push(window.setTimeout(() => { if (!disposed) run(); }, ms)); };
  const nextFrame = (run: () => void) => requestAnimationFrame(() => requestAnimationFrame(() => { if (!disposed) run(); }));

  function layerElement(layer: AgentLayer): HTMLElement {
    return h('div', { class: 'agent-layer', 'data-slot': 'enter' }, h('span', { class: 'agent-layer-caption' }, layer.caption),
      ...layer.nodes.map(node => h('div', { class: 'agent-node' },
        node.logo ? h('img', { class: `agent-node-logo logo-${node.logo}`, src: `/assets/agents/${node.logo}.png`, alt: '' })
          : h('span', { class: 'agent-node-glyph' }, icon(node.glyph ?? 'star')),
        h('span', null, node.name))));
  }
  function anchor(node: HTMLElement, side: 'left' | 'right'): [number, number] {
    const stage = element.getBoundingClientRect();
    const scale = stage.width / (element.offsetWidth || 1);
    const box = node.getBoundingClientRect();
    return [((side === 'right' ? box.right : box.left) - stage.left) / scale, (box.top + box.height / 2 - stage.top) / scale];
  }
  function route(from: HTMLElement, to: HTMLElement): string {
    const [x1, y1] = anchor(from, 'right');
    const [x2, y2] = anchor(to, 'left');
    const bend = (x2 - x1) * 0.5;
    return `M${x1 + 4},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2 - 4},${y2}`;
  }
  function layout(): void {
    svg.setAttribute('viewBox', `0 0 ${element.offsetWidth} ${element.offsetHeight}`);
    for (const wire of wires) {
      wire.path.setAttribute('d', route(wire.from, wire.to));
      wire.length = wire.path.getTotalLength();
    }
  }
  function connect(layer: AgentLayer): void {
    const sources = [...left!.querySelectorAll<HTMLElement>('.agent-node')].filter((_, i) => !layer.from || layer.from.includes(i));
    const targets = [...right!.querySelectorAll<HTMLElement>('.agent-node')];
    svg.setAttribute('viewBox', `0 0 ${element.offsetWidth} ${element.offsetHeight}`);
    svg.replaceChildren();
    wires = [];
    for (const from of sources) from.classList.add('is-sending');
    for (const from of sources) for (const to of targets) {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'agent-wire');
      path.setAttribute('d', route(from, to));
      svg.append(path);
      const length = path.getTotalLength();
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
      path.style.transitionDelay = `${wires.length * 90}ms`;
      const dots = reduced ? [] : [0, 1, 2].map(() => {
        const dot = document.createElementNS(SVGNS, 'circle');
        dot.setAttribute('class', 'agent-signal'); dot.setAttribute('r', '3.5'); dot.style.opacity = '0';
        svg.append(dot); return dot;
      });
      wires.push({ path, dots, from, to, length });
    }
    nextFrame(() => { for (const wire of wires) wire.path.style.strokeDashoffset = '0'; });
    later(DRAW + (wires.length - 1) * 90, () => {
      for (const wire of wires) { wire.path.style.strokeDasharray = 'none'; wire.path.style.transitionDelay = '0ms'; }
      flowStart = performance.now();
      if (!reduced && !frame) frame = requestAnimationFrame(animate);
    });
    targets.forEach((to, i) => later(DRAW + 500 + i * 160, () => to.classList.add('is-active')));
  }
  function animate(now: number): void {
    frame = requestAnimationFrame(animate);
    for (const wire of wires) wire.dots.forEach((dot, k) => {
      const t = ((now - flowStart) / 1500 + k / 3) % 1;
      const point = wire.path.getPointAtLength(t * wire.length);
      dot.setAttribute('cx', String(point.x)); dot.setAttribute('cy', String(point.y));
      dot.style.opacity = String(Math.min(1, t * 6, (1 - t) * 6));
    });
  }
  function show(index: number): void {
    const layer = LAYERS[index];
    caption.textContent = layer.caption;
    bar.style.width = `${Math.round(((index + 1) / LAYERS.length) * 100)}%`;
    right = layerElement(layer);
    element.append(right);
    nextFrame(() => { right!.dataset.slot = 'right'; });
    later(ENTER, () => connect(layer));
    if (index === LAYERS.length - 1) return; // The last pair keeps working until the game is ready.
    later(ENTER + DRAW + FLOW, () => {
      svg.classList.add('is-fading');
      const leaving = left!;
      leaving.dataset.slot = 'leave';
      right!.dataset.slot = 'left';
      left = right;
      later(SHIFT, () => {
        leaving.remove(); svg.classList.remove('is-fading'); svg.replaceChildren(); wires = [];
        for (const node of left!.querySelectorAll('.agent-node')) node.classList.remove('is-sending');
        show(index + 1);
      });
    });
  }

  // A reload mid-build picks the story back up near where the server is.
  const elapsed = startedAt ? Math.max(0, Date.now() - startedAt * 1000) : 0;
  const start = Math.min(LAYERS.length - 2, Math.floor(elapsed / STEP));
  left = layerElement(LAYERS[start]);
  left.dataset.slot = 'left';
  for (const node of left.querySelectorAll('.agent-node')) node.classList.add('is-active');
  element.append(left);
  later(start ? 0 : 500, () => show(start + 1));
  const resize = new ResizeObserver(() => layout());
  resize.observe(element);

  return {
    element,
    dispose: () => {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      resize.disconnect();
    },
  };
}
