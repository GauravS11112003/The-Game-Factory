/**
 * Written rules → RuleV4 (docs/v4/CONTRACTS_V4.md §2.4), offline: a keyword parser over the fixed vocabulary of
 * app/spec/logic.py. One sentence gives a mode, one rule (WHEN one trigger, DO up to four actions), two rules
 * ("collect 5 stars to win": collect → add_counter, counter → win), or nothing (`unknown`).
 *
 * A sentence becomes logic only when it names both a trigger and an action this vocabulary has, a state the game
 * always has ("gravity is low" → a start rule), or a kind of game ("it's like flappy bird"). Everything else stays
 * for the v2 parser (scene/rules_parser.ts): "the key opens the door", "you have 60 seconds", "the platform moves".
 * Rule ids are r1, r2, … in sentence order.
 *
 *   triggers  press space · press E / enter · touch(ing) X · collect / get / grab X · get all coins · every N seconds ·
 *             after N seconds · at the start · score N · N points to … · collect N X (a counter)
 *   actions   flip gravity · low / heavy gravity · fast / slow / speed boost · jump higher · reverse controls ·
 *             teleport to X · show / hide X · open X · freeze enemies · N points · extra heart · hurt · win · lose ·
 *             says "…" · plays a ding · shake
 *   targets   an entity id named in the sentence, or a noun from `aliases` ("door" → its id); otherwise a touched or
 *             collected noun is a pickup item name ("touching the star" → collect item "star").
 */
import type { GameMode, LogicParseResult, RuleDo, RuleV4, RuleWhen, SoundName } from '../types.gen.ts';

export interface ParseLogicOptions {
  /** Lower-case nouns → entity ids ("door" → "o7"), for sentences that name things by what they are. */
  aliases?: Record<string, string>;
}

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100,
};
const NUM = String.raw`(\d{1,5}(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|hundred)`;
const UNIT = String.raw`(seconds?|secs?|minutes?)`;
const ID_RE = /^[A-Za-z0-9_]{1,40}$/;
const NAME_RE = /^[a-z][a-z0-9 ]{0,15}$/;
const SOUNDS: readonly SoundName[] = ['ding', 'boing', 'zap', 'whoosh', 'boom', 'fanfare'];
/** Nouns that are never pickup items (terrain, the level itself, enemies, or words of an action). */
const NOT_ITEMS = new Set([
  'wall', 'ground', 'floor', 'ceiling', 'lava', 'water', 'spike', 'level', 'game', 'end', 'top', 'bottom', 'screen', 'edge',
  'button', 'key', 'thing', 'it', 'enemy', 'monster', 'faster', 'slower', 'speed', 'boost', 'point', 'heart', 'life', 'bigger',
  'higher', 'hurt', 'gravity', 'back', 'out', 'stuck', 'there', 'home', 'closer', 'away', 'ready', 'start', 'score', 'second',
  'minute', 'power', 'jump', 'control', 'way', 'place', 'time', 'turn', 'chance',
]);
const STOP = new Set(['the', 'a', 'an', 'any', 'every', 'each', 'some', 'all', 'my', 'your', 'that', 'this', 'big', 'little', 'small', 'magic', 'shiny', 'golden', 'gold', 'red', 'blue', 'green', 'yellow', 'purple', 'black', 'pink', 'orange', 'special', 'secret']);
const BREAK = /^(to|and|then|gives?|makes?|will|you|it|lets?|so|for|wins?|opens?|flips?|shows?|hides?|turns?|means?|is|are|does|plays?|starts?|ends?|teleports?|freezes?|hurts?|heals?|scores?|adds?|says?|when|if|or|with|at|in|on)$/;

function num(s: string | undefined): number | null {
  if (!s) return null;
  if (s in NUM_WORDS) return NUM_WORDS[s];
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "stars" → "star", "boxes" → "box", "berries" → "berry"; already-singular words stay. */
export function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function plural(w: string): string {
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(ch|sh|x|s)$/.test(w)) return w + 'es';
  return w + 's';
}

/** A valid item / counter name (≤ 16 chars of lower-case letters, digits and spaces), or null. */
function nameOf(words: string): string | null {
  const w = words.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16).trim();
  return NAME_RE.test(w) ? w : null;
}

/** Normalised sentence: lower case, plain quotes, no trailing punctuation. Quoted text is returned separately. */
function clean(raw: string): { s: string; quote: string | null } {
  const plain = String(raw ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').trim();
  const q = /"([^"]{1,90})"/.exec(plain);
  const s = plain.toLowerCase().replace(/"[^"]*"/g, ' ').replace(/[.!?;:,]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { s, quote: q ? q[1].trim() : null };
}

interface Target { id: string | null; item: string | null }

/** The object noun after a verb: an entity id, an alias, or a pickup item name (its head noun, singular). */
function targetAfter(s: string, verb: RegExp, ids: ReadonlySet<string>, aliases: Record<string, string>, it: string | null = null): Target | null {
  const m = verb.exec(s);
  if (!m) return null;
  const words: string[] = [];
  const skipped: string[] = [];
  for (const w0 of s.slice(m.index + m[0].length).trim().split(/\s+/)) {
    const w = w0.replace(/[^a-z0-9_']/g, '');
    if (!w) continue;
    // "touching the door opens it": it = the thing the trigger named
    if (!words.length && it && (w === 'it' || w === 'them')) return { id: it, item: null };
    // "touching this makes you fast", typed while a stroke was selected
    if (!words.length && (w === 'this' || w === 'that') && aliases[w]) return { id: aliases[w], item: null };
    if (!words.length && STOP.has(w)) {
      skipped.push(w);
      continue;
    }
    if (BREAK.test(w)) break;
    words.push(w);
    if (words.length >= 2) break;
  }
  if (!words.length) return null;
  const lookup = (phrase: string): string | null => {
    for (const id of ids) if (id.toLowerCase() === phrase) return id;
    return aliases[phrase] ?? aliases[singular(phrase)] ?? null;
  };
  const phrases = [words.join(' '), ...(skipped.length ? [`${skipped[skipped.length - 1]} ${words[0]}`] : []), words[words.length - 1], words[0]];
  for (const p of phrases) {
    const id = lookup(p);
    if (id) return { id, item: null };
  }
  const head = singular(words[words.length - 1]);
  if (NOT_ITEMS.has(head) || NOT_ITEMS.has(singular(words[0])) || NUM_WORDS[head] !== undefined) return null;
  const item = nameOf(head);
  return item ? { id: null, item } : null;
}

/** "for 5 seconds" → 5; `def` otherwise. */
function secondsIn(s: string, def: number | null): number | null {
  const m = new RegExp(String.raw`\bfor ${NUM} ${UNIT}`).exec(s);
  if (!m) return def;
  const n = num(m[1]);
  if (n === null || n <= 0) return def;
  return clamp(/^min/.test(m[2]) ? n * 60 : n, 0.5, 600);
}

function modeIn(s: string): GameMode | null {
  if (/\bflappy\b|\bflap(s|ping)?\b/.test(s)) return 'flappy';
  if (/\btop[ -]?down\b|\bfrom above\b|\bbird'?s[ -]eye\b|\boverhead\b|\bzelda\b|\bmaze game\b|\bwalk in (all|four|4) directions\b/.test(s)) return 'topdown';
  if (/\brunner\b|\bendless run|\bauto[ -]?run|\b(always|keeps?|never stops?) (running|moving)\b|\bruns? by (it|him|her)sel(f|ves)\b|\bcan'?t stop running\b/.test(s)) return 'runner';
  if (/\bplatformer\b|\blike mario\b|\bside[ -]?scroll/.test(s)) return 'platformer';
  return null;
}

interface When { when: RuleWhen; counter?: { name: string; n: number } }

const SPACE_KEY = /(?<!\b(in|into|outer|deep|from|to|through|of) )\bspace ?(bar)?\b(?! ?(ships?|levels?|themes?|stations?|worlds?|games?|cats?|m[ae]n|rocks?|aliens?))/;
const ACTION_KEY = /\b(press(es|ing)?|hit(s|ting)?|tap(s|ping)?|push(es|ing)?) (the )?(e|enter)\b|\b(the )?e (key|button)\b|\bkey e\b|\benter\b(?! (the|a|an|into|in)\b)|\breturn key\b|\baction (key|button)\b/;

function triggerIn(s: string, ids: ReadonlySet<string>, aliases: Record<string, string>): When | null {
  // keys (edges): space; E / Enter / the action key
  if (SPACE_KEY.test(s)) return { when: { kind: 'key', key: 'space' } };
  if (ACTION_KEY.test(s)) return { when: { kind: 'key', key: 'action' } };
  // all coins
  if (/\b(all|every|each) (of )?(the |your |my )?coins?\b|\bevery single coin\b/.test(s)) return { when: { kind: 'all_coins' } };
  // timers
  let m = new RegExp(String.raw`\b(every|each) ${NUM}? ?${UNIT}`).exec(s);
  if (m) {
    const n = m[2] ? num(m[2]) : 1;
    if (n !== null && n > 0) return { when: { kind: 'timer', seconds: clamp(/^min/.test(m[3]) ? n * 60 : n, 0.5, 600), every: true } };
  }
  m = new RegExp(String.raw`\b(after|in) ${NUM} ${UNIT}|\b${NUM} ${UNIT} (later|pass|go by)`).exec(s);
  if (m) {
    const n = num(m[2] ?? m[4]);
    const unit = m[3] ?? m[5];
    if (n !== null && n > 0) return { when: { kind: 'timer', seconds: clamp(/^min/.test(unit) ? n * 60 : n, 0.5, 600), every: false } };
  }
  // score: "when your score reaches 100", "get 50 points to win" (not "gives you 10 points")
  m = new RegExp(String.raw`\bscore (reaches|hits|gets to|is|of)? ?${NUM}\b`).exec(s) ?? new RegExp(String.raw`(?<!\b(gives?|adds?|earns?|worth|plus|you|and) )\b${NUM} points? (to|and then|then)\b`).exec(s);
  if (m) {
    const n = num(m[2] ?? m[3]);
    if (n !== null && n >= 1) return { when: { kind: 'score', at_least: clamp(Math.round(n), 1, 100000) } };
  }
  // collect N things (a counter): "collect 5 stars to win", "get 3 gems"
  m = new RegExp(String.raw`\b(collect(s|ing)?|get(s|ting)?|grab(s|bing)?|finds?|finding|picks? up|gather(s|ing)?) (?<n>${NUM.slice(1, -1)}) (?<a>[a-z]+)( (?<b>[a-z]+))?`).exec(s);
  if (m && m.groups) {
    const n = num(m.groups.n);
    const a = m.groups.a;
    const b = m.groups.b;
    const noun = b && !BREAK.test(b) && STOP.has(a) ? b : a;
    const item = nameOf(singular(noun));
    if (n !== null && n >= 2 && item && !NOT_ITEMS.has(item)) {
      const name = nameOf(plural(item));
      if (name) return { when: { kind: 'collect', item }, counter: { name, n: clamp(Math.round(n), 1, 1000) } };
    }
  }
  // touch / collect one thing
  const touch = targetAfter(s, /\b(touch(es|ing)?|bump(s|ing)? into|run(s|ning)? into|walk(s|ing)? into|reach(es|ing)?|step(s|ping)? on)\b/, ids, aliases);
  if (touch) return touch.id ? { when: { kind: 'touch', target: touch.id } } : { when: { kind: 'collect', item: touch.item } };
  const got = targetAfter(s, /\b(collect(s|ing)?|grab(s|bing)?|pick(s|ing)? up|get(s|ting)?|eat(s|ing)?|find(s|ing)?)\b/, ids, aliases);
  if (got) return got.id ? { when: { kind: 'collect', target: got.id } } : { when: { kind: 'collect', item: got.item } };
  // the start of each life
  if (/\b(at|from) the (start|beginning)\b|\bwhen (the level|the game|you) (starts?|begins?)\b|\bwhen you spawn\b|\byou start with\b/.test(s)) return { when: { kind: 'start' } };
  return null;
}

function actionsIn(s: string, quote: string | null, ids: ReadonlySet<string>, aliases: Record<string, string>, trig: When | null): RuleDo[] {
  const out: RuleDo[] = [];
  const add = (a: RuleDo): void => {
    if (out.length < 4 && !out.some((b) => b.kind === a.kind)) out.push(a);
  };
  const it = trig && (trig.when.kind === 'touch' || trig.when.kind === 'collect') ? trig.when.target ?? null : null;
  const timed = /\bboost\b|\bpower[ -]?up\b|\bfor a (bit|while|moment)\b/.test(s) ? 5 : null;
  const secs = secondsIn(s, timed);
  // gravity ("space to flip" is gravity too)
  if (/\bflip(s|ped|ping)? (the )?gravity\b|\bgravity (flips|reverses|switches|turns upside down)\b|\breverses? (the )?gravity\b|\bupside[ -]down\b|\bwalks? on the ceiling\b|\banti-?gravity\b|\bswitch(es)? gravity\b|\b(to )?flip(s)?( it| everything| the world)?$/.test(s)) {
    add({ kind: 'flip_gravity' });
  } else if (/\b(low|moon|less|floaty|light|weak) gravity\b|\bgravity (is )?(low|weak|lighter)\b|\bfloaty\b|\bfloat(s)? (up|around|like)\b|\bmoon ?jumps?\b/.test(s)) {
    add(secs !== null ? { kind: 'gravity', times: 0.5, seconds: secs } : { kind: 'gravity', times: 0.5 });
  } else if (/\b(heavy|high|strong|double|more) gravity\b|\bgravity (is )?(high|strong|heavy|stronger)\b/.test(s)) {
    add(secs !== null ? { kind: 'gravity', times: 1.5, seconds: secs } : { kind: 'gravity', times: 1.5 });
  }
  // speed and jump
  if (/\b(speed boost|super ?speed|speed(s)? (you )?up|go(es)? faster|run(s)? faster|zoom(s)?|fast(er)?|quick(er)?|turbo)\b/.test(s) && !/\bnot fast\b/.test(s)) {
    add(secs !== null ? { kind: 'speed', times: 1.6, seconds: secs } : { kind: 'speed', times: 1.6 });
  } else if (/\bslow(s|er)?( you)?( down)?\b|\bslow motion\b|\bsluggish\b/.test(s) && !/\bslow(ly)? moving\b/.test(s)) {
    add(secs !== null ? { kind: 'speed', times: 0.5, seconds: secs } : { kind: 'speed', times: 0.5 });
  }
  if (/\b(jump(s)? (higher|further|farther|really high|super high)|super ?jumps?|big(ger)? jumps?|high(er)? jumps?|jump boost|jump power)\b/.test(s)) {
    add(secs !== null ? { kind: 'jump_power', times: 1.4, seconds: secs } : { kind: 'jump_power', times: 1.4 });
  } else if (/\b(jump(s)? lower|tiny jumps?|small(er)? jumps?|can'?t jump (very )?high)\b/.test(s)) {
    add(secs !== null ? { kind: 'jump_power', times: 0.7, seconds: secs } : { kind: 'jump_power', times: 0.7 });
  }
  if (/\b(revers(e|es|ed) (the |your )?controls|controls (are |get |go )?(reversed|backwards|swapped|flipped)|swap(s)? left and right|left (is|becomes) right|backwards controls)\b/.test(s)) {
    add(secs !== null ? { kind: 'reverse_controls', seconds: secs } : { kind: 'reverse_controls' });
  }
  // places and things
  const tele = targetAfter(s, /\bteleports? (you |the player )?(back )?to\b|\bwarps? (you )?(back )?to\b|\bsends? you (back )?to\b|\bmoves? you to\b/, ids, aliases, it);
  if (tele && tele.id) add({ kind: 'teleport', target: tele.id });
  const show = targetAfter(s, /\b(shows?|reveals?|makes? (appear|visible)|turns? on|brings? back)\b/, ids, aliases, it);
  if (show && show.id) add({ kind: 'toggle', target: show.id, to: 'on' });
  const hide = targetAfter(s, /\b(hides?|removes?|makes? (disappear|vanish|invisible)|turns? off|gets? rid of)\b/, ids, aliases, it);
  if (hide && hide.id) add({ kind: 'toggle', target: hide.id, to: 'off' });
  const tog = targetAfter(s, /\btoggles?\b/, ids, aliases, it);
  if (tog && tog.id) add({ kind: 'toggle', target: tog.id, to: 'flip' });
  const open = targetAfter(s, /\b(opens?|unlocks?)\b/, ids, aliases, it);
  if (open && open.id) add({ kind: 'open', target: open.id });
  if (/\bfreez(e|es|ing)\b|\b(stops?|pauses?) (all )?(the )?(enemies|monsters|bad ?guys|baddies|everyone|everything)\b/.test(s)) {
    add({ kind: 'freeze_enemies', seconds: secondsIn(s, 5) ?? 5 });
  }
  // score and hearts
  const pts = new RegExp(String.raw`\b(gives?|adds?|earns?|gets?|worth|plus) (you )?${NUM} (points?|score)\b|\+${NUM} (points?)?`).exec(s);
  if (pts && !(trig && trig.when.kind === 'score')) {
    const n = num(pts[3] ?? pts[5]);
    if (n !== null && n !== 0) add({ kind: 'add_score', n: clamp(Math.round(n), -1000, 1000) });
  } else if (/\b(gives?|earns?|gets?) (you )?(a )?points?\b|\bscores? (a )?point\b/.test(s)) {
    add({ kind: 'add_score', n: 10 });
  }
  if (/\b(extra|bonus|one more|another) (heart|life)\b|\bheal(s|ing)?( you)?\b|\bgives? (you )?(a |an )?(heart|life)\b|\+1 (heart|life)\b/.test(s)) add({ kind: 'heal' });
  if (/\b(hurts?|damages?|lose (a|one) (heart|life)|loses? a heart|takes? (a|one) heart|ouch|kills? you|you die|zaps? you)\b/.test(s)) add({ kind: 'hurt' });
  // the end
  if (/\b(you|to|and|then|will|player|they) (win|wins|finish|beat the level)\b|\bwins? the (level|game)\b|\byou'?ve won\b|^win\b|\bwin$/.test(s)) add({ kind: 'win' });
  else if (/\b(you|to|and|then|will|player) (lose|loses)\b(?! (a|one|an|your) (heart|life))|\bgame over\b|\bstart (all )?over\b|\bloses? the (level|game)\b/.test(s)) add({ kind: 'lose' });
  // talk, sound, shake
  const sayM = /\b(says?|shows? the (message|words)|tells? you|pops? up)\b(.*)$/.exec(s);
  if (quote || sayM) {
    const text = (quote ?? sayM?.[3] ?? '').trim().replace(/^(that|:)\s*/, '').slice(0, 90).trim();
    if (text) add({ kind: 'say', text, seconds: 3 });
  }
  const snd = SOUNDS.find((n) => new RegExp(String.raw`\b${n}s?\b`).test(s));
  if (snd) add({ kind: 'sound', name: snd });
  else if (/\b(plays?|makes?) (a )?(sound|noise|beep)\b|\bbeeps?\b/.test(s)) add({ kind: 'sound', name: 'ding' });
  if (/\bshak(e|es|ing)\b|\bearthquake\b|\brumbles?\b/.test(s)) add({ kind: 'shake' });
  return out;
}

/** A state the game simply has ("gravity is low", "you are fast") becomes a start rule; other actions need a trigger. */
const STATE_KINDS = new Set<RuleDo['kind']>(['gravity', 'speed', 'jump_power', 'reverse_controls']);
const THING_NOUNS = /\b(monsters?|enem(y|ies)|platforms?|bad ?guys?|creatures?|saws?|spikes?|blocks?|ledges?|walls?|doors?|springs?)\b/;

/**
 * core.parseLogic (§2.4): sentences → rules, mode and the sentences it could not make into rules. `entityIds` are the
 * ids rules may name; `o.aliases` adds nouns for them (core/logic/index.ts logicTargets).
 */
export function parseLogic(sentences: string[], entityIds: string[] = [], o?: ParseLogicOptions): LogicParseResult {
  const ids = new Set((Array.isArray(entityIds) ? entityIds : []).filter((x) => typeof x === 'string' && ID_RE.test(x)));
  const aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(o?.aliases ?? {})) if (typeof v === 'string' && ID_RE.test(v)) aliases[k.toLowerCase()] = v;
  const rules: RuleV4[] = [];
  const unknown: string[] = [];
  let mode: GameMode | null = null;
  for (const raw of Array.isArray(sentences) ? sentences : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const { s, quote } = clean(raw);
    const m = modeIn(s);
    if (m) mode = m;
    const trig = triggerIn(s, ids, aliases);
    const acts = actionsIn(s, quote, ids, aliases, trig);
    const made: RuleV4[] = [];
    const next = (): string => `r${rules.length + made.length + 1}`;
    const once = /\bonly once\b|\bthe first time\b|\bjust once\b/.test(s);
    if (trig && trig.counter && acts.length) {
      // collect N things: count them; the counter rule does the actions
      const c = trig.counter;
      made.push({ id: next(), when: trig.when, then: [{ kind: 'add_counter', name: c.name, n: 1 }] });
      made.push({ id: next(), when: { kind: 'counter', name: c.name, at_least: c.n }, then: acts.slice(0, 4) as RuleV4['then'], ...(once ? { once } : {}) });
    } else if (trig && !trig.counter && acts.length) {
      made.push({ id: next(), when: trig.when, then: acts.slice(0, 4) as RuleV4['then'], ...(once ? { once } : {}) });
    } else if (!trig && acts.length && acts.every((a) => STATE_KINDS.has(a.kind)) && /\b(is|are|always|everything|the whole|in this (level|game))\b/.test(s)
      && /\b(you|you're|your|player|i|i'm|me|everything|everyone|gravity|controls|game|level|world)\b/.test(s) && !THING_NOUNS.test(s)) {
      // a state of the player or the world ("gravity is low"), never of a thing ("the monster is fast" stays v2)
      const always = acts.map((a) => {
        const c = { ...a } as RuleDo & { seconds?: number | null };
        delete c.seconds;
        return c as RuleDo;
      });
      made.push({ id: next(), when: { kind: 'start' }, then: always.slice(0, 4) as RuleV4['then'] });
    }
    if (made.length) rules.push(...made);
    else if (!m) unknown.push(raw.trim());
  }
  return { rules, mode, unknown, source: 'keywords' };
}

/** Did the keyword parser turn this sentence into logic (rules or a mode)? The v2 rules parser skips those (§2.4). */
export function isLogicSentence(sentence: string, entityIds: string[] = [], o?: ParseLogicOptions): boolean {
  const r = parseLogic([sentence], entityIds, o);
  return r.rules.length > 0 || r.mode !== null;
}
