/**
 * Generates the Studio templates (docs/v6/CONTRACTS_V6.md §4.4) into shared/studio/templates/*.json.
 * Every drawing is made of hand-drawn-looking strokes (seeded jitter, slightly wobbly lines, closed shapes with fills),
 * so the templates look like a person sketched them. Deterministic: same output on every run.
 *
 *   node --experimental-strip-types scripts/studio_templates.ts
 *
 * Templates: hill_climb, fighter, space_shooter, platformer, physics_puzzle, catch, flappy, top_down, runner (blank.json
 * is hand-written and left alone).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type P = [number, number];
interface Stroke { points: P[]; color: string; width: number; closed: boolean; fill: string | null }
interface Drawing { strokes: Stroke[]; w: number; h: number }
type Obj = Record<string, unknown>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'shared', 'studio', 'templates');
const THEMES = (JSON.parse(readFileSync(join(ROOT, 'shared', 'studio', 'themes.json'), 'utf8')) as { themes: Obj[] }).themes;

// ---- seeded hand jitter -------------------------------------------------------------------------------

let seed = 12345;
function rnd(): number {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const jit = (a: number): number => (rnd() * 2 - 1) * a;
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Subdivide and wobble a polyline like a hand would. */
function hand(pts: P[], amt = 1.6, step = 18, closed = false): P[] {
  const out: P[] = [];
  const n = closed ? pts.length : pts.length - 1;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.round(d / step));
    const nx = -(b[1] - a[1]) / (d || 1);
    const ny = (b[0] - a[0]) / (d || 1);
    for (let j = 0; j < k; j++) {
      const t = j / k;
      drift = drift * 0.7 + jit(amt);
      out.push([r1(a[0] + (b[0] - a[0]) * t + nx * drift + jit(amt * 0.3)), r1(a[1] + (b[1] - a[1]) * t + ny * drift + jit(amt * 0.3))]);
    }
  }
  if (!closed) {
    const last = pts[pts.length - 1];
    out.push([r1(last[0] + jit(amt * 0.4)), r1(last[1] + jit(amt * 0.4))]);
  }
  return out;
}

const S = (points: P[], color: string, width = 6, closed = false, fill: string | null = null): Stroke => ({ points, color, width, closed, fill });

function rect(cx: number, cy: number, w: number, h: number, color: string, fill: string | null, width = 6, amt = 1.4): Stroke {
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const c = (x: number, y: number): P => [x + jit(amt * 1.5), y + jit(amt * 1.5)];
  return S(hand([c(x0, y0), c(x0 + w, y0), c(x0 + w, y0 + h), c(x0, y0 + h)], amt, 20, true), color, width, true, fill);
}

function circle(cx: number, cy: number, r: number, color: string, fill: string | null, width = 6, amt = 1.2, n = 0): Stroke {
  const k = n || Math.max(10, Math.round(r / 3));
  const pts: P[] = [];
  const ph = rnd() * Math.PI * 2;
  for (let i = 0; i < k; i++) {
    const a = ph + (i / k) * Math.PI * 2;
    const rr = r + jit(amt);
    pts.push([r1(cx + Math.cos(a) * rr), r1(cy + Math.sin(a) * rr)]);
  }
  return S(pts, color, width, true, fill);
}

function poly(pts: P[], color: string, fill: string | null, width = 6, amt = 1.4): Stroke {
  return S(hand(pts, amt, 18, true), color, width, true, fill);
}

function line(pts: P[], color: string, width = 6, amt = 1.4, step = 18): Stroke {
  return S(hand(pts, amt, step), color, width, false, null);
}

function star(cx: number, cy: number, r: number, color: string, fill: string, width = 5): Stroke {
  const pts: P[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const rr = i % 2 ? r * 0.45 : r;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return poly(pts, color, fill, width, 0.8);
}

function blob(cx: number, cy: number, r: number, bump: number, color: string, fill: string, width = 6): Stroke {
  const k = 14;
  const pts: P[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const rr = r * (1 + jit(bump));
    pts.push([r1(cx + Math.cos(a) * rr), r1(cy + Math.sin(a) * rr)]);
  }
  return S(pts, color, width, true, fill);
}

/** A drawing, re-centred on its bounding box; returns the offset that was removed. */
function drawing(strokes: Stroke[]): { d: Drawing; cx: number; cy: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) for (const [x, y] of s.points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const s of strokes) s.points = s.points.map(([x, y]) => [r1(x - cx), r1(y - cy)] as P);
  return { d: { strokes, w: r1(maxX - minX), h: r1(maxY - minY) }, cx, cy };
}

/** An object whose strokes are drawn in world coordinates (centre = their bbox centre). */
function drawn(id: string, strokes: Stroke[], props: Obj = {}): Obj {
  const { d, cx, cy } = drawing(strokes);
  return { id, name: props.name ?? '', kind: 'thing', drawing: d, x: r1(cx), y: r1(cy), rotation: 0, scale: 1, layer: 0,
    physics: { body: 'static' }, behaviors: [], rules: [], counters: {}, tags: [], joints: [], template: false, hidden: false, player: 0, ...props };
}

/** An invisible box (zones, spawners, sensors). */
function zone(id: string, x: number, y: number, w: number, h: number, props: Obj = {}): Obj {
  return { id, name: props.name ?? '', kind: 'zone', drawing: { strokes: [], w, h }, x, y, rotation: 0, scale: 1, layer: 0,
    physics: { body: 'static', sensor: true }, behaviors: [], rules: [], counters: {}, tags: [], joints: [], template: false, hidden: false,
    player: 0, ...props };
}

const B = (id: string, type: string, params: Obj = {}): Obj => ({ id, type, params });
const R = (id: string, when: Obj, then: Obj[], extra: Obj = {}): Obj => ({ id, when, then, conditions: [], once: false, ...extra });
const E = (type: string, params: Obj = {}): Obj => ({ type, params });
const A = (type: string, params: Obj = {}): Obj => ({ type, params });

function theme(id: string): Obj {
  const t = THEMES.find((x) => x.id === id);
  if (!t) throw new Error(`no theme ${id}`);
  return JSON.parse(JSON.stringify(t)) as Obj;
}

function world(kind: string, o: Obj): Obj {
  return { kind, width: 1600, height: 900, gravity: [0, 1], camera: { mode: 'fixed', target: null, axis: 'xy', speed: 120, zoom: 1 },
    edges: 'walls', players: 1, ...o, ...(o.camera ? { camera: { mode: 'fixed', target: null, axis: 'xy', speed: 120, zoom: 1, ...(o.camera as Obj) } } : {}) };
}

function game(id: string, title: string, th: string, w: Obj, objects: Obj[], o: Obj = {}): Obj {
  return {
    format: 'drawplay-studio', version: 1, id: `tpl_${id}`, title, author: 'draw.play', theme: theme(th),
    hud: { items: [], timer: false, title: null, ...(o.hud as Obj ?? {}) },
    rules: o.rules ?? [], counters: o.counters ?? {},
    scenes: [{ id: 's1', name: (o.sceneName as string) ?? 'Level 1', world: w, objects, rules: o.sceneRules ?? [] }],
  };
}

// ---- shared props ---------------------------------------------------------------------------------------

const coin = (id: string, x: number, y: number, props: Obj = {}): Obj => drawn(id, [
  circle(x, y, 18, '#b07d12', '#ffd23f', 5, 0.7),
  line([[x - 3, y - 8], [x - 3, y + 8]], '#b07d12', 4, 0.5, 8),
], { kind: 'coin', tags: ['coin'], layer: 1, physics: { body: 'static', sensor: true },
  behaviors: [B('pick', 'pickup', { item: 'coins', amount: 1, to: 'player' }), B('bob', 'float', { amplitude: 5, period: 1.6 })], ...props });

const flag = (id: string, x: number, groundY: number, color: string, props: Obj = {}): Obj => drawn(id, [
  line([[x, groundY], [x, groundY - 150]], '#3b2f2f', 7, 1, 20),
  poly([[x + 2, groundY - 150], [x + 70, groundY - 128], [x + 2, groundY - 104]], '#3b2f2f', color, 5, 1),
], props);

// ---- 1. hill climb racer --------------------------------------------------------------------------------

function hillClimb(): Obj {
  seed = 101;
  const W = 12000;
  const terrain = (x: number): number => {
    const k = Math.min(1.2, x / 4000); // gentle at the start, wilder further out (slopes stay under ~40°)
    return 980 - 70 * k * Math.sin(x / 520) - 130 * k * Math.sin(x / 1300 + 1) - 55 * Math.sin(x / 260) * k * k - 12 * Math.sin(x / 90) * k;
  };
  const pts: P[] = [];
  for (let x = 0; x <= W; x += 40) pts.push([x, terrain(x)]);
  const flat = (x: number): number => (x < 700 ? 980 : terrain(x));
  const tpts = pts.map(([x]) => [x, r1(flat(x) + jit(1.2))] as P);
  const ground = drawn('ground', [S(tpts, '#5a3d1e', 14)], { name: 'Hills', kind: 'ground', tags: ['ground'],
    physics: { body: 'static', shape: 'line', friction: 1.2 } });
  const soil = drawn('soil', [S([...tpts.map(([x, y]) => [x, y + 6] as P), [W, 1400], [0, 1400]], '#7a5230', 4, true, '#c99a5b')],
    { name: 'Soil', kind: 'decoration', layer: -2, physics: { body: 'none' } });
  const grass = drawn('grass', [S(tpts.map(([x, y]) => [x, y - 6] as P), '#4f9d3a', 8)],
    { name: 'Grass', kind: 'decoration', layer: 1, physics: { body: 'none' } });
  const wall = drawn('start_wall', [line([[30, 990], [30, 500]], '#5a3d1e', 14)], { name: 'Wall', kind: 'wall', physics: { body: 'static', shape: 'line' } });
  const cx = 360;
  const cy = 980 - 95;
  const car = drawn('car', [
    poly([[cx - 85, cy + 12], [cx - 80, cy - 18], [cx - 30, cy - 22], [cx - 10, cy - 52], [cx + 40, cy - 52], [cx + 62, cy - 20], [cx + 88, cy - 12],
      [cx + 88, cy + 14]], '#1f1b18', '#e4572e', 6),
    poly([[cx - 2, cy - 44], [cx + 34, cy - 44], [cx + 50, cy - 22], [cx - 2, cy - 22]], '#1f1b18', '#bfe3f2', 4),
    line([[cx - 60, cy + 2], [cx + 70, cy + 2]], '#1f1b18', 3, 0.6),
  ], { name: 'Car', kind: 'car', tags: ['player'], player: 1, layer: 2,
    physics: { body: 'dynamic', shape: 'auto', density: 2, friction: 0.5 },
    behaviors: [B('drive', 'car', { power: 1.1, max_speed: 1100, tilt: 0.9, fuel_counter: 'fuel', distance_counter: 'distance' })],
    counters: { fuel: 8 } });
  const carY = car.y as number;
  const wheel = (id: string, x: number): Obj => drawn(id, [
    circle(x, cy + 30, 30, '#1f1b18', '#3a3a3a', 7, 0.8, 18),
    circle(x, cy + 30, 11, '#1f1b18', '#cfcfcf', 4, 0.4, 10),
    line([[x - 22, cy + 30], [x + 22, cy + 30]], '#cfcfcf', 3, 0.3, 10),
  ], { name: 'Wheel', kind: 'wheel', tags: ['wheel'], layer: 3, physics: { body: 'dynamic', shape: 'circle', friction: 1.4, density: 1.2 } });
  const wl = wheel('wheel_back', cx - 52);
  const wr = wheel('wheel_front', cx + 58);
  const cxw = car.x as number;
  car.joints = [
    { type: 'wheel', to: 'wheel_back', at: [r1((wl.x as number) - cxw), r1((wl.y as number) - carY)], to_at: [0, 0], motor: true, speed: 0, length: null, stiffness: 0.5 },
    { type: 'wheel', to: 'wheel_front', at: [r1((wr.x as number) - cxw), r1((wr.y as number) - carY)], to_at: [0, 0], motor: true, speed: 0, length: null, stiffness: 0.5 },
    { type: 'weld', to: 'roof', at: [r1(cx + 15 - cxw), r1(cy - 60 - carY)], to_at: [0, 0], motor: false, speed: 0, length: null, stiffness: 1 },
  ];
  const roof = zone('roof', cx + 15, cy - 60, 70, 18, { name: 'Roof sensor', physics: { body: 'dynamic', sensor: true, density: 0.05, gravity_scale: 0 },
    rules: [R('flip', E('overlap', { with: 'ground' }), [A('say', { text: 'Ouch!', target: 'car', seconds: 1.5 }), A('lose')], { text: 'If the roof touches the ground, you lose' })] });
  const objs: Obj[] = [soil, ground, grass, wall, car, wl, wr, roof];
  let n = 0;
  for (let x = 2200; x < W - 600; x += 2400) {
    const y = flat(x) - 70;
    objs.push(drawn(`fuel${++n}`, [
      rect(x, y, 40, 50, '#1f1b18', '#d7263d', 5, 1),
      line([[x - 10, y - 12], [x + 10, y + 12]], '#ffffff', 4, 0.5, 8),
      rect(x + 6, y - 31, 14, 10, '#1f1b18', '#888888', 3, 0.5),
    ], { name: 'Fuel can', kind: 'fuel', tags: ['fuel'], layer: 1, physics: { body: 'static', sensor: true },
      behaviors: [B('pick', 'pickup', { item: 'fuel', amount: 6, to: 'player' }), B('bob', 'float', { amplitude: 4, period: 2 })] }));
  }
  let c = 0;
  for (let x = 900; x < W - 600; x += 760) {
    for (let i = 0; i < 5; i++) {
      const xx = x + i * 46;
      const o = coin(`coin${++c}`, xx, flat(xx) - 62);
      (o.behaviors as Obj[])[0] = B('pick', 'pickup', { item: 'score', amount: 1, to: 'player' });
      objs.push(o);
    }
  }
  objs.push(flag('finish', W - 300, flat(W - 300), '#3bb273', { name: 'Finish', kind: 'goal', tags: ['goal'], physics: { body: 'static', sensor: true },
    behaviors: [B('goal', 'goal', { by: 'player', then: 'win' })] }));
  const doc = game('hill_climb', 'Hill Climb', 'sketchbook',
    world('hill climb racer', { width: W, height: 1400, edges: 'none', camera: { mode: 'follow', zoom: 0.9 } }), objs, {
      counters: { score: 0, distance: 0 },
      hud: { items: [
        { subject: 'car', counter: 'fuel', label: 'Fuel', style: 'bar', max: 10 },
        { subject: 'game', counter: 'score', label: 'Coins', style: 'number', max: null },
        { subject: 'game', counter: 'distance', label: 'Metres', style: 'number', max: null },
      ], timer: false, title: null },
      rules: [R('nofuel', E('every', { seconds: 2 }), [A('say', { text: 'Out of fuel!', target: 'car', seconds: 1.5 }), A('lose')],
        { conditions: [{ subject: 'car', counter: 'fuel', op: '<=', value: 0 }], text: 'Out of fuel means game over' })],
    });
  // the sketchbook look, with rolling hills behind the track
  const th = doc.theme as Obj;
  th.id = 'sketchbook_hills';
  th.background = { style: 'hills', colors: ['#cfe6f2', '#f6f1e7', '#a8c98a', '#7fb069'], parallax: true };
  return doc;
}

// ---- 2. fighting game -----------------------------------------------------------------------------------

function fighter(): Obj {
  seed = 202;
  const ground = drawn('stage', [rect(800, 850, 1500, 60, '#111111', '#8d6e63', 7, 1.5)], { name: 'Stage', kind: 'platform', tags: ['ground'],
    physics: { body: 'static', friction: 0.6 } });
  const p1 = drawn('plat_left', [rect(380, 590, 300, 26, '#111111', '#c7a17a', 6, 1.2)], { name: 'Ledge', kind: 'platform', physics: { body: 'static' } });
  const p2 = drawn('plat_right', [rect(1220, 590, 300, 26, '#111111', '#c7a17a', 6, 1.2)], { name: 'Ledge', kind: 'platform', physics: { body: 'static' } });
  const fighterDraw = (x: number, y: number, body: string, band: string): Stroke[] => [
    circle(x, y - 62, 26, '#111111', '#ffe0bd', 6, 1, 14),
    poly([[x - 26, y - 34], [x + 26, y - 34], [x + 30, y + 30], [x - 30, y + 30]], '#111111', body, 6, 1.2),
    line([[x - 30, y - 70], [x + 30, y - 70]], band, 8, 0.6, 10),
    line([[x - 18, y + 30], [x - 22, y + 66]], '#111111', 9, 0.8, 12),
    line([[x + 18, y + 30], [x + 22, y + 66]], '#111111', 9, 0.8, 12),
    circle(x + 10, y - 66, 3, '#111111', '#111111', 3, 0.2, 6),
  ];
  const common = (who: 1 | 2): Obj => ({
    kind: 'fighter', tags: ['fighter'], player: who, layer: 2,
    physics: { body: 'dynamic', shape: 'box', fixed_rotation: true, friction: 0.2, density: 1.5 },
    behaviors: [
      B('move', 'platformer', { speed: 380, jump: 860, double_jump: true, air_control: 0.85 }),
      B('punch', 'melee', { key: 'action', damage: 1, range: 70, knockback: 520, cooldown: 0.35 }),
      B('fire', 'shooter', { projectile: 'fireball', key: 'action2', rate: 0.8, speed: 950, direction: 'facing', damage: 2, lifetime: 1.4 }),
      B('hp', 'health', { max: 15, invulnerable: 0.3, on_zero: 'destroy', bar: false }),
      ...(who === 2 ? [B('bot', 'ai_fighter', { target: 'player1', skill: 0.6 })] : []),
    ],
    counters: { health: 15 },
  });
  const f1 = drawn('fighter1', fighterDraw(420, 740, '#1e90ff', '#ff3b30'), { name: 'Blue', ...common(1) });
  const f2 = drawn('fighter2', fighterDraw(1180, 740, '#ff3b30', '#ffd60a'), { name: 'Red', ...common(2) });
  const fire = drawn('fireball', [
    blob(0, 0, 18, 0.18, '#ff7b00', '#ffd166', 5),
    circle(-4, 0, 8, '#ff3b30', '#fff3c4', 3, 0.5, 8),
  ], { name: 'Fireball', kind: 'projectile', tags: ['fireball'], template: true, layer: 3, x: 800, y: -200,
    physics: { body: 'dynamic', shape: 'circle', sensor: true, gravity_scale: 0, density: 0.2 }, behaviors: [B('spin', 'rotate', { speed: 540 })] });
  return game('fighter', 'Stick Fighters', 'comic_pop', world('fighting game', { gravity: [0, 1.2], players: 1 }), [ground, p1, p2, f1, f2, fire], {
    hud: { items: [], timer: true, title: null },
    sceneRules: [R('hello', E('start'), [A('say', { text: 'Fight!', target: 'fighter2', seconds: 1.4 })])],
  });
}

// ---- 3. space shooter -----------------------------------------------------------------------------------

function spaceShooter(): Obj {
  seed = 303;
  const ship = drawn('ship', [
    poly([[800, 410], [835, 490], [800, 475], [765, 490]], '#e0e7ff', '#4cc9f0', 5, 0.8),
    poly([[790, 476], [810, 476], [800, 500]], '#f72585', '#ffd166', 4, 0.4),
  ], { name: 'Ship', kind: 'ship', tags: ['player'], player: 1, layer: 2,
    physics: { body: 'dynamic', friction: 0, gravity_scale: 0, density: 1 },
    behaviors: [B('fly', 'thrust_ship', { thrust: 720, turn: 280, max_speed: 650 }),
      B('gun', 'shooter', { projectile: 'default', key: 'space', rate: 6, speed: 950, direction: 'facing', damage: 1, lifetime: 1.1 }),
      B('wrap', 'wrap'), B('hp', 'health', { max: 3, invulnerable: 1.5, on_zero: 'lose' })],
    counters: { health: 3 } });
  const rock = (id: string, x: number, y: number, r: number, template: boolean): Obj => drawn(id, [
    blob(x, y, r, 0.16, '#e0e7ff', '#6c6f8f', 6),
    circle(x - r * 0.3, y - r * 0.2, r * 0.22, '#e0e7ff', '#55587a', 3, 0.6, 8),
    circle(x + r * 0.35, y + r * 0.25, r * 0.15, '#e0e7ff', '#55587a', 3, 0.5, 8),
  ], { name: 'Asteroid', kind: 'asteroid', tags: ['asteroid'], template, layer: 1,
    physics: { body: 'dynamic', shape: 'circle', gravity_scale: 0, bounce: 0.8, friction: 0, density: 2 },
    behaviors: [B('wrap', 'wrap'), B('hurt', 'damage', { to: 'player', amount: 1, knockback: 300 }), B('hp', 'health', { max: 2, invulnerable: 0.05 }),
      B('spin', 'rotate', { speed: 30 + rnd() * 40 })],
    counters: { health: 2 },
    rules: [R('points', E('destroyed'), [A('add', { subject: 'game', counter: 'score', amount: 10 }), A('shake', { power: 0.6 }), A('sound', { name: 'boom' })])] });
  const rocks = [rock('rock', 800, -300, 52, true), rock('rock_a', 260, 200, 60, false), rock('rock_b', 1350, 260, 48, false), rock('rock_c', 1200, 760, 56, false)];
  const spawner = zone('rock_maker', 800, 0, 1600, 4, { name: 'Asteroid maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [B('spawn', 'spawner', { template: 'rock', every: 2.4, max: 7, area: 'self', velocity: [0, 70], jitter: 110 })] });
  return game('space_shooter', 'Space Rocks', 'deep_space', world('space shooter', { gravity: [0, 0], edges: 'wrap' }), [...rocks, ship, spawner], {
    counters: { score: 0 },
    hud: { items: [{ subject: 'game', counter: 'score', label: 'Score', style: 'number', max: null },
      { subject: 'player1', counter: 'health', label: 'Shield', style: 'hearts', max: 3 }], timer: false, title: null },
    rules: [R('win', E('counter', { subject: 'game', counter: 'score', op: '>=', value: 200 }), [A('win')], { text: 'Reach 200 points to win' })],
  });
}

// ---- 4. platformer ----------------------------------------------------------------------------------------

function platformer(): Obj {
  seed = 404;
  const G = 800;
  const segs: [number, number][] = [[0, 900], [1080, 1640], [1820, 2500], [2640, 3200]];
  const objs: Obj[] = [];
  segs.forEach(([a, b], i) => {
    objs.push(drawn(`ground${i + 1}`, [rect((a + b) / 2, G + 50, b - a, 100, '#2d2a26', '#9bc53d', 7, 1.6)],
      { name: 'Ground', kind: 'ground', tags: ['ground'], physics: { body: 'static', friction: 0.5 } }));
  });
  objs.push(drawn('wall_left', [line([[10, 900], [10, 0]], '#2d2a26', 14)], { name: 'Wall', kind: 'wall', physics: { body: 'static', shape: 'line' } }));
  objs.push(drawn('wall_right', [line([[3190, 900], [3190, 0]], '#2d2a26', 14)], { name: 'Wall', kind: 'wall', physics: { body: 'static', shape: 'line' } }));
  // stepping stones sit low over the pits (no head bumps mid-jump); the high ones are bonus ledges
  const plats: [number, number, number][] = [[600, 620, 220], [990, 690, 120], [1350, 520, 240], [2150, 470, 260], [2570, 690, 110], [2880, 560, 200]];
  plats.forEach(([x, y, w], i) => objs.push(drawn(`plat${i + 1}`, [rect(x, y, w, 30, '#2d2a26', '#e8c07d', 6, 1.2)],
    { name: 'Platform', kind: 'platform', tags: ['solid'], physics: { body: 'static', friction: 0.5 } })));
  // a moving platform over the second pit
  objs.push(drawn('lift', [rect(1730, 700, 140, 26, '#2d2a26', '#f4a261', 6, 1)], { name: 'Lift', kind: 'platform', physics: { body: 'kinematic' },
    behaviors: [B('move', 'oscillate', { axis: 'y', range: 220, period: 3 })] }));
  const hx = 160;
  objs.push(drawn('hero', [
    poly([[hx - 22, G - 70], [hx + 22, G - 70], [hx + 26, G - 2], [hx - 26, G - 2]], '#2d2a26', '#e4572e', 6, 1),
    circle(hx, G - 92, 22, '#2d2a26', '#ffe0bd', 6, 0.9, 12),
    circle(hx + 8, G - 96, 3, '#2d2a26', '#2d2a26', 3, 0.2, 6),
    line([[hx - 24, G - 108], [hx + 26, G - 112]], '#2e86ab', 8, 0.6, 10),
  ], { name: 'Hero', kind: 'player', tags: ['player'], player: 1, layer: 2,
    physics: { body: 'dynamic', fixed_rotation: true, friction: 0.1 },
    behaviors: [B('move', 'platformer', { speed: 330, jump: 780, double_jump: false, air_control: 0.85 }),
      B('hp', 'health', { max: 3, invulnerable: 1, on_zero: 'respawn' })],
    counters: { health: 3 } }));
  const slime = (id: string, x: number, range: number): Obj[] => {
    const body = drawn(id, [
      poly([[x - 34, G - 2], [x - 30, G - 34], [x - 10, G - 50], [x + 12, G - 50], [x + 30, G - 34], [x + 34, G - 2]], '#2d2a26', '#7b2cbf', 6, 1),
      circle(x - 10, G - 30, 5, '#2d2a26', '#ffffff', 3, 0.3, 6), circle(x + 10, G - 30, 5, '#2d2a26', '#ffffff', 3, 0.3, 6),
    ], { name: 'Slime', kind: 'enemy', tags: ['enemy'], layer: 1, physics: { body: 'dynamic', fixed_rotation: true, friction: 0.1 },
      behaviors: [B('walk', 'patrol', { range, speed: 90, axis: 'x' }), B('hurt', 'damage', { to: 'player', amount: 1, knockback: 420 })] });
    const by = body.y as number;
    const bh = (body.drawing as Drawing).h;
    const top = zone(`${id}_top`, x, by - bh / 2 - 10, 56, 26, { name: 'Stomp spot', physics: { body: 'dynamic', sensor: true, density: 0.05, gravity_scale: 0 },
      rules: [R('stomp', E('overlap', { with: 'player' }), [A('destroy', { target: id }), A('destroy', { target: 'self' }),
        A('velocity', { target: 'other', x: 0, y: -620 }), A('add', { subject: 'game', counter: 'score', amount: 5 }), A('sound', { name: 'boing' })],
      { text: 'Jump on a slime to squash it' })] });
    body.joints = [{ type: 'weld', to: `${id}_top`, at: [0, r1((top.y as number) - by)], to_at: [0, 0], motor: false, speed: 0, length: null, stiffness: 1 }];
    return [body, top];
  };
  objs.push(...slime('slime1', 650, 300), ...slime('slime2', 2200, 380), ...slime('slime3', 2900, 300));
  const coinsAt: P[] = [[600, 560], [640, 560], [990, 630], [1350, 460], [1390, 460], [1310, 460], [1730, 520], [2150, 410], [2190, 410], [2110, 410],
    [2570, 630], [2880, 500], [460, 740], [1250, 740], [2350, 740]];
  coinsAt.forEach(([x, y], i) => objs.push(coin(`coin${i + 1}`, x, y)));
  objs.push(flag('checkpoint', 1500, G, '#2e86ab', { name: 'Checkpoint', kind: 'checkpoint', tags: ['checkpoint'], physics: { body: 'static', sensor: true },
    behaviors: [B('save', 'checkpoint')] }));
  objs.push(flag('goal', 3060, G, '#3bb273', { name: 'Goal', kind: 'goal', tags: ['goal'], physics: { body: 'static', sensor: true },
    behaviors: [B('goal', 'goal', { by: 'player', then: 'win' })] }));
  return game('platformer', 'Coin Quest', 'sketchbook', world('platformer', { width: 3200, edges: 'none', camera: { mode: 'follow' } }), objs, {
    counters: { score: 0, lives: 3 },
    hud: { items: [{ subject: 'player1', counter: 'coins', label: 'Coins', style: 'icons', max: null },
      { subject: 'game', counter: 'lives', label: 'Lives', style: 'hearts', max: 3 }], timer: true, title: null },
  });
}

// ---- 5. physics puzzle --------------------------------------------------------------------------------

function physicsPuzzle(): Obj {
  seed = 505;
  const G = 840;
  const objs: Obj[] = [];
  objs.push(drawn('ground', [line([[0, G], [1600, G]], '#3a2e39', 12, 1.5, 40)], { name: 'Ground', kind: 'ground', tags: ['ground'],
    physics: { body: 'static', shape: 'line', friction: 0.9 } }));
  objs.push(drawn('slingshot', [
    line([[260, G], [262, 700]], '#6b3e26', 14, 1, 20), line([[262, 700], [232, 640]], '#6b3e26', 12, 1, 12),
    line([[262, 700], [292, 640]], '#6b3e26', 12, 1, 12),
  ], { name: 'Slingshot', kind: 'decoration', layer: -1, physics: { body: 'none' } }));
  objs.push(drawn('bird', [
    circle(262, 630, 26, '#3a2e39', '#e63946', 6, 0.8, 14),
    circle(272, 624, 7, '#3a2e39', '#ffffff', 3, 0.3, 8),
    poly([[284, 632], [300, 636], [284, 642]], '#3a2e39', '#ffb703', 3, 0.3),
  ], { name: 'Bird', kind: 'bird', tags: ['bird'], player: 1, layer: 2,
    physics: { body: 'dynamic', shape: 'circle', density: 3, bounce: 0.3, friction: 0.6 },
    behaviors: [B('sling', 'launcher', { power: 0.85, max_pull: 170, shots_counter: 'shots', out_of_shots: 'lose' }),
      B('bonk', 'damage', { to: 'pig', amount: 2, knockback: 0, min_speed: 120 })] }));
  const crate = (id: string, x: number, y: number, w: number, h: number): Obj => drawn(id, [
    rect(x, y, w, h, '#3a2e39', '#d4a373', 6, 1.2),
    line([[x - w / 2 + 6, y - h / 2 + 6], [x + w / 2 - 6, y + h / 2 - 6]], '#8c5a2b', 4, 0.8, 14),
  ], { name: 'Crate', kind: 'crate', tags: ['crate'], layer: 1, physics: { body: 'dynamic', shape: 'box', density: 0.7, friction: 0.7 },
    behaviors: [B('crush', 'damage', { to: 'pig', amount: 1, knockback: 0, min_speed: 330 })] });
  const pig = (id: string, x: number, y: number): Obj => drawn(id, [
    circle(x, y, 28, '#2b5329', '#7bd389', 6, 0.9, 14),
    circle(x - 9, y - 8, 5, '#2b5329', '#ffffff', 3, 0.3, 6), circle(x + 9, y - 8, 5, '#2b5329', '#ffffff', 3, 0.3, 6),
    poly([[x - 9, y + 4], [x + 9, y + 4], [x + 7, y + 14], [x - 7, y + 14]], '#2b5329', '#5fae6b', 3, 0.3),
  ], { name: 'Pig', kind: 'pig', tags: ['pig'], layer: 1, physics: { body: 'dynamic', shape: 'circle', density: 0.8, friction: 0.6 },
    behaviors: [B('hp', 'health', { max: 2, invulnerable: 0.15, on_zero: 'destroy' })], counters: { health: 2 },
    rules: [R('points', E('destroyed'), [A('add', { subject: 'game', counter: 'score', amount: 100 })])] });
  // left tower
  objs.push(crate('c1', 1000, G - 44, 76, 76), crate('c2', 1000, G - 128, 76, 76));
  objs.push(pig('pig1', 1000, G - 202));
  // a plank bridge, a pig beside it
  objs.push(crate('post1', 1160, G - 66, 26, 120), crate('post2', 1320, G - 66, 26, 120));
  objs.push(crate('plank', 1240, G - 150, 220, 24));
  objs.push(pig('pig2', 1386, G - 34));
  objs.push(crate('c3', 1240, G - 206, 70, 70));
  objs.push(pig('pig3', 1240, G - 280));
  // right stack
  objs.push(crate('c4', 1450, G - 44, 76, 76), pig('pig4', 1450, G - 120));
  return game('physics_puzzle', 'Crate Smash', 'crayon_kids', world('physics puzzle', { edges: 'floor' }), objs, {
    counters: { shots: 5, score: 0 },
    hud: { items: [{ subject: 'game', counter: 'shots', label: 'Birds left', style: 'number', max: null },
      { subject: 'game', counter: 'score', label: 'Score', style: 'number', max: null }], timer: false, title: null },
    rules: [R('win', E('all_gone', { tag: 'pig' }), [A('win')], { text: 'Knock out every pig to win' })],
    sceneRules: [R('hint', E('start'), [A('say', { text: 'Pull me back and let go!', target: 'bird', seconds: 3 })])],
  });
}

// ---- 6. catch game --------------------------------------------------------------------------------------

function catchGame(): Obj {
  seed = 606;
  const basket = drawn('basket', [
    poly([[700, 790], [900, 790], [870, 850], [730, 850]], '#6a2c70', '#ff9ec7', 6, 1),
    line([[715, 810], [885, 810]], '#6a2c70', 4, 0.8, 16), line([[725, 830], [875, 830]], '#6a2c70', 4, 0.8, 16),
  ], { name: 'Basket', kind: 'player', tags: ['player'], player: 1, layer: 2,
    physics: { body: 'dynamic', shape: 'box', gravity_scale: 0, fixed_rotation: true, density: 20, friction: 0 },
    behaviors: [B('move', 'move_keys', { speed: 760, axes: 'x' }), B('hp', 'health', { max: 3, invulnerable: 0.8, on_zero: 'lose' })],
    counters: { health: 3 } });
  const starT = drawn('star', [star(0, 0, 24, '#c77d00', '#ffd23f', 5)], { name: 'Star', kind: 'star', tags: ['star'], template: true, layer: 1,
    x: 300, y: -200, physics: { body: 'dynamic', sensor: true, gravity_scale: 0.55, density: 0.3 },
    behaviors: [B('pick', 'pickup', { item: 'score', amount: 1, to: 'player' }), B('spin', 'rotate', { speed: 120 }), B('life', 'lifetime', { seconds: 9 })] });
  const bomb = drawn('bomb', [
    circle(0, 0, 24, '#1a1a1a', '#3d3d3d', 6, 0.7, 14),
    line([[10, -20], [20, -34]], '#8a5a2b', 5, 0.6, 8), star(22, -38, 8, '#ff7b00', '#ffd166', 3),
  ], { name: 'Bomb', kind: 'bomb', tags: ['bomb'], template: true, layer: 1, x: 500, y: -200,
    physics: { body: 'dynamic', sensor: true, gravity_scale: 0.7, density: 0.5 },
    behaviors: [B('boom', 'damage', { to: 'player', amount: 1, knockback: 0, destroy_self: true }), B('life', 'lifetime', { seconds: 9 })],
    rules: [R('bang', E('destroyed'), [A('shake', { power: 1.2 }), A('sound', { name: 'boom' })])] });
  const stars = zone('star_cloud', 800, -40, 1400, 10, { name: 'Star maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [B('spawn', 'spawner', { template: 'star', every: 0.75, max: 10, area: 'self', velocity: [0, 60], jitter: 40 })] });
  const bombs = zone('bomb_cloud', 800, -40, 1400, 10, { name: 'Bomb maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [B('spawn', 'spawner', { template: 'bomb', every: 2.2, max: 3, area: 'self', velocity: [0, 80], jitter: 30 })] });
  const cloud = (id: string, x: number, y: number): Obj => drawn(id, [blob(x, y, 60, 0.12, '#e6a3c8', '#ffffff', 5), blob(x + 60, y + 10, 45, 0.12, '#e6a3c8', '#ffffff', 5)],
    { name: 'Cloud', kind: 'decoration', layer: -1, physics: { body: 'none' }, behaviors: [B('bob', 'float', { amplitude: 8, period: 4 })] });
  return game('catch', 'Star Catcher', 'candy', world('catch game', { gravity: [0, 0.5] }), [cloud('cloud1', 300, 140), cloud('cloud2', 1200, 110),
    starT, bomb, stars, bombs, basket], {
    counters: { score: 0 },
    hud: { items: [{ subject: 'game', counter: 'score', label: 'Stars', style: 'number', max: null },
      { subject: 'player1', counter: 'health', label: 'Lives', style: 'hearts', max: 3 }], timer: false, title: 'Catch 25 stars!' },
    rules: [R('win', E('counter', { subject: 'game', counter: 'score', op: '>=', value: 25 }), [A('win')], { text: 'Catch 25 stars to win' })],
  });
}

// ---- 7. flappy -------------------------------------------------------------------------------------------

function flappy(): Obj {
  seed = 707;
  const bird = drawn('bird', [
    circle(400, 420, 30, '#1d3557', '#ffd23f', 6, 0.9, 14),
    poly([[384, 424], [404, 430], [386, 444]], '#1d3557', '#f4a261', 4, 0.5),
    circle(412, 410, 6, '#1d3557', '#ffffff', 3, 0.3, 6),
    poly([[428, 420], [448, 426], [428, 432]], '#1d3557', '#e76f51', 4, 0.4),
  ], { name: 'Bird', kind: 'bird', tags: ['player'], player: 1, layer: 2, physics: { body: 'dynamic', shape: 'circle', fixed_rotation: true, density: 1 },
    behaviors: [B('hover', 'float', { amplitude: 6, period: 1.2 })] });
  const gap = 230;
  const pipe = drawn('pipes', [
    rect(0, -gap / 2 - 360, 110, 720, '#1d3557', '#52b788', 7, 1.4), rect(0, -gap / 2 - 18, 134, 36, '#1d3557', '#40916c', 6, 1),
    rect(0, gap / 2 + 360, 110, 720, '#1d3557', '#52b788', 7, 1.4), rect(0, gap / 2 + 18, 134, 36, '#1d3557', '#40916c', 6, 1),
  ], { name: 'Pipes', kind: 'hazard', tags: ['pipe'], template: true, layer: 1, x: 1900, y: 450,
    physics: { body: 'kinematic' },
    behaviors: [B('deadly', 'hazard', { to: 'player' }), B('life', 'lifetime', { seconds: 9 })],
    rules: [R('passed', E('timer', { seconds: 4.95 }), [A('add', { subject: 'game', counter: 'score', amount: 1 }), A('sound', { name: 'coin' })],
      { text: 'A point for every pipe you fly through' })] });
  const maker = zone('pipe_maker', 1700, 450, 10, 330, { name: 'Pipe maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [{ ...B('spawn', 'spawner', { template: 'pipes', every: 1.75, max: 5, area: 'right', velocity: [-260, 0], jitter: 0 }), off: true }] });
  const floor = drawn('floor', [rect(800, 880, 1600, 40, '#1d3557', '#c9a66b', 6, 1.5)], { name: 'Floor', kind: 'hazard', tags: ['ground'], layer: 3,
    physics: { body: 'static' }, behaviors: [B('deadly', 'hazard', { to: 'player' })] });
  return game('flappy', 'Flappy Doodle', 'ocean', world('flappy', { gravity: [0, 0] }), [pipe, maker, floor, bird], {
    counters: { score: 0 },
    hud: { items: [{ subject: 'game', counter: 'score', label: 'Score', style: 'number', max: null }], timer: false, title: 'Space or tap to flap' },
    rules: [
      R('flap', E('key_down', { key: 'space' }), [A('velocity', { target: 'player1', x: 0, y: -520 }), A('sound', { name: 'jump' })],
        { text: 'Press space to flap' }),
      R('go', E('key_down', { key: 'space' }), [A('gravity', { x: 0, y: 1 }), A('enable', { target: 'pipe_maker', behavior: 'spawn', on: true }),
        A('enable', { target: 'bird', behavior: 'hover', on: false })], { once: true, text: 'The first flap starts the game' }),
      R('win', E('counter', { subject: 'game', counter: 'score', op: '>=', value: 15 }), [A('win')], { text: 'Fly through 15 pipes to win' }),
    ],
  });
}

// ---- 8. top-down collect -------------------------------------------------------------------------------

function topDown(): Obj {
  seed = 808;
  const W = 2400;
  const H = 1600;
  const objs: Obj[] = [];
  const wall = (id: string, x: number, y: number, w: number, h: number): Obj => drawn(id, [rect(x, y, w, h, '#1b4332', '#74a57f', 7, 1.6)],
    { name: 'Hedge', kind: 'wall', tags: ['solid'], physics: { body: 'static' } });
  objs.push(wall('w1', 600, 500, 60, 700), wall('w2', 1000, 1150, 800, 60), wall('w3', 1300, 380, 60, 560), wall('w4', 1700, 760, 600, 60),
    wall('w5', 1950, 1250, 60, 640), wall('w6', 300, 1150, 400, 60));
  // the vault: walls around the treasure with a door
  objs.push(wall('v1', 2150, 250, 500, 50), wall('v2', 1925, 380, 50, 260), wall('v3', 2375, 380, 50, 260));
  objs.push(drawn('door', [rect(2150, 505, 400, 46, '#5a189a', '#c77dff', 7, 1), circle(2150, 505, 9, '#5a189a', '#ffd60a', 3, 0.3, 8)],
    { name: 'Locked door', kind: 'door', tags: ['door'], layer: 1, physics: { body: 'static' },
      rules: [
        R('open', E('collide', { with: 'player' }), [A('take', { from: 'other', item: 'keys', amount: 1 }), A('say', { text: 'Click! It opens.', target: 'other', seconds: 1.6 }),
          A('sound', { name: 'ding' }), A('destroy', { target: 'self' })], { conditions: [{ subject: 'other', counter: 'keys', op: '>=', value: 1 }], text: 'A key opens the door' }),
        R('locked', E('collide', { with: 'player' }), [A('say', { text: 'Locked. Find a key!', target: 'other', seconds: 1.6 })],
          { conditions: [{ subject: 'other', counter: 'keys', op: '<', value: 1 }] }),
      ] }));
  objs.push(drawn('treasure', [
    rect(2150, 380, 110, 70, '#7f5539', '#ddb892', 6, 1), rect(2150, 352, 116, 26, '#7f5539', '#b08968', 5, 0.8), star(2150, 372, 14, '#ffb703', '#ffd60a', 3),
  ], { name: 'Treasure', kind: 'goal', tags: ['goal'], layer: 1, physics: { body: 'static', sensor: true },
    behaviors: [B('goal', 'goal', { by: 'player', then: 'win' }), B('bob', 'float', { amplitude: 4, period: 2 })] }));
  const key = (id: string, x: number, y: number): Obj => drawn(id, [
    circle(x - 16, y, 13, '#9c6644', '#ffd60a', 5, 0.5, 10), line([[x - 3, y], [x + 26, y]], '#9c6644', 7, 0.5, 10),
    line([[x + 18, y], [x + 18, y + 12]], '#9c6644', 6, 0.3, 6), line([[x + 26, y], [x + 26, y + 10]], '#9c6644', 6, 0.3, 6),
  ], { name: 'Key', kind: 'key', tags: ['key'], layer: 1, physics: { body: 'static', sensor: true },
    behaviors: [B('pick', 'pickup', { item: 'keys', amount: 1, to: 'player' }), B('bob', 'float', { amplitude: 5, period: 1.4 })] });
  objs.push(key('key1', 380, 1400), key('key2', 1500, 200));
  const gem = (id: string, x: number, y: number): Obj => drawn(id, [poly([[x, y - 18], [x + 15, y], [x, y + 18], [x - 15, y]], '#0077b6', '#90e0ef', 4, 0.5)],
    { name: 'Gem', kind: 'coin', tags: ['coin'], layer: 1, physics: { body: 'static', sensor: true },
      behaviors: [B('pick', 'pickup', { item: 'score', amount: 10, to: 'player' }), B('bob', 'float', { amplitude: 4, period: 1.8 })] });
  [[850, 300], [1100, 900], [1600, 1400], [2200, 1000], [400, 800], [1800, 500]].forEach(([x, y], i) => objs.push(gem(`gem${i + 1}`, x, y)));
  const bat = (id: string, x: number, y: number): Obj => drawn(id, [
    poly([[x - 40, y - 6], [x - 18, y - 22], [x - 10, y - 4], [x, y - 14], [x + 10, y - 4], [x + 18, y - 22], [x + 40, y - 6], [x + 14, y + 14], [x - 14, y + 14]],
      '#240046', '#7b2cbf', 5, 0.8),
    circle(x - 6, y, 3, '#ffffff', '#ffffff', 2, 0.1, 6), circle(x + 6, y, 3, '#ffffff', '#ffffff', 2, 0.1, 6),
  ], { name: 'Bat', kind: 'enemy', tags: ['enemy'], layer: 4,
    physics: { body: 'dynamic', gravity_scale: 0, fixed_rotation: true, density: 0.5, friction: 0, sensor: true },
    behaviors: [B('chase', 'follow', { target: 'player', speed: 120, axes: 'xy', range: 420 }), B('bite', 'damage', { to: 'player', amount: 1, knockback: 380 }),
      B('flap', 'float', { amplitude: 6, period: 0.5 })] });
  objs.push(bat('bat1', 900, 700), bat('bat2', 1650, 1100), bat('bat3', 1700, 300));
  const hx = 200;
  const hy = 200;
  objs.push(drawn('hero', [
    circle(hx, hy, 28, '#1b4332', '#f4a261', 6, 0.9, 14),
    circle(hx - 9, hy - 5, 4, '#1b4332', '#1b4332', 2, 0.2, 6), circle(hx + 9, hy - 5, 4, '#1b4332', '#1b4332', 2, 0.2, 6),
    line([[hx - 10, hy + 9], [hx, hy + 13], [hx + 10, hy + 9]], '#1b4332', 3, 0.3, 6),
    poly([[hx - 26, hy - 18], [hx, hy - 44], [hx + 26, hy - 18]], '#1b4332', '#40916c', 5, 0.6),
  ], { name: 'Hero', kind: 'hero', tags: ['player'], player: 1, layer: 3,
    physics: { body: 'dynamic', gravity_scale: 0, fixed_rotation: true, friction: 0 },
    behaviors: [B('walk', 'move_keys', { speed: 330, axes: 'xy' }), B('hp', 'health', { max: 3, invulnerable: 1.2, on_zero: 'lose' })],
    counters: { health: 3, keys: 0 } }));
  const doc = game('top_down', 'Key Keeper', 'jungle', world('top-down', { width: W, height: H, gravity: [0, 0], camera: { mode: 'follow' } }), objs, {
    counters: { score: 0 },
    hud: { items: [{ subject: 'player1', counter: 'keys', label: 'Keys', style: 'icons', max: null },
      { subject: 'player1', counter: 'health', label: 'Health', style: 'hearts', max: 3 },
      { subject: 'game', counter: 'score', label: 'Gems', style: 'number', max: null }], timer: false, title: null },
    sceneRules: [R('hint', E('start'), [A('say', { text: 'Find a key to open the vault!', target: 'hero', seconds: 3 })])],
  });
  // seen from above: a grassy ground instead of the side-view forest
  const th = doc.theme as Obj;
  th.id = 'jungle_ground';
  th.background = { style: 'paper', colors: ['#dcebc8', '#2d6a4f'], parallax: true };
  return doc;
}

// ---- 9. endless runner -----------------------------------------------------------------------------------

function runner(): Obj {
  seed = 909;
  const W = 20000;
  const G = 780;
  const objs: Obj[] = [];
  objs.push(drawn('ground', [line([[0, G], [W, G]], '#2de2e6', 10, 1, 60)], { name: 'Track', kind: 'ground', tags: ['ground'],
    physics: { body: 'static', shape: 'line', friction: 0.4 } }));
  objs.push(drawn('runner', [
    poly([[480, G - 90], [520, G - 90], [526, G - 30], [474, G - 30]], '#2de2e6', '#ff3864', 5, 0.8),
    circle(500, G - 112, 20, '#2de2e6', '#0d0221', 5, 0.7, 12),
    line([[488, G - 30], [478, G - 4]], '#2de2e6', 7, 0.5, 8), line([[512, G - 30], [524, G - 4]], '#2de2e6', 7, 0.5, 8),
  ], { name: 'Runner', kind: 'player', tags: ['player'], player: 1, layer: 2,
    physics: { body: 'dynamic', fixed_rotation: true, friction: 0, density: 1 },
    behaviors: [B('run', 'platformer', { speed: 260, jump: 860, double_jump: true, air_control: 0.9, auto_run: 300 })] }));
  const spike = drawn('spike', [poly([[-34, 30], [0, -34], [34, 30]], '#f9c80e', '#ff3864', 5, 0.6)], { name: 'Spike', kind: 'hazard', tags: ['hazard'],
    template: true, layer: 1, x: 2000, y: G - 32, physics: { body: 'kinematic' },
    behaviors: [B('deadly', 'hazard', { to: 'player' }), B('life', 'lifetime', { seconds: 12 })] });
  // blocks are safe to land on, but one that pushes you off the back of the screen ends the run
  const block = drawn('block', [rect(0, 0, 90, 110, '#f9c80e', '#3d0b5c', 6, 1)], { name: 'Block', kind: 'platform', tags: ['block'],
    template: true, layer: 1, x: 2400, y: G - 57, physics: { body: 'kinematic', friction: 0.2 },
    behaviors: [B('life', 'lifetime', { seconds: 12 })] });
  const orb = drawn('orb', [circle(0, 0, 16, '#f9c80e', '#2de2e6', 5, 0.5, 10)], { name: 'Orb', kind: 'coin', tags: ['coin'], template: true, layer: 1,
    x: 2600, y: 560, physics: { body: 'static', sensor: true },
    behaviors: [B('pick', 'pickup', { item: 'score', amount: 5, to: 'player' }), B('bob', 'float', { amplitude: 8, period: 1.2 }), B('life', 'lifetime', { seconds: 12 })] });
  objs.push(spike, block, orb);
  objs.push(zone('spike_maker', 800, G - 32, 10, 2, { name: 'Spike maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [B('spawn', 'spawner', { template: 'spike', every: 1.6, max: 6, area: 'right', velocity: [0, 0], jitter: 0 })] }));
  objs.push(zone('block_maker', 800, G - 57, 10, 2, { name: 'Block maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [B('spawn', 'spawner', { template: 'block', every: 4.1, max: 3, area: 'right', velocity: [0, 0], jitter: 0 })] }));
  objs.push(zone('orb_maker', 800, 560, 10, 160, { name: 'Orb maker', kind: 'spawner', physics: { body: 'none' },
    behaviors: [B('spawn', 'spawner', { template: 'orb', every: 2.3, max: 6, area: 'right', velocity: [0, 0], jitter: 0 })] }));
  return game('runner', 'Neon Runner', 'neon_arcade',
    world('endless runner', { width: W, gravity: [0, 1.1], edges: 'none', camera: { mode: 'auto_scroll', axis: 'x', speed: 300 } }), objs, {
      counters: { score: 0 },
      hud: { items: [{ subject: 'game', counter: 'score', label: 'Score', style: 'number', max: null }], timer: false, title: 'Reach 100!' },
      rules: [
        R('tick', E('every', { seconds: 0.5 }), [A('add', { subject: 'game', counter: 'score', amount: 1 })], { text: 'Points for staying alive' }),
        R('win', E('counter', { subject: 'game', counter: 'score', op: '>=', value: 100 }), [A('win')], { text: 'Reach 100 points to win' }),
      ],
    });
}

const ALL: [string, () => Obj][] = [
  ['hill_climb', hillClimb], ['fighter', fighter], ['space_shooter', spaceShooter], ['platformer', platformer], ['physics_puzzle', physicsPuzzle],
  ['catch', catchGame], ['flappy', flappy], ['top_down', topDown], ['runner', runner],
];

for (const [name, make] of ALL) {
  const doc = make();
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(doc)}\n`);
  const objs = ((doc.scenes as Obj[])[0].objects as Obj[]).length;
  console.log(`${name}.json  ${objs} objects`);
}
