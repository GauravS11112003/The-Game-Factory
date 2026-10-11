/** Theme presets (shared/studio/themes.json, docs/v6/CONTRACTS_V6.md §4.3): the Studio gallery and `{preset: id}`. */
import type { StudioTheme } from '../../core/types.gen.ts';
import raw from '../../../../shared/studio/themes.json';

export const THEMES: StudioTheme[] = ((raw as { themes?: unknown[] }).themes ?? []) as StudioTheme[];

export const DEFAULT_THEME: StudioTheme = THEMES.find((t) => t.id === 'sketchbook') ?? THEMES[0] ?? { name: 'Sketchbook' };

/** A preset by id (or by name, case-insensitive); null when there is none. */
export function themePreset(idOrName: string | null | undefined): StudioTheme | null {
  if (!idOrName) return null;
  const k = idOrName.toLowerCase();
  return THEMES.find((t) => t.id === idOrName || (t.name ?? '').toLowerCase() === k) ?? null;
}
