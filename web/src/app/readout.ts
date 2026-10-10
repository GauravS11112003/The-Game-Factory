/**
 * The kid-facing difficulty readout (§4.5): "Easy · about 1 fall in N tries · bot 0:31 · par 0:41" with N = round(1 /
 * max_s E_s), "you'll rarely fall" below E 0.05, 0-5 ink drops for the score, and the before/after line.
 */
import type { Band, PlaytestReport, Tier } from '../core/types.gen.ts';
import { DIFFICULTY } from '../core/params.ts';
import { h, icon } from './dom.ts';
import { fmtClock, t } from './messages.ts';

export function bandOf(C: number): Band {
  for (const b of DIFFICULTY.bands) if (b.C_max === null || C < b.C_max) return b.band as Band;
  return 'expert';
}

export function maxE(r: PlaytestReport): number {
  return r.segments.reduce((m, s) => Math.max(m, s.E), 0);
}

export function pillText(r: PlaytestReport): string {
  const band = t(`band.${r.band ?? bandOf(r.C)}`);
  const e = maxE(r);
  const args = { band, bot: fmtClock(r.fastest_ms), par: fmtClock(r.par_ms) };
  if (e < DIFFICULTY.rarely_fall_E) return t('readout.rarely_fall', args);
  return t('readout.pill', { ...args, n: Math.max(1, Math.round(1 / e)) });
}

export function drops(score: number): number {
  return Math.max(0, Math.min(5, Math.round(score / 20)));
}

export function pill(r: PlaytestReport | null): HTMLElement {
  if (!r) return h('div', { class: 'diff-pill muted' }, t('preview.measuring'));
  const n = drops(r.score);
  return h('div', { class: `diff-pill band-${r.band}`, title: t('preview.score', { score: r.score }) },
    h('span', { class: 'txt' }, pillText(r)),
    h('span', { class: 'drops', 'aria-label': t('preview.score', { score: r.score }) },
      ...Array.from({ length: 5 }, (_, i) => icon('drop', `ico drop${i < n ? ' full' : ''}`))));
}

export function beforeAfter(faithful: PlaytestReport | null, tier: Tier, cur: PlaytestReport | null): string | null {
  if (!faithful || !cur || tier === 'faithful') return null;
  return t('readout.before_after', {
    before: t(`band.${faithful.band}`), tier: t(`tier.${tier}`), after: t(`band.${cur.band}`), C: Math.round(cur.C * 100) / 100,
  });
}

/** Segment band bars (the sawtooth): height ∝ E_s, coloured by band. */
export function segmentBars(r: PlaytestReport): HTMLElement {
  const max = Math.max(0.3, ...r.segments.map((s) => s.E));
  return h('div', { class: 'seg-bars', role: 'img', 'aria-label': t('preview.segments') },
    ...r.segments.map((s, i) => h('div', { class: `seg band-${bandOf(s.E)}`, title: t('preview.segment_n', { n: i + 1, band: t(`band.${bandOf(s.E)}`) }) },
      h('div', { class: 'bar', style: { height: `${Math.max(6, (s.E / max) * 100)}%` } }),
      h('span', { class: 'lbl' }, String(i + 1)))));
}
