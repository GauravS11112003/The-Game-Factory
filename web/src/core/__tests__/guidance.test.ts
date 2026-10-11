/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { resolveRules } from '../build/level.ts';
import { applyGuidance } from '../generate/guidance.ts';
import { layoutDetailed, generateLevel } from '../generate/generate.ts';
import { keywordPlan } from '../generate/keyword.ts';
import { buildArt } from '../art/artdoc.ts';
import { sampleLevel } from '../art/frame.ts';
import type { GameGuidance, LevelPlan } from '../types.gen.ts';
import { REPO, SPEC_DIR, readJson } from './helpers.ts';
import { join } from 'node:path';

const wizard: GameGuidance = {
  theme_name: 'Wizard school', scene: 'castle', setting: 'Enchanted castle', style_prompt: 'Magical illustrated castle',
  mechanics: ['keys_doors', 'moving_platforms', 'coins', 'double_jump'], excluded_mechanics: ['enemies'],
  enemy_archetype: 'flyer', palette: ['#e8e1f5', '#aca0c9', '#b0a0c4', '#9561bc'], author_context: ['No enemies'],
};
const plan = (): LevelPlan => ({ ...keywordPlan('keys and moving stairs', 2), sections: [
  { role: 'teach', beats: [{ kind: 'flat', length: 8, coins: 0, spikes: 'none', enemy: 'walker' }] },
  { role: 'finale', beats: [{ kind: 'goal', style: 'flag' }] },
] });

describe('author game guidance', () => {
  it.each(['wizard', 'spooky', 'blocks', 'mario', 'celeste', 'hollow'])('keeps the %s example mechanics in its real layout', (name) => {
    const catalog = readJson<Record<string, { name: string; scene: GameGuidance['scene']; setting: string; style: string; mechanics: string[]; enemy: GameGuidance['enemy_archetype']; palette: GameGuidance['palette'] }>>(join(REPO, 'shared', 'game-themes.json'));
    const messages = readJson<{ messages: Record<string, string> }>(join(SPEC_DIR, 'messages.json')).messages;
    const profile = catalog[name];
    const guidance: GameGuidance = { theme_name: profile.name, scene: profile.scene, setting: profile.setting,
      style_prompt: profile.style, mechanics: profile.mechanics, enemy_archetype: profile.enemy, palette: profile.palette };
    const { layout } = layoutDetailed(keywordPlan(messages[`create.theme_example.${name}.prompt`], 2),
      { version: 1, guidance }, 1);
    if (profile.mechanics.includes('keys_doors')) {
      expect(layout.prims.some((p) => p.k === 'key')).toBe(true);
      expect(layout.prims.some((p) => p.k === 'wall' && p.door)).toBe(true);
    }
    if (profile.mechanics.includes('crumbling_platforms')) expect(layout.prims.some((p) => p.k === 'platform' && p.crumble)).toBe(true);
    if (profile.mechanics.includes('moving_platforms')) expect(layout.prims.some((p) => p.k === 'platform' && p.move)).toBe(true);
    if (profile.mechanics.includes('bounce_pads')) expect(layout.prims.some((p) => p.k === 'spring')).toBe(true);
    if (profile.mechanics.includes('enemies')) expect(layout.prims.some((p) => p.k === 'enemy')).toBe(true);
  });

  it('adds real keys, doors, moving platforms and collectibles without enemies', () => {
    const rules = resolveRules({ version: 1, guidance: wizard, abilities: { double_jump: true } });
    expect(rules.guidance).toEqual(wizard);
    const layout = layoutDetailed(plan(), rules, 1).layout;
    expect(layout.prims.some((p) => p.k === 'key')).toBe(true);
    expect(layout.prims.some((p) => p.k === 'wall' && p.door)).toBe(true);
    expect(layout.prims.some((p) => p.k === 'platform' && p.move)).toBe(true);
    expect(layout.prims.some((p) => p.k === 'coin')).toBe(true);
    expect(layout.prims.some((p) => p.k === 'enemy')).toBe(false);
    expect(layout.dropped).toEqual([]);
  });

  it('removes excluded beats and keeps the input plan unchanged', () => {
    const input = keywordPlan('monsters', 2);
    const before = JSON.stringify(input);
    const out = applyGuidance(input, wizard);
    expect(out.sections.flatMap((s) => s.beats).some((b) => b.kind === 'enemy_gauntlet' || (b.kind === 'flat' && b.enemy !== 'none'))).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('also excludes pickups and checkpoints inserted automatically by layout recipes', () => {
    const guidance = { ...wizard, mechanics: [], excluded_mechanics: ['coins', 'checkpoint', 'enemies', 'hazards'] };
    const { layout } = layoutDetailed(keywordPlan('spikes and monsters', 3), { version: 1, guidance }, 1);
    expect(layout.prims.some((p) => ['coin', 'big_coin', 'enemy', 'spikes', 'lava', 'saw', 'firebar'].includes(p.k) ||
      (p.k === 'flag' && p.role === 'checkpoint'))).toBe(false);
    expect(layout.prims.some((p) => p.k === 'flag' && p.role === 'goal')).toBe(true);
  });

  it('carries guidance into the playable level and distinct art without changing collisions', () => {
    const out = generateLevel(plan(), { version: 1, guidance: wizard, abilities: { double_jump: true } }, 2);
    expect(out.result.level.rules?.guidance?.scene).toBe('castle');
    expect(out.result.level.design?.solvable).toBe(true);
    const compiled = JSON.stringify(out.result.level.compiled);
    const art = buildArt(out.result.level, out.ink, { theme: 'sketchbook', seed: 2 });
    expect(art.styles.guidance_sky.fill).toBe('#e8e1f5');
    expect(art.layers.find((l) => l.id === 'mid')?.paths.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.result.level.compiled)).toBe(compiled);
  }, 30_000);

  it('renders different scenery for spooky, blocky and wizard worlds', () => {
    const scenes = ['castle', 'haunted', 'blocks'] as const;
    const paths = scenes.map((scene) => {
      const level = sampleLevel('sketchbook', { guidance: { ...wizard, scene } });
      const art = buildArt(level, null, { theme: 'sketchbook', seed: 1 });
      return JSON.stringify(art.layers.find((l) => l.id === 'mid')?.paths);
    });
    expect(new Set(paths).size).toBe(3);
  });
});
