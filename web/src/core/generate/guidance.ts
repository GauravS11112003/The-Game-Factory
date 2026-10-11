import type { Beat, GameGuidance, LevelPlan } from '../types.gen.ts';
import type { Layout, Prim } from './layout.ts';

/** Layout recipes add pickups and checkpoints too; author exclusions also cover those additions. */
export function applyLayoutGuidance(layout: Layout, guidance: GameGuidance | null | undefined): Layout {
  if (!guidance?.excluded_mechanics?.length) return layout;
  const excluded = new Set(guidance.excluded_mechanics);
  const prims = layout.prims.filter((p) => !(
    (excluded.has('coins') && (p.k === 'coin' || p.k === 'big_coin')) ||
    (excluded.has('enemies') && p.k === 'enemy') ||
    (excluded.has('hazards') && ['spikes', 'lava', 'saw', 'firebar'].includes(p.k)) ||
    (excluded.has('bounce_pads') && p.k === 'spring') ||
    (excluded.has('checkpoint') && p.k === 'flag' && p.role === 'checkpoint') ||
    (excluded.has('keys_doors') && (p.k === 'key' || (p.k === 'wall' && p.door)))
  )).map((p): Prim => {
    if (p.k !== 'platform') return p;
    const out = { ...p };
    if (excluded.has('moving_platforms')) delete out.move;
    if (excluded.has('crumbling_platforms')) delete out.crumble;
    return out;
  });
  return { ...layout, prims };
}

/** Convert the author's theme into supported, playable beats before layout and bot checks. */
export function applyGuidance(plan: LevelPlan, guidance: GameGuidance | null | undefined): LevelPlan {
  if (!guidance) return plan;
  const wanted = new Set(guidance.mechanics);
  const excluded = new Set(guidance.excluded_mechanics);
  const sections = plan.sections.map((section) => ({ ...section, beats: section.beats.map((beat): Beat => {
    if ((excluded.has('enemies') && beat.kind === 'enemy_gauntlet') ||
      (excluded.has('hazards') && ['gap', 'saw_corridor', 'wall'].includes(beat.kind)) ||
      (excluded.has('moving_platforms') && beat.kind === 'moving_bridge') ||
      (excluded.has('crumbling_platforms') && beat.kind === 'crumble_run') ||
      (excluded.has('bounce_pads') && beat.kind === 'spring_up') ||
      (excluded.has('keys_doors') && (beat.kind === 'key' || beat.kind === 'door')) ||
      (excluded.has('checkpoint') && beat.kind === 'checkpoint')) {
      return { kind: 'rest', length: 5 };
    }
    if (beat.kind === 'flat') return { ...beat,
      enemy: excluded.has('enemies') ? 'none' : beat.enemy,
      coins: excluded.has('coins') ? 0 : beat.coins,
      spikes: excluded.has('hazards') ? 'none' : beat.spikes };
    if (beat.kind === 'ceiling' && excluded.has('hazards')) return { ...beat, spikes: false };
    if (beat.kind === 'pillars' && excluded.has('hazards')) return { ...beat, hazard: 'void' };
    return { ...beat };
  }) }));
  const all = (): Beat[] => sections.flatMap((section) => section.beats);
  const present = (kind: Beat['kind']): boolean => all().some((beat) => beat.kind === kind);
  const introduction: Beat[] = [];
  if (wanted.has('coins') && !all().some((b) => b.kind === 'flat' && b.coins > 0))
    introduction.push({ kind: 'flat', length: 8, enemy: 'none', coins: 4, spikes: 'none' });
  if (wanted.has('keys_doors') && !present('key')) introduction.push({ kind: 'key', place: 'alcove' });
  // Introduce the requested lock before optional theme beats, which a short world may trim.
  if (wanted.has('keys_doors') && !present('door')) introduction.push({ kind: 'door' });
  if (wanted.has('moving_platforms') && !present('moving_bridge'))
    introduction.push({ kind: 'moving_bridge', gap: 4, speed: 'slow', vertical: guidance.scene === 'castle' });
  if (wanted.has('crumbling_platforms') && !present('crumble_run'))
    introduction.push({ kind: 'crumble_run', n: 2, floor: 'shallow' });
  if (wanted.has('bounce_pads') && !present('spring_up')) introduction.push({ kind: 'spring_up', height: 3 });
  if (wanted.has('enemies') && !all().some((b) => b.kind === 'enemy_gauntlet' || (b.kind === 'flat' && b.enemy !== 'none')))
    introduction.push({ kind: 'enemy_gauntlet', archetype: guidance.enemy_archetype ?? 'walker', n: 1 });
  if (wanted.has('checkpoint') && !present('checkpoint')) introduction.push({ kind: 'checkpoint' });
  if (!sections.length) return plan;
  sections[0].beats.push(...introduction);
  // Key and door ordering is a gameplay constraint, including for model-produced plans.
  if (wanted.has('keys_doors')) {
    let keySeen = false;
    for (const section of sections) for (const beat of section.beats) {
      if (beat.kind === 'key') keySeen = true;
      if (beat.kind === 'door' && !keySeen) {
        sections[0].beats.unshift({ kind: 'key', place: 'alcove' });
        keySeen = true;
      }
    }
  }
  return { ...plan, sections };
}
