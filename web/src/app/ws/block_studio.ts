/**
 * #/blocks/new and #/blocks/:id — the Block Studio (docs/v4/CONTRACTS_V4.md §5, §6, §7). Draw the block on the
 * Creature Studio's pad (editor/creature.ts inkPad), name it, describe it in words → POST /blocks/describe → an
 * editable draft: kind, what it does (behaviour chips with simple parameters), solid or not, spiky, rule cards, and the
 * words it could not use shown honestly. Optional: a paper symbol (three small cells), a description and tags.
 * Publish → POST /blocks (new or remix, `?from=<id>`) or POST /blocks/{id}/versions (your own block). With `?game=<id>`
 * the finished block can go straight into that game. Publishing needs a player (identity.ts).
 * Offline (or before lane C's describe route answers), the creature keyword reader and the core rule parser fill in
 * what they can.
 */
import type { Behavior, BlockCard, BlockCreate, BlockDescribeResult, BlockKind, Dir4, PickupEffect, RuleV4, ZoneEffect } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { ARCHETYPES, chipsOfBehavior, creatureBehavior, readCreature, type CreatureArchetype } from '../creature_words.ts';
import { h, icon } from '../dom.ts';
import { currentPlayer, ensurePlayer } from '../identity.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { v4 } from '../v4api.ts';
import type { Speed } from '../../editor/chips.ts';
import { artOf, inkPad, symbolCells } from '../../editor/creature.ts';
import { CreatureStage } from '../../editor/creature_stage.ts';
import { addBlockTo } from './blocks.ts';
import { parseExtras, parseRules, ruleCard } from './logic.ts';
import {
  BEHAVIOURS, BLOCK_KINDS, behaviourText, collisionFor, defaultBehaviour, parseTags, withFreshIds, type BehaviourKind,
} from './model.ts';
import { btn, calm, chip, emptyState, enc, note, pickRow } from './ui.ts';

const NAME_MAX = 24;
const DESC_MAX = 300;
const ENEMY_ARCH = ARCHETYPES.filter((a) => a !== 'static') as Exclude<CreatureArchetype, 'static'>[];
const ARCH_KEY: Record<Exclude<CreatureArchetype, 'static'>, string> = {
  walker: 'chip.walks', hopper: 'chip.hops', flyer: 'chip.flies', shooter: 'chip.shoots', chaser: 'chip.chases', crusher: 'chip.crushes',
};
const ZONES: ZoneEffect[] = ['wind', 'water', 'ice', 'low_gravity', 'conveyor', 'slow'];
const PICKUPS: PickupEffect[] = ['none', 'speed', 'jump', 'flip', 'heart', 'score', 'freeze', 'low_gravity'];
const DIRS: Dir4[] = ['left', 'right', 'up', 'down'];

type Mode = 'new' | 'version' | 'remix';

export function blockStudioScreen(root: HTMLElement, blockId: string | null, query: URLSearchParams): () => void {
  let disposed = false;
  let cleanup: (() => void) | null = null;
  const gameId = query.get('game');
  const fromId = query.get('from');
  const page = h('div', { class: 'w-page bs-page' }, note(t('ui.loading'), 'muted'));
  root.append(page);

  void (async () => {
    try {
      await ensurePlayer();
    } catch {
      if (!disposed) page.replaceChildren(emptyState(t('studio4.need_player'), btn(t('studio4.who'), { cls: 'primary small', icon: 'person', onclick: () => navigate(location.hash) })));
      return;
    }
    let base: BlockCard | null = null;
    const id = blockId ?? fromId;
    if (id) {
      try {
        base = await v4.block(id);
      } catch (e) {
        if (!disposed) page.replaceChildren(emptyState(calm(e, 'blocks.not_ready'), btn(t('blocks.title'), { href: '#/blocks', cls: 'small' })));
        return;
      }
    }
    if (disposed) return;
    const me = currentPlayer();
    const mode: Mode = blockId && base ? (base.author_id && me && base.author_id === me.id ? 'version' : 'remix') : base ? 'remix' : 'new';
    cleanup = mountStudio(page, base, mode, gameId, () => disposed);
  })();

  return () => {
    disposed = true;
    cleanup?.();
  };
}

function mountStudio(page: HTMLElement, base: BlockCard | null, mode: Mode, gameId: string | null, gone: () => boolean): () => void {
  // ---- state ----
  let kind: BlockKind = base?.kind ?? 'creature';
  let behavior: Behavior | null = base ? base.behavior ?? null : defaultBehaviour('enemy');
  const fromChips = chipsOfBehavior(behavior);
  let speed: Speed = fromChips?.speed ?? 'normal';
  let spiky = base?.spiky ?? false;
  let collision: 'solid' | 'one_way' | 'none' = base?.collision ?? collisionFor(behavior);
  let logic: RuleV4[] = base?.logic?.slice() ?? [];
  let read: { summary: string; unknown: string[]; source: 'model' | 'keywords' } | null = null;
  let busy = false;
  let gameTitle = '';

  // ---- drawing ----
  const stage = new CreatureStage(512);
  const ink = inkPad({ strokes: base?.art?.strokes ?? [], onChange: () => syncStage() });
  const symbol = symbolCells({ symbol: base?.symbol ?? null });
  const onKey = (e: KeyboardEvent): void => {
    ink.undoKey(e);
  };
  window.addEventListener('keydown', onKey);

  // ---- fields ----
  const nameIn = h('input', {
    type: 'text', maxLength: NAME_MAX, value: base ? (mode === 'remix' ? kidText(base.name).slice(0, NAME_MAX) : base.name) : '',
    placeholder: t('studio4.name_placeholder'), required: true,
  });
  const words = h('textarea', { rows: 3, maxLength: 300, placeholder: t('studio4.describe_placeholder') });
  const readBtn = btn(t('studio4.read'), { icon: 'question', cls: 'small' }) as HTMLButtonElement;
  const readOut = h('div', { class: 'bs-read', 'aria-live': 'polite' });
  const desc = h('textarea', { rows: 2, maxLength: DESC_MAX, placeholder: t('studio4.description_placeholder'), value: base?.description ?? '' });
  const tags = h('input', { type: 'text', maxLength: 200, placeholder: t('studio4.tags_placeholder'), value: (base?.tags ?? []).join(', ') });
  const result = h('div', { class: 'bs-result' });
  const stageBox = h('div', { class: 'bs-stage' }, h('h3', { class: 'w-h4' }, t('creature.watch')), stage.canvas);
  const status = h('p', { class: 'small muted', role: 'status' });
  const publish = btn(t(mode === 'version' ? 'studio4.publish_version' : 'studio4.publish'), { cls: 'primary', icon: 'check' }) as HTMLButtonElement;
  const ruleIn = h('input', { type: 'text', class: 'w-input', maxLength: 160, placeholder: t('gw.rule_placeholder'), 'aria-label': t('studio4.rule_add') });
  const ruleForm = h('form', { class: 'w-inline' }, ruleIn, btn(t('ui.add'), { type: 'submit', cls: 'small', icon: 'plus' }));
  const ruleOut = h('div', { class: 'w-rule-cards', 'aria-live': 'polite' });
  const field = (label: string, input: HTMLElement, hint?: string): HTMLElement =>
    h('label', { class: 'w-field' }, h('span', null, label), input, hint ? h('span', { class: 'small muted' }, hint) : '');

  const title = mode === 'version' ? t('studio4.title_version', { name: kidText(base!.name) })
    : mode === 'remix' ? t('studio4.title_remix', { name: kidText(base!.name) }) : t('studio4.title');
  page.replaceChildren(
    h('div', { class: 'w-head' },
      h('div', { class: 'w-head-text' },
        h('div', { class: 'w-crumbs' }, h('a', { href: gameId ? `#/blocks?game=${enc(gameId)}` : '#/blocks' }, t('blocks.title')), ' › ', title),
        h('h1', { class: 'w-h1' }, title),
        h('p', { class: 'w-sub' }, mode === 'remix' && base ? t('studio4.sub_remix', { author: base.author || t('ui.someone') }) : t('studio4.sub')))),
    h('div', { class: 'bs' },
      h('section', { class: 'w-card bs-draw', 'aria-label': t('studio4.draw') },
        h('h2', { class: 'w-h3' }, t('studio4.draw')),
        h('p', { class: 'small muted' }, t('studio4.draw_help')),
        ink.toolrow, ink.pad.canvas,
        symbol.el),
      h('section', { class: 'w-card', 'aria-label': t('studio4.about') },
        field(t('studio4.name'), nameIn),
        h('div', { class: 'w-field' }, h('span', null, t('studio4.describe')), words, h('div', { class: 'row wrap' }, readBtn, h('span', { class: 'small muted' }, t('studio4.describe_help')))),
        readOut,
        result,
        h('h3', { class: 'w-h4' }, t('studio4.rules')),
        h('p', { class: 'small muted' }, t('studio4.rules_help')),
        ruleOut, ruleForm,
        stageBox,
        field(t('studio4.description'), desc),
        field(t('studio4.tags'), tags, t('studio4.tags_help')),
        status,
        h('div', { class: 'bs-actions' }, btn(t('ui.cancel'), { href: gameId ? `#/game/${enc(gameId)}?tab=blocks` : '#/blocks' }), publish))));

  if (gameId) api.game(gameId).then((g) => { gameTitle = g.title; }, () => undefined);

  // ---- the editable draft ----
  function setBehaviour(b: Behavior | null): void {
    behavior = b;
    collision = collisionFor(b);
    if (b?.kind === 'enemy') spiky = !!b.spiky || spiky;
    renderResult();
  }

  function renderResult(): void {
    const kids: (HTMLElement | string)[] = [
      h('h3', { class: 'w-h4' }, t('studio4.kind')),
      pickRow(BLOCK_KINDS, kind, (k) => t(`blocks.kind_${k}`), (k) => {
        kind = k;
        if (k === 'rules') behavior = null;
        else if (!behavior) setBehaviour(defaultBehaviour(k === 'creature' ? 'enemy' : k === 'pickup' ? 'pickup' : k === 'platform' ? 'move' : k === 'hazard' ? 'saw' : 'static'));
        renderResult();
      }, { name: t('studio4.kind') }),
    ];
    if (kind !== 'rules') {
      kids.push(
        h('h3', { class: 'w-h4' }, t('studio4.does')),
        pickRow<BehaviourKind>(BEHAVIOURS, behavior?.kind ?? null, (b) => t(`studio4.beh_${b}`), (b) => {
          if (behavior?.kind !== b) setBehaviour(defaultBehaviour(b, t('studio4.npc_default')));
        }, { name: t('studio4.does') }),
        params(),
        h('h3', { class: 'w-h4' }, t('studio4.solid')),
        pickRow<'solid' | 'one_way' | 'none'>(['solid', 'one_way', 'none'], collision, (c) => t(`blocks.collision_${c}`), (c) => { collision = c; renderResult(); }, { name: t('studio4.solid') }),
        h('div', { class: 'w-picks' }, h('button', {
          type: 'button', class: `w-pick${spiky ? ' on' : ''}`, 'aria-pressed': String(spiky),
          onclick: () => {
            spiky = !spiky;
            if (behavior?.kind === 'enemy') behavior = { ...behavior, spiky };
            renderResult();
          },
        }, t('creature.spiky'))));
    }
    const does = behaviourText(kind === 'rules' ? null : behavior);
    if (does) kids.push(h('p', { class: 'small' }, t('studio4.so_far', { what: does })));
    result.replaceChildren(...kids);
    stageBox.classList.toggle('hidden', !(kind === 'creature' && (behavior?.kind === 'enemy' || behavior?.kind === 'static')));
    renderRules();
    syncStage();
  }

  /** Simple chips for the behaviour's numbers (speed, direction, distance, effect, lines). */
  function params(): HTMLElement {
    const b = behavior;
    const box = h('div', { class: 'bs-param' });
    if (!b) return box;
    const row = (label: string, el: HTMLElement): void => {
      box.append(h('span', { class: 'small muted' }, label), el);
    };
    if (b.kind === 'enemy') {
      row(t('creature.does'), pickRow(ENEMY_ARCH, b.archetype, (a) => t(ARCH_KEY[a]), (a) => setBehaviour(creatureBehavior(a, speed, spiky))));
      row(t('chip.speed'), pickRow<Speed>(['slow', 'normal', 'fast'], speed, (s) => t(`chip.speed_${s}`), (s) => { speed = s; setBehaviour(creatureBehavior(b.archetype, s, spiky)); }));
    } else if (b.kind === 'move') {
      row(t('studio4.which_way'), pickRow(DIRS, b.dir, (d) => t(`studio4.dir_${d}`), (d) => setBehaviour({ ...b, dir: d })));
      row(t('chip.distance'), pickRow(['3', '6', '9', '12'], String(b.cells), (c) => t('studio4.cells', { n: Number(c) }), (c) => setBehaviour({ ...b, cells: Number(c) })));
    } else if (b.kind === 'spring') {
      row(t('studio4.which_way'), pickRow<'up' | 'left' | 'right'>(['up', 'left', 'right'], b.dir ?? 'up', (d) => t(`studio4.dir_${d}`), (d) => setBehaviour({ ...b, dir: d })));
    } else if (b.kind === 'zone') {
      row(t('studio4.zone'), pickRow(ZONES, b.effect, (z) => t(`studio4.zone_${z}`), (z) => setBehaviour({ ...b, effect: z })));
      if (b.effect === 'wind' || b.effect === 'conveyor') row(t('studio4.which_way'), pickRow(DIRS, b.dir ?? 'right', (d) => t(`studio4.dir_${d}`), (d) => setBehaviour({ ...b, dir: d })));
    } else if (b.kind === 'pickup') {
      row(t('studio4.pickup_does'), pickRow(PICKUPS, b.effect ?? 'none', (p) => t(`studio4.pickup_${p}`), (p) => setBehaviour({ ...b, effect: p })));
      const item = h('input', { type: 'text', class: 'w-input', maxLength: 16, value: b.item ?? '', placeholder: t('studio4.item_placeholder'), 'aria-label': t('studio4.item') });
      item.onchange = () => { behavior = { ...b, item: item.value.trim().toLowerCase().slice(0, 16) || 'star' }; };
      row(t('studio4.item'), item);
    } else if (b.kind === 'portal') {
      const pair = h('input', { type: 'text', class: 'w-input', maxLength: 12, value: b.pair ?? 'a', 'aria-label': t('studio4.portal_pair') });
      pair.onchange = () => { behavior = { ...b, pair: pair.value.trim().slice(0, 12) || 'a' }; };
      row(t('studio4.portal_pair'), pair);
      box.append(note(t('studio4.portal_help')));
    } else if (b.kind === 'npc') {
      const lines = h('textarea', { rows: 3, class: 'w-input', maxLength: 480, value: b.lines.join('\n'), 'aria-label': t('studio4.npc_lines') });
      lines.onchange = () => {
        const ls = lines.value.split('\n').map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 6);
        behavior = { ...b, lines: (ls.length ? ls : [t('studio4.npc_default')]) as typeof b.lines };
      };
      row(t('studio4.npc_lines'), lines);
    }
    return box;
  }

  function renderRules(): void {
    ruleOut.replaceChildren(...(logic.length
      ? logic.map((r) => ruleCard(r, { onDelete: () => { logic = logic.filter((x) => x.id !== r.id); renderRules(); } }))
      : [note(t(kind === 'rules' ? 'studio4.rules_needed' : 'studio4.rules_none'))]));
  }

  function syncStage(): void {
    if (kind === 'creature' && behavior && (behavior.kind === 'enemy' || behavior.kind === 'static')) stage.set(ink.pad.value, behavior, spiky);
  }

  // ---- words → a draft ----
  function applyRead(r: BlockDescribeResult): void {
    kind = r.kind;
    behavior = r.kind === 'rules' ? null : r.behavior ?? defaultBehaviour(r.kind === 'creature' ? 'enemy' : 'static');
    speed = chipsOfBehavior(behavior)?.speed ?? 'normal';
    spiky = r.spiky;
    collision = r.collision;
    if (r.logic.length) logic = [...logic, ...withFreshIds(logic, r.logic, 'r')];
    read = { summary: r.summary, unknown: r.unknown, source: r.source };
    renderRead();
    renderResult();
  }

  function renderRead(): void {
    if (!read) {
      readOut.replaceChildren();
      return;
    }
    readOut.replaceChildren(
      h('div', { class: 'w-note' }, read.summary ? kidText(read.summary) : t('studio4.read_done'), ' ',
        chip(t(read.source === 'model' ? 'studio4.read_model' : 'studio4.read_keywords'), 'plain')),
      ...read.unknown.map((u) => h('div', { class: 'w-rule-note unknown' }, icon('question'), h('span', null, t('studio4.unknown', { text: kidText(u) })))));
  }

  readBtn.onclick = async () => {
    const text = words.value.trim();
    if (!text) {
      words.focus();
      return;
    }
    readBtn.disabled = true;
    readOut.replaceChildren(note(t('studio4.reading')));
    try {
      const r = await v4.describeBlock({ name: nameIn.value.trim() || t('studio4.name_placeholder'), text, ink: ink.pad.value });
      if (gone()) return;
      applyRead(r);
    } catch {
      if (gone()) return;
      await readOffline(text);
    } finally {
      readBtn.disabled = false;
    }
  };

  /** The describe route is not there: the creature keywords and the core rule parser do what they can. */
  async function readOffline(text: string): Promise<void> {
    const c = readCreature(nameIn.value, text);
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    const parsed = await parseRules(sentences, { prefer: 'local' }).catch(() => null);
    if (gone()) return;
    // sentences the creature reader understood are not "unknown"
    if (parsed) parsed.unknown = parsed.unknown.filter((u) => !readCreature('', u).matched);
    const ruleCount = parsed?.rules.length ?? 0;
    if (!c.matched && !ruleCount) {
      read = null;
      readOut.replaceChildren(h('p', { class: 'w-note' }, t('studio4.read_offline_nothing')));
      return;
    }
    applyRead({
      kind: c.matched ? 'creature' : ruleCount ? 'rules' : kind,
      behavior: c.matched ? creatureBehavior(c.archetype, c.speed, c.spiky) : null,
      spiky: c.spiky, collision: 'none', logic: parsed?.rules ?? [], summary: '', unknown: parsed?.unknown ?? [], source: 'keywords',
    });
  }

  ruleForm.onsubmit = async (e) => {
    e.preventDefault();
    const text = ruleIn.value.trim();
    if (!text) return;
    ruleOut.append(note(t('gw.rule_reading')));
    try {
      const r = await parseRules([text], { prefer: 'server' });
      if (gone()) return;
      if (r.rules.length) {
        logic = [...logic, ...withFreshIds(logic, r.rules, 'r')];
        ruleIn.value = '';
      }
      renderRules();
      ruleOut.append(...parseExtras({ ...r, mode: null }), r.rules.length ? '' : note(t('gw.rule_nothing')));
    } catch (err) {
      if (!gone()) {
        renderRules();
        ruleOut.append(h('p', { class: 'w-note warn' }, calm(err, 'gw.rule_parser_not_ready')));
      }
    }
  };
  words.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) readBtn.click();
  };

  // ---- publish ----
  publish.onclick = async () => {
    if (busy) return;
    const name = kidText(nameIn.value.trim()).slice(0, NAME_MAX);
    const strokes = ink.pad.value;
    const need = !name ? 'studio4.need_name' : kind !== 'rules' && !strokes.length ? 'studio4.need_drawing'
      : kind !== 'rules' && !behavior ? 'studio4.need_behaviour' : kind === 'rules' && !logic.length ? 'studio4.rules_needed' : null;
    if (need) {
      status.textContent = t(need);
      if (!name) nameIn.focus();
      return;
    }
    const body: BlockCreate = {
      name, kind,
      behavior: kind === 'rules' ? null : behavior,
      spiky: kind === 'rules' ? false : spiky,
      collision: kind === 'rules' ? 'none' : collision,
      art: strokes.length ? artOf(strokes) : null,
      symbol: symbol.value(),
      logic,
      description: desc.value.trim().slice(0, DESC_MAX) || null,
      tags: parseTags(tags.value) as BlockCreate['tags'],
      parent: mode === 'remix' && base ? { block_id: base.id, version: base.version } : mode === 'version' ? base?.parent ?? null : null,
    };
    busy = true;
    publish.disabled = true;
    status.textContent = t('studio4.publishing');
    try {
      const card = mode === 'version' && base ? await v4.newBlockVersion(base.id, body) : await v4.createBlock(body);
      if (gone()) return;
      done(card);
    } catch (e) {
      status.textContent = calm(e, 'blocks.not_ready');
      busy = false;
      publish.disabled = false;
    }
  };

  function done(card: BlockCard): void {
    stage.stop();
    const gid = gameId;
    const add = gid ? btn(t('blocks.add_to', { game: kidText(gameTitle || t('ui.untitled')) }), {
      cls: 'primary', icon: 'plus',
      onclick: async (e) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        if (await addBlockTo(card, { id: gid, title: gameTitle })) navigate(`#/game/${enc(gid)}?tab=blocks`);
        else b.disabled = false;
      },
    }) : '';
    page.replaceChildren(h('div', { class: 'w-card bs-done' },
      h('h1', { class: 'w-h1' }, t('studio4.published', { name: kidText(card.name) })),
      h('p', { class: 'w-sub' }, t('blocks.version_n', { v: card.version }), ' · ', t('studio4.published_help')),
      h('div', { class: 'row wrap', style: { marginTop: '14px' } },
        add,
        btn(t('studio4.see_in_library'), { href: `#/blocks?open=${enc(card.id)}${gid ? `&game=${enc(gid)}` : ''}`, icon: 'star' }),
        btn(t('studio4.make_another'), { icon: 'plus', onclick: () => navigate(`#/blocks/new${gid ? `?game=${enc(gid)}` : ''}`) }))));
  }

  renderResult();
  stage.start();
  if (!base) nameIn.focus({ preventScroll: true });

  return () => {
    stage.stop();
    window.removeEventListener('keydown', onKey);
  };
}
