/**
 * Offline keyword planner (§8.3 step 6): when the model is off, a prompt still becomes a level. Keywords (lava, key,
 * tower, spikes, moving, saw, crumble, monster, sky, easy / hard, …) pick one of 12 canned plans; ties break on a
 * hash of the text, so the same prompt always gives the same plan. Each canned plan is a teach → test → twist →
 * finale arc sized for 2 screens; longer levels repeat its test and twist with one notch more each time, separated
 * by rests, and a 1-screen level keeps teach + finale. The layout then stretches the flats to fill 48·screens.
 */
import type { Beat, LevelPlan, Section } from '../types.gen.ts';
import { hash8 } from '../util/ids.ts';
import { clampInt } from './beats.ts';
import type { PlanBand } from './beats.ts';

interface Canned {
  id: string;
  title: string;
  tags: string[];
  theme: LevelPlan['theme'];
  summary: string;
  teach: Beat[];
  test: Beat[];
  twist: Beat[];
  finale: Beat[];
}

const F = (length: number, enemy: 'none' | 'walker' | 'hopper' | 'chaser' = 'none', coins = 0, spikes: 'none' | 'middle' | 'far_end' = 'none'): Beat => ({ kind: 'flat', length, enemy, coins, spikes });
const GAP = (width: number, floor: 'void' | 'spikes' | 'lava' = 'void'): Beat => ({ kind: 'gap', width, floor });
const REST = (length: number): Beat => ({ kind: 'rest', length });
const GOAL = (style: 'flag' | 'staircase' = 'flag'): Beat => ({ kind: 'goal', style });

export const CANNED: readonly Canned[] = [
  {
    id: 'meadow', title: 'Meadow Run', tags: ['run', 'jump', 'meadow', 'grass', 'hill', 'walk', 'park', 'field'], theme: 'sketchbook',
    summary: 'A sunny run with hops, steps and a monster to stomp.',
    teach: [F(8, 'none', 3), GAP(3), { kind: 'step', rise: 2, length: 5 }],
    test: [F(10, 'walker', 4), GAP(5), { kind: 'stairs', n: 3, rise: 2, run: 3 }],
    twist: [{ kind: 'enemy_gauntlet', archetype: 'walker', n: 2 }, GAP(6)],
    finale: [{ kind: 'step', rise: -2, length: 4 }, GAP(5), GOAL('staircase')],
  },
  {
    id: 'spikes', title: 'Spike Hop', tags: ['spike', 'spikes', 'spiky', 'sharp', 'thorn', 'pointy', 'cactus'], theme: 'sketchbook',
    summary: 'Hop over spikes on the ground, in pits and on the ceiling.',
    teach: [F(10, 'none', 3, 'middle'), GAP(3, 'spikes')],
    test: [{ kind: 'pillars', n: 3, spacing: 3, hazard: 'spikes' }, F(10, 'none', 0, 'far_end')],
    twist: [{ kind: 'ceiling', length: 14, spikes: true, headroom: 4 }, GAP(4, 'spikes')],
    finale: [{ kind: 'floaters', n: 3, dy: 2, spacing: 3, oneway: true }, GOAL()],
  },
  {
    id: 'lava', title: 'Lava Lake', tags: ['lava', 'fire', 'volcano', 'hot', 'magma', 'burn', 'flame'], theme: 'kraft',
    summary: 'Jump across lava pits on pillars and floating rocks.',
    teach: [F(8, 'none', 3), GAP(3, 'lava'), F(6)],
    test: [{ kind: 'pillars', n: 3, spacing: 3, hazard: 'lava' }, GAP(5, 'lava')],
    twist: [{ kind: 'floaters', n: 3, dy: 2, spacing: 3, oneway: false }, { kind: 'crumble_run', n: 3, floor: 'void' }],
    finale: [GAP(5, 'lava'), F(6, 'hopper'), GOAL()],
  },
  {
    id: 'key', title: 'Key Keep', tags: ['key', 'door', 'lock', 'castle', 'treasure', 'gate', 'keep'], theme: 'notebook',
    summary: 'Find the key, open the door and get past the guards.',
    teach: [F(8, 'none', 3), { kind: 'key', place: 'high' }, F(6)],
    test: [{ kind: 'enemy_gauntlet', archetype: 'walker', n: 2 }, GAP(4)],
    twist: [{ kind: 'door' }, { kind: 'stairs', n: 2, rise: 2, run: 3 }, GAP(5, 'spikes')],
    finale: [F(8, 'hopper'), GOAL()],
  },
  {
    id: 'tower', title: 'Tall Tower', tags: ['tower', 'climb', 'tall', 'up', 'high', 'sky', 'castle'], theme: 'graph',
    summary: 'Climb a zig-zag tower and bounce up the cliffs.',
    teach: [F(8, 'none', 3), { kind: 'stairs', n: 2, rise: 2, run: 3 }],
    test: [{ kind: 'tower', tiers: 3, rise: 3, oneway: true }, F(6)],
    twist: [{ kind: 'step', rise: -4, length: 4 }, { kind: 'spring_up', height: 5 }],
    finale: [GAP(4), GOAL('staircase')],
  },
  {
    id: 'moving', title: 'Moving Bridges', tags: ['moving', 'move', 'moves', 'platform', 'bridge', 'lift', 'elevator', 'ride', 'ferry'], theme: 'notebook',
    summary: 'Ride moving bridges and a lift over the pits.',
    teach: [F(8, 'none', 3), { kind: 'moving_bridge', gap: 6, speed: 'slow', vertical: false }],
    test: [F(6), { kind: 'moving_bridge', gap: 8, speed: 'normal', vertical: false }, F(6)],
    twist: [{ kind: 'moving_bridge', gap: 6, speed: 'normal', vertical: true }, GAP(4)],
    finale: [{ kind: 'step', rise: -3, length: 4 }, GOAL()],
  },
  {
    id: 'saw', title: 'Saw Mill', tags: ['saw', 'saws', 'blade', 'buzz', 'cut', 'mill', 'factory'], theme: 'graph',
    summary: 'Time your run past spinning saws.',
    teach: [F(8, 'none', 3), { kind: 'saw_corridor', length: 10, saws: 1 }],
    test: [GAP(4), { kind: 'saw_corridor', length: 14, saws: 2 }],
    twist: [{ kind: 'moving_bridge', gap: 7, speed: 'normal', vertical: false }, { kind: 'saw_corridor', length: 12, saws: 2 }],
    finale: [GAP(5), GOAL()],
  },
  {
    id: 'lava_key', title: 'Lava Key Cave', tags: ['lava', 'key', 'cave', 'door', 'exit', 'fire'], theme: 'kraft',
    summary: 'A hot cave where a key opens the exit.',
    teach: [F(8, 'none', 3), GAP(3, 'lava'), { kind: 'key', place: 'alcove' }],
    test: [{ kind: 'pillars', n: 2, spacing: 3, hazard: 'lava' }, F(8, 'walker')],
    twist: [{ kind: 'ceiling', length: 10, spikes: false, headroom: 3 }, GAP(4, 'lava')],
    finale: [{ kind: 'door' }, F(6), GOAL()],
  },
  {
    id: 'spike_tower', title: 'Spike Tower', tags: ['spike', 'tower', 'climb', 'spikes', 'tall'], theme: 'sketchbook',
    summary: 'Climb above a spike floor without slipping.',
    teach: [F(10, 'none', 3, 'middle'), { kind: 'step', rise: 2, length: 4 }],
    test: [{ kind: 'tower', tiers: 3, rise: 3, oneway: true }],
    twist: [{ kind: 'step', rise: -3, length: 3 }, GAP(4, 'spikes'), { kind: 'wall', height: 3, spikes: 'near_face' }],
    finale: [F(8, 'walker'), GOAL()],
  },
  {
    id: 'crumble', title: 'Crumble Canyon', tags: ['crumble', 'crumbles', 'fall', 'falling', 'break', 'canyon', 'cliff', 'rock'], theme: 'kraft',
    summary: 'Keep moving: the ledges crumble under your feet.',
    teach: [F(8, 'none', 3), { kind: 'crumble_run', n: 3, floor: 'shallow' }],
    test: [F(6), { kind: 'crumble_run', n: 4, floor: 'void' }, F(6)],
    twist: [{ kind: 'floaters', n: 3, dy: 2, spacing: 3, oneway: true }, GAP(5)],
    finale: [{ kind: 'crumble_run', n: 3, floor: 'void' }, GOAL()],
  },
  {
    id: 'monsters', title: 'Monster March', tags: ['monster', 'monsters', 'enemy', 'enemies', 'stomp', 'bug', 'frog', 'bat', 'march', 'creature'], theme: 'sketchbook',
    summary: 'Stomp, dodge and hop past a parade of monsters.',
    teach: [F(12, 'walker', 4), GAP(3)],
    test: [{ kind: 'enemy_gauntlet', archetype: 'hopper', n: 2 }, F(6)],
    twist: [{ kind: 'enemy_gauntlet', archetype: 'flyer', n: 2 }, GAP(4)],
    finale: [{ kind: 'enemy_gauntlet', archetype: 'walker', n: 2 }, GOAL()],
  },
  {
    id: 'sky', title: 'Sky Hop', tags: ['sky', 'cloud', 'clouds', 'float', 'floating', 'fly', 'air', 'jumpy', 'bouncy', 'spring'], theme: 'notebook',
    summary: 'Bounce on springs and hop across floating ledges.',
    teach: [F(8, 'none', 3), { kind: 'spring_up', height: 4 }],
    test: [{ kind: 'floaters', n: 3, dy: 2, spacing: 3, oneway: true }, F(6)],
    twist: [{ kind: 'pillars', n: 3, spacing: 3, hazard: 'void' }, { kind: 'spring_up', height: 5 }],
    finale: [GAP(5), GOAL()],
  },
];

const EASY = ['easy', 'simple', 'baby', 'little', 'gentle', 'calm', 'beginner', 'short'];
const HARD = ['hard', 'harder', 'hardest', 'super', 'difficult', 'tricky', 'impossible', 'expert', 'insane', 'crazy', 'tough'];
const THEMES: Record<string, LevelPlan['theme']> = { notebook: 'notebook', graph: 'graph', kraft: 'kraft', sketch: 'sketchbook', sketchbook: 'sketchbook' };

function words(prompt: string): string[] {
  return prompt.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}

/** One notch harder (longer repeats of a section stay inside the clamps, which layout applies anyway). */
function notch(b: Beat, k: number): Beat {
  switch (b.kind) {
    case 'gap':
      return { ...b, width: b.width + k };
    case 'pillars':
    case 'floaters':
      return { ...b, spacing: b.spacing + k };
    case 'enemy_gauntlet':
      return { ...b, n: b.n + k };
    case 'saw_corridor':
      return { ...b, saws: b.saws + k };
    case 'crumble_run':
      return { ...b, n: b.n + k };
    case 'moving_bridge':
      return { ...b, gap: b.gap + k, speed: k > 0 ? 'fast' : b.speed };
    default:
      return b;
  }
}

/** §11.3(b) `keywordPlan`: a canned plan for the prompt, sized for `screens`. */
export function keywordPlan(prompt: string, screens: number): LevelPlan {
  const text = String(prompt ?? '').slice(0, 400);
  const ws = words(text);
  const set = new Set(ws.flatMap((w) => [w, w.endsWith('s') ? w.slice(0, -1) : w]));
  const band: PlanBand = ws.some((w) => HARD.includes(w)) ? 'hard' : ws.some((w) => EASY.includes(w)) ? 'easy' : ws.includes('medium') ? 'normal' : 'normal';
  const n = clampInt(screens, 1, 6, 2);
  let best = -1;
  let picks: Canned[] = [];
  for (const c of CANNED) {
    const score = c.tags.filter((t) => set.has(t)).length + (c.tags.filter((t) => set.has(t)).length >= 2 ? 0.5 : 0);
    if (score > best) {
      best = score;
      picks = [c];
    } else if (score === best) picks.push(c);
  }
  const h = parseInt(hash8({ prompt: text.toLowerCase().trim() }), 16) >>> 0;
  const c = picks[h % picks.length];
  const sections: Section[] = [{ role: 'teach', beats: [...c.teach] }];
  if (n >= 2) {
    const repeats = Math.max(1, n - 1);
    for (let k = 0; k < repeats; k++) {
      if (k > 0) sections.push({ role: 'rest', beats: [REST(6)] });
      sections.push({ role: 'test', beats: c.test.map((b) => notch(b, k)) });
      if (k % 2 === 0 || k === repeats - 1) sections.push({ role: 'twist', beats: c.twist.map((b) => notch(b, k)) });
    }
  }
  sections.push({ role: 'finale', beats: [...c.finale] });
  let theme = c.theme;
  for (const w of ws) if (THEMES[w]) theme = THEMES[w];
  const title = c.title;
  return { title, theme, screens: n, band, sections, kid_summary: c.summary, safety_ok: true };
}
