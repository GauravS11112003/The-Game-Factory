/**
 * The v4 view contract, read defensively (docs/v4/CONTRACTS_V4.md §4.2). Lane A's sim grows these fields; until it
 * does (or for a sim that predates them) every one reads as the v2 default: platformer, gravity 1, score 0, no
 * counters, no effects, no speech bubble, no keys. Level-side facts (the mode, the keys and score some rule uses,
 * the entities a rule can show or hide) come from `rules.logic` and `compiled.logic`, the same rules the sim runs.
 * Pure: no Phaser, no DOM, so node tests run it.
 */
import type { PlayerView, SimEvent, SimView } from '../core/sim/types.ts';
import type { GameMode, LevelV2, RuleDo, RuleKey, RuleV4 } from '../core/types.gen.ts';

/** New input bits (§4.1): a `key: space` rule's Space, and E / Enter. */
export const IN_SPACE = 64;
export const IN_ACTION = 128;

export interface EffectsV4 {
  speed_f: number;
  jump_f: number;
  gravity_f: number;
  reverse_f: number;
  freeze_f: number;
}

export interface SayV4 {
  text: string;
  target: string | null;
  frames_left: number;
}

/** The §4.2 additions with their defaults filled in. */
export interface V4View {
  mode: GameMode;
  gravity: 1 | -1;
  score: number;
  counters: Record<string, number>;
  effects: EffectsV4;
  say: SayV4 | null;
  uses_keys: RuleKey[];
}

export type V4EventType = 'flip' | 'teleport' | 'portal' | 'pickup' | 'say' | 'sound' | 'shake' | 'score' | 'toggle' | 'freeze' | 'rule';

/** A sim event that may carry a v4 type and its new optional fields (sound / counter / item name, say text). */
export type SimEventV4 = Omit<SimEvent, 'type'> & { type: SimEvent['type'] | V4EventType; name?: string; text?: string };

export const MODES: readonly GameMode[] = ['platformer', 'topdown', 'runner', 'flappy'];
export const RULE_KEYS: readonly RuleKey[] = ['space', 'action'];
export const NO_EFFECTS: Readonly<EffectsV4> = { speed_f: 0, jump_f: 0, gravity_f: 0, reverse_f: 0, freeze_f: 0 };

const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);

export function modeOf(x: unknown): GameMode {
  return typeof x === 'string' && (MODES as readonly string[]).includes(x) ? (x as GameMode) : 'platformer';
}

function keysOf(x: unknown): RuleKey[] {
  if (!Array.isArray(x)) return [];
  return RULE_KEYS.filter((k) => x.includes(k));
}

/** The player's gravity sign (§2.3); 1 when the sim does not report it. */
export function gravityOf(p: PlayerView | null | undefined): 1 | -1 {
  return (p as { gravity?: unknown } | null | undefined)?.gravity === -1 ? -1 : 1;
}

/** SimView → its v4 fields, every absent one at the v2 default. */
export function v4Of(v: SimView | null | undefined): V4View {
  const x = (v ?? {}) as Partial<Record<keyof V4View, unknown>>;
  const e = (x.effects && typeof x.effects === 'object' ? x.effects : {}) as Partial<Record<keyof EffectsV4, unknown>>;
  const counters: Record<string, number> = {};
  if (x.counters && typeof x.counters === 'object') {
    for (const [k, n] of Object.entries(x.counters as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n)) counters[k] = n;
  }
  const s = x.say as Partial<SayV4> | null | undefined;
  const say = s && typeof s === 'object' && typeof s.text === 'string' && s.text.trim()
    ? { text: s.text, target: typeof s.target === 'string' && s.target ? s.target : null, frames_left: num(s.frames_left) }
    : null;
  const pg = gravityOf(v?.player);
  return {
    mode: modeOf(x.mode),
    gravity: x.gravity === -1 || pg === -1 ? -1 : 1,
    score: num(x.score),
    counters,
    effects: { speed_f: num(e.speed_f), jump_f: num(e.jump_f), gravity_f: num(e.gravity_f), reverse_f: num(e.reverse_f), freeze_f: num(e.freeze_f) },
    say,
    uses_keys: keysOf(x.uses_keys),
  };
}

/** The rules the sim evaluates for this level: game-wide first, then the level's own (§2). */
export function levelLogic(level: LevelV2 | null | undefined): RuleV4[] {
  const a = level?.rules?.logic;
  const b = level?.compiled?.logic;
  return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
}

/** The level's mode (null = platformer, §3). */
export function levelMode(level: LevelV2 | null | undefined): GameMode {
  return modeOf(level?.rules?.mode);
}

/** Keys some rule listens to (`when: {kind: 'key'}`), in RULE_KEYS order. */
export function levelKeys(level: LevelV2 | null | undefined): RuleKey[] {
  const used = new Set<string>();
  for (const r of levelLogic(level)) if (r?.when?.kind === 'key') used.add(r.when.key);
  return RULE_KEYS.filter((k) => used.has(k));
}

function actions(level: LevelV2 | null | undefined): RuleDo[] {
  const out: RuleDo[] = [];
  for (const r of levelLogic(level)) if (Array.isArray(r?.then)) out.push(...r.then);
  return out;
}

/** The HUD shows a score when some rule adds to it or waits for it (pickups that score compile to `add_score`). */
export function levelUsesScore(level: LevelV2 | null | undefined): boolean {
  if (levelLogic(level).some((r) => r?.when?.kind === 'score')) return true;
  return actions(level).some((a) => a?.kind === 'add_score');
}

/** Entities a rule can show or hide, plus those that start hidden: their "gone" is a fade, never a death. */
export function toggleTargets(level: LevelV2 | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const e of level?.compiled?.entities ?? []) if ((e as { hidden?: boolean | null }).hidden) out.add(e.id);
  for (const a of actions(level)) if (a?.kind === 'toggle' && typeof a.target === 'string') out.add(a.target);
  return out;
}

/** Union of two key lists, in RULE_KEYS order. */
export function mergeKeys(a: readonly RuleKey[], b: readonly RuleKey[]): RuleKey[] {
  return RULE_KEYS.filter((k) => a.includes(k) || b.includes(k));
}

/**
 * What the character animates from. Top-down has no ground: nobody stands, lands or falls, and walking in any of the
 * four directions plays the walk cycle (facing follows the last horizontal move).
 */
export function poseInput(p: PlayerView, mode: GameMode): { vx: number; vy: number; onGround: boolean; state: PlayerView['state'] } {
  if (mode !== 'topdown') return { vx: p.vx, vy: p.vy, onGround: p.on_ground, state: p.state };
  const speed = Math.hypot(p.vx, p.vy);
  const busy = p.state === 'dead' || p.state === 'respawn' || p.state === 'win';
  return { vx: speed * p.facing, vy: 0, onGround: true, state: busy ? p.state : speed > 6 ? 'run' : 'idle' };
}
