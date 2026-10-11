/** v4 sim (docs/v4/CONTRACTS_V4.md §2-5): modes, gravity flip, the 9 triggers, the 18 actions, primitives, hidden. */
import { describe, expect, it } from 'vitest';
import { PROFILES } from '../sim/profiles.ts';
import { V4 } from '../params.ts';
import { SimCore } from '../sim/core.ts';
import { ACTION, D, J, L, R, RUN, SPACE, ceilingRows, play, rows, rule, types, v4Level } from './v4.helpers.ts';

const prof = PROFILES['v2-standard'];
const flipOnSpace = rule('r1', { kind: 'key', key: 'space' }, { kind: 'flip_gravity' });

describe('modes (§3)', () => {
  it('runner holds Right once the clock starts, Left is ignored', () => {
    const still = play(v4Level({ mode: 'runner' }), () => 0, 60);
    expect(still.sim.view().player.x).toBe(2);
    const p = play(v4Level({ mode: 'runner' }), () => L, 60);
    expect(p.sim.view().mode).toBe('runner');
    expect(p.sim.view().player.x).toBeGreaterThan(4);
    expect(p.sim.view().player.facing).toBe(1);
  });

  it('flappy flaps on every Jump press, in the air too, at walk speed', () => {
    const p = play(v4Level({ mode: 'flappy' }), (f) => (f % 20 === 0 ? J | RUN : RUN), 120);
    const jumps = types(p, 'jump');
    expect(jumps.length).toBe(6);
    for (const e of jumps) expect(e.vy).toBeCloseTo(-V4.flappy.flap_frac * prof.jump_base, 6);
    const v = p.sim.view();
    expect(v.player.on_ground).toBe(false);
    expect(v.player.vx).toBeLessThanOrEqual(prof.walk_max + 1e-9);
  });

  it('top-down has no gravity and walks four ways; walls and the world edges block; no pits', () => {
    const lv = v4Level({ mode: 'topdown', rows: rows((r) => (r >= 6 && r <= 20 ? '20.1#27.' : '48.')), ents: [{ id: 'start', type: 'player_start', x: 10, y: 14 }], replace: true });
    const idle = play(lv, () => 0, 60).sim.view().player;
    expect([idle.x, idle.y]).toEqual([10, 14]);
    const right = play(lv, () => R, 240).sim.view().player;
    expect(right.x).toBeCloseTo(20 - 6 / 16, 3); // the wall at column 20 stops the body
    const up = play(lv, () => J, 400).sim.view().player;
    expect(up.y).toBeCloseTo(28 / 16, 3); // the top edge is a wall
    const down = play(lv, () => D, 400).sim.view().player;
    expect(down.y).toBe(27);
    expect(types(play(lv, () => D, 400), 'death')).toEqual([]);
  });

  it('top-down: touching an enemy hurts (no stomps) and springs push along their dir', () => {
    const lv = v4Level({
      mode: 'topdown', rows: rows(() => '48.'), replace: true,
      ents: [{ id: 'start', type: 'player_start', x: 4, y: 14 }, { id: 'e1', type: 'enemy', archetype: 'walker', x: 8, y: 14, w: 1, h: 1, params: { speed: 0 }, bounds: null }],
    });
    expect(types(play(lv, () => R, 120), 'stomp')).toEqual([]);
    expect(types(play(lv, () => R, 120), 'death')[0].cause).toBe('enemy');
    const sp = v4Level({
      mode: 'topdown', rows: rows(() => '48.'), replace: true,
      ents: [{ id: 'start', type: 'player_start', x: 4, y: 14 }, { id: 's1', type: 'spring', x: 6, y: 14.25, dir: 'up', strength: 1, w: 1 }],
    });
    const p = play(sp, () => R, 60);
    expect(types(p, 'spring').length).toBe(1);
    expect(p.sim.view().player.y).toBeLessThan(10);
  });
});

describe('gravity flip (§2.3)', () => {
  it('space flips the player onto the ceiling; a jump then launches toward +y', () => {
    const lv = v4Level({ rows: ceilingRows(5), logic: [flipOnSpace] });
    const p = play(lv, (f) => (f === 10 ? SPACE : 0), 90);
    const v = p.sim.view();
    expect(types(p, 'flip').length).toBe(1);
    expect([v.gravity, v.player.gravity, v.player.on_ground]).toEqual([-1, -1, true]);
    expect(v.player.y).toBe(6 + 28 / 16); // feet line under the ceiling's underside
    const j = play(lv, (f) => (f === 10 ? SPACE : f >= 90 && f < 96 ? J : 0), 100);
    expect(j.sim.view().player.y).toBeGreaterThan(6 + 28 / 16);
    expect(j.sim.view().player.vy).toBeGreaterThan(0);
  });

  it('flipped: one-way tiles do not hold the player and the top of the world is a pit', () => {
    const oneWay = rows((r) => (r === 5 ? '48=' : r >= 22 ? '48#' : '48.'));
    const p = play(v4Level({ rows: oneWay, logic: [flipOnSpace] }), (f) => (f === 5 ? SPACE : 0), 150);
    const death = types(p, 'death');
    expect(death.length).toBe(1);
    expect(death[0].cause).toBe('pit');
    expect(death[0].y as number).toBeLessThan(-2 + 28 / 16 + 0.01);
    // respawn: gravity 1 again
    expect(p.sim.view().gravity).toBe(1);
  });

  it('flipped stomps hit an enemy from below; enemies are not flipped', () => {
    const lv = v4Level({
      rows: ceilingRows(2), logic: [flipOnSpace],
      ents: [{ id: 'fly', type: 'enemy', archetype: 'flyer', x: 2, y: 12, w: 1, h: 1, params: { pattern: 'horizontal', range: 0.001, speed: 0.001 }, bounds: null }],
    });
    const s = new SimCore(lv, { seed: 1 });
    let vy = 0;
    let stomps = 0;
    for (let f = 0; f < 60; f++) {
      const ev = s.step(f === 5 ? SPACE : 0);
      if (ev.some((e) => e.type === 'stomp')) {
        stomps++;
        vy = s.view().player.vy;
      }
      expect(ev.some((e) => e.type === 'death')).toBe(false);
    }
    expect(stomps).toBe(1);
    expect(vy).toBeGreaterThan(0); // bounced away from the enemy (toward +y)
  });
});

describe('triggers (§2.1)', () => {
  it('start fires on the first frame of each life; key fires on edges only', () => {
    const lv = v4Level({ logic: [rule('s', { kind: 'start' }, { kind: 'sound', name: 'ding' }), rule('k', { kind: 'key', key: 'action' }, { kind: 'add_score', n: 1 })] });
    const p = play(lv, (f) => (f >= 10 && f < 30 ? ACTION : f === 40 || f === 42 ? ACTION : 0), 60);
    expect(types(p, 'sound').map((e) => e.frame)).toEqual([1]);
    expect(p.sim.view().score).toBe(3);
    expect(p.sim.view().uses_keys).toEqual(['action']);
  });

  it('touch fires once per overlap; collect by target, by item and by coin; all_coins once', () => {
    const lv = v4Level({
      ents: [{ id: 'c1', type: 'coin', x: 6, y: 21.5 }, { id: 'c2', type: 'coin', x: 9, y: 21.5 }, { id: 'pk', type: 'pickup', x: 12, y: 21.5, item: 'star' }, { id: 'cp', type: 'checkpoint', x: 15, y: 22 }],
      logic: [
        rule('t', { kind: 'touch', target: 'cp' }, { kind: 'add_counter', name: 'touches', n: 1 }),
        rule('ct', { kind: 'collect', target: 'c1' }, { kind: 'add_counter', name: 'first', n: 1 }),
        rule('ci', { kind: 'collect', item: 'star' }, { kind: 'add_counter', name: 'stars', n: 1 }),
        rule('cc', { kind: 'collect', item: 'coin' }, { kind: 'add_score', n: 5 }),
        rule('ac', { kind: 'all_coins' }, { kind: 'sound', name: 'fanfare' }),
      ],
    });
    const p = play(lv, () => R, 200);
    const v = p.sim.view();
    expect(v.counters).toEqual({ first: 1, stars: 1, touches: 1 });
    expect(v.score).toBe(10);
    expect(types(p, 'sound').length).toBe(1);
    expect(types(p, 'pickup')[0].name).toBe('star');
  });

  it('timer counts from the first input (once, and every N seconds)', () => {
    const lv = v4Level({ logic: [rule('once', { kind: 'timer', seconds: 1 }, { kind: 'sound', name: 'zap' }), rule('every', { kind: 'timer', seconds: 0.5, every: true }, { kind: 'add_score', n: 1 })] });
    const p = play(lv, (f) => (f < 10 ? 0 : 2), 200);
    expect(types(p, 'sound').map((e) => e.frame)).toEqual([11 + 59]);
    expect(p.sim.view().score).toBe(Math.floor((200 - 10) / 30));
  });

  it('zone, score and counter fire when crossed', () => {
    const lv = v4Level({
      ents: [{ id: 'c1', type: 'coin', x: 6, y: 21.5 }, { id: 'c2', type: 'coin', x: 8, y: 21.5 }],
      logic: [
        rule('z', { kind: 'zone', rect: [10, 19, 12, 22] }, { kind: 'shake' }),
        rule('c', { kind: 'collect', item: 'coin' }, { kind: 'add_score', n: 5 }, { kind: 'add_counter', name: 'coins', n: 1 }),
        rule('s', { kind: 'score', at_least: 10 }, { kind: 'sound', name: 'boing' }),
        rule('n', { kind: 'counter', name: 'coins', at_least: 2 }, { kind: 'sound', name: 'boom' }),
      ],
    });
    const p = play(lv, () => R, 200);
    expect(types(p, 'shake').length).toBe(1);
    expect(types(p, 'sound').map((e) => e.name)).toEqual(['boing', 'boom']);
    expect(types(p, 'rule').map((e) => e.id)).toEqual(['c', 'c', 's', 'n', 'z']);
  });
});

describe('actions (§2.2)', () => {
  const press = (then: Parameters<typeof rule>[2][], extra: Parameters<typeof v4Level>[0] = {}) => v4Level({ ...extra, logic: [rule('k', { kind: 'key', key: 'space' }, ...then)] });

  it('speed, jump_power, gravity and reverse_controls change the player; seconds are frames; −1 until respawn', () => {
    const base = play(v4Level({ logic: [rule('k', { kind: 'key', key: 'space' }, { kind: 'sound', name: 'ding' })] }), (f) => (f === 0 ? SPACE : R), 90).sim.view().player.x;
    const fast = play(press([{ kind: 'speed', times: 2, seconds: 10 }]), (f) => (f === 0 ? SPACE : R), 90);
    expect(fast.sim.view().player.x).toBeGreaterThan(base + 1);
    expect(play(press([{ kind: 'speed', times: 2, seconds: 1 }]), (f) => (f === 0 ? SPACE : 0), 30).sim.view().effects?.speed_f).toBe(31);
    expect(play(press([{ kind: 'speed', times: 2 }]), (f) => (f === 0 ? SPACE : 0), 30).sim.view().effects?.speed_f).toBe(-1);
    const apex = (lv: ReturnType<typeof press>): number => {
      let y = Infinity;
      const s = new SimCore(lv, { seed: 1 });
      for (let f = 0; f < 80; f++) {
        s.step(f === 0 ? SPACE : f >= 2 && f < 40 ? J : 0);
        y = Math.min(y, s.view().player.y);
      }
      return 22 - y;
    };
    const a0 = apex(press([{ kind: 'sound', name: 'ding' }]));
    expect(apex(press([{ kind: 'jump_power', times: 1.4 }]))).toBeGreaterThan(a0 + 1);
    expect(apex(press([{ kind: 'gravity', times: 0.5 }]))).toBeGreaterThan(a0 + 1);
    const rev = play(press([{ kind: 'reverse_controls', seconds: 5 }]), (f) => (f === 0 ? SPACE : R), 30);
    expect(rev.sim.view().player.x).toBeLessThan(2);
  });

  it('teleport (cell or entity), toggle, open, freeze_enemies', () => {
    const tp = play(press([{ kind: 'teleport', to: [30, 10] }]), (f) => (f === 0 ? SPACE : 0), 2);
    expect(types(tp, 'teleport').length).toBe(1);
    expect(tp.sim.view().player.x).toBe(30);
    const tpe = play(press([{ kind: 'teleport', target: 'goal' }]), (f) => (f === 0 ? SPACE : 0), 3);
    expect(types(tpe, 'win').length).toBe(1);
    const door = { id: 'd1', type: 'door' as const, x: 6, y: 18, w: 1, h: 4 };
    const shut = play(v4Level({ ents: [door] }), () => R, 120).sim.view().player.x;
    expect(shut).toBeLessThan(6);
    const opened = play(press([{ kind: 'open', target: 'd1' }], { ents: [door] }), (f) => (f === 0 ? SPACE : R), 120);
    expect(types(opened, 'door_open').length).toBe(1);
    expect(opened.sim.view().player.x).toBeGreaterThan(8);
    const hidden = play(press([{ kind: 'toggle', target: 'd1', to: 'off' }], { ents: [door] }), (f) => (f === 0 ? SPACE : R), 120);
    expect(types(hidden, 'toggle')[0]).toMatchObject({ id: 'd1', n: 0 });
    expect(hidden.sim.view().player.x).toBeGreaterThan(8);
    expect(hidden.sim.view().entities.find((e) => e.id === 'd1')?.active).toBe(false);
    const walker = { id: 'w', type: 'enemy' as const, archetype: 'walker' as const, x: 20, y: 22, w: 1, h: 1, params: { speed: 3 }, bounds: [10, 30] as [number, number] };
    // the rule runs after the enemies moved this frame: frozen from the next frame for 60 frames
    const wx = (n: number): number | undefined => play(press([{ kind: 'freeze_enemies', seconds: 1 }], { ents: [walker] }), (f) => (f === 0 ? SPACE : 0), n).sim.view().entities.find((e) => e.id === 'w')?.x;
    const fz = play(press([{ kind: 'freeze_enemies', seconds: 1 }], { ents: [walker] }), (f) => (f === 0 ? SPACE : 0), 50);
    expect(types(fz, 'freeze').length).toBe(1);
    expect(wx(50)).toBe(wx(1));
    expect(wx(80)).not.toBe(wx(1));
    expect(fz.sim.view().effects?.freeze_f).toBe(11);
  });

  it('score, counters, heal, hurt, say, sound, shake, win, lose', () => {
    const lv = press([{ kind: 'add_score', n: 7 }, { kind: 'add_counter', name: 'keys' }, { kind: 'say', text: 'hello', seconds: 1 }, { kind: 'sound', name: 'boing' }], { hearts: 3 });
    const p = play(lv, (f) => (f === 0 ? SPACE : 0), 20);
    const v = p.sim.view();
    expect([v.score, v.counters, v.say?.text, v.say?.frames_left]).toEqual([7, { keys: 1 }, 'hello', 41]);
    expect(types(p, 'say')[0].text).toBe('hello');
    const hurt = play(press([{ kind: 'hurt' }], { hearts: 3 }), (f) => (f === 0 ? SPACE : 0), 5);
    expect(types(hurt, 'hit')[0].cause).toBe('rule');
    expect(hurt.sim.view().hearts).toBe(2);
    const heal = play(v4Level({ hearts: 3, logic: [rule('h', { kind: 'key', key: 'space' }, { kind: 'hurt' }), rule('g', { kind: 'key', key: 'action' }, { kind: 'heal' }, { kind: 'shake' })] }), (f) => (f === 0 ? SPACE : f === 2 ? ACTION : 0), 5);
    expect([heal.sim.view().hearts, types(heal, 'shake').length]).toEqual([3, 1]);
    expect(types(play(press([{ kind: 'win' }]), (f) => (f === 0 ? SPACE : 0), 3), 'win').length).toBe(1);
    const lose = play(press([{ kind: 'add_score', n: 3 }, { kind: 'lose' }]), (f) => (f === 0 ? SPACE : 0), 3);
    expect(types(lose, 'lose')[0].cause).toBe('rule');
    expect(lose.sim.view().score).toBe(0); // a lose restarts the level
  });

  it('once fires once per life; score is kept and latches reset on respawn', () => {
    const lv = v4Level({
      rows: ceilingRows(3, [10, 14]),
      logic: [{ id: 'o', when: { kind: 'key', key: 'space' }, then: [{ kind: 'add_score', n: 1 }], once: true }],
    });
    const p = play(lv, (f) => (f === 0 || f === 5 ? SPACE : f > 10 && f < 200 ? R : f === 280 || f === 290 ? SPACE : 0), 300);
    expect(types(p, 'death').length).toBe(1);
    expect(p.sim.view().score).toBe(2);
  });
});

describe('primitives (§5) and hidden entities', () => {
  it('portals move the player to the partner, keep velocity and cool down (no bounce back)', () => {
    const lv = v4Level({ ents: [{ id: 'p1', type: 'portal', x: 8, y: 21, pair: 'p2' }, { id: 'p2', type: 'portal', x: 30, y: 21, pair: 'p1' }] });
    const p = play(lv, () => R, 200);
    expect(types(p, 'portal').map((e) => e.id)).toEqual(['p1']);
    expect(types(p, 'win').length).toBe(1);
    const stand = play(lv, (f) => (f < 60 ? R : 0), 300);
    expect(types(stand, 'portal').length).toBe(1);
  });

  it('zones: wind pushes, water slows the fall and swims, ice slides, slow halves speed, conveyor carries', () => {
    const open = ceilingRows(-1);
    const x = (effect: 'wind' | 'ice' | 'slow' | 'conveyor', input: (f: number) => number, n: number): number =>
      play(v4Level({ rows: open, ents: [{ id: 'z', type: 'zone', x: 0, y: 10, w: 48, h: 12, effect, dir: 'right', strength: 1 }] }), input, n).sim.view().player.x;
    const plain = play(v4Level({ rows: open }), (f) => (f < 30 ? R : 0), 90).sim.view().player.x;
    expect(x('ice', (f) => (f < 30 ? R : 0), 90)).toBeGreaterThan(plain + 0.5);
    expect(x('slow', () => R, 60)).toBeLessThan(play(v4Level({ rows: open }), () => R, 60).sim.view().player.x - 1);
    expect(x('conveyor', () => 0, 60)).toBeCloseTo(2 + (60 * 60) / 60 / 16, 1);
    expect(x('wind', (f) => (f < 3 ? J : 0), 50)).toBeGreaterThan(2.1);
    const water = play(v4Level({ rows: rows((r) => (r >= 22 ? '48#' : '48.')), ents: [{ id: 'start', type: 'player_start', x: 2, y: 5 }, { id: 'w', type: 'zone', x: 0, y: 0, w: 48, h: 22, effect: 'water' }], replace: true }), (f) => (f === 40 ? J : 0), 60);
    expect(water.sim.view().player.vy).toBeLessThanOrEqual(V4.zone.water_max_fall);
    expect(types(water, 'jump').length).toBe(1);
  });

  it('pickups are collected on touch and come back after respawn_s; talkers say their lines in turn', () => {
    const lv = v4Level({ ents: [{ id: 'pk', type: 'pickup', x: 5, y: 21.5, item: 'gem', respawn_s: 1 }] });
    const p = play(lv, (f) => (f < 20 ? R : 0), 30);
    expect(p.sim.view().entities.find((e) => e.id === 'pk')).toMatchObject({ active: false, state: 'used', kind: 'gem' });
    const back = play(lv, (f) => (f < 20 ? R : f < 40 ? L : 0), 140);
    expect(back.sim.view().entities.find((e) => e.id === 'pk')?.active).toBe(true);
    const npc = v4Level({ ents: [{ id: 'owl', type: 'npc', x: 8, y: 22, lines: ['one', 'two'] }] });
    const t = play(npc, (f) => (f < 100 ? R : f < 200 ? L : 0), 210);
    expect(types(t, 'say').map((e) => e.text)).toEqual(['one', 'two']);
    expect(t.sim.view().say?.target).toBe('owl');
  });

  it('hidden entities are inert until a toggle shows them', () => {
    const spikes = { id: 'sp', type: 'spikes' as const, host: null, face: 'top' as const, x0: 6, x1: 8, y: 22, facing: 'up' as const, hidden: true };
    expect(types(play(v4Level({ ents: [spikes] }), () => R, 120), 'death')).toEqual([]);
    const shown = v4Level({ ents: [spikes], logic: [rule('k', { kind: 'key', key: 'space' }, { kind: 'toggle', target: 'sp', to: 'on' })] });
    expect(types(play(shown, (f) => (f === 0 ? SPACE : R), 120), 'death').length).toBe(1);
    const goal = v4Level();
    (goal.compiled.entities[1] as { hidden?: boolean }).hidden = true;
    expect(types(play(goal, () => R, 400), 'win')).toEqual([]);
  });
});

describe('rules switched off', () => {
  it('a rule with off: true never fires and adds no key to the controls', () => {
    const lv = v4Level({ game: [{ id: 'g1', when: { kind: 'key', key: 'space' }, then: [{ kind: 'add_score', n: 1 }], off: true }], logic: [rule('r1', { kind: 'start' }, { kind: 'shake' })] });
    const p = play(lv, (f) => (f % 4 === 0 ? SPACE : 0), 40);
    expect([p.sim.view().score, p.sim.view().uses_keys, types(p, 'shake').length]).toEqual([0, [], 1]);
  });
});

describe('state, snapshot and hash', () => {
  it('rule state is in snapshots and the hash; v2 levels have none and ignore the rule keys', () => {
    const lv = v4Level({ logic: [rule('k', { kind: 'key', key: 'space' }, { kind: 'add_score', n: 1 })] });
    const s = new SimCore(lv, { seed: 1 });
    s.step(SPACE);
    const snap = s.snapshot();
    const h = s.hash();
    s.step(0);
    s.step(SPACE);
    expect(s.view().score).toBe(2);
    expect(s.hash()).not.toBe(h);
    s.restore(snap);
    expect([s.view().score, s.hash()]).toEqual([1, h]);
    const v2 = v4Level();
    const a = play(v2, (f) => (f % 7 === 0 ? R | SPACE | ACTION : R), 200).sim;
    const b = play(v2, () => R, 200).sim;
    expect(a.S.r).toBeUndefined();
    expect(a.view().player.x).toBe(b.view().player.x);
  });
});
