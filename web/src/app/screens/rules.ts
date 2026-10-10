/**
 * #/game/:id/rules — the game rules sheet on screen (§8.2): a printed-sheet-style page with big checkboxes for the
 * physics profile, abilities, lives and hearts, theme, music, timers, camera and the designer's default dial, and a
 * mini-stage with the real jump arcs for the chosen profile and abilities.
 *
 * Two ways to save. "Save for new levels" stores the rules (version + 1); published levels keep their own snapshot.
 * "Apply to all levels" dry-runs the bot over the game first (POST /games/{id}/rules/check, or the same dry run in the
 * browser core when the server cannot): every level that would become unsolvable is listed with its reason, and the
 * change is blocked unless the creator lets the designer repair those levels with Faithful repairs (shown per level),
 * then PUT ?apply=all&repair=1 saves each as a new version — or cancels.
 * The theme boxes are live samples through the real renderer, and tapping one plays two bars of its music. A paper
 * Rules Sheet can be scanned: its ticks fill in the boxes (two ticks in one group come back as a question).
 */
import type { ChallengeBand, Dial, GameRules, ProfileId, Theme } from '../../core/types.gen.ts';
import { ART } from '../../core/params.ts';
import { auditionTheme, themeSwatch } from '../../engine/index.ts';
import { api, ApiError, type GameCard } from '../api.ts';
import { jumpArcs, type Arc } from '../arcs.ts';
import { coreClient, CoreError } from '../core_client.ts';
import type { DryLevel, DryRow } from '../core_types.ts';
import { card, h, icon, prefersReducedMotion, toast } from '../dom.ts';
import { kidText, t, tRef } from '../messages.ts';
import { DEFAULT_RULES } from '../rules.ts';
import { openPdf } from './scan.ts';

const PROFILES_SHOWN: ProfileId[] = ['v2-gentle', 'v2-standard', 'v2-snappy'];
const THEMES: Theme[] = ['sketchbook', 'notebook', 'graph', 'kraft'];
/** Paper swatches for the theme boxes (the stage draws the real paper, lane E). */
const THEME_PAPER: Record<Theme, { base: string; css: string }> = {
  sketchbook: { base: ART.themes.sketchbook.base, css: `radial-gradient(rgba(31,27,24,0.25) 1px, transparent 1.3px) 0 0 / 6px 6px, ${ART.themes.sketchbook.base}` },
  notebook: { base: '#FDFCF6', css: 'linear-gradient(90deg, transparent 5px, rgba(224,69,58,0.7) 5px, rgba(224,69,58,0.7) 6px, transparent 6px), repeating-linear-gradient(transparent 0 5px, rgba(44,123,229,0.35) 5px 6px), #FDFCF6' },
  graph: { base: '#F7FAF6', css: 'linear-gradient(rgba(62,158,79,0.3) 1px, transparent 1px) 0 0 / 5px 5px, linear-gradient(90deg, rgba(62,158,79,0.3) 1px, transparent 1px) 0 0 / 5px 5px, #F7FAF6' },
  kraft: { base: ART.themes.kraft.base, css: ART.themes.kraft.base },
};
const ARC_COLORS: Record<Arc['kind'], string> = { stand: ART.palette.ink, walk: ART.palette.blue, run: ART.palette.green, double: ART.palette.pencil_violet };

type Abil = 'run' | 'stomp' | 'double_jump' | 'fast_fall';

function withDefaults(r: GameRules | null): GameRules {
  const base = r ?? DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...base, abilities: { ...DEFAULT_RULES.abilities, ...(base.abilities ?? {}) } };
}

function same(a: GameRules, b: GameRules): boolean {
  const k = (r: GameRules): string => JSON.stringify({ ...r, version: 0, profile_hash: null });
  return k(a) === k(b);
}

export function rulesScreen(root: HTMLElement, gameId: string): () => void {
  let disposed = false;
  let game: GameCard | null = null;
  let saved: GameRules = withDefaults(null);
  let rules: GameRules = withDefaults(null);
  let arcs: Arc[] = [];
  let raf = 0;
  let busy = false;
  const body = h('div', { class: 'rules-screen' }, card(null, h('p', { class: 'muted' }, t('ui.loading'))));
  root.append(body);
  const sheet = h('div', { class: 'rules-sheet' });
  const stageCanvas = h('canvas', { class: 'arc-stage', width: 960, height: 400 });
  const legend = h('div', { class: 'arc-legend' });
  const result = h('div', { class: 'rules-result' });
  const saveBtn = h('button', { type: 'button', class: 'pill', title: t('rules.save_new_help') }, icon('check'), t('rules.save_new'));
  const applyBtn = h('button', { type: 'button', class: 'pill primary big', title: t('rules.apply_all_help') }, icon('retry'), t('rules.apply_all'));
  const resetBtn = h('button', { type: 'button', class: 'pill' }, icon('undo'), t('rules.reset'));
  const sheetNote = h('div', { class: 'sheet-note small' });
  const scanIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  let stopAudition: (() => void) | null = null;

  const load = async (): Promise<void> => {
    try {
      const [g, r] = await Promise.all([api.game(gameId), api.rules(gameId).catch(() => null)]);
      game = g;
      saved = withDefaults(r ?? g.rules);
      rules = withDefaults(saved);
    } catch (e) {
      if (!disposed) body.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.not_found'))));
      return;
    }
    if (disposed) return;
    body.replaceChildren(
      card('rules-head', h('div', { class: 'row between wrap' },
        h('div', null,
          h('h1', { class: 'marker-underline' }, t('rules.title', { game: kidText(game.title || t('ui.untitled')) })),
          h('p', { class: 'muted' }, t('rules.help'))),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'pill', onclick: () => void openPdf(`/api/v2/templates/rules.pdf?game=${encodeURIComponent(gameId)}`) }, icon('rules'), t('rules.print')),
          h('button', { type: 'button', class: 'pill', onclick: () => scanIn.click() }, icon('camera'), t('rules.scan')),
          h('a', { class: 'pill', href: `#/game/${encodeURIComponent(gameId)}` }, icon('home'), t('ui.game')))),
        sheetNote, scanIn),
      h('div', { class: 'rules-layout' },
        card('paper-sheet', sheet),
        card('arc-card', h('h3', null, t('rules.mini_stage')), stageCanvas, legend,
          h('div', { class: 'row end wrap' }, resetBtn, saveBtn, applyBtn), result)));
    render();
  };

  function set(patch: Partial<GameRules>, abil?: Partial<Record<Abil, boolean>>): void {
    rules = { ...rules, ...patch, abilities: { ...rules.abilities, ...(abil ?? {}) } };
    result.replaceChildren();
    render();
  }

  // ---- the sheet ---------------------------------------------------------------------------------------------
  function box(label: string, on: boolean, onclick: () => void, o: { sub?: string; radio?: boolean; disabled?: boolean; swatch?: string; thumb?: HTMLElement | null } = {}): HTMLElement {
    return h('button', {
      type: 'button', class: `check-box${on ? ' on' : ''}${o.radio ? ' radio' : ''}${o.thumb ? ' with-thumb' : ''}`, role: o.radio ? 'radio' : 'checkbox', 'aria-checked': String(on),
      disabled: o.disabled, onclick,
    },
    h('span', { class: 'tick', style: o.swatch ? { background: o.swatch } : undefined }, on ? '✓' : ''),
    h('span', { class: 'cb-text' }, h('span', { class: 'cb-label' }, label), o.sub ? h('span', { class: 'cb-sub small muted' }, o.sub) : '', o.thumb ?? ''));
  }

  /** A live paper sample through the real renderer (lane E), or the CSS swatch when the renderer can't. */
  function themeThumb(th: Theme): HTMLElement | null {
    try {
      return themeSwatch(th, 132, { selected: rules.theme === th });
    } catch {
      return null;
    }
  }

  function pickTheme(th: Theme): void {
    set({ theme: th });
    if (rules.music === false) return;
    try {
      stopAudition?.();
      stopAudition = auditionTheme(th);
    } catch {
      stopAudition = null;
    }
  }

  function group(title: string, ...kids: HTMLElement[]): HTMLElement {
    return h('fieldset', { class: 'sheet-group' }, h('legend', null, title), h('div', { class: 'boxes' }, ...kids));
  }

  function render(): void {
    const ab = { ...DEFAULT_RULES.abilities, ...rules.abilities } as Record<Abil, boolean>;
    const profiles: ProfileId[] = rules.physics_profile === 'v1-classic' || saved.physics_profile === 'v1-classic' ? [...PROFILES_SHOWN, 'v1-classic'] : PROFILES_SHOWN;
    const classic = rules.physics_profile === 'v1-classic';
    const lives = rules.lives ?? 'off';
    const dial: Dial = rules.default_dial ?? 'polished';
    sheet.replaceChildren(
      group(t('rules.g_profile'), ...profiles.map((p) => box(t(`rules.profile_${p}`), rules.physics_profile === p, () => set({ physics_profile: p }), { radio: true, sub: t(`rules.profile_${p}_sub`) }))),
      group(t('rules.g_abilities'), ...(['run', 'stomp', 'double_jump', 'fast_fall'] as Abil[]).map((a) =>
        box(t(`rules.ability_${a}`), !!ab[a] && !(a === 'run' && classic), () => set({}, { [a]: !ab[a] }), { sub: t(`rules.ability_${a}_sub`), disabled: a === 'run' && classic }))),
      group(t('rules.g_lives'),
        box(t('rules.lives_off'), lives === 'off', () => set({ lives: 'off' }), { radio: true, sub: t('rules.lives_off_sub') }),
        box(t('rules.lives_n', { n: 3 }), lives === 3, () => set({ lives: 3 }), { radio: true }),
        box(t('rules.lives_n', { n: 5 }), lives === 5, () => set({ lives: 5 }), { radio: true })),
      group(t('rules.g_hearts'), ...[1, 2, 3].map((n) => box(t('rules.hearts_n', { n }), (rules.hearts ?? 1) === n, () => set({ hearts: n }), { radio: true }))),
      group(t('rules.g_theme'), ...THEMES.map((th) => box(t(`rules.theme_${th}`), rules.theme === th, () => pickTheme(th), { radio: true, swatch: THEME_PAPER[th].css, thumb: themeThumb(th) }))),
      group(t('rules.g_more'),
        box(t('rules.music'), rules.music !== false, () => set({ music: rules.music === false })),
        box(t('rules.timer_pressure'), !!rules.timer_pressure, () => set({ timer_pressure: !rules.timer_pressure }), { sub: t('rules.timer_pressure_sub') }),
        box(t('rules.no_backscroll'), rules.camera === 'no_backscroll', () => set({ camera: rules.camera === 'no_backscroll' ? 'follow' : 'no_backscroll' }), { sub: t('rules.no_backscroll_sub') })),
      group(t('rules.g_dial'),
        ...(['faithful', 'polished', 'challenging'] as Dial[]).map((d) => box(t(`dial.${d}`), dial === d, () => set({ default_dial: d }), { radio: true })),
        ...(dial === 'challenging' ? (['normal', 'hard'] as ChallengeBand[]).map((b) => box(t(`band.${b}`), (rules.default_band ?? 'normal') === b, () => set({ default_band: b }), { radio: true })) : [])));
    const dirty = !same(rules, saved);
    saveBtn.disabled = !dirty || busy;
    applyBtn.disabled = busy || !(game?.levels.length);
    resetBtn.disabled = !dirty || busy;
    computeArcs();
  }

  // ---- the mini-stage -------------------------------------------------------------------------------------------
  let arcKey = '';
  function computeArcs(): void {
    const key = `${rules.physics_profile}|${JSON.stringify(rules.abilities)}`;
    if (key === arcKey) return;
    arcKey = key;
    arcs = jumpArcs(rules);
    legend.replaceChildren(...(arcs.length ? arcs.map((a) => h('div', { class: 'arc-row' },
      h('span', { class: 'arc-swatch', style: { background: ARC_COLORS[a.kind] } }),
      h('span', null, t(`rules.arc_${a.kind}`, { high: a.apex, far: a.dist })))) : [h('p', { class: 'muted small' }, t('ui.stage_not_ready'))]));
    startAnim();
  }

  function startAnim(): void {
    cancelAnimationFrame(raf);
    const ctx = stageCanvas.getContext('2d');
    if (!ctx) return;
    const reduce = prefersReducedMotion();
    const t0 = performance.now();
    const loop = (now: number): void => {
      if (disposed || !stageCanvas.isConnected) return;
      drawArcs(ctx, reduce ? null : (now - t0) / 1000);
      if (!reduce) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function drawArcs(ctx: CanvasRenderingContext2D, time: number | null): void {
    const Wc = stageCanvas.width;
    const Hc = stageCanvas.height;
    const maxD = Math.max(6, ...arcs.map((a) => a.dist));
    const maxH = Math.max(4, ...arcs.map((a) => a.apex));
    const S = Math.min((Wc - 80) / (maxD + 2), (Hc - 60) / (maxH + 2.2));
    const ox = 50;
    const oy = Hc - 36;
    const X = (x: number): number => ox + x * S;
    const Y = (y: number): number => oy - y * S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = THEME_PAPER[rules.theme ?? 'sketchbook'].base;
    ctx.fillRect(0, 0, Wc, Hc);
    // cell grid with row numbers (squares high) and the floor
    ctx.strokeStyle = 'rgba(31,27,24,0.09)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= maxD + 2; x++) {
      ctx.beginPath();
      ctx.moveTo(X(x), Y(0));
      ctx.lineTo(X(x), Y(maxH + 2));
      ctx.stroke();
    }
    for (let y = 0; y <= maxH + 2; y++) {
      ctx.beginPath();
      ctx.moveTo(X(-1), Y(y));
      ctx.lineTo(X(maxD + 2), Y(y));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(31,27,24,0.45)';
    ctx.font = '15px "Patrick Hand", system-ui, sans-serif';
    for (let y = 1; y <= Math.floor(maxH + 1); y++) ctx.fillText(String(y), 8, Y(y) + 5);
    ctx.strokeStyle = ART.palette.ink;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(X(-1), Y(0) + 2);
    ctx.lineTo(X(maxD + 2), Y(0) + 2);
    ctx.stroke();
    // arcs
    for (const a of arcs) {
      ctx.strokeStyle = ARC_COLORS[a.kind];
      ctx.lineWidth = 3;
      ctx.setLineDash(a.kind === 'double' ? [8, 6] : []);
      ctx.beginPath();
      a.pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.stroke();
      ctx.setLineDash([]);
      const top = a.pts.reduce((m, p) => (p[1] > m[1] ? p : m), a.pts[0]);
      ctx.fillStyle = ARC_COLORS[a.kind];
      ctx.beginPath();
      ctx.arc(X(top[0]), Y(top[1]), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    // a pencil stick figure rides one arc after another
    if (time !== null && arcs.length) {
      const total = arcs.reduce((s, a) => s + a.frames / 60 + 0.5, 0);
      let tt = time % total;
      for (const a of arcs) {
        const dur = a.frames / 60 + 0.5;
        if (tt > dur) {
          tt -= dur;
          continue;
        }
        const f = Math.min(a.pts.length - 1, Math.floor(Math.max(0, tt - 0.25) * 60));
        const [x, y] = a.pts[f];
        stick(ctx, X(x), Y(y), S, ARC_COLORS[a.kind]);
        break;
      }
    } else if (arcs.length) stick(ctx, X(0), Y(0), S, ART.palette.pencil_violet);
  }

  function stick(ctx: CanvasRenderingContext2D, x: number, y: number, S: number, color: string): void {
    const hgt = 1.75 * S;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, S * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y - hgt + S * 0.27, S * 0.25, 0, Math.PI * 2);
    ctx.moveTo(x, y - hgt + S * 0.52);
    ctx.lineTo(x, y - S * 0.6);
    ctx.lineTo(x + S * 0.3, y);
    ctx.moveTo(x, y - S * 0.6);
    ctx.lineTo(x - S * 0.3, y);
    ctx.moveTo(x - S * 0.32, y - hgt * 0.55);
    ctx.lineTo(x + S * 0.32, y - hgt * 0.55);
    ctx.stroke();
    ctx.restore();
  }

  // ---- save: check the game, list what breaks, block unless repaired ----------------------------------------------------
  function dryLevels(): DryLevel[] {
    return (game?.levels ?? []).filter((l) => l.level).map((l) => ({ id: l.id, title: l.title || t('ui.untitled'), level: l.level! }));
  }

  async function check(repair: boolean): Promise<DryRow[] | null> {
    const levels = dryLevels();
    try {
      // the server's check includes the designer's Faithful repairs per level when it ran them
      const affected = await api.rulesCheck(gameId, rules);
      const titles = new Map(levels.map((l) => [l.id, l.title]));
      const withRepairs = affected.length > 0 && affected.every((a) => typeof a.repairable === 'boolean');
      if (!repair || withRepairs) {
        return affected.map((a) => ({
          level_id: a.level_id, title: titles.get(a.level_id) ?? a.level_id, before: true, after: false, reason_key: a.reason_key,
          repairs: (a.repairs ?? []).filter((e) => e.reason_key).map((e) => ({ key: e.reason_key, args: e.reason_args ?? {} })),
          repaired: withRepairs ? a.repairable ?? false : null, skipped: false,
        }));
      }
    } catch (e) {
      if (!(e instanceof ApiError) || ![0, 404, 405, 501, 503].includes(e.status)) throw e;
    }
    if (!levels.length) return [];
    try {
      const rows = await coreClient().rulesCheck({ levels, rules, repair });
      return rows.filter((r) => r.reason_key);
    } catch (e) {
      result.replaceChildren(h('p', { class: 'warn' }, t(e instanceof CoreError && e.notImplemented ? 'rules.cant_check' : 'error.build_failed')));
      return null;
    }
  }

  async function put(apply: 'none' | 'all', repair: boolean): Promise<void> {
    busy = true;
    render();
    try {
      const out = await api.putRules(gameId, { ...rules, version: saved.version }, { apply, repair });
      saved = withDefaults(out.rules ?? { ...rules, version: saved.version + 1 });
      rules = withDefaults(saved);
      const msg = apply === 'all' ? t('rules.applied', { v: saved.version, n: out.applied }) : t('rules.saved', { v: saved.version });
      result.replaceChildren(h('p', { class: 'ok' }, msg), out.failed ? h('p', { class: 'warn small' }, t('rules.some_failed', { n: out.failed })) : '');
      toast(msg);
    } catch (e) {
      if (e instanceof ApiError && e.messageKey === 'rules.blocked') {
        // the server's own dry run found levels that break: list them
        const titles = new Map(dryLevels().map((l) => [l.id, l.title]));
        const aff = ((e.body as { affected?: { level_id: string; reason_key?: string; x_title?: string }[] } | null)?.affected ?? []);
        showAffected(aff.map((a) => ({ level_id: a.level_id, title: a.x_title ?? titles.get(a.level_id) ?? a.level_id, before: true, after: false, reason_key: a.reason_key ?? 'rules.becomes_unsolvable', repairs: [], repaired: null, skipped: false })), false);
      } else result.replaceChildren(h('p', { class: 'warn' }, t(e instanceof ApiError ? e.messageKey : 'error.network', e instanceof ApiError ? e.args : {})));
    } finally {
      busy = false;
      render();
    }
  }

  function showAffected(rows: DryRow[], repaired: boolean): void {
    const all = rows.every((r) => r.repaired);
    result.replaceChildren(card('affected',
      h('h3', { class: 'warn' }, t('rules.blocked', { n: rows.length })),
      h('ul', { class: 'dry-list' }, ...rows.map((r) => h('li', { class: r.repaired ? 'ok' : 'bad' },
        h('span', { class: 'mark' }, r.repaired ? '🔧' : '✗'), ' ',
        h('a', { href: `#/play/${encodeURIComponent(r.level_id)}`, target: '_blank' }, kidText(r.title)), ' ',
        h('span', { class: 'small' }, t(r.reason_key ?? 'rules.becomes_unsolvable')),
        repaired ? h('div', { class: 'small muted' },
          r.skipped ? t('rules.repair_no_ink') : r.repaired ? t('rules.repair_ok') : t('rules.repair_fails'),
          ...r.repairs.slice(0, 4).map((m) => h('div', { class: 'small' }, `• ${tRef(m)}`))) : ''))),
      h('div', { class: 'row end wrap' },
        h('button', { type: 'button', class: 'pill', onclick: () => { rules = withDefaults(saved); result.replaceChildren(); render(); } }, t('ui.cancel')),
        !repaired ? h('button', { type: 'button', class: 'pill accent', onclick: () => void runRepair() }, icon('pencil'), t('rules.let_designer_fix')) : '',
        repaired && all ? h('button', { type: 'button', class: 'pill primary', onclick: () => void put('all', true) }, icon('check'), t('rules.save_and_fix')) : '')));
  }

  async function runRepair(): Promise<void> {
    busy = true;
    render();
    result.replaceChildren(h('p', { class: 'muted' }, t('rules.repairing')));
    const rows = await check(true).catch(() => null);
    busy = false;
    render();
    if (rows) showAffected(rows, true);
  }

  saveBtn.onclick = () => void put('none', false);

  applyBtn.onclick = async () => {
    busy = true;
    render();
    result.replaceChildren(h('p', { class: 'muted' }, t('rules.checking', { n: dryLevels().length })));
    let rows: DryRow[] | null = null;
    try {
      rows = await check(false);
    } catch (e) {
      result.replaceChildren(h('p', { class: 'warn' }, t(e instanceof ApiError ? e.messageKey : 'error.network')));
    }
    busy = false;
    render();
    if (!rows) return;
    if (!rows.length) await put('all', false);
    else showAffected(rows, rows.every((r) => r.repaired !== null));
  };

  // ---- a paper Rules Sheet: its ticks fill the boxes (the kid reviews, then saves) ---------------------------------
  scanIn.onchange = async () => {
    const f = scanIn.files?.[0];
    scanIn.value = '';
    if (!f) return;
    sheetNote.replaceChildren(h('span', { class: 'muted' }, t('rules.scan_reading')));
    try {
      const r = await api.scanRulesSheet(f);
      if (r.game_id && r.game_id !== gameId) {
        sheetNote.replaceChildren(h('span', { class: 'warn' }, t('rules.scan_other_game')));
        return;
      }
      const patch = r.patch as Partial<GameRules>;
      const abil = (patch.abilities ?? {}) as Partial<Record<Abil, boolean>>;
      const rest: Partial<GameRules> = { ...patch };
      delete rest.abilities;
      delete rest.version;
      set(rest, abil);
      const changed = Object.keys(rest).length + Object.keys(abil).length;
      sheetNote.replaceChildren(
        h('p', { class: 'ok' }, t(changed ? 'rules.scan_done' : 'warning.rules_nothing_ticked', { n: changed })),
        r.story ? h('p', { class: 'pencil-text' }, t('rules.scan_story', { story: kidText(r.story) })) : '',
        ...r.asks.map((m) => h('p', { class: 'ask-line' }, icon('question'), ' ', t(m.key, m.args ?? {}))),
        ...r.warnings.map((m) => h('p', { class: 'small warn' }, t(m.key, m.args ?? {}))));
    } catch (e) {
      sheetNote.replaceChildren(h('span', { class: 'warn' }, t(e instanceof ApiError ? e.messageKey : 'error.upload_failed', e instanceof ApiError ? e.args : {})));
    }
  };
  resetBtn.onclick = () => {
    rules = withDefaults(saved);
    result.replaceChildren();
    render();
  };

  void load();
  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    stopAudition?.();
  };
}
