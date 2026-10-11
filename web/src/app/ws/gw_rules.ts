/**
 * The workspace's Rules tab (docs/v4/CONTRACTS_V4.md §2, §3): the game mode (GameRules.mode), the game-wide rule cards
 * (GameRules.logic) with switch off and delete, and "write a rule": words → POST /logic/parse (or the core parser) →
 * preview cards → added to GameRules.logic with fresh ids. Everything saves with PUT /games/{id}/rules.
 */
import type { GameMode, GameRules, LogicParseResult, RuleV4 } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { h, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import type { GwCtx } from './gw_ctx.ts';
import { parked, parseExtras, parseRules, ruleCard } from './logic.ts';
import { MODES, withFreshIds } from './model.ts';
import { btn, calm, enc, modeName, note, pickRow } from './ui.ts';

export function rulesPanel(ctx: GwCtx, panel: HTMLElement): void {
  const gameId = ctx.game.id;
  const status = h('p', { class: 'small muted', role: 'status' });
  let busy = false;

  async function save(next: GameRules, done: string): Promise<boolean> {
    if (busy) return false;
    busy = true;
    status.textContent = t('ui.saving');
    try {
      const r = await api.putRules(gameId, next);
      if (ctx.gone()) return false;
      ctx.setRules(r.rules ?? next);
      status.textContent = '';
      toast(done);
      return true;
    } catch (e) {
      status.textContent = calm(e);
      return false;
    } finally {
      busy = false;
    }
  }

  // ---- mode ----
  const modeBox = h('div');
  const renderMode = (): void => {
    const cur: GameMode = ctx.rules().mode ?? 'platformer';
    modeBox.replaceChildren(
      h('h3', { class: 'w-h4' }, t('gw.mode_title')),
      pickRow(MODES, cur, modeName, (m) => void setMode(m), { name: t('gw.mode_title') }),
      note(t(`gw.mode.${cur}_sub`)),
      note(t('gw.mode_note')));
  };
  async function setMode(m: GameMode): Promise<void> {
    if ((ctx.rules().mode ?? 'platformer') === m) return;
    if (await save({ ...ctx.rules(), mode: m }, t('gw.mode_saved', { mode: modeName(m) }))) {
      renderMode();
    }
  }

  // ---- the game's rules ----
  const list = h('div', { class: 'w-rule-cards' });
  const fromBlock = (r: RuleV4): string | null => {
    const lt = ctx.library().find((x) => x.block && r.id.startsWith(`${x.block.block_id}_`));
    return lt ? t('gw.rule_from_block', { name: kidText(lt.name) }) : null;
  };
  const renderList = (): void => {
    const on = ctx.rules().logic ?? [];
    const off = parked.get(gameId);
    list.replaceChildren(...(on.length || off.length ? [
      ...on.map((r) => ruleCard(r, { from: fromBlock(r), onToggle: () => void switchOff(r), onDelete: () => void remove(r) })),
      ...off.map((r) => ruleCard(r, { off: true, from: fromBlock(r), onToggle: () => void switchOn(r), onDelete: () => forget(r) })),
    ] : [note(t('gw.rules_empty'))]));
  };
  async function switchOff(r: RuleV4): Promise<void> {
    const rest = (ctx.rules().logic ?? []).filter((x) => x.id !== r.id);
    if (await save({ ...ctx.rules(), logic: rest }, t('gw.rule_off_done'))) {
      parked.set(gameId, [...parked.get(gameId).filter((x) => x.id !== r.id), r]);
      renderList();
    }
  }
  async function switchOn(r: RuleV4): Promise<void> {
    const cur = ctx.rules().logic ?? [];
    const back = cur.some((x) => x.id === r.id) ? withFreshIds(cur, [r]) : [r];
    if (await save({ ...ctx.rules(), logic: [...cur, ...back] }, t('gw.rule_on_done'))) {
      parked.set(gameId, parked.get(gameId).filter((x) => x.id !== r.id));
      renderList();
    }
  }
  async function remove(r: RuleV4): Promise<void> {
    if (!confirm(t('gw.rule_delete_confirm'))) return;
    if (await save({ ...ctx.rules(), logic: (ctx.rules().logic ?? []).filter((x) => x.id !== r.id) }, t('gw.rule_deleted'))) renderList();
  }
  function forget(r: RuleV4): void {
    parked.set(gameId, parked.get(gameId).filter((x) => x.id !== r.id));
    renderList();
  }

  // ---- write a rule ----
  const input = h('input', { type: 'text', class: 'w-input', maxLength: 160, placeholder: t('gw.rule_placeholder'), 'aria-label': t('gw.rule_write') });
  const readBtn = btn(t('gw.rule_read'), { icon: 'question', type: 'submit' });
  const preview = h('div', { class: 'w-rule-cards', 'aria-live': 'polite' });
  const form = h('form', { class: 'w-inline' }, input, readBtn);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    (readBtn as HTMLButtonElement).disabled = true;
    preview.replaceChildren(note(t('gw.rule_reading')));
    let r: LogicParseResult;
    try {
      r = await parseRules([text], { gameId, prefer: 'server' });
    } catch (err) {
      if (!ctx.gone()) preview.replaceChildren(h('p', { class: 'w-note warn' }, calm(err, 'gw.rule_parser_not_ready')));
      return;
    } finally {
      (readBtn as HTMLButtonElement).disabled = false;
    }
    if (ctx.gone()) return;
    showPreview(r);
  };
  function showPreview(r: LogicParseResult): void {
    const extras = parseExtras(r, { onMode: (m) => void setMode(m) });
    const add = r.rules.length ? btn(r.rules.length === 1 ? t('gw.rule_add_one') : t('gw.rule_add_n', { n: r.rules.length }), {
      cls: 'primary small', icon: 'plus',
      onclick: async () => {
        const cur = ctx.rules().logic ?? [];
        if (await save({ ...ctx.rules(), logic: [...cur, ...withFreshIds(cur, r.rules)] }, t('gw.rules_added', { n: r.rules.length }))) {
          input.value = '';
          preview.replaceChildren();
          renderList();
        }
      },
    }) : '';
    preview.replaceChildren(
      ...(r.rules.length ? [h('div', { class: 'w-h4' }, t('gw.rule_preview'))] : []),
      ...r.rules.map((x) => ruleCard(x)),
      ...extras,
      r.rules.length || extras.length ? '' : note(t('gw.rule_nothing')),
      h('div', { class: 'row wrap' }, add, r.source === 'model' ? h('span', { class: 'small muted' }, t('gw.rule_read_by_model')) : ''));
  }

  renderMode();
  renderList();
  panel.append(
    modeBox,
    h('h3', { class: 'w-h4' }, t('gw.rules_title')),
    h('p', { class: 'small muted' }, t('gw.rules_help')),
    list,
    h('h3', { class: 'w-h4' }, t('gw.rule_write')),
    form, preview, status,
    h('div', { class: 'row wrap', style: { marginTop: '12px' } },
      btn(t('gw.rules_sheet'), { href: `#/game/${enc(gameId)}/rules`, icon: 'rules', cls: 'small' })),
    note(t('gw.rules_sheet_help')));
}
