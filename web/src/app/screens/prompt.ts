/**
 * #/prompt[?game=<id>] — "Tell me a level" (§8.3): text → beats → a verified blue-line draft you draw over.
 *
 * Online, POST /api/v2/prompt-levels runs PLAN (the model picks beats; code lays out the geometry, proves it with the
 * bot, fixes it, and designs it at the chosen dial) and the preview streams it like any build; "Back to drawing"
 * opens the draft as editable blue lines. Offline (or while that route is not live), the keyword planner runs in the
 * browser core (lava, key, tower, spikes, moving, saw, easy/hard → one of the canned plans seeded by the text) and the
 * draft opens straight in the editor, playable with ▶. Kid marker strokes over a draft object replace it ("your
 * ground wins"), and "Ink it" turns the rest into marker.
 */
import type { Beat, ChallengeBand, Dial, GameRules, LevelPlan } from '../../core/types.gen.ts';
import { WORLD } from '../../core/params.ts';
import { api, ApiError } from '../api.ts';
import { coreClient, CoreError } from '../core_client.ts';
import type { PlanResult } from '../core_types.ts';
import { card, h, icon } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { DEFAULT_RULES } from '../rules.ts';
import { store } from '../store.ts';
import { drawLevelThumb } from '../thumbs.ts';
import { emptyDoc } from '../../editor/doc.ts';

const EXAMPLES = ['prompt.example_1', 'prompt.example_2', 'prompt.example_3', 'prompt.example_4'];

/** A stable seed from the prompt text (FNV-1a), so the same words give the same draft. */
export function textSeed(s: string): number {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x || 1;
}

const BEAT_ICON: Record<Beat['kind'], string> = {
  flat: '▁', gap: '⎵', step: '▟', stairs: '☰', pillars: '▥', floaters: '═', ceiling: '▔', wall: '▮', moving_bridge: '↔',
  crumble_run: '🧱', saw_corridor: '✺', tower: '🗼', enemy_gauntlet: '👾', spring_up: '🌀', key: '🔑', door: '🚪', rest: '☕',
  checkpoint: '🚩', goal: '🏁',
};

function beatChip(b: Beat): HTMLElement {
  return h('span', { class: 'beat-chip', title: t(`beat.${b.kind}`) }, h('span', { class: 'emo' }, BEAT_ICON[b.kind] ?? '•'), t(`beat.${b.kind}`));
}

export function planView(plan: LevelPlan): HTMLElement {
  return h('div', { class: 'plan-view' },
    plan.kid_summary ? h('p', { class: 'designer-note note-text' }, kidText(plan.kid_summary)) : '',
    h('ol', { class: 'plan-sections' }, ...plan.sections.map((s) => h('li', null,
      h('span', { class: `sec-role role-${s.role}` }, t(`section.${s.role}`)),
      h('span', { class: 'beats' }, ...s.beats.map(beatChip))))));
}

export function promptScreen(root: HTMLElement, query: URLSearchParams): () => void {
  let disposed = false;
  const gameId = query.get('game');
  let rules: GameRules = DEFAULT_RULES;
  let screens = 2;
  let dial: Dial = 'polished';
  let band: ChallengeBand = 'normal';
  let busy = false;
  let draft: PlanResult | null = null;

  const text = h('textarea', { class: 'text prompt-text', rows: 3, maxLength: 300, placeholder: t('prompt.placeholder') });
  const examples = h('div', { class: 'chips' }, h('span', { class: 'small muted' }, t('prompt.try')),
    ...EXAMPLES.map((k) => h('button', { type: 'button', class: 'chip', onclick: () => { text.value = t(k); text.focus(); } }, t(k))));
  const screensRow = h('div', { class: 'row wrap' });
  const dialRow = h('div', { class: 'chips' });
  const go = h('button', { type: 'button', class: 'pill primary big' }, icon('pencil'), t('prompt.make'));
  const out = h('div', { class: 'prompt-out' });

  function renderOptions(): void {
    screensRow.replaceChildren(h('span', { class: 'small muted' }, t('prompt.how_long')),
      h('div', { class: 'sheet-picker' }, ...Array.from({ length: WORLD.max_screens }, (_, i) => h('button', {
        type: 'button', class: `sheet-icon${i < screens ? ' on' : ''}`, title: t('home.screens', { n: i + 1 }),
        onclick: () => { screens = i + 1; renderOptions(); },
      }, String(i + 1)))),
      h('span', { class: 'small' }, t('home.screens', { n: screens })));
    dialRow.replaceChildren(h('span', { class: 'small muted' }, t('prompt.how_hard')),
      ...(['faithful', 'polished', 'challenging'] as Dial[]).map((d) => h('button', {
        type: 'button', class: `chip${dial === d ? ' on' : ''}`, onclick: () => { dial = d; renderOptions(); },
      }, t(`dial.${d}`))),
      ...(dial === 'challenging' ? (['normal', 'hard'] as ChallengeBand[]).map((b) => h('button', {
        type: 'button', class: `chip${band === b ? ' on' : ''}`, onclick: () => { band = b; renderOptions(); },
      }, t(`band.${b}`))) : []));
    go.disabled = busy;
  }

  async function make(): Promise<void> {
    const prompt = text.value.trim();
    if (!prompt) {
      text.focus();
      return;
    }
    busy = true;
    renderOptions();
    out.replaceChildren(card(null, h('p', { class: 'muted' }, t('prompt.thinking'))));
    try {
      const b = await api.promptLevel({ prompt, game_id: gameId, screens, dial, band: dial === 'challenging' ? band : null });
      if (!b.draft_id || !b.build_id) throw new ApiError(501, 'error.not_implemented');
      store.setDraftBuild(b.draft_id, { build_id: b.build_id, events_url: b.events_url });
      store.setDraftDoc(b.draft_id, emptyDoc({ screens, gameId, title: '' }));
      const tier = dial === 'faithful' ? 'faithful' : dial === 'challenging' ? band : 'polished';
      navigate(`#/preview/${encodeURIComponent(b.draft_id)}?b=${encodeURIComponent(b.build_id)}&dial=${tier}`);
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || ![0, 404, 405, 501, 503].includes(e.status)) {
        busy = false;
        renderOptions();
        out.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.build_failed', e instanceof ApiError ? e.args : {}))));
        return;
      }
    }
    // Offline: the keyword planner in the browser core.
    try {
      draft = await coreClient().plan({ prompt, screens, rules, seed: textSeed(prompt) });
      if (disposed) return;
      showDraft(draft);
    } catch (e) {
      out.replaceChildren(card(null, h('p', null, t(e instanceof CoreError && e.notImplemented ? 'prompt.not_ready' : 'error.build_failed'))));
    } finally {
      busy = false;
      renderOptions();
    }
  }

  function showDraft(d: PlanResult): void {
    const c = h('canvas', { class: 'draft-thumb', width: 1280, height: Math.round((1280 * 27) / d.ink.world.w) });
    if (d.level) drawLevelThumb(c, d.level, d.ink);
    out.replaceChildren(card('draft-card',
      h('div', { class: 'row between wrap' },
        h('h2', null, kidText(d.plan.title || t('prompt.your_draft'))),
        h('span', { class: 'badge' }, t('badge.quick_look_offline'))),
      d.level ? c : '',
      d.solvable === false ? h('p', { class: 'warn small' }, t('prompt.draft_unsolvable')) : '',
      d.fixes > 0 ? h('p', { class: 'small pencil-text' }, t('prompt.fixed', { n: d.fixes })) : '',
      planView(d.plan),
      h('p', { class: 'muted small' }, t('prompt.draw_over_help')),
      h('div', { class: 'row end wrap' },
        h('button', { type: 'button', class: 'pill', onclick: () => void make() }, icon('retry'), t('prompt.again')),
        h('button', { type: 'button', class: 'pill primary big', onclick: () => openDraft(d) }, icon('marker'), t('prompt.draw_over')))));
  }

  function openDraft(d: PlanResult): void {
    let n = 1;
    const strokes = d.ink.strokes.map((s) => ({ ...s, origin: 'draft' as const, t: s.t ?? n++ }));
    const doc = emptyDoc({ screens: d.ink.world.screens, strokes, gameId, title: kidText(d.plan.title ?? '') });
    store.setEditorDoc(doc);
    navigate(`#/draw?from=prompt${gameId ? `&game=${encodeURIComponent(gameId)}` : ''}`);
  }

  go.onclick = () => void make();
  text.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void make();
  };

  root.append(card('prompt-card',
    h('h1', { class: 'marker-underline' }, t('ui.prompt')),
    h('p', null, t('prompt.help')),
    text, examples, screensRow, dialRow,
    h('div', { class: 'row end' }, go)), out);
  renderOptions();
  text.focus();

  if (gameId) {
    api.rules(gameId).then((r) => {
      if (disposed || !r) return;
      rules = { ...DEFAULT_RULES, ...r, abilities: { ...DEFAULT_RULES.abilities, ...(r.abilities ?? {}) } };
      dial = rules.default_dial ?? dial;
      band = rules.default_band ?? band;
      renderOptions();
    }).catch(() => undefined);
  }

  return () => {
    disposed = true;
    draft = null;
  };
}
