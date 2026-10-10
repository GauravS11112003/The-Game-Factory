/**
 * Theme picker support (PLAN_V2 §7.5 paper themes, §8.2 the rules sheet's "4 theme swatches", §7.8 one music loop per
 * theme). The catalog names each theme with its paper, ink and loop; `renderThemeSwatch` draws a live sample level
 * through the real ArtDoc → Canvas2D pipeline, so a swatch is exactly how a level will look; `auditionTheme` plays a
 * couple of bars of the theme's loop. The engine swaps themes in place (`GameHandle.setTheme`).
 */
import type { GameRules, InkStroke, Theme } from '../core/types.gen.ts';
import { ART } from '../core/params.ts';
import { buildArt } from '../core/art/artdoc.ts';
import { sampleLevel, SAMPLE_VIEW } from '../core/art/frame.ts';
import type { ArtDoc } from '../core/art/types.ts';
import { PAPER_THEMES } from '../core/art/outline.ts';
import { inkHex } from '../core/art/styles.ts';
import { auditionMusic, musicScale } from '../audio/index.ts';
import { drawInk } from './canvas_ink.ts';
import { roundRectPath } from './paper2d.ts';
import { msg } from './text.ts';

export const THEME_IDS: readonly Theme[] = ['sketchbook', 'notebook', 'graph', 'kraft'];

export interface ThemeInfo {
  id: Theme;
  /** Kid-facing name (messages.json `theme.<id>`). */
  name: string;
  paper: string; // base paper colour
  ink: string; // the black marker on this paper (kraft lightens ink 8%)
  accent: string; // the theme's pattern colour (dot grid, rules, grid, fibres)
  music: string; // the loop's scale, e.g. "C major pentatonic"
}

const NAMES: Record<Theme, string> = { sketchbook: 'Sketchbook', notebook: 'Notebook', graph: 'Graph paper', kraft: 'Brown paper' };

export function themeInfo(theme: Theme): ThemeInfo {
  const t = (PAPER_THEMES as Record<string, { base: string; dot?: string; rule?: string; grid?: string; fibre?: string }>)[theme] ?? PAPER_THEMES.sketchbook;
  return {
    id: theme,
    name: msg(`theme.${theme}`, {}, NAMES[theme] ?? NAMES.sketchbook),
    paper: t.base,
    ink: inkHex('black', theme),
    accent: t.dot ?? t.rule ?? t.grid ?? t.fibre ?? ART.palette.ink,
    music: musicScale(theme),
  };
}

export function themeCatalog(): ThemeInfo[] {
  return THEME_IDS.map(themeInfo);
}

/** The theme a level plays with: the game's (or picker's) rules win over the level's resolved snapshot. */
export function resolveTheme(rules: Partial<GameRules> | null | undefined, levelRules?: Partial<GameRules> | null): Theme {
  const t = rules?.theme ?? levelRules?.theme ?? 'sketchbook';
  return THEME_IDS.includes(t) ? t : 'sketchbook';
}

const docs = new Map<string, ArtDoc>();

/**
 * Draw a theme swatch into a canvas (any size; the sample is letterboxed 16:9): paper, parallax, a hatched ground
 * with a pit, a jump-through ledge, spikes, coins, a big star, the goal flag and the character (the kid's own
 * strokes when given, else the house doodle) — the real renderer, so swatches can't drift from the game.
 */
export function renderThemeSwatch(c: HTMLCanvasElement, theme: Theme, o: { character?: InkStroke[] | null; selected?: boolean } = {}): void {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const key = `${theme}|${o.character ? o.character.map((s) => s.id).join(',') : '-'}`;
  let doc = docs.get(key);
  if (!doc) {
    const level = sampleLevel(theme);
    const ink = o.character && o.character.length ? { strokes: [], components: [], character: { strokes: o.character } } : null;
    doc = buildArt(level, ink as never, { seed: 7, theme });
    if (docs.size > 16) docs.delete(docs.keys().next().value as string);
    docs.set(key, doc);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  try {
    drawInk(ctx, doc, SAMPLE_VIEW);
  } catch (e) {
    ctx.fillStyle = themeInfo(theme).paper;
    ctx.fillRect(0, 0, c.width, c.height);
    console.warn('theme swatch failed', theme, e);
  }
  if (o.selected) {
    // a marker ring around the chosen swatch
    const k = Math.max(1, c.width / 320);
    ctx.save();
    ctx.strokeStyle = ART.palette.blue;
    ctx.lineWidth = 4 * k;
    ctx.lineJoin = 'round';
    const p = 3 * k;
    roundRectPath(ctx, p, p, c.width - 2 * p, c.height - 2 * p, 10 * k);
    ctx.stroke();
    ctx.restore();
  }
}

/** A swatch as a ready canvas element (CSS width × height px, crisp at the device pixel ratio). */
export function themeSwatch(theme: Theme, cssW = 160, o: { character?: InkStroke[] | null; selected?: boolean } = {}): HTMLCanvasElement {
  const dpr = Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
  const c = document.createElement('canvas');
  const cssH = Math.round((cssW * 9) / 16);
  c.width = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  c.dataset.theme = theme;
  renderThemeSwatch(c, theme, o);
  return c;
}

/** Play two bars of the theme's music loop (call from a click). Returns a stop function. */
export function auditionTheme(theme: Theme, seed?: string): () => void {
  return auditionMusic(theme, { seed });
}
