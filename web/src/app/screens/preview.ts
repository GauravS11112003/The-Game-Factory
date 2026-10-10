/**
 * #/preview/:draft — what I saw, what I changed, how it plays (PLAN_V2 §7.10).
 *
 * Top strip: stage chips (① Ink ✓ 0.5 s · ② Understood ⏳ · ③ Designed), the dial (Faithful | Polished | Challenging ▾
 * Normal/Hard; tiers are precomputed so the swap is instant), the difficulty pill, the reach message, an editable
 * title, Play test and Publish (gated, with a one-sentence reason and a fix button).
 * Report: designer note; What I saw (grouped by role, kid stroke thumbnails, solid/dotted confidence, "Is this
 * right?" re-labels); What I changed (cards: I understood / I fixed / I added / Heads up, Keep/Undo, ghosts, why?,
 * dependents, required lock, Make it mine; Undo all; Rejected ideas); Questions (Ask cards); How it plays (Watch the
 * bot, bot time and par, segment bars, flags with Fix it, Why is this hard?). Designer suggestions arrive late.
 * Toggles rebuild locally in the browser core, morph the stage, then PUT /drafts/{id}/edits persists them.
 */
import type {
  AskCard, AskOption, CellXY, EditOp, EditRecord, Flag, InkDoc, InkStroke, LevelV2, LibraryType, Morph, PlaytestReport, RectCells,
  Replay, Role, SawItem, Stage as StageId, Tier,
} from '../../core/types.gen.ts';
import { CORE_VERSION, encodeReplay, profileHash, PROFILES } from '../../core/index.ts';
import { DERIVED, PERCEPTION } from '../../core/params.ts';
import { api, ApiError } from '../api.ts';
import { coreClient } from '../core_client.ts';
import { DraftModel, targetOf, tierRank, TIERS, type TierView } from '../draft.ts';
import { card, h, icon, isPhone, toast } from '../dom.ts';
import { emptyInkFor } from '../ink.ts';
import { takeHandoff } from '../handoff.ts';
import { fmtClock, kidText, roleChip, t, tMaybe } from '../messages.ts';
import { beforeAfter, pill, segmentBars } from '../readout.ts';
import { Stage } from '../stage.ts';
import { store } from '../store.ts';
import { followBuild } from '../sse.ts';
import { drawLevelThumb, objectThumb } from '../thumbs.ts';
import { emptyDoc, type EditorDocData } from '../../editor/doc.ts';
import { rolesFor } from '../../editor/chips.ts';
import { navigate } from '../router.ts';
import { typeThumb } from './library.ts';
import { shareCardPNG } from '../../engine/index.ts';

const ROLE_ICON: Partial<Record<Role, string>> = {
  ground: '▁', platform: '═', wall: '▮', ceiling: '▔', spikes: '▲', lava: '〰', saw: '✺', enemy: '👾', coin: '●', big_coin: '★',
  key: '🔑', door: '🚪', spring: '🌀', checkpoint: '🚩', goal: '🏁', pole: '│', start_marker: '🙂', text: '✎', arrow: '➜',
  decoration: '🌳', library_tag: '📚', unknown: '?',
};

const STAGE_LABELS: [StageId, string][] = [['ink', '①'], ['understood', '②'], ['designed', '③']];

type CardGroup = 'understood' | 'fixed' | 'added';

interface CardModel {
  key: string;
  group: CardGroup;
  edits: EditRecord[];
}

function groupOfEdit(e: EditRecord): CardGroup {
  if (e.class === 'U' || e.class === 'K') return 'understood';
  if (e.class === 'N' || e.class === 'R') return 'fixed';
  return 'added';
}

function ghostKind(before: RectCells[], after: RectCells[]): 'move' | 'appear' | 'vanish' {
  if (!before.length) return 'appear';
  if (!after.length) return 'vanish';
  return 'move';
}

/** Bot input log (RLE pairs: run, bits) → a Replay the engine can ghost (§4.2 `trace`, §8.4). */
function botReplay(level: LevelV2, r: PlaytestReport): Replay | null {
  const tr = r.trace ?? [];
  if (tr.length < 2) return null;
  let frames = 0;
  for (let i = 0; i + 1 < tr.length; i += 2) frames += Math.max(0, tr[i]);
  if (!frames || frames > 60 * 60 * 20) return null;
  const inputs = new Uint8Array(frames);
  let f = 0;
  for (let i = 0; i + 1 < tr.length; i += 2) {
    inputs.fill(tr[i + 1] & 0x1f, f, f + tr[i]);
    f += tr[i];
  }
  let ph = level.rules.profile_hash ?? '';
  if (!ph) {
    try {
      ph = profileHash(level.rules.physics_profile ?? 'v2-standard');
    } catch {
      ph = '';
    }
  }
  return {
    v: 1, core: CORE_VERSION, profile_hash: ph, level_id: level.id, level_version: level.version, level_hash: level.meta.level_hash,
    frames, input: encodeReplay(inputs),
  };
}

function firstNum(s: string | undefined | null): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(s ?? '');
  return m ? Number(m[0]) : null;
}

/** The highest ledge a running jump reaches, in whole rows, for the level's physics profile (§5.3 envelope). */
function apexRows(level: LevelV2 | null): number {
  const p = PROFILES[level?.rules.physics_profile ?? 'v2-standard'] ?? PROFILES['v2-standard'];
  const e = p?.envelope.apex_c;
  return Math.floor(e?.run ?? e?.walk ?? 4);
}

/** "Nobody can finish this yet" + the blocking jump in plain words (§4.3 unsolvable, frontier). */
function frontierText(r: PlaytestReport, level: LevelV2 | null = null): string {
  const b = r.frontier?.blocking;
  if (!b) return t(r.reason === 'key_unreachable' ? 'frontier.key_unreachable' : 'frontier.goal_unreachable');
  const need = firstNum(b.need);
  const have = firstNum(b.have);
  switch (b.kind) {
    case 'gap_too_wide':
      return t('frontier.needs_run_up', { need: need ?? '?', max: DERIVED.g_max_expected.runway_3, have: have ?? 0 });
    case 'ledge_too_high':
      return t('frontier.too_high', { need: need ?? '?', max: apexRows(level) });
    case 'wall_too_tall':
      return t('frontier.too_tall', { need: need ?? '?', max: apexRows(level) });
    case 'head_bonk':
      return t('frontier.head_bonk');
    case 'key_unreachable':
      return t('frontier.key_unreachable');
    case 'spawn_trapped':
      return t('frontier.spawn_trapped');
    default:
      return t('frontier.goal_unreachable');
  }
}

function flagText(f: Flag, r: PlaytestReport, level: LevelV2 | null): string {
  if (f.code === 'unsolvable') return t('flag.unsolvable', { need: frontierText(r, level) });
  return tMaybe(f.message_key, f.args ?? {}) ?? t(`flag.${f.code}`, f.args ?? {});
}

function editReason(e: EditRecord): string {
  if (e.reason_text && (e.by === 'model' || e.by === 'kid')) return kidText(e.reason_text);
  return tMaybe(e.reason_key, e.reason_args ?? {}) ?? t('preview.changed_something');
}

/** The "why?" disclosure with the numbers (§7.10 card anatomy). */
function whyText(e: EditRecord): string {
  const a = (e.reason_args ?? {}) as Record<string, unknown>;
  if (a.gap !== undefined && a.max !== undefined) return t('why.gap', { gap: a.gap, max: a.max, dx: a.dx ?? 1 });
  if (a.rise !== undefined && a.max !== undefined) return t('why.ledge', { rise: a.rise, max: a.max });
  const v = e.validation;
  const bits: string[] = [];
  if (v) {
    bits.push(t(v.solvable ? 'why.still_finishable' : 'why.not_finishable'));
    if (v.drift_cells > 0.05) bits.push(t('why.moved', { cells: Math.round(v.drift_cells * 10) / 10 }));
    if (Math.abs(v.dC) >= 0.01) bits.push(t(v.dC > 0 ? 'why.harder' : 'why.easier', { dC: Math.round(Math.abs(v.dC) * 100) / 100 }));
  }
  return bits.length ? bits.join(' ') : t('why.no_numbers');
}

function badgeOf(e: EditRecord): string {
  if (e.class === 'N' || e.class === 'R') return t('card.badge.fixed');
  if (e.by === 'model') return t('card.badge.designers_pick');
  if (e.class === 'U' || e.class === 'K') return '';
  return t('card.badge.designer');
}

function opIcon(e: EditRecord): string {
  const m: Partial<Record<EditOp['op'], string>> = {
    set_role: '🔎', group: '🧩', detach: '✂', bind: '⚙', link: '🔗', straighten: '〰', close_gap: '⇿', snap: '🧲', orient: '↻',
    form_goal: '🏁', set_collision: '⤒', place_start: '🙂', clear_spawn: '🛟', coin_from_dot: '●', nudge: '↔', trim: '✂', extend: '⟷',
    add_step: '▟', add_spring: '🌀', add_checkpoint: '🚩', add_coin_trail: '⋯', add_coin: '●', add_big_coin: '★', add_hint_arrow: '➜',
    tune: '⏩', animate: '🚶', set_par: '⏱', widen_gap: '⟺', shrink_landing: '⇥', shift_platform: '⇅', add_spikes: '▲',
    add_enemy: '👾', add_hazard: '✺', make_crumble: '🧱', set_timer: '⏳', reprise: '🔁', make_mine: '✍',
  };
  return m[e.op.op] ?? '✎';
}

export function previewScreen(root: HTMLElement, draftId: string, query: URLSearchParams): () => void {
  const saved = store.draftBuild(draftId);
  const buildId = query.get('b') ?? saved?.build_id ?? null;
  const eventsUrl = buildId ? `/api/v2/builds/${buildId}/events` : saved?.events_url ?? null;
  const model = new DraftModel(draftId, buildId);
  const wanted = query.get('dial');
  model.tier = wanted === 'faithful' || wanted === 'normal' || wanted === 'hard' ? wanted : 'polished';
  const stage = new Stage('stage preview-stage');
  let disposed = false;
  let shownKey = '';
  let selectedCard: string | null = null;
  let watching = false;
  let challengeOpen = model.tier === 'normal' || model.tier === 'hard';
  let undoAll: Record<string, 'applied' | 'undone'> | null = null;
  let titleTouched = false;
  let keptApplied = false;
  const openWhy = new Set<string>();
  // the game's library, for "Is this Grumpo?" asks with the type's own art (§8.1 "Uncertain or offline")
  let library: LibraryType[] = [];
  const draftGame = store.draftDoc(draftId)?.gameId ?? null;
  if (draftGame) api.library(draftGame).then((l) => { library = l; renderAsks(); }).catch(() => undefined);
  let rejectedOpen = false;
  let followStop: (() => void) | null = null;
  const extraStops: (() => void)[] = [];

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const stageChips = h('div', { class: 'stage-chips' });
  const badges = h('div', { class: 'badges' });
  const dial = h('div', { class: 'dial', role: 'radiogroup', 'aria-label': t('preview.dial') });
  const pillBox = h('div', { class: 'pill-box' });
  const reachMsg = h('div', { class: 'reach small' });
  const titleIn = h('input', { class: 'title-in', type: 'text', maxLength: 40, placeholder: t('preview.title_placeholder'), 'aria-label': t('preview.title') });
  titleIn.oninput = () => (titleTouched = true);
  const playBtn = h('button', { type: 'button', class: 'pill' }, icon('play'), t('preview.play_test'));
  // paper levels: "my original sketch" behind the level (lane E's underlay), shown once the stage says it has photos
  let sketchOn = false;
  const sketchBtn = h('button', { type: 'button', class: 'pill small hidden', title: t('preview.sketch_help') }, icon('camera'), t('preview.sketch'));
  sketchBtn.onclick = () => {
    sketchOn = !sketchOn;
    if (!stage.setUnderlay(sketchOn)) sketchOn = false;
    sketchBtn.classList.toggle('on', sketchOn);
  };
  const publishBtn = h('button', { type: 'button', class: 'pill primary' }, icon('flag'), t('preview.publish'));
  const publishWhy = h('div', { class: 'publish-why small' });
  const top = h('div', { class: 'preview-top card paper' },
    h('div', { class: 'row wrap' }, stageChips, badges),
    h('div', { class: 'row wrap' }, dial, pillBox),
    reachMsg,
    h('div', { class: 'row wrap' }, titleIn, playBtn, publishBtn, sketchBtn),
    publishWhy);

  const noteBox = h('div', { class: 'designer-note' });
  const sawSec = h('section', { class: 'rep-sec', data: { sec: 'saw' } });
  const changedSec = h('section', { class: 'rep-sec', data: { sec: 'changed' } });
  const asksSec = h('section', { class: 'rep-sec', data: { sec: 'changed' } });
  const sugSec = h('section', { class: 'rep-sec', data: { sec: 'changed' } });
  const playsSec = h('section', { class: 'rep-sec', data: { sec: 'plays' } });
  const footer = h('div', { class: 'rep-footer' });
  const tabs = h('div', { class: 'rep-tabs', role: 'tablist' },
    ...(['saw', 'changed', 'plays'] as const).map((k) => h('button', {
      type: 'button', class: 'tab', role: 'tab', data: { tab: k },
      onclick: () => { report.dataset.tab = k; report.classList.add('open'); syncTabs(); },
    }, t(`preview.tab_${k}`))));
  const handle = h('button', { type: 'button', class: 'sheet-handle', 'aria-label': t('preview.report'), onclick: () => report.classList.toggle('open') });
  const report = h('aside', { class: 'report card paper', data: { tab: 'saw' } }, handle, tabs, noteBox, sawSec, changedSec, asksSec, sugSec, playsSec, footer);
  const layout = h('div', { class: 'preview-layout' }, stage.el, report);
  root.append(h('div', { class: 'preview' }, top, layout));

  // Phone: the report is a swipe-up sheet (§7.10 layout).
  let swipeY: number | null = null;
  for (const el of [handle, tabs] as HTMLElement[]) {
    el.addEventListener('pointerdown', (e: PointerEvent) => (swipeY = e.clientY));
    el.addEventListener('pointerup', (e: PointerEvent) => {
      if (swipeY === null) return;
      const dy = e.clientY - swipeY;
      swipeY = null;
      if (dy < -24) report.classList.add('open');
      else if (dy > 24) report.classList.remove('open');
    });
  }

  function syncTabs(): void {
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('.tab')) b.classList.toggle('on', b.dataset.tab === report.dataset.tab);
  }
  syncTabs();

  // ---- what tier is on stage --------------------------------------------------------------------------------------
  function shownTier(): Tier {
    if (model.hasTier(model.tier)) return model.tier;
    for (let i = tierRank(model.tier); i >= 0; i--) if (model.hasTier(TIERS[i])) return TIERS[i];
    return TIERS.find((x) => model.hasTier(x)) ?? model.tier;
  }

  function currentView(): TierView | null {
    return model.view(shownTier());
  }

  function inkFor(level: LevelV2): InkDoc {
    return model.ink ?? emptyInkFor(level);
  }

  function updateStage(morphs?: Morph[]): void {
    const v = currentView();
    if (!v) return;
    const key = `${v.tier}:${v.stage}:${v.seq}:${v.local ? v.level.meta.level_hash : ''}:${model.ink ? 1 : 0}`;
    if (key === shownKey) return;
    const wasStage = shownKey.split(':')[1];
    shownKey = key;
    stage.show({ level: v.level, ink: inkFor(v.level), morphs: morphs ?? v.morphs });
    if (stage.playing && wasStage && wasStage !== v.stage && !v.local) {
      toast(t('toast.designer_polished'), { action: { label: t('preview.try_it'), run: () => stage.show({ level: v.level, ink: inkFor(v.level), morphs: v.morphs }, { when: 'now' }) } });
    }
    syncOverlays();
  }

  function syncOverlays(): void {
    const v = currentView();
    const spec: Parameters<Stage['setOverlays']>[0] = {};
    if (selectedCard && v) {
      const c = cardModels(v.tier).find((x) => x.key === selectedCard);
      const ghosts = (c?.edits ?? []).filter((e) => e.ghost).map((e) => ({ before: e.ghost!.before, after: e.ghost!.after, kind: ghostKind(e.ghost!.before, e.ghost!.after) }));
      if (ghosts.length) spec.editGhosts = ghosts;
    }
    if (watching && v) {
      spec.botPath = v.report.route.flatMap((s) => [s.from, s.to]);
      spec.flags = v.report.route.flatMap((s) => {
        const out: { at: CellXY; code: string }[] = [];
        const w = Math.min(s.w_f, s.h_f, s.phi_f ?? Infinity);
        if (w < 8) out.push({ at: s.from, code: 'tight_window' });
        if (s.blind) out.push({ at: s.from, code: 'blind_jump' });
        return out;
      });
    }
    stage.setOverlays(spec);
  }

  // ---- top strip ---------------------------------------------------------------------------------------------------
  function stageStatus(st: StageId): { mark: string; text: string; cls: string } {
    const names: Record<StageId, ('ink' | 'perceive' | 'understood' | 'design' | 'designed')[]> = {
      ink: ['ink'], understood: ['understood', 'perceive'], designed: ['designed', 'design'],
    };
    for (const n of names[st]) {
      const ev = model.stages.get(n);
      if (!ev) continue;
      if (ev.status === 'done' && n === names[st][0]) return { mark: '✓', text: `${(ev.t_ms / 1000).toFixed(1)} s`, cls: 'done' };
      if (ev.status === 'skipped') return { mark: '–', text: t('stage.status.skipped'), cls: 'skipped' };
      if (ev.status === 'failed') return { mark: '!', text: t('stage.status.failed'), cls: 'failed' };
      if (ev.status === 'late') return { mark: '⏳', text: t('stage.status.late'), cls: 'late' };
      if (ev.status === 'start' || ev.status === 'done') return { mark: '⏳', text: '', cls: 'working' };
    }
    if (model.tiers[st] && Object.keys(model.tiers[st]!).length) return { mark: '✓', text: '', cls: 'done' };
    return { mark: model.done ? '–' : '', text: '', cls: 'waiting' };
  }

  function renderTop(): void {
    stageChips.replaceChildren(...STAGE_LABELS.map(([st, num]) => {
      const s = stageStatus(st);
      return h('span', { class: `stage-chip ${s.cls}` }, `${num} ${t(`stage.${st}`)} `, h('b', null, s.mark), s.text ? ` ${s.text}` : '');
    }));
    const b: HTMLElement[] = [];
    if (model.modelMode() !== 'live') b.push(h('span', { class: 'badge' }, t('badge.quick_look_offline')));
    if (model.warnings.some((w) => w.message_key === 'warning.budget_resting')) b.push(h('span', { class: 'badge' }, t('toast.designer_resting')));
    const designLate = model.stages.get('design')?.status === 'late';
    if ((designLate || model.note?.source === 'greedy') && model.hasTier('polished')) b.push(h('span', { class: 'badge' }, t('badge.polished_auto')));
    if (model.safety() === 'held') b.push(h('span', { class: 'badge warn' }, t('badge.saved_privately')));
    badges.replaceChildren(...b);

    // Dial
    const tier = shownTier();
    const btn = (tr: Tier | 'challenging', label: string): HTMLButtonElement => {
      const available = tr === 'challenging' ? model.hasTier('normal') || model.hasTier('hard') : model.hasTier(tr);
      const on = tr === 'challenging' ? tier === 'normal' || tier === 'hard' : tier === tr;
      return h('button', {
        type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', class: `dial-pos${on ? ' on' : ''}`, disabled: !available,
        onclick: () => {
          if (tr === 'challenging') {
            challengeOpen = true;
            setTier(model.tier === 'hard' ? 'hard' : 'normal');
          } else {
            challengeOpen = false;
            setTier(tr);
          }
        },
      }, label, tr === 'challenging' ? ' ▾' : '');
    };
    const sub = challengeOpen || tier === 'normal' || tier === 'hard'
      ? h('div', { class: 'dial-sub' }, ...(['normal', 'hard'] as Tier[]).map((tr) => h('button', {
        type: 'button', class: `chip${tier === tr ? ' on' : ''}`, disabled: !model.hasTier(tr), onclick: () => setTier(tr),
      }, t(`band.${tr}`))))
      : null;
    dial.replaceChildren(btn('faithful', t('tier.faithful')), btn('polished', t('tier.polished')), btn('challenging', t('dial.challenging')), sub ?? '');

    const v = currentView();
    const faithful = model.view('faithful')?.report ?? null;
    const ba = v ? beforeAfter(faithful, v.tier, v.report) : null;
    pillBox.replaceChildren(pill(v?.report ?? null), ba ? h('div', { class: 'small muted' }, ba) : '');
    if (v && !v.reach && v.tier !== 'faithful') {
      const best = [...TIERS].reverse().find((tr) => tr !== 'faithful' && model.view(tr)?.reach);
      reachMsg.textContent = t('reach.goes_up_to', { band: t(`band.${model.view(best ?? 'polished')?.report.band ?? 'easy'}`) });
    } else reachMsg.textContent = '';
    if (!titleTouched) {
      const sugg = model.note?.title_suggestion ?? model.graph0?.title ?? '';
      if (sugg && !titleIn.value) titleIn.value = kidText(sugg).slice(0, 40);
    }
    renderPublish();
  }

  function setTier(tr: Tier): void {
    if (model.tier === tr && shownTier() === tr) return;
    const before = currentView();
    model.tier = tr;
    const after = currentView();
    updateStage(before && after ? dialMorphs(before, after) : undefined);
    renderAll();
    if (!after?.local && hasKidChanges()) void rebuild();
    api.dial(draftId, tr).catch(() => undefined);
  }

  /** Added pieces sketch in, removed ones erase (§7.10 dial). */
  function dialMorphs(a: TierView, b: TierView): Morph[] {
    const A = new Set(a.editIds);
    const B = new Set(b.editIds);
    const out: Morph[] = [];
    for (const e of model.allEdits()) {
      if (!e.ghost) continue;
      const inA = A.has(e.id);
      const inB = B.has(e.id);
      if (inA === inB) continue;
      const r = (inB ? e.ghost.after : e.ghost.before)[0] ?? e.ghost.after[0] ?? e.ghost.before[0];
      if (!r) continue;
      out.push({ object_id: targetOf(e.op), from: r, to: r, kind: inB ? 'appear' : 'vanish' });
    }
    return out;
  }

  function hasKidChanges(): boolean {
    return Object.keys(model.statuses).length > 0 || model.kidEdits.size > 0;
  }

  // ---- publish gating (§7.10) ----------------------------------------------------------------------------------
  interface Gate { ok: boolean; key?: string; args?: Record<string, unknown>; fix?: { label: string; run: () => void }; unlisted?: boolean }

  function gate(): Gate {
    const v = currentView();
    if (!v) return { ok: false, key: 'preview.wait_build' };
    const tier = v.tier;
    if (!v.level.compiled.entities.some((e) => e.type === 'goal')) return { ok: false, key: 'publish.needs_goal', fix: { label: t('editor.back_to_drawing'), run: () => backToDrawing(false) } };
    const reqUndone = model.editsFor(tier).filter((e) => e.required && model.statusOf(e) === 'undone');
    if (reqUndone.length) return { ok: false, key: 'publish.required_undone', fix: { label: t('card.keep'), run: () => toggle(reqUndone.map((e) => e.id), true) } };
    if (!v.report.solvable) {
      const f = v.report.flags.find((x) => x.code === 'unsolvable' && x.fix_cids?.length);
      return {
        ok: false, key: 'publish.unsolvable',
        fix: f ? { label: t('card.fix_it'), run: () => void fixFlag(f) } : tier === 'faithful' && model.hasTier('polished') ? { label: t('tier.polished'), run: () => setTier('polished') } : undefined,
      };
    }
    if (model.entityErrors.length) return { ok: false, key: 'publish.entity_error', fix: { label: t('editor.back_to_drawing'), run: () => backToDrawing(false) } };
    const un = model.unansweredAsks();
    if (un.length) return { ok: false, key: 'publish.unanswered_ask', fix: { label: t('preview.show_question'), run: () => focusAsk(un[0].id) } };
    if (model.safety() === 'flag') return { ok: false, key: 'publish.safety_flag' };
    return { ok: true, unlisted: model.safety() === 'held' };
  }

  function renderPublish(): void {
    const g = gate();
    publishBtn.disabled = !g.ok;
    publishWhy.replaceChildren();
    if (!g.ok && g.key) {
      publishWhy.append(h('span', null, t(g.key, g.args ?? {})));
      if (g.fix) publishWhy.append(' ', h('button', { type: 'button', class: 'pill small', onclick: g.fix.run }, g.fix.label));
    } else if (g.unlisted) publishWhy.append(h('span', { class: 'muted' }, t('badge.saved_privately')));
  }

  function focusAsk(id: string): void {
    report.dataset.tab = 'changed';
    report.classList.add('open');
    syncTabs();
    asksSec.querySelector<HTMLElement>(`[data-ask="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- designer note ---------------------------------------------------------------------------------------------
  function renderNote(): void {
    const n = model.note;
    const v = currentView();
    noteBox.replaceChildren();
    const text = n?.designer_note ? kidText(n.designer_note) : v ? t(v.tier === 'faithful' ? 'note.faithful' : 'note.greedy') : t('preview.building');
    noteBox.append(h('p', { class: 'note-text' }, icon('pencil'), ' ', text));
    if (n?.critique?.length) noteBox.append(h('ul', { class: 'critique' }, ...n.critique.slice(0, 3).map((c) => h('li', null, kidText(c)))));
    for (const w of model.warnings.slice(-3)) {
      const s = tMaybe(w.message_key, w.args ?? {});
      if (s) noteBox.append(h('p', { class: 'small muted' }, s));
    }
    // a fresh DESIGN on the current drawing (§3.10 DESIGN "on Redesign"); only once the build has finished
    if (model.done && model.modelMode() === 'live' && model.hasTier('polished')) {
      noteBox.append(h('button', { type: 'button', class: 'link small', onclick: () => void redesign() }, icon('pencil'), ' ', t('preview.redesign')));
    }
    for (const e of model.errors.slice(-3)) {
      const s = tMaybe(e.message_key, e.args ?? {});
      if (s) noteBox.append(h('p', { class: `small ${e.fatal ? 'bad' : 'warn'}` }, s));
    }
  }

  // ---- What I saw ----------------------------------------------------------------------------------------------------
  function renderSaw(): void {
    sawSec.replaceChildren(h('h3', { class: 'marker-underline' }, t('preview.saw')));
    const items = model.saw?.items ?? [];
    if (!items.length) {
      sawSec.append(h('p', { class: 'muted' }, t(model.done ? 'preview.saw_nothing' : 'preview.looking')));
      return;
    }
    const byRole = new Map<Role, SawItem[]>();
    for (const it of items) byRole.set(it.role, [...(byRole.get(it.role) ?? []), it]);
    for (const [role, list] of byRole) {
      const grp = h('div', { class: 'saw-group' }, h('h4', null, h('span', { class: 'emo' }, ROLE_ICON[role] ?? '•'), ` ${roleChip(role)} ×${list.length}`));
      for (const it of list) grp.append(sawItem(it));
      sawSec.append(grp);
    }
    const specks = model.ink?.noise?.count ?? 0;
    if (specks > 0) sawSec.append(h('p', { class: 'small muted' }, t('saw.specks', { n: specks })));
  }

  function sawItem(it: SawItem): HTMLElement {
    const ob = model.object(it.object_id);
    const kidRole = [...model.kidEdits.values()].find((e) => e.op.op === 'set_role' && e.op.target === it.object_id);
    const sure = it.conf >= PERCEPTION.ask_conf || !!kidRole;
    const text = tMaybe(it.rel_key, it.rel_args ?? {}) ?? roleChip(it.role);
    const row = h('div', { class: `saw-item${sure ? ' sure' : ' unsure'}` },
      objectThumb(model.ink, ob?.strokes ?? [], it.bbox),
      h('div', { class: 'saw-text' }, h('span', null, kidRole ? t('kid.relabel', { role: t(`role.${(kidRole.op as { role: Role }).role}`) }) : text)));
    row.onmouseenter = () => stage.setOverlays({ editGhosts: [{ before: [], after: [it.bbox], kind: 'appear' }] });
    row.onmouseleave = () => syncOverlays();
    const inkColors = (ob?.strokes ?? []).map((id) => model.ink?.strokes.find((s) => s.id === id)?.color).filter((c): c is InkStroke['color'] => !!c);
    if (!sure) {
      const pool = [...new Set([...(ob?.alt ?? []).map((a) => a.role), ...(['platform', 'wall', 'decoration', 'enemy', 'spikes', 'text'] as Role[])])];
      const alts = rolesFor(inkColors, pool).filter((r) => r !== it.role).slice(0, 6);
      row.querySelector('.saw-text')!.append(h('div', { class: 'chips' }, h('span', { class: 'muted small' }, t('ask.is_this_right')),
        h('button', { type: 'button', class: 'chip', onclick: () => relabel(it.object_id, it.role) }, t('ask.option.yes')),
        ...alts.map((r) => h('button', { type: 'button', class: 'chip', onclick: () => relabel(it.object_id, r) }, roleChip(r)))));
    } else {
      const more = h('button', { type: 'button', class: 'link small', onclick: () => {
        more.replaceWith(h('div', { class: 'chips' }, ...rolesFor(inkColors).filter((r) => r !== it.role).map((r) => h('button', { type: 'button', class: 'chip', onclick: () => relabel(it.object_id, r) }, roleChip(r)))));
      } }, t('preview.change'));
      row.querySelector('.saw-text')!.append(more);
    }
    return row;
  }

  function relabel(objectId: string, role: Role): void {
    model.addKidEdit({ op: 'set_role', target: objectId, role }, { reason_key: 'kid.relabel', reason_args: { role: t(`role.${role}`) } });
    scheduleRebuild();
  }

  // ---- What I changed ------------------------------------------------------------------------------------------------
  function cardModels(tier: Tier): CardModel[] {
    const out: CardModel[] = [];
    const byGroup = new Map<string, CardModel>();
    for (const e of model.editsFor(tier)) {
      if (e.status === 'rejected' && !model.statuses[e.id]) continue;
      if (e.class === 'N' && e.group) {
        const k = `g:${e.group}`;
        const c = byGroup.get(k);
        if (c) c.edits.push(e);
        else {
          const nc: CardModel = { key: k, group: 'fixed', edits: [e] };
          byGroup.set(k, nc);
          out.push(nc);
        }
      } else out.push({ key: e.id, group: groupOfEdit(e), edits: [e] });
    }
    return out;
  }

  function renderChanged(): void {
    const v = currentView();
    changedSec.replaceChildren(h('h3', { class: 'marker-underline' }, t('preview.changed')));
    if (!v) {
      changedSec.append(h('p', { class: 'muted' }, t('preview.building')));
      footer.replaceChildren();
      return;
    }
    const cards = cardModels(v.tier);
    const groups: [CardGroup, string][] = [['understood', 'card.group.understood'], ['fixed', 'card.group.fixed'], ['added', 'card.group.added']];
    let any = false;
    for (const [g, key] of groups) {
      const list = cards.filter((c) => c.group === g);
      if (!list.length) continue;
      any = true;
      changedSec.append(h('h4', null, t(key)), ...list.map((c) => editCard(c, v)));
    }
    const heads = v.report.flags.filter((f) => f.severity !== 'block' && f.code !== 'unsolvable');
    if (heads.length) {
      any = true;
      changedSec.append(h('h4', null, t('card.group.heads_up')), ...heads.map((f) => flagCard(f, v.report, v.level)));
    }
    if (!any) changedSec.append(h('p', { class: 'muted' }, t('preview.no_changes')));
    renderFooter(v);
  }

  function editCard(c: CardModel, v: TierView): HTMLElement {
    const e0 = c.edits[0];
    const statuses = c.edits.map((e) => model.statusOf(e));
    const kept = statuses.some((s) => s === 'applied');
    const rejected = statuses.every((s) => s === 'rejected');
    const allEdits = new Map(model.allEdits().map((e) => [e.id, e]));
    const needs = c.edits.flatMap((e) => e.depends_on ?? []).map((id) => allEdits.get(id)).filter((d): d is EditRecord => !!d && model.statusOf(d) === 'undone');
    const reason = c.edits.length > 1 && e0.reason_key === 'norm.tidy_lines' ? t('norm.tidy_lines', { n: c.edits.length }) : editReason(e0);
    const why = h('div', { class: `why small${openWhy.has(c.key) ? '' : ' hidden'}` }, whyText(e0));
    const el = h('div', {
      class: `edit-card${kept ? '' : ' undone'}${needs.length ? ' blocked' : ''}${selectedCard === c.key ? ' selected' : ''}`,
      data: { card: c.key },
      onclick: (ev: MouseEvent) => {
        if ((ev.target as HTMLElement).closest('button')) return;
        selectedCard = selectedCard === c.key ? null : c.key;
        renderChanged();
        syncOverlays();
      },
    },
    h('div', { class: 'row' }, h('span', { class: 'emo' }, opIcon(e0)), h('span', { class: 'reason' }, reason),
      badgeOf(e0) ? h('span', { class: 'badge' }, badgeOf(e0)) : ''),
    h('div', { class: 'row' },
      rejected ? h('span', { class: 'muted small' }, t('preview.rejected')) : h('div', { class: 'seg-toggle', role: 'group' },
        h('button', { type: 'button', class: kept ? 'on' : '', disabled: !!needs.length, onclick: () => toggle(c.edits.map((e) => e.id), true) }, t('card.keep')),
        h('button', { type: 'button', class: kept ? '' : 'on', disabled: !!needs.length, onclick: () => toggle(c.edits.map((e) => e.id), false) }, t('card.undo'))),
      h('button', {
        type: 'button', class: 'link small',
        onclick: () => {
          if (openWhy.has(c.key)) openWhy.delete(c.key);
          else openWhy.add(c.key);
          why.classList.toggle('hidden', !openWhy.has(c.key));
        },
      }, t('card.why')),
      mineButton(c, v),
      ownArtButton(c)),
    needs.length ? h('div', { class: 'small muted' }, t('card.needs', { what: editReason(needs[0]) })) : '',
    c.edits.some((e) => e.required) ? h('div', { class: 'small lock' }, icon('lock'), ' ', t('card.required_lock')) : '',
    why);
    return el;
  }

  /** §8.1 instance art: a library instance uses its type's drawing; "use my new drawing" keeps the kid's blob. */
  function ownArtButton(c: CardModel): HTMLElement | string {
    const e = c.edits[0];
    if (e.op.op !== 'use_library') return '';
    const op = e.op;
    const name = String((e.reason_args ?? {}).name ?? '');
    const mine = [...model.kidEdits.values()].find((k) => k.op.op === 'use_library' && k.op.target === op.target
      && (k.op as EditOp & { x_own_art?: boolean }).x_own_art && model.statusOf(k) === 'applied');
    return h('button', {
      type: 'button', class: 'link small',
      onclick: () => {
        if (mine) model.setStatus([mine.id], 'undone');
        else model.addKidEdit({ ...op, x_own_art: true } as EditOp, { reason_key: 'library.own_art', reason_args: { name } });
        scheduleRebuild();
        renderChanged();
      },
    }, mine ? t('library.use_type_art', { name }) : t('library.use_own_art'));
  }

  /** "Make it mine" on designer objects (K1): the designer object found under the card's ghost. */
  function mineButton(c: CardModel, v: TierView): HTMLElement | string {
    const e = c.edits[0];
    if (e.class !== 'P' && e.class !== 'C' && e.op.op !== 'add_step' && e.op.op !== 'add_spring') return '';
    const after = e.ghost?.after?.[0];
    const objs = (v.level.objects ?? []).filter((o) => o.origin === 'designer');
    const hit = after ? objs.find((o) => o.shape.k === 'body' ? overlap(o.shape.bbox, after) : o.shape.k === 'point' ? inside(o.shape.p, after) : false) : null;
    const targetId = hit?.id ?? (typeof (e.op as { target?: unknown }).target === 'string' ? (e.op as { target: string }).target : null);
    if (!targetId) return '';
    const already = [...model.kidEdits.values()].some((k) => k.op.op === 'make_mine' && k.op.target === targetId);
    return h('button', {
      type: 'button', class: 'pill small', disabled: already,
      onclick: () => {
        model.addKidEdit({ op: 'make_mine', target: targetId }, { reason_key: 'kid.make_mine', tier: v.tier });
        scheduleRebuild();
      },
    }, icon('pencil'), t('card.make_it_mine'));
  }

  function flagCard(f: Flag, r: PlaytestReport, level: LevelV2 | null): HTMLElement {
    return h('div', { class: `edit-card flag sev-${f.severity}` },
      h('div', { class: 'row' }, h('span', { class: 'emo' }, '⚠'), h('span', { class: 'reason' }, flagText(f, r, level))),
      f.fix_cids?.length ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'pill small', onclick: () => void fixFlag(f) }, t('card.fix_it'))) : '');
  }

  function renderFooter(v: TierView): void {
    const rejected = model.allEdits().filter((e) => e.status === 'rejected');
    const allIds = model.editsFor(v.tier).filter((e) => e.class !== 'U' && e.status !== 'rejected').map((e) => e.id);
    const undoAllBtn = h('button', {
      type: 'button', class: 'pill small',
      onclick: () => {
        if (undoAll) {
          model.statuses = { ...undoAll };
          undoAll = null;
          model.kidSeq = model.lastSeq;
          model.local = {};
          model.emit('kid');
        } else {
          undoAll = { ...model.statuses };
          model.setStatus(allIds, 'undone');
          if (model.tier !== 'faithful') setTier('faithful');
        }
        scheduleRebuild();
      },
    }, icon('undo'), t(undoAll ? 'preview.redo_all' : 'card.undo_all'));
    const rej = rejected.length
      ? h('details', { class: 'rejected', open: rejectedOpen, ontoggle: (ev: Event) => (rejectedOpen = (ev.currentTarget as HTMLDetailsElement).open) },
        h('summary', null, t('card.rejected_ideas', { n: rejected.length })),
        h('ul', null, ...rejected.map((e) => h('li', null, editReason(e), e.reject_reason ? h('span', { class: 'muted' }, ` · ${tMaybe(e.reject_reason.key, e.reject_reason.args ?? {}) ?? ''}`) : ''))))
      : '';
    const bake = h('input', { type: 'checkbox', id: `bake-${draftId}` });
    footer.replaceChildren(
      h('div', { class: 'row wrap' }, allIds.length ? undoAllBtn : '', rej),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', class: 'pill', onclick: () => backToDrawing(bake.checked) }, icon('pencil'), t('editor.back_to_drawing')),
        h('label', { class: 'small', for: bake.id }, bake, ' ', t('editor.bake_fixes'))));
  }

  // ---- questions -------------------------------------------------------------------------------------------------------
  function renderAsks(): void {
    const asks = [...model.asks.values()];
    asksSec.replaceChildren();
    if (!asks.length) return;
    asksSec.append(h('h3', { class: 'marker-underline' }, t('preview.questions')), ...asks.map(askCard));
  }

  function askCard(a: AskCard): HTMLElement {
    const chosen = model.answers[a.id] ?? a.answer ?? null;
    const about = model.object(a.about);
    const el = h('div', { class: `ask-card${chosen ? ' answered' : ''}`, data: { ask: a.id } },
      h('div', { class: 'row' }, objectThumb(model.ink, about?.strokes ?? [], null, 56, 42), h('strong', null, tMaybe(a.message_key, a.args ?? {}) ?? t('ask.is_this_right'))));
    const opts = h('div', { class: 'chips' });
    for (const op of a.options) {
      if (op.tap_target) {
        opts.append(...tapCandidates(a).map((ob) => h('button', {
          type: 'button', class: `chip thumb${chosen === `tap:${ob.id}` ? ' on' : ''}`, title: roleChip(ob.role),
          onclick: () => void answer(a, op, ob.id),
        }, objectThumb(model.ink, ob.strokes, null, 48, 36))));
      } else {
        const lt = a.kind === 'is_library' ? libraryTypeFor(op, a) : null;
        opts.append(h('button', { type: 'button', class: `chip${lt ? ' thumb lib' : ''}${chosen === op.id ? ' on' : ''}`, onclick: () => void answer(a, op, null) },
          lt ? typeThumb(lt, 40, 34) : '', tMaybe(op.label_key, op.label_args ?? {}) ?? kidText(op.id)));
      }
    }
    el.append(opts);
    if (!chosen && a.default_option) {
      const d = a.options.find((o) => o.id === a.default_option);
      if (d) el.append(h('p', { class: 'small muted' }, t('preview.ask_default', { choice: tMaybe(d.label_key, d.label_args ?? {}) ?? kidText(d.id) })));
    }
    if (chosen) el.append(h('p', { class: 'small ok' }, t('kid.answer')));
    return el;
  }

  /** The library type an "Is this …?" option names (by type id or name in its args). */
  function libraryTypeFor(op: AskOption, a: AskCard): LibraryType | null {
    const args = { ...(a.args ?? {}), ...(op.label_args ?? {}) } as Record<string, unknown>;
    const id = typeof args.type_id === 'string' ? args.type_id : null;
    const name = typeof args.name === 'string' ? args.name.toLowerCase() : typeof args.type_name === 'string' ? args.type_name.toLowerCase() : null;
    return library.find((x) => x.id === id) ?? (name ? library.find((x) => x.name.toLowerCase() === name) ?? null : null);
  }

  function tapCandidates(a: AskCard): { id: string; role: Role; strokes: string[] }[] {
    const roles: Partial<Record<AskCard['kind'], Role[]>> = {
      which_door: ['door', 'wall'], which_flag_is_goal: ['goal', 'checkpoint', 'decoration'], which_target: ['platform', 'ground', 'enemy', 'wall'],
      is_library: ['enemy', 'decoration', 'unknown'],
    };
    const want = roles[a.kind] ?? ['platform', 'wall', 'enemy', 'decoration'];
    return model.objects().filter((o) => want.includes(o.role) && o.id !== a.about && !o.rel?.part_of).slice(0, 8)
      .map((o) => ({ id: o.id, role: o.role, strokes: o.strokes }));
  }

  async function answer(a: AskCard, opt: AskOption, tapped: string | null): Promise<void> {
    const choice = tapped ? `tap:${tapped}` : opt.id;
    model.answers[a.id] = choice;
    let ops: EditOp[] = opt.ops ?? [];
    if (tapped) {
      // "$tap" placeholders in a tap option's ops become the tapped object (lane D, requests/D-1 §4).
      ops = ops.map((o) => JSON.parse(JSON.stringify(o).split('"$tap"').join(JSON.stringify(tapped))) as EditOp);
      if (!ops.length && a.kind === 'which_door') ops = [{ op: 'link', key: a.about, door: tapped }];
      else if (!ops.length && a.kind === 'which_flag_is_goal') ops = [{ op: 'set_role', target: tapped, role: 'goal' }];
    }
    const xs = (opt as AskOption & { x_statuses?: Record<string, 'applied' | 'undone'> }).x_statuses;
    if (xs) for (const [id, st] of Object.entries(xs)) model.statuses[id] = st;
    for (const op of ops) model.addKidEdit(op, { reason_key: 'kid.answer' });
    if (!ops.length) {
      model.kidSeq = model.lastSeq;
      model.local = {};
      model.emit('kid');
    }
    scheduleRebuild();
    api.answer(draftId, a.id, tapped ?? opt.id).then(() => reconcile(shownTier())).catch(() => undefined);
  }

  // ---- designer suggestions (late picks, refine, critic) ---------------------------------------------------------
  function renderSuggestions(): void {
    const sug = [...model.suggestions.values()];
    sugSec.replaceChildren();
    if (!sug.length) return;
    sugSec.append(h('h3', { class: 'marker-underline' }, t('preview.suggestions')), ...sug.map((e) => {
      const on = model.statuses[e.id] === 'applied';
      return h('div', { class: `edit-card suggestion${on ? '' : ' undone'}` },
        h('div', { class: 'row' }, h('span', { class: 'emo' }, opIcon(e)), h('span', { class: 'reason' }, editReason(e)), h('span', { class: 'badge' }, t('card.badge.designers_pick'))),
        h('div', { class: 'row' }, h('div', { class: 'seg-toggle' },
          h('button', { type: 'button', class: on ? 'on' : '', onclick: () => { model.setStatus([e.id], 'applied'); scheduleRebuild(); } }, t('preview.try_it')),
          h('button', { type: 'button', class: on ? '' : 'on', onclick: () => { model.setStatus([e.id], 'undone'); scheduleRebuild(); } }, t('preview.no_thanks')))));
    }));
  }

  // ---- How it plays ------------------------------------------------------------------------------------------------
  function renderPlays(): void {
    const v = currentView();
    playsSec.replaceChildren(h('h3', { class: 'marker-underline' }, t('preview.plays')));
    if (!v) {
      playsSec.append(h('p', { class: 'muted' }, t('preview.building')));
      return;
    }
    const r = v.report;
    const watch = h('button', { type: 'button', class: `pill${watching ? ' on' : ''}`, onclick: () => watchBot() }, icon('bot'), t(watching ? 'preview.stop_bot' : 'card.watch_bot'));
    playsSec.append(
      h('div', { class: 'row wrap' }, watch,
        h('span', { class: 'small' }, t('preview.bot_par', { bot: fmtClock(r.fastest_ms), par: fmtClock(r.par_ms) })),
        r.casual_clear_s ? h('span', { class: 'small muted' }, t('preview.casual', { s: Math.round(r.casual_clear_s) })) : ''),
      r.segments.length ? segmentBars(r) : '');
    const flags = r.flags;
    if (!r.solvable && !flags.some((f) => f.code === 'unsolvable')) playsSec.append(h('p', { class: 'warn' }, t('flag.unsolvable', { need: frontierText(r, v.level) })));
    for (const f of flags) playsSec.append(flagCard(f, r, v.level));
    if (!flags.length && r.solvable) playsSec.append(h('p', { class: 'small ok' }, t('preview.no_flags')));
    playsSec.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'pill', onclick: () => void whyHard() }, icon('question'), t('card.why_hard')),
      model.deaths.length ? h('span', { class: 'small muted' }, t('preview.your_falls', { n: model.deaths.length })) : ''));
  }

  function watchBot(): void {
    const v = currentView();
    if (!v) return;
    if (watching) {
      watching = false;
      stage.setMode('preview');
      syncOverlays();
      renderPlays();
      return;
    }
    const rep = botReplay(v.level, v.report);
    if (!rep) {
      toast(t('preview.bot_unavailable'));
      return;
    }
    watching = true;
    const strokes: InkStroke[] | undefined = model.ink?.character?.strokes;
    stage.setMode('preview', { ghosts: [{ replay: rep, strokes, label: t('preview.bot') }] });
    syncOverlays();
    renderPlays();
  }

  async function fixFlag(f: Flag): Promise<void> {
    const cids = new Set(f.fix_cids ?? []);
    const existing = [...model.suggestions.values(), ...model.edits.values()].find((e) => cids.has(e.cid ?? '') || cids.has(e.id));
    if (existing) {
      model.setStatus([existing.id], 'applied');
      scheduleRebuild();
      return;
    }
    const v = currentView();
    if (!model.ink || !model.graph0 || !v) return void toast(t('preview.fix_unavailable'));
    try {
      const { menu } = await coreClient().menu({ ink: model.ink, graph0: buildGraph0(v.level), edits: model.buildEdits(), rules: v.level.rules, library: [], tier: v.tier, seed: 1, max: 40 });
      const c = menu.find((m) => cids.has(m.cid));
      if (!c) return void toast(t('preview.fix_unavailable'));
      const tier = c.tiers.includes(v.tier) ? v.tier : c.tiers[0] ?? v.tier;
      model.addKidEdit(c.op, { reason_key: c.summary_key, reason_args: (c.summary_args ?? {}) as Record<string, string | number | boolean | null>, tier, cid: c.cid });
      for (const op of c.extra_ops ?? []) model.addKidEdit(op, { reason_key: c.summary_key, tier });
      if (tierRank(tier) > tierRank(model.tier)) setTier(tier);
      scheduleRebuild();
    } catch {
      toast(t('preview.fix_unavailable'));
    }
  }

  async function redesign(): Promise<void> {
    try {
      const r = await api.redesign(draftId);
      toast(t('preview.redesign_thinking'));
      followSide(r.build_id);
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.build_failed', e instanceof ApiError ? e.args : {}));
    }
  }

  async function whyHard(): Promise<void> {
    try {
      const segTimes: Record<string, number> = {};
      const r = await api.critic(draftId, { deaths: model.deaths, attempts: model.attempts, segment_times: segTimes });
      toast(t('preview.critic_thinking'));
      followSide(r.build_id);
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.build_failed', e instanceof ApiError ? e.args : {}));
    }
  }

  /** Follow a side build (critic, redesign) whose events may live in their own log. */
  function followSide(sideBuild: string): void {
    const stop = followBuild(`/api/v2/builds/${sideBuild}/events`, draftId, (e) => {
      // Redesign and critic builds append to the same draft log, so seq stays monotonic (requests/D-1 §5).
      model.apply(e);
    }, { pollMs: 1500 });
    extraStops.push(stop);
  }

  // ---- toggles: local rebuild, morph, persist ------------------------------------------------------------------------
  function toggle(ids: string[], keep: boolean): void {
    model.setStatus(ids, keep ? 'applied' : 'undone');
    const morphs: Morph[] = [];
    for (const id of ids) {
      const e = model.allEdits().find((x) => x.id === id);
      if (!e?.ghost) continue;
      const from = (keep ? e.ghost.before : e.ghost.after)[0];
      const to = (keep ? e.ghost.after : e.ghost.before)[0];
      if (from && to) morphs.push({ object_id: targetOf(e.op), from, to, kind: 'move' });
      else if (to) morphs.push({ object_id: targetOf(e.op), from: to, to, kind: 'appear' });
      else if (from) morphs.push({ object_id: targetOf(e.op), from, to: from, kind: 'vanish' });
    }
    pendingMorphs = morphs;
    scheduleRebuild();
  }

  let pendingMorphs: Morph[] = [];
  let rebuildTimer = 0;
  function scheduleRebuild(): void {
    renderAll();
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(() => void rebuild(), 40);
  }

  /**
   * The G0 a local rebuild starts from: like the server (CONTRACTS §3.11), once the model's reading was merged its
   * named setpieces ride in graph0; before that the core derives geometric ones itself.
   */
  function buildGraph0(level: LevelV2): NonNullable<typeof model.graph0> {
    const g = model.graph0!;
    const named = (level.setpieces ?? []).filter((sp) => sp.by !== 'geometric');
    return model.stages.get('perceive')?.status === 'done' && named.length ? { ...g, setpieces: named } : g;
  }

  let rebuildRev = 0;
  async function rebuild(): Promise<void> {
    const rev = ++rebuildRev;
    const tier = shownTier();
    const base = model.server(tier) ?? model.view(tier);
    const persisted = persist();
    if (!model.ink || !model.graph0 || !base) return;
    try {
      const r = await coreClient().build({ ink: model.ink, graph0: buildGraph0(base.level), edits: model.buildEdits(), rules: base.level.rules, library: [], tier, seed: 1 });
      if (disposed || rev !== rebuildRev) return;
      model.local[tier] = {
        stage: base.stage, tier, level: r.level, report: r.report, editIds: r.edits.filter((e) => e.status === 'applied').map((e) => e.id),
        reach: base.reach, morphs: [], local: true, seq: model.lastSeq, atSeq: model.lastSeq,
      };
      for (const rj of r.rejected) {
        const e = model.edits.get(rj.id) ?? model.kidEdits.get(rj.id);
        if (e && model.statuses[rj.id] === 'applied') toast(t('preview.change_rejected'));
      }
      updateStage(pendingMorphs);
      pendingMorphs = [];
      renderAll();
      await persisted;
      void reconcile(tier);
    } catch {
      // The local core is not ready: the server is authoritative; pick up its rebuilt tiers.
      await persisted;
      if (!(await reconcile(tier))) void pollServer();
    }
  }

  /**
   * After PUT /edits (or an answer) the server writes the authoritative tier to
   * /uploads/drafts/<id>/tiers/current.<tier>.json (requests/D-1 §5). Use it when it differs from the local build.
   */
  async function reconcile(tier: Tier): Promise<boolean> {
    try {
      const r = await fetch(`/uploads/drafts/${encodeURIComponent(draftId)}/tiers/current.${tier}.json`, { cache: 'no-store' });
      if (!r.ok) return false;
      const j = (await r.json()) as { level?: LevelV2; report?: PlaytestReport; edit_ids?: string[]; edits?: EditRecord[]; reach?: boolean };
      if (disposed || !j.level?.compiled || !j.report) return false;
      const loc = model.local[tier];
      if (loc && loc.level.meta.level_hash === j.level.meta.level_hash) return true;
      const base = model.server(tier);
      model.local[tier] = {
        stage: base?.stage ?? model.latestStage() ?? 'ink', tier, level: j.level, report: j.report,
        editIds: j.edit_ids ?? (j.edits ?? []).filter((e) => e.status === 'applied').map((e) => e.id),
        reach: j.reach ?? base?.reach ?? true, morphs: [], local: true, seq: model.lastSeq, atSeq: model.lastSeq,
      };
      if (shownTier() === tier) updateStage();
      renderAll();
      return true;
    } catch {
      return false;
    }
  }

  let persistTimer = 0;
  function persist(): Promise<void> {
    window.clearTimeout(persistTimer);
    return new Promise((resolve) => {
      persistTimer = window.setTimeout(async () => {
        try {
          await api.putEdits(draftId, model.effectiveStatuses(), model.kidOps());
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 501)) console.warn('saving edits failed', e);
        }
        resolve();
      }, 120);
    });
  }

  async function pollServer(): Promise<void> {
    for (let i = 0; i < 6 && !disposed; i++) {
      const r = await api.draft(draftId, model.lastSeq).catch(() => null);
      const evs = r?.events ?? [];
      for (const e of evs) model.apply(e);
      if (evs.some((e) => e.event === 'tier')) return;
      await new Promise((res) => setTimeout(res, 800));
    }
  }

  // ---- play test ---------------------------------------------------------------------------------------------------
  playBtn.onclick = () => {
    if (stage.playing) {
      stage.setMode('preview');
      playBtn.replaceChildren(icon('play'), t('preview.play_test'));
      renderPlays();
      return;
    }
    watching = false;
    stage.setMode('test');
    playBtn.replaceChildren(icon('pencil'), t('preview.stop_test'));
    stage.el.querySelector<HTMLElement>('canvas')?.focus();
  };
  const segDeaths = new Map<string, number>();
  stage.on('ready', (p: { underlay?: boolean } | undefined) => sketchBtn.classList.toggle('hidden', !p?.underlay));
  stage.on('die', (p: { cause?: string; x?: number; y?: number; frame?: number; segment?: string }) => {
    if (!stage.playing) return;
    const d = { x: p?.x ?? 0, y: p?.y ?? 0, cause: p?.cause ?? 'unknown', frame: p?.frame ?? 0, segment: p?.segment ?? 'seg0' };
    model.deaths.push(d);
    model.attempts++;
    const n = (segDeaths.get(d.segment) ?? 0) + 1;
    segDeaths.set(d.segment, n);
    if (n === 5) toast(t('preview.five_falls'), { action: { label: t('card.why_hard'), run: () => void whyHard() } });
  });
  stage.on('win', () => {
    if (!stage.playing) return;
    model.attempts++;
    toast(t('editor.test_won'));
  });
  stage.on('entity_error', (p: { thing?: string; where?: string } | undefined) => {
    model.entityErrors.push(p?.thing ?? 'entity');
    toast(t('error.entity', { thing: p?.thing ?? t('editor.something'), where: p?.where ?? t('editor.here') }));
    renderTop();
  });

  // ---- publish -----------------------------------------------------------------------------------------------------
  publishBtn.onclick = async () => {
    const g = gate();
    const v = currentView();
    if (!g.ok || !v) return;
    let author = store.author();
    if (!author) {
      author = (await askName()) ?? '';
      if (!author) return;
      store.setAuthor(author);
    }
    publishBtn.disabled = true;
    try {
      const res = await api.publish({
        draft_id: draftId, tier: v.tier, author, title: titleIn.value.trim() || null, statuses: model.effectiveStatuses(),
        level_hash: v.level.meta.level_hash,
      });
      const level = res.level;
      void uploadThumb(level);
      showPublished(level, g.unlisted ?? false);
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.build_failed', e instanceof ApiError ? e.args : {}));
    } finally {
      renderPublish();
    }
  };

  /** The 640 × 360 PNG at publish (§7.9): lane E's share card picture ('clean', so feed cards stay text-free). */
  async function uploadThumb(level: LevelV2): Promise<void> {
    let blob: Blob | null = null;
    try {
      blob = await shareCardPNG(level, model.ink ?? null, { style: 'clean' });
    } catch {
      blob = null;
    }
    if (!blob) {
      const c = h('canvas', { width: 640, height: 360 });
      if (!drawLevelThumb(c, level, model.ink ?? undefined)) return;
      blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
    }
    if (blob) await api.thumbnail(level.id, blob).catch(() => undefined);
  }

  function askName(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', class: 'text', maxLength: 16, placeholder: t('ui.your_name') });
      const done = (v: string | null): void => {
        back.remove();
        resolve(v);
      };
      const back = h('div', { class: 'modal-back' }, card('narrow',
        h('h2', null, t('ui.who_made_it')), input,
        h('div', { class: 'row end' },
          h('button', { type: 'button', class: 'pill', onclick: () => done(null) }, t('ui.cancel')),
          h('button', { type: 'button', class: 'pill primary', onclick: () => done(input.value.trim().slice(0, 16) || null) }, t('ui.ok')))));
      input.onkeydown = (e) => e.key === 'Enter' && done(input.value.trim().slice(0, 16) || null);
      document.body.append(back);
      input.focus();
    });
  }

  function showPublished(level: LevelV2, unlisted: boolean): void {
    const link = `${location.origin}${location.pathname}#/play/${level.id}`;
    const back = h('div', { class: 'modal-back' }, card('narrow celebrate',
      h('h2', { class: 'marker-underline' }, t(level.meta.safety === 'unchecked' ? 'publish.unchecked' : 'publish.ok')),
      unlisted ? h('p', { class: 'muted' }, t('badge.saved_privately')) : '',
      h('div', { class: 'row wrap end' },
        h('button', { type: 'button', class: 'pill', onclick: () => { back.remove(); navigate('#/'); } }, icon('home'), t('ui.home')),
        h('button', { type: 'button', class: 'pill', onclick: () => void share(link) }, icon('share'), t('results.challenge')),
        h('button', { type: 'button', class: 'pill primary', onclick: () => { back.remove(); navigate(`#/play/${level.id}`); } }, icon('play'), t('ui.play')))));
    document.body.append(back);
  }

  async function share(url: string): Promise<void> {
    try {
      if (navigator.share) await navigator.share({ url, title: titleIn.value || 'draw-a-level' });
      else {
        await navigator.clipboard.writeText(url);
        toast(t('ui.link_copied'));
      }
    } catch {
      /* cancelled */
    }
  }

  // ---- back to drawing (and Bake my fixes) ---------------------------------------------------------------------------
  function backToDrawing(bake: boolean): void {
    // a prompt or paper draft has no editor document yet (or only its game and title): build it from the ink
    const stored = store.draftDoc(draftId);
    const base: EditorDocData = stored && stored.strokes.length ? stored
      : { ...docFromInk(model.ink), gameId: stored?.gameId ?? null, title: stored?.title ?? '' };
    const doc: EditorDocData = { ...base, keptStatuses: model.effectiveStatuses() };
    if (bake) doc.strokes = bakeStrokes(doc.strokes);
    store.setEditorDoc(doc);
    navigate(`#/draw?from=${encodeURIComponent(draftId)}`);
  }

  function docFromInk(ink: InkDoc | null): EditorDocData {
    if (!ink) return emptyDoc();
    let t0 = 1;
    return emptyDoc({
      screens: ink.world.screens, strokes: ink.strokes.map((s) => ({ ...s, t: s.t ?? t0++ })),
      character: ink.character?.strokes ?? [], rules: ink.typed_rules.map((r, i) => ({ id: `r${i}`, text: r.text, strokeId: null })),
    });
  }

  /** Write the accepted N and R geometry back into the strokes (§3.8 "Bake my fixes"). */
  function bakeStrokes(strokes: InkStroke[]): InkStroke[] {
    const v = currentView();
    if (!v) return strokes;
    const byId = new Map(strokes.map((s) => [s.id, s]));
    for (const e of model.editsFor(v.tier)) {
      if ((e.class !== 'N' && e.class !== 'R') || model.statusOf(e) !== 'applied') continue;
      const ob = (v.level.objects ?? []).find((o) => o.id === targetOf(e.op)) ?? model.object(targetOf(e.op));
      if (!ob) continue;
      if (e.op.op === 'straighten' && ob.shape.k === 'surface' && ob.strokes.length === 1) {
        const s = byId.get(ob.strokes[0]);
        if (!s || s.kind !== 'line') continue;
        const w = s.w.reduce((a, b) => a + b, 0) / Math.max(1, s.w.length);
        const pts: CellXY[] = [];
        for (const seg of ob.shape.segs) {
          if (!pts.length) pts.push([seg.a[0], seg.a[1] + w / 2]);
          pts.push([seg.b[0], seg.b[1] + w / 2]);
        }
        if (pts.length >= 2) byId.set(s.id, { ...s, pts, w: pts.map(() => w) });
        continue;
      }
      const b = e.ghost?.before?.[0];
      const a = e.ghost?.after?.[0];
      if (!a || !b) continue;
      const dx = a[0] - b[0];
      const dy = a[1] - b[1];
      if (Math.abs(dx) + Math.abs(dy) < 1 / 16) continue;
      for (const id of [...ob.strokes, ...(ob.rel?.parts ?? []).flatMap((p) => model.object(p)?.strokes ?? [])]) {
        const s = byId.get(id);
        if (s) byId.set(id, { ...s, pts: s.pts.map((p) => [p[0] + dx, p[1] + dy] as CellXY) });
      }
    }
    return strokes.map((s) => byId.get(s.id) ?? s);
  }

  // ---- kept statuses from a previous draft (edits are kept by stable id) --------------------------------------------
  function applyKept(): void {
    if (keptApplied) return;
    const kept = store.draftKept(draftId);
    if (!kept || !model.edits.size) return;
    keptApplied = true;
    const undone = Object.entries(kept).filter(([id, s]) => s === 'undone' && model.edits.has(id)).map(([id]) => id);
    if (undone.length) {
      model.setStatus(undone, 'undone');
      scheduleRebuild();
    }
  }

  // ---- rendering --------------------------------------------------------------------------------------------------
  function renderAll(): void {
    if (disposed) return;
    renderTop();
    renderNote();
    renderSaw();
    renderChanged();
    renderAsks();
    renderSuggestions();
    renderPlays();
  }

  let renderQueued = false;
  model.on((c) => {
    // Newer server tiers do not know the kid's local toggles yet: rebuild the shown tier with them.
    if (c === 'tier' && hasKidChanges() && !currentView()?.local && !model.lastTierFromKid) {
      window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => void rebuild(), 120);
    }
    if (c === 'tier' || c === 'ink') updateStage();
    if (c === 'edits') applyKept();
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderAll();
    });
  });

  renderAll();
  // The editor's local Ink build plays at once; the server's tiers replace it as they stream in.
  const local = takeHandoff(draftId);
  if (local && !currentView()) stage.show({ level: local.level, ink: local.ink });
  followStop = followBuild(eventsUrl, draftId, (e) => model.apply(e), {
    onState: (s) => {
      if (s === 'failed') toast(t('error.build_failed'));
      // after the build's own stream: anything the draft logged later (rebuilds with the kid's edits, a reopened
      // preview) comes from the polling endpoint
      if (s === 'done' || s === 'failed') {
        api.draft(draftId, model.lastSeq).then((r) => {
          if (disposed) return;
          for (const e of (r.events ?? []).slice().sort((a, b) => a.seq - b.seq)) model.apply(e);
        }).catch(() => undefined);
      }
    },
  });
  if (isPhone()) report.classList.remove('open');

  return () => {
    disposed = true;
    followStop?.();
    for (const s of extraStops) s();
    window.clearTimeout(rebuildTimer);
    window.clearTimeout(persistTimer);
    stage.destroy();
  };
}

function overlap(a: RectCells, b: RectCells): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function inside(p: CellXY, r: RectCells): boolean {
  return p[0] >= r[0] - 0.5 && p[0] <= r[2] + 0.5 && p[1] >= r[1] - 0.5 && p[1] <= r[3] + 0.5;
}

