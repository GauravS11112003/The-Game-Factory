/**
 * Pure helpers for the v4 workspace (lane D, docs/v4/CONTRACTS_V4.md §2, §3, §7): a level's status chip, the bot
 * pill for a design block, rule-card sentences when the core has no describeRule yet, fresh rule ids, what a block
 * does, block filters and tags. No DOM here, so vitest runs these in node.
 */
import type {
  Behavior, BlockCard, BlockKind, DesignBlock, Flag, GameMode, LevelV2, MessageRef, RuleDo, RuleV4, RuleWhen,
} from '../../core/types.gen.ts';
import { DIFFICULTY } from '../../core/params.ts';
import type { LevelCard } from '../api.ts';
import { bindingTag, chipBinding, DEFAULT_CHIP_OPTIONS } from '../../editor/chips.ts';
import { fmtClock, t } from '../messages.ts';

export const MODES: readonly GameMode[] = ['platformer', 'topdown', 'runner', 'flappy'];
export const BLOCK_KINDS: readonly BlockKind[] = ['creature', 'platform', 'hazard', 'pickup', 'prop', 'player', 'rules'];

export function isMode(v: unknown): v is GameMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

// ---- levels ----------------------------------------------------------------------------------------------------------

/** Flags that need fixing: severity hard or block (warn and info are notes). */
export function fixCount(flags: readonly Flag[] | null | undefined): number {
  return (flags ?? []).filter((f) => f.severity === 'hard' || f.severity === 'block').length;
}

export type LevelStatus = { kind: 'beat' } | { kind: 'fix'; n: number } | { kind: 'unchecked' };

/** Beatable (the bot clears it and nothing needs fixing), N to fix, or not checked yet (no design report). */
export function levelStatus(level: LevelV2 | null | undefined): LevelStatus {
  const d = level?.design;
  if (!d) return { kind: 'unchecked' };
  const n = fixCount(d.flags);
  if (!d.solvable) return { kind: 'fix', n: Math.max(1, n) };
  return n ? { kind: 'fix', n } : { kind: 'beat' };
}

/** The level to show first: the one asked for, else the newest by created_at, else the last in the game's order. */
export function firstLevel(levels: readonly LevelCard[], asked: string | null): LevelCard | null {
  if (asked) {
    const hit = levels.find((l) => l.id === asked);
    if (hit) return hit;
  }
  let best: LevelCard | null = null;
  for (const l of levels) if (l.level?.created_at && (!best?.level?.created_at || l.level.created_at > best.level.created_at)) best = l;
  return best ?? levels[levels.length - 1] ?? null;
}

export function statusText(s: LevelStatus): string {
  return s.kind === 'beat' ? t('gw.status_beatable') : s.kind === 'fix' ? t('gw.status_fix', { n: s.n }) : t('gw.status_unchecked');
}

/** "Easy · about 1 fall in 6 tries · bot 0:31 · par 0:41" from a level's design block (readout.ts does it for reports). */
export function designPill(d: DesignBlock): string {
  const e = d.segments.reduce((m, s) => Math.max(m, s.E), 0);
  const args = { band: t(`band.${d.band}`), bot: fmtClock(d.fastest_ms), par: fmtClock(d.par_ms) };
  if (e < DIFFICULTY.rarely_fall_E) return t('readout.rarely_fall', args);
  return t('readout.pill', { ...args, n: Math.max(1, Math.round(1 / e)) });
}

/** A flag's sentence: its own message key when it has one, else the flag code's. */
export function flagRef(f: Flag): MessageRef {
  return { key: f.message_key || `flag.${f.code}`, args: f.args ?? {} };
}

// ---- rules -------------------------------------------------------------------------------------------------------------

function whenRef(w: RuleWhen): MessageRef {
  switch (w.kind) {
    case 'start':
    case 'all_coins':
    case 'zone':
      return { key: `gw.rule.when_${w.kind}` };
    case 'key':
      return { key: w.key === 'space' ? 'gw.rule.when_key_space' : 'gw.rule.when_key_action' };
    case 'touch':
      return { key: 'gw.rule.when_touch', args: { target: w.target } };
    case 'collect':
      if (w.target) return { key: 'gw.rule.when_collect', args: { target: w.target } };
      if (w.item === 'coin') return { key: 'gw.rule.when_collect_coin' };
      return { key: 'gw.rule.when_collect_item', args: { item: w.item ?? '' } };
    case 'timer':
      return { key: w.every ? 'gw.rule.when_timer_every' : 'gw.rule.when_timer', args: { seconds: w.seconds } };
    case 'score':
      return { key: 'gw.rule.when_score', args: { n: w.at_least } };
    case 'counter':
      return { key: 'gw.rule.when_counter', args: { name: w.name, n: w.at_least } };
  }
}

function doRef(d: RuleDo): MessageRef {
  switch (d.kind) {
    case 'gravity':
    case 'speed':
    case 'jump_power':
      return { key: `gw.rule.do_${d.kind}${d.seconds ? '_for' : ''}`, args: { times: d.times, seconds: d.seconds ?? 0 } };
    case 'reverse_controls':
      return { key: `gw.rule.do_reverse_controls${d.seconds ? '_for' : ''}`, args: { seconds: d.seconds ?? 0 } };
    case 'teleport':
      return d.target ? { key: 'gw.rule.do_teleport', args: { target: d.target } }
        : { key: 'gw.rule.do_teleport_to', args: { x: d.to?.[0] ?? 0, y: d.to?.[1] ?? 0 } };
    case 'toggle':
      return { key: `gw.rule.do_toggle_${d.to ?? 'flip'}`, args: { target: d.target } };
    case 'open':
      return { key: 'gw.rule.do_open', args: { target: d.target } };
    case 'freeze_enemies':
      return { key: 'gw.rule.do_freeze_enemies', args: { seconds: d.seconds } };
    case 'add_score':
      return { key: 'gw.rule.do_add_score', args: { n: d.n } };
    case 'add_counter':
      return { key: 'gw.rule.do_add_counter', args: { n: d.n ?? 1, name: d.name } };
    case 'say':
      return { key: 'gw.rule.do_say', args: { text: d.text } };
    case 'sound':
      return { key: 'gw.rule.do_sound', args: { name: d.name } };
    default:
      return { key: `gw.rule.do_${d.kind}` };
  }
}

/** One sentence per part ("When you press space", "flip gravity"): the local stand-in for core.describeRule. */
export function fallbackRuleParts(rule: RuleV4): MessageRef[] {
  return [whenRef(rule.when), ...rule.then.map(doRef)];
}

/** `incoming` with ids that are new in `existing` (g1, g2, … after the highest one used). */
export function withFreshIds(existing: readonly RuleV4[], incoming: readonly RuleV4[], prefix = 'g'): RuleV4[] {
  const used = new Set(existing.map((r) => r.id));
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let n = existing.reduce((m, r) => Math.max(m, Number(re.exec(r.id)?.[1] ?? 0)), 0) + 1;
  return incoming.map((r) => {
    let id = `${prefix}${n++}`;
    while (used.has(id)) id = `${prefix}${n++}`;
    used.add(id);
    return { ...r, id };
  });
}

// ---- blocks ------------------------------------------------------------------------------------------------------------

/** Kid words for a behaviour ("walks", "a portal", "wind pushes you"), or null for a rules-only block. */
export function behaviourText(b: Behavior | null | undefined): string | null {
  if (!b) return null;
  switch (b.kind) {
    case 'portal':
    case 'npc':
    case 'saw':
    case 'firebar':
      return t(`blocks.does_${b.kind}`);
    case 'zone':
      return t(`blocks.does_zone_${b.effect}`);
    case 'pickup':
      return t(`blocks.does_pickup_${b.effect ?? 'none'}`);
    default:
      return bindingTag({ id: 'x', color: 'black', kind: 'line', pts: [[0, 0]], w: [0.5], closed: false, sheet: 0, origin: 'kid', rule: b });
  }
}

/** "walks · spiky · 2 rules" for a block card. */
export function blockDoes(b: Pick<BlockCard, 'kind' | 'behavior' | 'spiky' | 'logic'>): string {
  const bits: string[] = [];
  const does = behaviourText(b.behavior);
  if (does) bits.push(does);
  else if (b.kind !== 'rules') bits.push(t(`blocks.kind_${b.kind}`));
  if (b.spiky) bits.push(t('creature.spiky_short'));
  const n = b.logic?.length ?? 0;
  if (n) bits.push(n === 1 ? t('blocks.rules_one') : t('blocks.rules_n', { n }));
  return bits.join(' · ') || t('blocks.does_nothing');
}

/** Search words and a kind, applied on the client too (the server filters as well; this keeps the grid honest). */
export function filterBlocks(list: readonly BlockCard[], o: { q?: string; kind?: BlockKind | null }): BlockCard[] {
  const words = (o.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((b) => {
    if (o.kind && b.kind !== o.kind) return false;
    if (!words.length) return true;
    const hay = [b.name, b.author, b.description ?? '', ...(b.tags ?? [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function sortBlocks(list: readonly BlockCard[], sort: 'new' | 'popular'): BlockCard[] {
  const byNew = (a: BlockCard, b: BlockCard): number => (b.created_at ?? '').localeCompare(a.created_at ?? '');
  return list.slice().sort(sort === 'popular' ? (a, b) => (b.uses ?? 0) - (a.uses ?? 0) || byNew(a, b) : byNew);
}

/** "lava, Cave , cave,  spooky" → ["lava", "cave", "spooky"] (≤ 8 tags, ≤ 20 characters each). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,#\n]+/)) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 20).trim();
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}

// ---- block studio defaults ---------------------------------------------------------------------------------------------

export type BehaviourKind = Behavior['kind'];
export const BEHAVIOURS: readonly BehaviourKind[] = ['static', 'enemy', 'move', 'spring', 'crumble', 'falling', 'saw', 'firebar', 'portal', 'zone', 'pickup', 'npc'];

/** A behaviour of that kind with the editor's everyday numbers (the same ones its chips write). */
export function defaultBehaviour(kind: BehaviourKind, npcLine = '…'): Behavior {
  const chip = (id: Parameters<typeof chipBinding>[0]): Behavior => chipBinding(id, DEFAULT_CHIP_OPTIONS).rule ?? { kind: 'static' };
  switch (kind) {
    case 'enemy':
      return chip('walker');
    case 'move':
      return chip('move_h');
    case 'spring':
      return chip('bouncy');
    case 'crumble':
      return chip('crumbles');
    case 'falling':
      return chip('falls');
    case 'saw':
      return { kind: 'saw' };
    case 'firebar':
      return { kind: 'firebar' };
    case 'portal':
      return { kind: 'portal', pair: 'a' };
    case 'zone':
      return { kind: 'zone', effect: 'wind', dir: 'right', strength: 1 };
    case 'pickup':
      return { kind: 'pickup', item: 'star', effect: 'none' };
    case 'npc':
      return { kind: 'npc', lines: [npcLine], name: null };
    default:
      return { kind: 'static' };
  }
}

/** How a behaviour usually collides: moving, crumbling and falling ledges are one-way, springs solid, the rest none. */
export function collisionFor(b: Behavior | null | undefined): 'solid' | 'one_way' | 'none' {
  if (!b) return 'none';
  return b.kind === 'move' || b.kind === 'crumble' || b.kind === 'falling' ? 'one_way' : b.kind === 'spring' ? 'solid' : 'none';
}
