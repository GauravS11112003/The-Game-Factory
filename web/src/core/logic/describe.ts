/**
 * Rule cards (docs/v4/CONTRACTS_V4.md §2.4): core.describeRule(rule) → one MessageRef per part, the trigger first
 * ("When you press Space") then each action ("flip gravity"), keyed logic.when.<kind> and logic.do.<kind> (variants
 * add a suffix: logic.when.key_space, logic.do.speed_timed). Sentences live in shared/spec/messages-v4/core.json.
 */
import type { MessageRef, RuleDo, RuleV4, RuleWhen } from '../types.gen.ts';

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function whenRef(w: RuleWhen): MessageRef {
  switch (w.kind) {
    case 'start': return { key: 'logic.when.start', args: {} };
    case 'key': return { key: w.key === 'space' ? 'logic.when.key_space' : 'logic.when.key_action', args: {} };
    case 'touch': return { key: 'logic.when.touch', args: { target: w.target } };
    case 'collect':
      if (w.target) return { key: 'logic.when.collect', args: { what: w.target } };
      return { key: w.item === 'coin' ? 'logic.when.collect_coin' : 'logic.when.collect_item', args: { what: w.item ?? '' } };
    case 'all_coins': return { key: 'logic.when.all_coins', args: {} };
    case 'timer': return { key: w.every ? 'logic.when.timer_every' : 'logic.when.timer', args: { seconds: r2(w.seconds) } };
    case 'zone': return { key: 'logic.when.zone', args: { x: w.rect[0], y: w.rect[1], x1: w.rect[2], y1: w.rect[3] } };
    case 'score': return { key: 'logic.when.score', args: { n: w.at_least } };
    case 'counter': return { key: 'logic.when.counter', args: { name: w.name, n: w.at_least } };
  }
}

function timed(base: string, seconds: number | null | undefined, args: Record<string, string | number>): MessageRef {
  return typeof seconds === 'number' ? { key: `${base}_timed`, args: { ...args, seconds: r2(seconds) } } : { key: base, args };
}

function doRef(a: RuleDo): MessageRef {
  switch (a.kind) {
    case 'flip_gravity': return { key: 'logic.do.flip_gravity', args: {} };
    case 'gravity': return timed('logic.do.gravity', a.seconds, { times: r2(a.times) });
    case 'speed': return timed('logic.do.speed', a.seconds, { times: r2(a.times) });
    case 'jump_power': return timed('logic.do.jump_power', a.seconds, { times: r2(a.times) });
    case 'reverse_controls': return timed('logic.do.reverse_controls', a.seconds, {});
    case 'teleport':
      return a.target ? { key: 'logic.do.teleport', args: { target: a.target } } : { key: 'logic.do.teleport_cell', args: { x: a.to?.[0] ?? 0, y: a.to?.[1] ?? 0 } };
    case 'toggle': return { key: a.to === 'on' ? 'logic.do.toggle_on' : a.to === 'off' ? 'logic.do.toggle_off' : 'logic.do.toggle', args: { target: a.target } };
    case 'open': return { key: 'logic.do.open', args: { target: a.target } };
    case 'freeze_enemies': return { key: 'logic.do.freeze_enemies', args: { seconds: r2(a.seconds) } };
    case 'add_score': return a.n < 0 ? { key: 'logic.do.lose_score', args: { n: -a.n } } : { key: 'logic.do.add_score', args: { n: a.n } };
    case 'add_counter': {
      const n = a.n ?? 1;
      return n < 0 ? { key: 'logic.do.lose_counter', args: { name: a.name, n: -n } } : { key: 'logic.do.add_counter', args: { name: a.name, n } };
    }
    case 'heal': return { key: 'logic.do.heal', args: {} };
    case 'hurt': return { key: 'logic.do.hurt', args: {} };
    case 'win': return { key: 'logic.do.win', args: {} };
    case 'lose': return { key: 'logic.do.lose', args: {} };
    case 'say': return { key: a.target ? 'logic.do.say_target' : 'logic.do.say', args: { text: a.text, target: a.target ?? '' } };
    case 'sound': return { key: 'logic.do.sound', args: { name: a.name } };
    case 'shake': return { key: 'logic.do.shake', args: {} };
  }
}

/** core.describeRule: [when, ...actions] (+ logic.once for once rules). */
export function describeRule(rule: RuleV4): MessageRef[] {
  const out: MessageRef[] = [whenRef(rule.when)];
  for (const a of rule.then ?? []) out.push(doRef(a));
  if (rule.once) out.push({ key: 'logic.once', args: {} });
  return out;
}

/** Every message key describeRule can return (the messages test checks core.json covers them). */
export const LOGIC_MESSAGE_KEYS: readonly string[] = [
  'logic.when.start', 'logic.when.key_space', 'logic.when.key_action', 'logic.when.touch', 'logic.when.collect', 'logic.when.collect_coin',
  'logic.when.collect_item', 'logic.when.all_coins', 'logic.when.timer', 'logic.when.timer_every', 'logic.when.zone', 'logic.when.score',
  'logic.when.counter', 'logic.do.flip_gravity', 'logic.do.gravity', 'logic.do.gravity_timed', 'logic.do.speed', 'logic.do.speed_timed',
  'logic.do.jump_power', 'logic.do.jump_power_timed', 'logic.do.reverse_controls', 'logic.do.reverse_controls_timed', 'logic.do.teleport',
  'logic.do.teleport_cell', 'logic.do.toggle', 'logic.do.toggle_on', 'logic.do.toggle_off', 'logic.do.open', 'logic.do.freeze_enemies',
  'logic.do.add_score', 'logic.do.lose_score', 'logic.do.add_counter', 'logic.do.lose_counter', 'logic.do.heal', 'logic.do.hurt',
  'logic.do.win', 'logic.do.lose', 'logic.do.say', 'logic.do.say_target', 'logic.do.sound', 'logic.do.shake', 'logic.once',
];
