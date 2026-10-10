/**
 * The offline creature reader (§8.1 "Offline, keywords do it"): a kid's name and sentence → archetype, speed and
 * spiky, the same fields the CREATURE model call returns (CreatureSpec). Deterministic and tolerant of kid spelling:
 * every archetype has a word list; hits in the sentence count 1, hits in the name ½ ("Batty" flies); a negated hit
 * ("can't fly", "doesn't hop", "no wings") counts −1. The best score wins; ties go to the word said first.
 * Nothing matched → walker at normal speed (the most common creature, and the safest to place).
 */
import type { Behavior, CreatureSpecJson } from '../core/types.gen.ts';
import { chipBinding, type ChipId, type Speed } from '../editor/chips.ts';

export type CreatureArchetype = CreatureSpecJson['archetype'];

export const ARCHETYPES: readonly CreatureArchetype[] = ['walker', 'hopper', 'flyer', 'shooter', 'chaser', 'crusher', 'static'];

const WORDS: Record<CreatureArchetype, readonly string[]> = {
  walker: ['walk', 'walks', 'walking', 'walker', 'patrol', 'patrols', 'march', 'marches', 'wander', 'wanders', 'waddle', 'waddles',
    'crawl', 'crawls', 'roll', 'rolls', 'stroll', 'strolls', 'back and forth', 'left and right', 'paces', 'creeps', 'slither', 'slithers'],
  hopper: ['hop', 'hops', 'hopping', 'hopper', 'jump', 'jumps', 'jumping', 'jumpy', 'leap', 'leaps', 'bounce', 'bounces', 'bouncy',
    'boing', 'spring', 'springs', 'frog', 'toad', 'bunny', 'rabbit', 'kangaroo', 'cricket', 'grasshopper', 'flea'],
  flyer: ['fly', 'flies', 'flying', 'flyer', 'flier', 'float', 'floats', 'floating', 'hover', 'hovers', 'wing', 'wings', 'bird',
    'bat', 'bee', 'bug', 'butterfly', 'dragon', 'ghost', 'cloud', 'balloon', 'owl', 'glides', 'glide', 'soar', 'soars', 'buzz', 'buzzes'],
  shooter: ['shoot', 'shoots', 'shooting', 'shooter', 'spit', 'spits', 'throw', 'throws', 'fire', 'fires', 'fireball', 'fireballs',
    'cannon', 'blast', 'blasts', 'laser', 'lasers', 'zap', 'zaps', 'sneeze', 'sneezes', 'blow', 'blows', 'bubbles', 'darts', 'arrows'],
  chaser: ['chase', 'chases', 'chasing', 'chaser', 'follow', 'follows', 'hunt', 'hunts', 'angry', 'mad', 'grumpy', 'run after',
    'runs after', 'comes after', 'goes after', 'catch', 'catches', 'charge', 'charges', 'attack', 'attacks', 'bully'],
  crusher: ['crush', 'crushes', 'crusher', 'smash', 'smashes', 'squash', 'squashes', 'squish', 'squishes', 'stomp down', 'drop', 'drops',
    'falls down', 'slam', 'slams', 'pound', 'pounds', 'thwomp', 'rock', 'boulder', 'anvil', 'block', 'heavy'],
  static: ['still', 'stays', 'sleeps', 'sleepy', 'sleeping', 'statue', 'sits', 'sitting', 'stands', 'standing', 'waits', 'guards',
    'doesn\'t move', 'does not move', 'never moves', 'plant', 'flower', 'mushroom', 'rock solid'],
};

const SLOW = ['slow', 'slowly', 'lazy', 'sleepy', 'turtle', 'snail', 'sloth', 'tired', 'old', 'gentle', 'calm', 'baby', 'tiny'];
const FAST = ['fast', 'quick', 'quickly', 'speedy', 'zoom', 'zooms', 'rocket', 'super', 'dash', 'dashes', 'rush', 'rushes', 'race',
  'races', 'hyper', 'cheetah', 'lightning', 'very fast', 'crazy'];
const SPIKY = ['spike', 'spikes', 'spiky', 'spikey', 'sharp', 'thorn', 'thorns', 'thorny', 'pointy', 'prickly', 'prickles', 'cactus',
  'porcupine', 'hedgehog', 'urchin', 'needles', 'horns', 'can\'t stomp', 'cannot stomp', 'don\'t jump on', 'do not jump on', 'ouch'];
const NEGATORS = ['not', 'no', 'never', 'can\'t', 'cannot', 'doesn\'t', 'does not', 'don\'t', 'won\'t', 'without'];

function norm(s: string): string {
  return ` ${s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

interface Hit {
  score: number;
  first: number;
}

/** Score one word list against normalized text; negated hits subtract. */
function score(text: string, words: readonly string[], weight: number): Hit {
  let s = 0;
  let first = Infinity;
  for (const w of words) {
    const needle = ` ${w} `;
    let at = text.indexOf(needle);
    while (at >= 0) {
      const before = text.slice(Math.max(0, at - 14), at + 1);
      const negated = NEGATORS.some((n) => before.endsWith(` ${n} `) || before.includes(` ${n} `));
      s += negated ? -weight : weight;
      if (!negated) first = Math.min(first, at);
      at = text.indexOf(needle, at + needle.length - 1);
    }
  }
  return { score: s, first };
}

export interface CreatureRead {
  archetype: CreatureArchetype;
  speed: Speed;
  spiky: boolean;
  /** Words that decided it (for "I read: walks · slow · spiky"). */
  matched: boolean;
}

export function readCreature(name: string, text: string): CreatureRead {
  const t = norm(text);
  const n = norm(name.replace(/([a-z])([A-Z])/g, '$1 $2'));
  // Names are often words glued together ("Batty", "Hopsy"): test the name's prefixes as words too.
  const nameWords = n.trim().split(' ').flatMap((w) => [w, w.replace(/(y|ie|ster|o|a|s)$/, '')]).map((w) => ` ${w} `).join('');
  let best: CreatureArchetype = 'walker';
  let bestHit: Hit = { score: 0, first: Infinity };
  for (const a of ARCHETYPES) {
    const h1 = score(t, WORDS[a], 1);
    const h2 = score(nameWords, WORDS[a], 0.5);
    const hit = { score: h1.score + h2.score, first: Math.min(h1.first, h2.first + 1000) };
    if (hit.score > bestHit.score || (hit.score === bestHit.score && hit.score > 0 && hit.first < bestHit.first)) {
      best = a;
      bestHit = hit;
    }
  }
  const slow = score(t, SLOW, 1).score + score(nameWords, SLOW, 0.5).score;
  const fast = score(t, FAST, 1).score + score(nameWords, FAST, 0.5).score;
  const spiky = score(t, SPIKY, 1).score + score(nameWords, SPIKY, 0.5).score > 0;
  const speed: Speed = fast > slow && fast > 0 ? 'fast' : slow > fast && slow > 0 ? 'slow' : 'normal';
  return { archetype: bestHit.score > 0 ? best : 'walker', speed, spiky, matched: bestHit.score > 0 || slow !== fast || spiky };
}

/** The behavior a creature's chips stand for, on the §5.6 grids (the same numbers the editor's chips write). */
export function creatureBehavior(a: CreatureArchetype, speed: Speed, spiky: boolean): Behavior {
  if (a === 'static') return { kind: 'static' };
  const b = chipBinding(a as ChipId, { cells: 6, speed, reverse: false }).rule;
  if (b && b.kind === 'enemy') return { ...b, spiky };
  return { kind: 'enemy', archetype: 'walker', spiky };
}

/** Back from a behavior to the chips (editing a type, or saving a level object). */
export function chipsOfBehavior(b: Behavior | null | undefined): { archetype: CreatureArchetype; speed: Speed; spiky: boolean } | null {
  if (!b) return null;
  if (b.kind === 'static') return { archetype: 'static', speed: 'normal', spiky: false };
  if (b.kind !== 'enemy') return null;
  const p = b.params ?? {};
  const v = b.archetype === 'hopper' || b.archetype === 'shooter' ? p.interval : b.archetype === 'crusher' ? p.warn : p.speed;
  let speed: Speed = 'normal';
  if (typeof v === 'number') {
    const ref = creatureBehavior(b.archetype, 'normal', false);
    const rp = ref.kind === 'enemy' ? ref.params ?? {} : {};
    const rv = b.archetype === 'hopper' || b.archetype === 'shooter' ? rp.interval : b.archetype === 'crusher' ? rp.warn : rp.speed;
    if (typeof rv === 'number' && Math.abs(v - rv) > 1e-6) {
      // timing archetypes are faster when the interval is shorter
      const faster = b.archetype === 'hopper' || b.archetype === 'shooter' || b.archetype === 'crusher' ? v < rv : v > rv;
      speed = faster ? 'fast' : 'slow';
    }
  }
  return { archetype: b.archetype, speed, spiky: !!b.spiky };
}

/** §8.1 letter: unique per game, auto-assigned as the first free letter of the name (then any free letter). */
export function assignLetter(name: string, used: Iterable<string>): string {
  const taken = new Set([...used].map((l) => l.toUpperCase()));
  for (const ch of name.toUpperCase()) if (ch >= 'A' && ch <= 'Z' && !taken.has(ch)) return ch;
  for (let c = 65; c <= 90; c++) {
    const ch = String.fromCharCode(c);
    if (!taken.has(ch)) return ch;
  }
  return 'Z';
}
