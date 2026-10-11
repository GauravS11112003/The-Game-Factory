import { describe, expect, it } from 'vitest';
import { BEHAVIORS, ACTIONS } from '../model/catalog.ts';
import { normalizeDoc } from '../runtime/normalize.ts';
import { coerceParam, resolveParams } from '../runtime/params.ts';
import { behaviorCodes, ruleKeyMatches, schemeName } from '../runtime/keys.ts';
import { MAX_FIRINGS_PER_FRAME, compare } from '../runtime/world.ts';
import { box, makeWorld, names } from './runtime_fakes.ts';

const scene = (objects: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'g', title: 't', scenes: [{ id: 's1', objects, ...extra }] });

describe('params', () => {
  it('fills defaults, clamps numbers, rounds ints and ignores unknown params', () => {
    const p = resolveParams(BEHAVIORS.get('platformer'), { speed: 99999, jump: 'high', bogus: 1 });
    expect(p.speed).toBe(1200);
    expect(p.jump).toBe(640);
    expect(p.double_jump).toBe(false);
    expect('bogus' in p).toBe(false);
    const sp = resolveParams(BEHAVIORS.get('spawner'), { max: 3.7, area: 'nowhere', velocity: [1, 'x'] });
    expect(sp.max).toBe(4);
    expect(sp.area).toBe('self');
    expect(sp.velocity).toEqual([0, 0]);
  });

  it('coerces bools, strings and counters', () => {
    expect(coerceParam({ name: 'b', type: 'bool', default: false }, 'true')).toBe(true);
    expect(coerceParam({ name: 'b', type: 'bool', default: true }, 'maybe')).toBe(true);
    expect(coerceParam({ name: 'c', type: 'counter', default: 'coins' }, ' Gems ')).toBe('gems');
    expect(coerceParam({ name: 'n', type: 'number', default: 2, min: 0, max: 5 }, -3)).toBe(0);
    expect(resolveParams(ACTIONS.get('add'), {})).toEqual({ subject: 'game', counter: 'score', amount: 1 });
  });
});

describe('keys', () => {
  it('maps players to schemes', () => {
    expect(schemeName(1, 1)).toBe('single');
    expect(schemeName(2, 1)).toBe('single');
    expect(schemeName(1, 2)).toBe('player1');
    expect(schemeName(2, 2)).toBe('player2');
    expect(schemeName(0, 2)).toBe('single');
  });

  it('gives each scheme its keys', () => {
    expect(behaviorCodes('left', 'player2')).toEqual(['ArrowLeft']);
    expect(behaviorCodes('action', 'player1')).toEqual(['KeyF']);
    expect(behaviorCodes('jump', 'single')).toContain('Space');
    expect(ruleKeyMatches('action', 'KeyF', 'player1')).toBe(true);
    expect(ruleKeyMatches('action', 'KeyF', 'player2')).toBe(false);
    expect(ruleKeyMatches('space', 'Space', 'player2')).toBe(true); // raw key in rules
    expect(ruleKeyMatches('w', 'KeyW', 'player2')).toBe(true);
    expect(ruleKeyMatches('any', 'KeyZ', 'single')).toBe(true);
  });
});

describe('normalize', () => {
  it('never throws and reports each unknown type once', () => {
    expect(() => normalizeDoc(null)).not.toThrow();
    expect(normalizeDoc('junk').doc.scenes.length).toBe(1);
    const { doc, errors } = normalizeDoc(scene([
      { id: 'a', behaviors: [{ id: 'b1', type: 'teleporty' }, { id: 'b2', type: 'teleporty' }, { id: 'b3', type: 'rotate' }],
        rules: [{ id: 'r', when: { type: 'start' }, then: [{ type: 'explode' }, { type: 'win' }] }] },
      { id: 'g', physics: { shape: 'line', body: 'dynamic' } },
      { id: 'a' },
      { nope: true },
    ]));
    expect(errors).toEqual(['unknown behaviour "teleporty"', 'unknown action "explode"']);
    const objs = doc.scenes[0].objects;
    expect(objs.map((o) => o.id)).toEqual(['a', 'g']);
    expect(objs[0].behaviors.map((b) => b.type)).toEqual(['rotate']);
    expect(objs[0].rules[0].then.map((a) => a.type)).toEqual(['win']);
    expect(objs[1].physics.body).toBe('static');
  });
});

describe('targets', () => {
  const { world } = makeWorld(scene([
    { id: 'hero', player: 1, tags: ['player'], drawing: box() },
    { id: 'p2', player: 2, x: 900, drawing: box() },
    { id: 'e1', tags: ['enemy'], x: 100, drawing: box() },
    { id: 'e2', tags: ['enemy'], x: 200, drawing: box() },
    { id: 'enemy', tags: ['boss'], x: 300, drawing: box() },
    { id: 'bat', template: true, tags: ['bat'], drawing: box() },
  ]));
  const [hero, p2, e1] = ['hero', 'p2', 'e1'].map((id) => world.byId.get(id)!);
  const ctx = { self: e1, other: hero };

  it('resolves keywords', () => {
    expect(world.resolve('self', ctx)).toEqual([e1]);
    expect(world.resolve('other', ctx)).toEqual([hero]);
    expect(world.resolve('player1', ctx)).toEqual([hero]);
    expect(world.resolve('player2', ctx)).toEqual([p2]);
    expect(world.resolve('player', ctx)).toEqual([hero]); // 1-player world: player 1
    expect(world.resolve('game', ctx)).toEqual([]);
  });

  it('resolves tags, and ids win over tags', () => {
    expect(world.resolve('enemy', ctx).map((e) => e.id)).toEqual(['enemy']);
    expect(world.resolve('boss', ctx).map((e) => e.id)).toEqual(['enemy']);
    expect(world.resolve('nobody', ctx)).toEqual([]);
    expect(world.matches('enemy', e1, ctx)).toBe(false);
    expect(world.matches('player', hero, ctx)).toBe(true);
    expect(world.matches('any', p2, ctx)).toBe(true);
  });

  it('includes template copies under the template id', () => {
    const c = world.spawn('bat', 5, 5)!;
    expect(c.id).toMatch(/^bat#\d+$/);
    expect(world.resolve('bat', ctx)).toEqual([c]);
    expect(world.matches('bat', c, ctx)).toBe(true);
  });

  it('picks the nearest player in 2-player worlds', () => {
    const w2 = makeWorld({ scenes: [{ id: 's', world: { players: 2 }, objects: [
      { id: 'a', player: 1, x: 0, drawing: box() }, { id: 'b', player: 2, x: 1000, drawing: box() }, { id: 'm', x: 900, drawing: box() }] }] }).world;
    expect(w2.resolve('player', { self: w2.byId.get('m')!, other: null })[0].id).toBe('b');
  });
});

describe('conditions', () => {
  it('compares and reads missing counters as 0', () => {
    expect(compare(3, '>=', 3)).toBe(true);
    expect(compare(3, '>', 3)).toBe(false);
    expect(compare(2, '!=', 3)).toBe(true);
    expect(compare(2, '==', 2)).toBe(true);
    const { world } = makeWorld({ counters: { score: 5 }, scenes: [{ id: 's', objects: [
      { id: 'door', counters: { keys: 0 }, drawing: box() }, { id: 'hero', player: 1, counters: { keys: 2 }, drawing: box() }] }] });
    const door = world.byId.get('door')!;
    const hero = world.byId.get('hero')!;
    const ctx = { self: door, other: hero };
    expect(world.conditionsHold([{ subject: 'other', counter: 'keys', op: '>=', value: 1 }], ctx)).toBe(true);
    expect(world.conditionsHold([{ subject: 'self', counter: 'keys', op: '>=', value: 1 }], ctx)).toBe(false);
    expect(world.conditionsHold([{ subject: 'game', counter: 'score', op: '==', value: 5 }], ctx)).toBe(true);
    expect(world.conditionsHold([{ subject: 'hero', counter: 'gems', op: '==', value: 0 }], ctx)).toBe(true);
    expect(world.conditionsHold([{ subject: 'ghost', counter: 'gems', op: '<', value: 0 }], ctx)).toBe(false);
  });
});

describe('rules engine', () => {
  it('fires game, then scene, then object rules, in order', () => {
    const say = (id: string, text: string) => ({ id, when: { type: 'start' }, then: [{ type: 'say', params: { text, target: 'nobody' } }] });
    const { world, host } = makeWorld({ rules: [say('g1', 'game')], scenes: [{ id: 's', rules: [say('s1', 'scene')], objects: [
      { id: 'a', rules: [say('a1', 'a1'), say('a2', 'a2')], drawing: box() }, { id: 'b', rules: [say('b1', 'b')], drawing: box() }] }] });
    world.start();
    world.processEvents();
    expect(names(host, 'say').map((a) => a[1])).toEqual(['game', 'scene', 'a1', 'a2', 'b']);
  });

  it('honours once, off and conditions', () => {
    const { world } = makeWorld({ counters: { n: 0, gate: 0 }, rules: [
      { id: 'r1', when: { type: 'every', params: { seconds: 0.1 } }, then: [{ type: 'add', params: { counter: 'n' } }], once: true },
      { id: 'r2', when: { type: 'every', params: { seconds: 0.1 } }, then: [{ type: 'add', params: { counter: 'n', amount: 100 } }], off: true },
      { id: 'r3', when: { type: 'every', params: { seconds: 0.1 } }, conditions: [{ subject: 'game', counter: 'gate', op: '>=', value: 1 }],
        then: [{ type: 'add', params: { counter: 'n', amount: 10 } }] },
    ], scenes: [{ id: 's', objects: [] }] });
    world.start();
    for (let i = 0; i < 30; i++) {
      world.tick(1 / 60);
      world.processEvents();
    }
    expect(world.game.n).toBe(1);
    world.game.gate = 1;
    for (let i = 0; i < 5; i++) {
      world.tick(1 / 60);
      world.processEvents();
    }
    expect(world.game.n).toBe(11);
  });

  it('runs events raised by actions on the next frame', () => {
    const { world, host } = makeWorld(scene([
      { id: 'a', rules: [{ id: 'r', when: { type: 'start' }, then: [{ type: 'destroy', params: { target: 'b' } }] }], drawing: box() },
      { id: 'b', rules: [{ id: 'r', when: { type: 'destroyed' }, then: [{ type: 'win' }] }], drawing: box() },
    ]));
    world.start();
    world.processEvents();
    expect(names(host, 'destroy').length).toBe(1);
    expect(names(host, 'win').length).toBe(0);
    world.processEvents();
    expect(names(host, 'win').length).toBe(1);
  });

  it('caps rule firings per frame and carries the rest over', () => {
    const rules = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, when: { type: 'start' }, then: [{ type: 'add', params: { counter: 'n' } }] }));
    const { world } = makeWorld({ counters: { n: 0 }, rules: rules.slice(0, 48), scenes: [{ id: 's', rules: rules.slice(48), objects: [] }] });
    world.start();
    world.processEvents();
    expect(world.game.n).toBe(MAX_FIRINGS_PER_FRAME);
    world.processEvents();
    expect(world.game.n).toBe(100);
  });

  it('survives a self-feeding loop without locking up', () => {
    const { world } = makeWorld(scene([
      { id: 'seed', drawing: box(), rules: [{ id: 'go', when: { type: 'start' }, then: [{ type: 'spawn', params: { template: 'egg' } }] }] },
      { id: 'egg', template: true, drawing: box(), rules: [{ id: 'more', when: { type: 'spawned' }, then: [{ type: 'spawn', params: { template: 'egg', count: 2 } }] }] },
    ]));
    world.start();
    for (let i = 0; i < 40; i++) world.processEvents();
    expect(world.live().length).toBeLessThanOrEqual(501);
    expect(world.queue.length + world.next.length).toBeLessThanOrEqual(1024 + 64);
  });

  it('fires counter rules when they become true and re-arms', () => {
    const { world } = makeWorld({ counters: { coins: 0, wins: 0 }, rules: [
      { id: 'c', when: { type: 'counter', params: { subject: 'game', counter: 'coins', op: '>=', value: 3 } },
        then: [{ type: 'add', params: { counter: 'wins' } }] }], scenes: [{ id: 's', objects: [] }] });
    const step = () => {
      world.tick(1 / 60);
      world.processEvents();
    };
    world.start();
    step();
    world.game.coins = 3;
    step();
    step();
    expect(world.game.wins).toBe(1);
    world.game.coins = 1;
    step();
    world.game.coins = 5;
    step();
    expect(world.game.wins).toBe(2);
  });

  it('fires all_gone once when the last tagged object goes', () => {
    const { world, host } = makeWorld({ rules: [{ id: 'w', when: { type: 'all_gone', params: { tag: 'pig' } }, then: [{ type: 'win' }] }],
      scenes: [{ id: 's', objects: [{ id: 'p1', tags: ['pig'], drawing: box() }, { id: 'p2', tags: ['pig'], drawing: box() }] }] });
    const step = () => {
      world.tick(1 / 60);
      world.processEvents();
    };
    world.start();
    step();
    world.destroy(world.byId.get('p1')!);
    step();
    expect(names(host, 'win').length).toBe(0);
    world.destroy(world.byId.get('p2')!);
    step();
    step();
    expect(names(host, 'win').length).toBe(1);
  });

  it('matches key rules through the owner scheme', () => {
    const { world } = makeWorld({ counters: { a: 0, b: 0 }, rules: [
      { id: 'k', when: { type: 'key_down', params: { key: 'space' } }, then: [{ type: 'add', params: { counter: 'a' } }] }],
    scenes: [{ id: 's', world: { players: 2 }, objects: [
      { id: 'p2', player: 2, drawing: box(), rules: [{ id: 'k', when: { type: 'key_down', params: { key: 'action' } }, then: [{ type: 'add', params: { counter: 'b' } }] }] }] }] });
    world.key('key_down', 'Space');
    world.key('key_down', 'KeyF'); // player 1's action: not p2's
    world.key('key_down', 'KeyL');
    world.processEvents();
    expect(world.game).toEqual({ a: 1, b: 1 });
  });
});

describe('health, pickups and contacts', () => {
  it('damage respects the safe time and on_zero', () => {
    const { world, host } = makeWorld(scene([
      { id: 'hero', player: 1, drawing: box(), behaviors: [{ id: 'h', type: 'health', params: { max: 2, invulnerable: 1, on_zero: 'lose' } }] },
      { id: 'spike', drawing: box(), behaviors: [{ id: 'd', type: 'damage', params: { to: 'player', amount: 1 } }] },
    ]));
    const hero = world.byId.get('hero')!;
    const spike = world.byId.get('spike')!;
    expect(hero.counters.health).toBe(2);
    world.contact('begin', spike, hero, false);
    world.contact('active', spike, hero, false);
    expect(hero.counters.health).toBe(1);
    world.tick(1.1);
    world.contact('active', spike, hero, false);
    expect(hero.counters.health).toBe(0);
    expect(names(host, 'lose').length).toBe(1);
  });

  it('pickups give items and score', () => {
    const { world } = makeWorld({ counters: { score: 0 }, scenes: [{ id: 's', objects: [
      { id: 'hero', player: 1, drawing: box() },
      { id: 'coin', drawing: box(), physics: { sensor: true }, behaviors: [{ id: 'p', type: 'pickup', params: { item: 'coins', amount: 2 } }] }] }] });
    const hero = world.byId.get('hero')!;
    world.contact('begin', world.byId.get('coin')!, hero, true);
    expect(hero.counters.coins).toBe(2);
    expect(world.game.score).toBe(2);
    expect(world.byId.get('coin')!.alive).toBe(false);
  });

  it('respawns a player at its checkpoint and spends a life', () => {
    const { world, host } = makeWorld({ counters: { lives: 2 }, scenes: [{ id: 's', world: { edges: 'none' }, objects: [
      { id: 'hero', player: 1, drawing: box(), x: 10, y: 10 }, { id: 'flag', x: 500, y: 300, drawing: box(20, 80), behaviors: [{ id: 'c', type: 'checkpoint' }] }] }] });
    const hero = world.byId.get('hero')!;
    world.contact('begin', world.byId.get('flag')!, hero, true);
    world.outOfBounds(hero);
    expect(world.game.lives).toBe(1);
    expect(hero.body!.x).toBe(500);
    world.outOfBounds(hero);
    expect(names(host, 'lose').length).toBe(1);
  });

  it('declares the other player the winner when a duellist is destroyed', () => {
    const { world, host } = makeWorld({ scenes: [{ id: 's', world: { players: 2 }, objects: [
      { id: 'a', player: 1, tags: ['fighter'], drawing: box() }, { id: 'b', player: 2, tags: ['fighter'], drawing: box() }] }] });
    world.destroy(world.byId.get('a')!);
    expect(names(host, 'win')).toEqual([['rt.p2_wins']]);
  });

  it('projectiles skip their own side', () => {
    const { world } = makeWorld({ scenes: [{ id: 's', world: { players: 2 }, objects: [
      { id: 'a', player: 1, tags: ['fighter'], drawing: box(), counters: { health: 3 } },
      { id: 'b', player: 2, tags: ['fighter'], drawing: box(), counters: { health: 3 } }] }] });
    const a = world.byId.get('a')!;
    const b = world.byId.get('b')!;
    const bullet = world.spawn('default', 0, 0, 0, 0, { shooter: a })!;
    bullet.projectileDamage = 1;
    world.contact('begin', bullet, a, true);
    expect(a.counters.health).toBe(3);
    world.contact('begin', bullet, b, true);
    expect(b.counters.health).toBe(2);
    expect(bullet.alive).toBe(false);
  });
});
