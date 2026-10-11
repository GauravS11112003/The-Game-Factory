import type { GameBrief, InkDoc } from '../core/types.gen.ts';
import type { EditorDocData } from '../editor/doc.ts';
import { card, h } from './dom.ts';
import { t } from './messages.ts';

export const GAME_CATEGORIES = [
  { id: 'action', symbol: '⚡' },
  { id: 'adventure', symbol: '🧭' },
  { id: 'rpg', symbol: '🗡️' },
  { id: 'strategy', symbol: '♟️' },
  { id: 'simulation', symbol: '🏡' },
  { id: 'puzzle', symbol: '🧩' },
  { id: 'racing', symbol: '🏎️' },
  { id: 'sports', symbol: '⚽' },
  { id: 'platformer', symbol: '🍄' },
  { id: 'survival', symbol: '🔥' },
  { id: 'custom', symbol: '✎' },
] as const satisfies readonly { id: GameBrief['category']; symbol: string }[];

export interface CreationDraft {
  kind?: 'game' | 'level';
  appendLevel?: boolean;
  levelId?: string;
  prompt?: string;
  title: string;
  author: string;
  brief: GameBrief;
  doc: EditorDocData;
  gameId: string | null;
}

/** Fold older multi-field drafts into one prompt without discarding their ideas. */
export function creationPrompt(saved: CreationDraft | null): string {
  if (!saved) return '';
  if (saved.prompt !== undefined) return saved.prompt;
  const parts = [saved.doc.imaginationContext, saved.brief.custom_definition,
    saved.brief.theme, saved.brief.gameplay, saved.brief.details]
    .map((value) => value?.trim() ?? '').filter(Boolean);
  return parts.filter((value, index) => !parts.some((other, otherIndex) =>
    otherIndex !== index && other.includes(value) && (other.length > value.length || otherIndex < index)))
    .join('\n\n').slice(0, 8000);
}

/** Capture the current whole drawing, including notes, without classifying its shapes. */
export function creationInk(doc: EditorDocData): InkDoc {
  return { v: 2, source: 'canvas', world: { screens: doc.screens, w: doc.screens * 48, h: 27 },
    strokes: doc.strokes, components: [], character: { strokes: doc.character },
    typed_rules: doc.rules.map((rule) => ({ text: rule.text })), rules_ink: [], sheets: [],
    noise: { count: 0 }, parent: doc.parent };
}

export function briefCard(brief: GameBrief): HTMLElement {
  return card('creation-brief',
    h('div', { class: 'row between wrap' }, h('h3', null, t('create.brief_title')),
      h('span', { class: 'badge' }, t(`create.category.${brief.category}`))),
    h('dl', { class: 'brief-details' }, ...(['custom_definition', 'theme', 'gameplay', 'details'] as const)
      .filter((key) => brief[key] && (key !== 'custom_definition' || brief.category === 'custom'))
      .map((key) => h('div', null, h('dt', null, t(`create.${key}`)), h('dd', null, brief[key])))));
}
