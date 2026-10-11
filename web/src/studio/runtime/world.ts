/**
 * The runtime's world model (docs/v6/CONTRACTS_V6.md §2, §3, §4.2), pure: no Phaser, no DOM. It owns entities, counters,
 * target resolution, conditions, the rules engine (an event queue per scene, ≤ 64 rule firings per frame, events raised
 * by actions run next frame), every rule action, and the contact behaviours (pickup, damage, hazard, goal, checkpoint,
 * bounce pad, conveyor, projectiles). Physical effects go through `Host` (the Phaser/Matter adapter, or a fake in tests);
 * bodies are read and moved through `BodyIO`.
 *
 * Firing order: broadcast events (start, keys, timer, every, counter, all_gone) visit game rules, then scene rules, then
 * object rules in object order; object events (collide, overlap, leave, clicked, health_zero, destroyed, spawned,
 * out_of_bounds) visit the object's own rules, then the global rules when the object is the scope's player 1.
 * `overlap` fires for any touch (sensor or solid), `collide` only for solid contacts.
 */
import type { BodyKind, NAction, NBehavior, NCondition, NDoc, NObject, NRule, NScene } from './normalize.ts';
import { num, str, bool, type Params } from './params.ts';
import { ruleKeyMatches, schemeName } from './keys.ts';

export const MAX_FIRINGS_PER_FRAME = 64;
export const MAX_QUEUE = 1024;
export const MAX_ENTITIES = 500;

/** A physics body as the behaviours see it (px, px/s, degrees). */
export interface BodyIO {
  readonly kind: BodyKind;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly vx: number;
  readonly vy: number;
  readonly av: number;
  /** Standing on something (contact normal within 45° of up), refreshed every step. */
  grounded: boolean;
  /** Horizontal velocity of what it stands on (moving platforms, conveyors). */
  groundVx: number;
  setVelocity(vx: number, vy: number): void;
  setAngularVelocity(degPerSec: number): void;
  setAngle(deg: number): void;
  setPosition(x: number, y: number): void;
  /** Launchers: hold still (static) until launched. */
  setFrozen?(frozen: boolean): void;
  /** Wheel-jointed children with their radius (the car behaviour drives them). */
  wheels?(): { body: BodyIO; radius: number; motor: boolean }[];
  /** Is there something solid at this world point? (ledge checks) */
  probe?(x: number, y: number): boolean;
}

export interface BehState {
  def: NBehavior;
  on: boolean;
  s: Record<string, number | string | boolean | null>;
}

export interface Ent {
  id: string;
  def: NObject;
  templateId: string | null;
  tags: Set<string>;
  counters: Record<string, number>;
  alive: boolean;
  shown: boolean;
  player: 0 | 1 | 2;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  startX: number;
  startY: number;
  checkX: number;
  checkY: number;
  facing: 1 | -1;
  /** Visual-only rotation for move_keys face_move (deg) and the float bob (px). */
  faceAngle: number | null;
  bob: number;
  invuln: number;
  behaviors: BehState[];
  rules: NRule[];
  body: BodyIO | null;
  bornAt: number;
  /** Projectiles: who fired it and how much it hurts. */
  shooter: Ent | null;
  projectileDamage: number;
  /** Computer-controlled keys (ai_fighter) */
  ai: Record<string, boolean> | null;
  aiPrev: Record<string, boolean> | null;
  /** Wheels and welded parts: contacts count for this entity. */
  root: Ent | null;
  /** Spawner that made it (for `max`). */
  spawnedBy: string | null;
  groundedPrev: boolean;
}

export type FxName = 'jump' | 'land' | 'hit' | 'pickup' | 'swing' | 'shoot' | 'launch' | 'boing' | 'checkpoint' | 'spawn' | 'heal'
  | 'respawn' | 'thrust' | 'poof' | 'goal';

export interface RuntimeEventOut {
  type: 'ready' | 'win' | 'lose' | 'scene' | 'counter' | 'say' | 'destroyed' | 'spawned' | 'error';
  scene?: string;
  object?: string;
  counter?: string;
  value?: number;
  text?: string;
}

/** What the world asks of the engine adapter. */
export interface Host {
  /** Build the body and view for a new copy; the host calls world.addEnt and returns the entity. */
  spawn(def: NObject, opts: { vx: number; vy: number; angle?: number }): Ent | null;
  destroy(e: Ent, fx: 'poof' | 'quiet'): void;
  setVisible(e: Ent, shown: boolean): void;
  setSensor(e: Ent, sensor: boolean): void;
  setGravity(gx: number, gy: number): void;
  flipGravity(): void;
  timeScale(scale: number, seconds: number): void;
  sound(name: string): void;
  shake(power: number): void;
  flash(color: string): void;
  say(e: Ent | null, text: string, seconds: number): void;
  camera(target: Ent | null, zoom: number): void;
  win(text?: string): void;
  lose(text?: string): void;
  nextScene(): void;
  goScene(id: string): void;
  fx(name: FxName, e: Ent, data?: { x?: number; y?: number; power?: number; other?: Ent }): void;
  counterChanged(subject: string, counter: string, value: number): void;
  emit(e: RuntimeEventOut): void;
  /** Default projectile when a shooter names no template. */
  defaultProjectile(): NObject;
}

export interface QueuedEvent {
  type: string;
  ent?: Ent;
  other?: Ent;
  code?: string;
  /** resumption of an event cut off by the per-frame firing cap */
  pending?: { rule: NRule; self: Ent | null; other: Ent | null; key: string }[];
}

interface Ctx {
  self: Ent | null;
  other: Ent | null;
}

const OPS: Record<NCondition['op'], (a: number, b: number) => boolean> = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => Math.abs(a - b) < 1e-9,
  '!=': (a, b) => Math.abs(a - b) >= 1e-9,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
};

export function compare(a: number, op: string, b: number): boolean {
  return (OPS[op as NCondition['op']] ?? OPS['>='])(a, b);
}

export class World {
  readonly doc: NDoc;
  readonly scene: NScene;
  readonly host: Host;
  readonly players: 1 | 2;
  ents: Ent[] = [];
  byId = new Map<string, Ent>();
  game: Record<string, number>;
  t = 0;
  frame = 0;
  firings = 0;
  queue: QueuedEvent[] = [];
  next: QueuedEvent[] = [];
  /** Camera view in world px (the adapter keeps it current; spawner areas and auto-scroll use it). */
  view = { x: 0, y: 0, w: 1600, h: 900 };
  /** World gravity in g (the `gravity` / `flip_gravity` actions change it). */
  gravity: [number, number];
  over = false;
  random: () => number;
  private fired = new Set<string>();
  private timers = new Map<string, number>();
  private armed = new Map<string, boolean>();
  private seenTag = new Map<string, boolean>();
  private later: { at: number; fn: () => void }[] = [];
  private copyN = 0;
  private explicitWin = false;
  private duel = false;
  readonly templates = new Map<string, NObject>();

  constructor(doc: NDoc, scene: NScene, host: Host, opts: { game?: Record<string, number>; random?: () => number } = {}) {
    this.doc = doc;
    this.scene = scene;
    this.host = host;
    this.players = scene.world.players;
    this.game = { ...(opts.game ?? doc.counters) };
    this.gravity = [...scene.world.gravity];
    this.random = opts.random ?? Math.random;
    for (const o of scene.objects) this.templates.set(o.id, o);
    const allRules = [...doc.rules, ...scene.rules, ...scene.objects.flatMap((o) => o.rules)];
    this.explicitWin = allRules.some((r) => r.then.some((a) => a.type === 'win' || a.type === 'next_scene' || a.type === 'go_scene'))
      || scene.objects.some((o) => o.behaviors.some((b) => b.type === 'goal'));
    const placed = scene.objects.filter((o) => !o.template);
    this.duel = placed.some((o) => o.player === 1) && placed.some((o) => o.player === 2);
  }

  // ---- entities ---------------------------------------------------------------------------------

  /** Create the entity for an object (the host calls this while building bodies). */
  addEnt(def: NObject, o: { id?: string; templateId?: string | null; x?: number; y?: number } = {}): Ent {
    const x = o.x ?? def.x;
    const y = o.y ?? def.y;
    const e: Ent = {
      id: o.id ?? def.id,
      def,
      templateId: o.templateId ?? null,
      tags: new Set(def.tags),
      counters: { ...def.counters },
      alive: true,
      shown: !def.hidden,
      player: def.player,
      x,
      y,
      angle: def.rotation,
      vx: 0,
      vy: 0,
      w: Math.max(1, def.w * def.scale),
      h: Math.max(1, def.h * def.scale),
      startX: x,
      startY: y,
      checkX: x,
      checkY: y,
      facing: 1,
      faceAngle: null,
      bob: 0,
      invuln: 0,
      behaviors: def.behaviors.map((b) => ({ def: b, on: !b.off, s: {} })),
      rules: def.rules,
      body: null,
      bornAt: this.t,
      shooter: null,
      projectileDamage: 0,
      ai: null,
      aiPrev: null,
      root: null,
      spawnedBy: null,
      groundedPrev: true,
    };
    const hp = e.behaviors.find((b) => b.def.type === 'health');
    if (hp && !('health' in e.counters)) e.counters.health = num(hp.def.params, 'max', 3);
    this.ents.push(e);
    this.byId.set(e.id, e);
    return e;
  }

  live(): Ent[] {
    return this.ents.filter((e) => e.alive);
  }

  /** Alive and shown (hidden objects are inert until shown). */
  active(e: Ent | null | undefined): e is Ent {
    return !!e && e.alive && e.shown;
  }

  beh(e: Ent, type: string): BehState | undefined {
    return e.behaviors.find((b) => b.on && b.def.type === type);
  }

  hasBeh(e: Ent, type: string): boolean {
    return !!this.beh(e, type);
  }

  /** Player n's object (first alive one), else an object tagged "player" for n = 1. */
  playerEnt(n: 1 | 2): Ent | null {
    const live = this.ents.filter((e) => e.alive && !e.def.template);
    return live.find((e) => e.player === n) ?? (n === 1 ? live.find((e) => e.tags.has('player')) ?? null : null);
  }

  private nearestPlayer(from: Ent | null): Ent | null {
    const ps = this.ents.filter((e) => e.alive && e.player > 0);
    if (!ps.length) return this.playerEnt(1);
    if (!from || this.players === 1) return ps.find((e) => e.player === 1) ?? ps[0];
    let best: Ent | null = null;
    let bd = Infinity;
    for (const p of ps) {
      if (p === from) continue;
      const d = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best ?? ps[0];
  }

  /** Is `e` a player object (keys drive it, or tagged "player")? */
  isPlayer(e: Ent): boolean {
    return e.player > 0 || e.tags.has('player');
  }

  /**
   * Targets (§2): self, other, player, player1, player2, any (all), game (none: counters use `subject`), an object id
   * (with the copies of a template id), or a tag. Ids win over tags.
   */
  resolve(t: string, ctx: Ctx): Ent[] {
    const one = (e: Ent | null | undefined): Ent[] => (e && e.alive ? [e] : []);
    switch (t) {
      case '':
      case 'game':
        return [];
      case 'self':
        return one(ctx.self);
      case 'other':
        return one(ctx.other);
      case 'player':
        return one(this.nearestPlayer(ctx.self));
      case 'player1':
        return one(this.playerEnt(1));
      case 'player2':
        return one(this.playerEnt(2));
      case 'any':
        return this.ents.filter((e) => e.alive && !e.def.template);
    }
    const byId = this.byId.get(t);
    if (byId && byId.alive && !byId.def.template) return [byId];
    if (this.templates.has(t)) {
      const copies = this.ents.filter((e) => e.alive && e.templateId === t);
      if (copies.length || byId) return copies;
    }
    const tag = t.toLowerCase();
    return this.ents.filter((e) => e.alive && !e.def.template && e.tags.has(tag));
  }

  /** Does entity `e` match target `t` (event filters like collide.with and damage.to)? */
  matches(t: string, e: Ent, ctx: Ctx): boolean {
    switch (t) {
      case 'any':
      case '':
        return true;
      case 'self':
        return e === ctx.self;
      case 'other':
        return e === ctx.other;
      case 'player':
        return this.isPlayer(e);
      case 'player1':
        return e.player === 1 || (e.player === 0 && e === this.playerEnt(1));
      case 'player2':
        return e.player === 2;
      case 'game':
        return false;
    }
    if (e.id === t || e.templateId === t) return true;
    if (this.byId.has(t) && !this.templates.get(t)?.template) return false; // an id that names another object
    return e.tags.has(t.toLowerCase());
  }

  // ---- counters ----------------------------------------------------------------------------------

  /** Read a counter: subject "game", or a target (first match). Missing reads as 0. */
  read(subject: string, counter: string, ctx: Ctx): number {
    if (subject === 'game') return this.game[counter] ?? 0;
    const e = this.resolve(subject || 'self', ctx)[0];
    return e?.counters[counter] ?? 0;
  }

  setCounter(owner: Ent | 'game', counter: string, value: number): void {
    if (!counter || !Number.isFinite(value)) return;
    const box = owner === 'game' ? this.game : owner.counters;
    const v = Math.round(value * 1000) / 1000;
    if (box[counter] === v) return;
    box[counter] = v;
    this.host.counterChanged(owner === 'game' ? 'game' : owner.id, counter, v);
  }

  addCounter(owner: Ent | 'game', counter: string, delta: number): void {
    const box = owner === 'game' ? this.game : owner.counters;
    this.setCounter(owner, counter, (box[counter] ?? 0) + delta);
  }

  /** All conditions hold (§2: subject self | game | other | an object id; a missing counter reads 0). */
  conditionsHold(conds: NCondition[], ctx: Ctx): boolean {
    for (const c of conds) if (!compare(this.read(c.subject, c.counter, ctx), c.op, c.value)) return false;
    return true;
  }

  // ---- events and rules --------------------------------------------------------------------------

  raise(ev: QueuedEvent): void {
    if (this.next.length >= MAX_QUEUE) this.next.shift();
    this.next.push(ev);
  }

  /** Start the scene: initial seen tags, then the `start` event. */
  start(): void {
    for (const e of this.ents) if (e.alive && !e.def.template) for (const t of e.tags) this.seenTag.set(t, true);
    this.raise({ type: 'start' });
  }

  private globalRules(): { rule: NRule; key: string }[] {
    return [
      ...this.doc.rules.map((rule) => ({ rule, key: `g:${rule.id}` })),
      ...this.scene.rules.map((rule) => ({ rule, key: `s:${rule.id}` })),
    ];
  }

  /** Every rule instance: global ones (self = player 1) then each live object's own. */
  private allInstances(type: string): { rule: NRule; self: Ent | null; other: Ent | null; key: string }[] {
    const out: { rule: NRule; self: Ent | null; other: Ent | null; key: string }[] = [];
    const p1 = this.playerEnt(1);
    for (const { rule, key } of this.globalRules()) if (rule.when.type === type) out.push({ rule, self: p1, other: null, key });
    for (const e of this.ents) {
      if (!this.active(e) || e.def.template) continue;
      for (const rule of e.rules) if (rule.when.type === type) out.push({ rule, self: e, other: null, key: `${e.id}:${rule.id}` });
    }
    return out;
  }

  private objectInstances(type: string, e: Ent, other: Ent | null): { rule: NRule; self: Ent | null; other: Ent | null; key: string }[] {
    const out: { rule: NRule; self: Ent | null; other: Ent | null; key: string }[] = [];
    for (const rule of e.rules) if (rule.when.type === type) out.push({ rule, self: e, other, key: `${e.id}:${rule.id}` });
    if (e === this.playerEnt(1)) {
      for (const { rule, key } of this.globalRules()) if (rule.when.type === type) out.push({ rule, self: e, other, key });
    }
    return out;
  }

  /** Candidates for one event, in firing order, filtered by the event's own params. */
  candidates(ev: QueuedEvent): { rule: NRule; self: Ent | null; other: Ent | null; key: string }[] {
    if (ev.pending) return ev.pending;
    switch (ev.type) {
      case 'start':
        return this.allInstances('start');
      case 'key_down':
      case 'key_up':
        return this.allInstances(ev.type).filter((c) => {
          const s = schemeName(c.self && c.rule !== undefined && this.isObjectRule(c) ? c.self.player : 0, this.players);
          return ruleKeyMatches(str(c.rule.when.params, 'key', 'space'), ev.code ?? '', s);
        });
      case 'collide':
      case 'overlap':
      case 'leave':
        if (!ev.ent || !ev.other) return [];
        return this.objectInstances(ev.type, ev.ent, ev.other).filter((c) =>
          this.matches(str(c.rule.when.params, 'with', 'any'), ev.other!, { self: c.self, other: ev.other! }));
      case 'health_zero':
      case 'destroyed':
      case 'spawned':
      case 'clicked':
      case 'out_of_bounds':
        return ev.ent ? this.objectInstances(ev.type, ev.ent, ev.other ?? null) : [];
      default:
        return [];
    }
  }

  private isObjectRule(c: { key: string }): boolean {
    return !c.key.startsWith('g:') && !c.key.startsWith('s:');
  }

  /** Fire one rule instance if it may (off, once, conditions). Returns true when it ran. */
  fire(rule: NRule, self: Ent | null, other: Ent | null, key: string): boolean {
    if (rule.off || this.over) return false;
    if (rule.once && this.fired.has(key)) return false;
    const ctx = { self, other };
    if (!this.conditionsHold(rule.conditions, ctx)) return false;
    if (rule.once) this.fired.add(key);
    this.firings++;
    for (const a of rule.then) {
      try {
        this.act(a, ctx);
      } catch {
        /* one broken action never stops the game */
      }
      if (this.over) break;
    }
    return true;
  }

  /** Run the queue raised so far (events raised now wait for the next frame), with the per-frame firing cap. */
  processEvents(): void {
    this.firings = 0;
    this.queue = this.next;
    this.next = [];
    const carry: QueuedEvent[] = [];
    while (this.queue.length) {
      const ev = this.queue.shift()!;
      if (this.firings >= MAX_FIRINGS_PER_FRAME) {
        carry.push(ev);
        continue;
      }
      const cands = this.candidates(ev);
      for (let i = 0; i < cands.length; i++) {
        if (this.firings >= MAX_FIRINGS_PER_FRAME) {
          carry.push({ type: ev.type, pending: cands.slice(i) });
          break;
        }
        const c = cands[i];
        if (c.self && !c.self.alive && ev.type !== 'destroyed' && ev.type !== 'health_zero') continue;
        this.fire(c.rule, c.self, c.other, c.key);
      }
    }
    this.next = [...carry, ...this.next];
  }

  /** Timers, repeating timers, counter thresholds and all_gone; plus delayed jobs. Call once per frame. */
  tick(dt: number): void {
    this.t += dt;
    this.frame++;
    for (const e of this.ents) if (e.invuln > 0) e.invuln = Math.max(0, e.invuln - dt);
    if (this.later.length) {
      const due = this.later.filter((l) => l.at <= this.t);
      this.later = this.later.filter((l) => l.at > this.t);
      for (const l of due) l.fn();
    }
    const pending: { rule: NRule; self: Ent | null; other: Ent | null; key: string }[] = [];
    for (const type of ['timer', 'every', 'counter', 'all_gone']) {
      for (const c of this.allInstances(type)) {
        const p = c.rule.when.params;
        const age = this.isObjectRule(c) && c.self ? this.t - c.self.bornAt : this.t;
        if (type === 'timer') {
          if (age >= num(p, 'seconds', 3) && !this.timers.has(c.key)) {
            this.timers.set(c.key, 1);
            pending.push(c);
          }
        } else if (type === 'every') {
          const period = Math.max(0.05, num(p, 'seconds', 2));
          const nextAt = this.timers.get(c.key) ?? period;
          if (age >= nextAt) {
            this.timers.set(c.key, nextAt + period * Math.max(1, Math.floor((age - nextAt) / period) + 1));
            pending.push(c);
          } else if (!this.timers.has(c.key)) this.timers.set(c.key, nextAt);
        } else if (type === 'counter') {
          const ctx = { self: c.self, other: null };
          const v = this.read(str(p, 'subject', 'self') || 'self', str(p, 'counter', 'coins'), ctx);
          const ok = compare(v, str(p, 'op', '>='), num(p, 'value', 10));
          const was = this.armed.get(c.key) ?? false;
          if (ok && !was) pending.push(c);
          this.armed.set(c.key, ok);
        } else {
          const tag = str(p, 'tag', 'enemy');
          const n = this.ents.filter((e) => e.alive && !e.def.template && e.tags.has(tag)).length;
          if (n > 0) {
            this.seenTag.set(tag, true);
            this.armed.set(c.key, false);
          } else if (this.seenTag.get(tag) && !this.armed.get(c.key)) {
            this.armed.set(c.key, true);
            pending.push(c);
          }
        }
      }
    }
    if (pending.length) this.raise({ type: 'tick', pending });
  }

  // ---- actions -------------------------------------------------------------------------------------

  private targets(p: Params, key: string, ctx: Ctx, d = 'self'): Ent[] {
    return this.resolve(str(p, key, d), ctx);
  }

  act(a: NAction, ctx: Ctx): void {
    const p = a.params;
    switch (a.type) {
      case 'add':
      case 'set': {
        const subject = str(p, 'subject', 'game') || 'game';
        const counter = str(p, 'counter', 'score');
        const v = a.type === 'add' ? num(p, 'amount', 1) : num(p, 'value', 0);
        const owners: (Ent | 'game')[] = subject === 'game' ? ['game'] : this.resolve(subject, ctx);
        for (const o of owners) (a.type === 'add' ? this.addCounter(o, counter, v) : this.setCounter(o, counter, v));
        return;
      }
      case 'give': {
        const item = str(p, 'item', 'key');
        const amount = num(p, 'amount', 1);
        for (const t of this.targets(p, 'to', ctx, 'other')) {
          let n = amount;
          if (ctx.self && item in ctx.self.counters && ctx.self !== t) {
            n = Math.min(amount, Math.max(0, ctx.self.counters[item]));
            this.addCounter(ctx.self, item, -n);
          }
          this.addCounter(t, item, n);
        }
        return;
      }
      case 'take': {
        const item = str(p, 'item', 'key');
        const amount = num(p, 'amount', 1);
        for (const t of this.targets(p, 'from', ctx, 'other')) {
          const n = Math.min(amount, Math.max(0, t.counters[item] ?? 0));
          this.addCounter(t, item, -n);
          if (ctx.self && ctx.self !== t && item in ctx.self.counters) this.addCounter(ctx.self, item, n);
        }
        return;
      }
      case 'damage':
        for (const t of this.targets(p, 'target', ctx, 'other')) this.hurt(t, num(p, 'amount', 1), ctx.self, 300);
        return;
      case 'heal':
        for (const t of this.targets(p, 'target', ctx)) this.heal(t, num(p, 'amount', 1));
        return;
      case 'destroy':
        for (const t of this.targets(p, 'target', ctx)) this.destroy(t);
        return;
      case 'spawn': {
        const tpl = str(p, 'template', '');
        const at = this.targets(p, 'at', ctx);
        const count = Math.max(1, Math.min(50, Math.round(num(p, 'count', 1))));
        const v = Array.isArray(p.velocity) ? (p.velocity as number[]) : [0, 0];
        const spots = at.length ? at.map((e) => [e.x, e.y]) : ctx.self ? [[ctx.self.x, ctx.self.y]] : [];
        if (!spots.length) {
          const def = this.templates.get(tpl);
          if (def) spots.push([def.x, def.y]);
        }
        for (const [x, y] of spots) {
          for (let i = 0; i < count; i++) {
            const jx = count > 1 ? (this.random() - 0.5) * 30 : 0;
            this.spawn(tpl, x + jx, y, v[0] ?? 0, v[1] ?? 0);
          }
        }
        return;
      }
      case 'impulse':
        for (const t of this.targets(p, 'target', ctx)) {
          const b = t.body;
          if (b) b.setVelocity(b.vx + num(p, 'x', 0), b.vy + num(p, 'y', -600));
        }
        return;
      case 'velocity':
        for (const t of this.targets(p, 'target', ctx)) t.body?.setVelocity(num(p, 'x', 0), num(p, 'y', 0));
        return;
      case 'teleport': {
        const dest = this.resolve(str(p, 'to', ''), ctx)[0];
        if (!dest) return;
        for (const t of this.targets(p, 'target', ctx, 'other')) {
          if (t === dest) continue;
          t.body?.setPosition(dest.x, dest.y);
          t.x = dest.x;
          t.y = dest.y;
          this.host.fx('poof', t);
        }
        return;
      }
      case 'show':
      case 'hide': {
        // hidden objects are not "alive targets" for most actions, but show must reach them
        const name = str(p, 'target', 'self');
        const list = a.type === 'show' ? this.resolveIncludingHidden(name, ctx) : this.targets(p, 'target', ctx);
        for (const t of list) this.setShown(t, a.type === 'show');
        return;
      }
      case 'solid':
        for (const t of this.targets(p, 'target', ctx)) this.host.setSensor(t, !bool(p, 'on', true));
        return;
      case 'gravity':
        this.gravity = [num(p, 'x', 0), num(p, 'y', -1)];
        this.host.setGravity(this.gravity[0], this.gravity[1]);
        return;
      case 'flip_gravity':
        this.gravity = [-this.gravity[0], -this.gravity[1]];
        this.host.flipGravity();
        return;
      case 'time_scale':
        this.host.timeScale(num(p, 'scale', 0.5), num(p, 'seconds', 3));
        return;
      case 'enable': {
        const which = str(p, 'behavior', '');
        for (const t of this.targets(p, 'target', ctx)) {
          for (const b of t.behaviors) if (b.def.id === which || b.def.type === which) b.on = bool(p, 'on', true);
        }
        return;
      }
      case 'sound':
        this.host.sound(str(p, 'name', 'ding'));
        return;
      case 'shake':
        this.host.shake(num(p, 'power', 1));
        return;
      case 'flash':
        this.host.flash(str(p, 'color', '#ffffff'));
        return;
      case 'say': {
        const text = str(p, 'text', 'Hi!').slice(0, 120);
        const secs = Math.max(0.3, Math.min(30, num(p, 'seconds', 2.5)));
        const ts = this.targets(p, 'target', ctx);
        if (!ts.length) this.host.say(null, text, secs);
        for (const t of ts) this.host.say(t, text, secs);
        this.host.emit({ type: 'say', text, object: ts[0]?.id });
        return;
      }
      case 'camera':
        this.host.camera(this.targets(p, 'target', ctx)[0] ?? null, num(p, 'zoom', 1));
        return;
      case 'win':
        this.host.win();
        return;
      case 'lose':
        this.host.lose();
        return;
      case 'next_scene':
        this.host.nextScene();
        return;
      case 'go_scene':
        this.host.goScene(str(p, 'scene', ''));
        return;
      default:
        return;
    }
  }

  resolveIncludingHidden(t: string, ctx: Ctx): Ent[] {
    const live = this.resolve(t, ctx);
    if (live.length) return live;
    const e = this.byId.get(t);
    if (e && e.alive) return [e];
    return this.ents.filter((x) => x.alive && !x.def.template && x.tags.has(t.toLowerCase()));
  }

  setShown(e: Ent, shown: boolean): void {
    if (e.shown === shown) return;
    e.shown = shown;
    this.host.setVisible(e, shown);
    if (shown) this.host.fx('spawn', e);
  }

  // ---- life and death ------------------------------------------------------------------------------

  healthMax(e: Ent): number {
    const hp = this.beh(e, 'health');
    return hp ? num(hp.def.params, 'max', 3) : Math.max(1, e.def.counters.health ?? e.counters.health ?? 1);
  }

  /** Damage (§3 health): respects the safe time after a hit; no health at all = destroyed. */
  hurt(e: Ent, amount: number, src: Ent | null, knockback = 0): void {
    if (!this.active(e) || amount <= 0 || this.over) return;
    const hp = this.beh(e, 'health');
    const hasHealth = !!hp || 'health' in e.counters;
    if (!hasHealth) {
      this.host.fx('hit', e, { other: src ?? undefined });
      this.destroy(e);
      return;
    }
    if (e.invuln > 0) return;
    this.addCounter(e, 'health', -amount);
    e.invuln = hp ? num(hp.def.params, 'invulnerable', 0.6) : 0.3;
    this.host.fx('hit', e, { power: amount, other: src ?? undefined });
    if (knockback > 0 && src && e.body && e.body.kind === 'dynamic') {
      const dir = Math.sign(e.x - src.x) || (src.facing ?? 1);
      e.body.setVelocity(e.body.vx + dir * knockback, e.body.vy - knockback * 0.45);
    }
    if ((e.counters.health ?? 0) <= 0) this.zero(e);
  }

  heal(e: Ent, amount: number): void {
    const max = this.healthMax(e);
    this.setCounter(e, 'health', Math.min(max, (e.counters.health ?? 0) + amount));
    this.host.fx('heal', e);
  }

  /** Health reached zero: health_zero event, then on_zero. */
  zero(e: Ent): void {
    this.raise({ type: 'health_zero', ent: e });
    const hp = this.beh(e, 'health');
    const mode = hp ? str(hp.def.params, 'on_zero', 'destroy') : 'destroy';
    if (mode === 'destroy') this.destroy(e);
    else if (mode === 'lose') this.host.lose();
    else if (mode === 'respawn') this.lifeLost(e, true);
  }

  /** A player object died or fell out: −1 life (game counter `lives` if it exists) and respawn, or lose. */
  lifeLost(e: Ent, viaHealth = false): void {
    if ('lives' in this.game) {
      this.addCounter('game', 'lives', -1);
      if ((this.game.lives ?? 0) <= 0) {
        this.host.lose();
        return;
      }
      this.respawn(e);
      return;
    }
    const hp = this.beh(e, 'health');
    if (viaHealth || (hp && str(hp.def.params, 'on_zero', 'destroy') === 'respawn')) this.respawn(e);
    else this.host.lose();
  }

  respawn(e: Ent): void {
    e.body?.setVelocity(0, 0);
    e.body?.setPosition(e.checkX, e.checkY);
    e.x = e.checkX;
    e.y = e.checkY;
    if (this.beh(e, 'health') || 'health' in e.counters) this.setCounter(e, 'health', this.healthMax(e));
    e.invuln = 1.2;
    this.host.fx('respawn', e);
  }

  destroy(e: Ent, fx: 'poof' | 'quiet' = 'poof'): void {
    if (!e.alive) return;
    e.alive = false;
    this.host.destroy(e, fx);
    this.raise({ type: 'destroyed', ent: e });
    this.host.emit({ type: 'destroyed', object: e.id });
    // parts hanging on it by wheel / weld joints go with it
    for (const o of this.ents) if (o.alive && o.root === e) this.destroy(o, 'quiet');
    if (this.duel && !this.explicitWin && e.player > 0 && !this.over) {
      const otherAlive = this.ents.some((x) => x.alive && x.player > 0 && x.player !== e.player);
      if (otherAlive) {
        if (this.players === 2) this.host.win(e.player === 1 ? 'rt.p2_wins' : 'rt.p1_wins');
        else if (e.player === 1) this.host.lose('rt.p2_wins');
        else this.host.win();
      }
    }
  }

  /** Make a copy of a template (or any object) at a point. Fresh id `<template id>#<n>`. */
  spawn(templateId: string, x: number, y: number, vx = 0, vy = 0, o: { angle?: number; shooter?: Ent; spawner?: string } = {}): Ent | null {
    if (this.over) return null;
    const def = templateId === 'default' || !templateId ? (o.shooter ? this.host.defaultProjectile() : null) : this.templates.get(templateId);
    if (!def) return null;
    if (this.ents.filter((e) => e.alive).length >= MAX_ENTITIES) return null;
    if (!def.drawing?.strokes?.length && !(def.w > 0 && def.h > 0)) return null; // empty templates are ignored
    const id = `${def.id}#${++this.copyN}`;
    const copy: NObject = { ...def, id, x, y, template: false, hidden: false, rotation: o.angle ?? def.rotation };
    const e = this.host.spawn(copy, { vx, vy, angle: o.angle });
    if (!e) return null;
    e.templateId = def.id;
    e.spawnedBy = o.spawner ?? null;
    if (o.shooter) e.shooter = o.shooter;
    for (const t of e.tags) this.seenTag.set(t, true);
    this.raise({ type: 'spawned', ent: e });
    this.host.emit({ type: 'spawned', object: e.id });
    return e;
  }

  later_(seconds: number, fn: () => void): void {
    this.later.push({ at: this.t + seconds, fn });
  }

  // ---- contacts --------------------------------------------------------------------------------------

  /** Are these two on the same side (a shooter and its projectiles; allies share a tag unless they are rival players)? */
  allies(a: Ent, b: Ent): boolean {
    if (a === b) return true;
    if (a.player > 0 && b.player > 0) return a.player === b.player;
    for (const t of a.tags) if (b.tags.has(t)) return true;
    return false;
  }

  /**
   * A contact from the physics adapter. `kind`: begin / active (every step while touching) / end. `nx, ny` is the
   * contact normal pointing from a to b. The adapter maps wheel parts to their car (`root`) before calling.
   */
  contact(kind: 'begin' | 'active' | 'end', a: Ent, b: Ent, sensor: boolean, nx = 0, ny = 0, speed = 0): void {
    if (!this.active(a) || !this.active(b) || a === b || this.over) return;
    if (kind === 'end') {
      this.raise({ type: 'leave', ent: a, other: b });
      this.raise({ type: 'leave', ent: b, other: a });
      return;
    }
    this.touch(kind, a, b, sensor, nx, ny, speed);
    if (this.active(a) && this.active(b)) this.touch(kind, b, a, sensor, -nx, -ny, speed);
    if (kind === 'begin') {
      for (const [x, y] of [[a, b], [b, a]]) {
        this.raise({ type: 'overlap', ent: x, other: y });
        if (!sensor) this.raise({ type: 'collide', ent: x, other: y });
      }
    }
  }

  /** Behaviours of `e` reacting to touching `o` (normal from e to o). */
  private touch(kind: 'begin' | 'active', e: Ent, o: Ent, sensor: boolean, nx: number, ny: number, speed: number): void {
    const ctx = { self: e, other: o };
    // projectiles fired by a shooter
    if (e.shooter && kind === 'begin') {
      const sh = e.shooter;
      if (o === sh || o.shooter || this.allies(sh, o)) return; // own side and other bullets: pass through
      const hasHealth = !!this.beh(o, 'health') || 'health' in o.counters;
      const moving = !!o.body && (o.body.kind === 'dynamic' || o.body.kind === 'kinematic');
      if (e.projectileDamage > 0 && (hasHealth || (moving && !o.def.physics.sensor))) {
        this.hurt(o, e.projectileDamage, e, 260);
        this.destroy(e);
        return;
      }
      if (!o.def.physics.sensor && o.def.physics.body !== 'none') {
        this.destroy(e); // hit a wall or the ground
        return;
      }
    }
    for (const b of e.behaviors) {
      if (!b.on) continue;
      const p = b.def.params;
      switch (b.def.type) {
        case 'pickup': {
          if (kind !== 'begin' || !this.matches(str(p, 'to', 'player'), o, ctx) || !e.shown) break;
          const item = str(p, 'item', 'coins') || 'coins';
          const amount = num(p, 'amount', 1);
          if (item === 'score') this.addCounter('game', 'score', amount);
          else {
            this.addCounter(o, item, amount);
            if (item === 'coins' || item === 'coin') this.addCounter('game', 'score', amount);
          }
          this.host.fx('pickup', e, { other: o });
          const re = num(p, 'respawn', 0);
          if (re > 0) {
            this.setShown(e, false);
            this.later_(re, () => e.alive && this.setShown(e, true));
          } else this.destroy(e, 'quiet');
          return;
        }
        case 'damage': {
          if (!this.matches(str(p, 'to', 'player'), o, ctx)) break;
          if (e.shooter && (o === e.shooter || this.allies(e.shooter, o))) break;
          if (kind === 'active' && o.invuln > 0) break;
          const minSpeed = num(p, 'min_speed', 0);
          if (minSpeed > 0 && (kind === 'active' || speed < minSpeed)) break;
          const hadHealth = !!this.beh(o, 'health') || 'health' in o.counters;
          if (kind === 'active' && !hadHealth) break;
          this.hurt(o, num(p, 'amount', 1), e, num(p, 'knockback', 350));
          if (bool(p, 'destroy_self', false)) {
            this.destroy(e);
            return;
          }
          break;
        }
        case 'hazard': {
          if (!this.matches(str(p, 'to', 'player'), o, ctx) || o.invuln > 0) break;
          if (this.beh(o, 'health') || 'health' in o.counters) {
            o.invuln = 0;
            this.hurt(o, Math.max(1, o.counters.health ?? 1), e, 0);
          } else if (this.isPlayer(o)) this.lifeLost(o);
          else this.destroy(o);
          break;
        }
        case 'goal': {
          if (kind !== 'begin' || !this.matches(str(p, 'by', 'player'), o, ctx)) break;
          this.host.fx('goal', e, { other: o });
          if (str(p, 'then', 'next_scene') === 'win') this.host.win();
          else this.host.nextScene();
          return;
        }
        case 'checkpoint': {
          if (kind !== 'begin' || !this.isPlayer(o)) break;
          if (o.checkX === e.x && o.checkY === e.y - e.h / 2) break;
          o.checkX = e.x;
          o.checkY = e.y - Math.max(0, e.h / 2 - o.h / 2) - 4;
          if (b.s.done !== true) {
            b.s.done = true;
            this.host.fx('checkpoint', e, { other: o });
          }
          break;
        }
        case 'bounce_pad': {
          // `o` landed on it from above: normal from pad to o points up (rotated with the pad)
          if (kind !== 'begin' || !o.body || o.body.kind !== 'dynamic') break;
          const a = (e.angle * Math.PI) / 180;
          const ux = Math.sin(a);
          const uy = -Math.cos(a);
          if (nx * ux + ny * uy < 0.5) break;
          const pw = num(p, 'power', 1000);
          o.body.setVelocity(o.body.vx * 0.6 + ux * pw, uy * pw);
          o.groundedPrev = false;
          this.host.fx('boing', e, { other: o });
          break;
        }
        case 'conveyor': {
          if (!o.body || o.body.kind !== 'dynamic') break;
          if (ny > -0.5) break; // only things on top (normal from conveyor to o points up)
          const sp = num(p, 'speed', 150);
          o.body.groundVx = sp;
          if (!this.hasBeh(o, 'platformer') && !this.hasBeh(o, 'move_keys')) o.body.setVelocity(o.body.vx + (sp - o.body.vx) * 0.25, o.body.vy);
          break;
        }
      }
    }
  }

  /** Something left the world (edges none, or pushed behind an auto-scrolling camera). */
  outOfBounds(e: Ent): void {
    if (!e.alive || this.over) return;
    this.raise({ type: 'out_of_bounds', ent: e });
    if (this.isPlayer(e) && !e.def.template) {
      if (e.root) return;
      this.lifeLost(e);
    } else if (!e.root) this.destroy(e, 'quiet');
  }

  clicked(e: Ent): void {
    if (this.active(e)) this.raise({ type: 'clicked', ent: e });
  }

  key(type: 'key_down' | 'key_up', code: string): void {
    this.raise({ type, code });
  }

  /** Topmost shown entity under a world point (rotated boxes). */
  hitTest(x: number, y: number, pad = 0): Ent | null {
    let best: Ent | null = null;
    for (const e of this.ents) {
      if (!this.active(e) || e.def.template) continue;
      const a = (-e.angle * Math.PI) / 180;
      const dx = x - e.x;
      const dy = y - e.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= e.w / 2 + pad && Math.abs(ly) <= e.h / 2 + pad) {
        if (!best || e.def.layer > best.def.layer || (e.def.layer === best.def.layer && e.def.order >= best.def.order)) best = e;
      }
    }
    return best;
  }

  /** Counters for the Studio watch panel: game + every object that has counters. */
  countersSnapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = { game: { ...this.game } };
    for (const e of this.ents) if (e.alive && Object.keys(e.counters).length) out[e.id] = { ...e.counters };
    return out;
  }
}
