import type { GameBrief } from '../../core/types.gen.ts';
import { emptyDoc, type EditorDocData } from '../../editor/doc.ts';
import { createEditor, type EditorHandle } from '../../editor/index.ts';
import { DEFAULT_RULES } from '../rules.ts';
import { api, ApiError } from '../api.ts';
import { collab } from '../collab/api.ts';
import { card, h, icon } from '../dom.ts';
import { creationInk, creationPrompt, GAME_CATEGORIES, type CreationDraft } from '../game-brief.ts';
import { currentPlayer, signIn, usesAuth0 } from '../identity.ts';
import { t } from '../messages.ts';
import { navigate } from '../router.ts';
import { store } from '../store.ts';
import { imagineScreen } from './imagine.ts';
import { graphicsOption, multiplayerOption } from '../graphics-option.ts';

type CreationIntent = { kind: 'game' } | {
  kind: 'level'; gameId: string; gameTitle: string; category: GameBrief['category'];
  append: boolean; levelId?: string;
};

/** Game creation and level creation have explicit, independent draft scopes. */
export function createGameScreen(root: HTMLElement, query = new URLSearchParams()): () => void {
  if (!query.has('from') && !query.has('game')) return creationPage(root, store.creationDraft());
  let disposed = false;
  let cleanup: (() => void) | undefined;
  const from = query.get('from');
  const adding = !from;
  root.append(h('p', { role: 'status' }, t('ui.loading')));
  void (async () => {
    try {
      const original = from ? await api.imaginedGame(from) : null;
      const gameId = query.get('game') ?? original?.game_id;
      if (!gameId || (original?.game_id && original.game_id !== gameId)) throw new ApiError(404, 'error.not_found');
      const game = await api.game(gameId);
      const selected = game.generated_levels?.find(level => level.draft_id === from || level.level_id === original?.level_id || level.level_id === original?.draft_id || level.level_id === query.get('level'));
      const levelId = original?.level_id ?? selected?.level_id ?? (from ? selected?.draft_id : undefined);
      if (from && !levelId) throw new ApiError(404, 'error.not_found');
      const pending = store.levelCreationDraft(gameId, adding ? 'new' : levelId!);
      let doc = pending?.doc ?? (from ? store.draftDoc(from) : null) ?? emptyDoc();
      let prompt = pending?.prompt ?? (from ? doc.imaginationContext : '') ?? '';
      if (from && !pending && !store.draftDoc(from)) {
        const input = await api.imaginedInputs(from);
        prompt = input.prompt;
        doc = emptyDoc({ strokes: input.ink.strokes, screens: input.ink.world.screens,
          character: input.ink.character?.strokes ?? [], imaginationContext: input.prompt,
          rules: input.ink.typed_rules.map((rule, i) => ({ id: `note${i}`, text: rule.text, strokeId: null })) });
      }
      const category = game.generated?.category ?? game.brief?.category ?? 'platformer';
      doc = { ...doc, multiplayer: pending?.doc.multiplayer ?? doc.multiplayer ?? original?.multiplayer ?? selected?.multiplayer ?? game.generated?.multiplayer ?? false, betterGraphics: pending?.doc.betterGraphics ?? doc.betterGraphics ??
        original?.better_graphics ?? selected?.better_graphics ?? game.generated?.better_graphics ?? false };
      if (disposed) return;
      root.replaceChildren();
      cleanup = creationPage(root, { kind: 'level', title: game.title, author: game.author, prompt,
        brief: { category, custom_definition: '', theme: '', gameplay: '', details: '' },
        doc: { ...doc, gameId, parent: null }, gameId }, from ?? '', false,
        { kind: 'level', gameId, gameTitle: game.title, category, append: adding, levelId });
    } catch (error) {
      if (!disposed) root.replaceChildren(h('p', null, t(error instanceof ApiError ? error.messageKey : 'error.network')));
    }
  })();
  return () => { disposed = true; cleanup?.(); };
}

/** This modal only restores a new-game draft; level drafts have their own routes and slots. */
export function openCreateGameModal(onClose?: () => void, initial?: {
  prompt: string; category: GameBrief['category']; sketch?: boolean;
}): () => void {
  const previousFocus = document.activeElement as HTMLElement | null;
  const previousOverflow = document.body.style.overflow;
  let closed = false;
  let cleanup: (() => void) | undefined;
  const content = h('div', { class: 'creation-modal-content' });
  const close = (): void => {
    if (closed) return;
    closed = true;
    cleanup?.();
    document.removeEventListener('keydown', keydown, true);
    backdrop.remove();
    document.body.style.overflow = previousOverflow;
    if (previousFocus?.isConnected) previousFocus.focus();
    onClose?.();
  };
  const dialog = h('div', { class: 'creation-modal-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'creation-modal-title', 'aria-describedby': 'creation-modal-description', tabindex: -1 },
    h('div', { class: 'creation-modal-heading row between' },
      h('div', { class: 'creation-modal-title-group' },
        h('span', { class: 'creation-modal-emblem', 'aria-hidden': 'true' }, icon('pencil')),
        h('div', null, h('span', { class: 'creation-eyebrow' }, 'The Game Factory / Idea desk'),
          h('h2', { id: 'creation-modal-title' }, 'Your game idea'),
          h('p', { id: 'creation-modal-description' }, t('create.intro')))),
      h('button', { class: 'tool', type: 'button', 'aria-label': t('ui.close'), onclick: close }, icon('close'))), content);
  const backdrop = h('div', { class: 'modal-back creation-modal', onclick: (event: Event) => { if (event.target === backdrop) close(); } }, dialog);
  const keydown = (event: KeyboardEvent): void => {
    // Editor subdialogs manage their own keyboard focus until dismissed.
    if (document.querySelector('.modal-back:not(.creation-modal), dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      const targets = [...dialog.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex="0"]')]
        .filter((el) => !el.matches(':disabled') && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
      const first = targets[0]; const last = targets.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  };
  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  const saved = store.creationDraft();
  const draft = initial ? {
    ...(saved ?? { kind: 'game' as const, title: '', author: store.author(), doc: emptyDoc(), gameId: null }),
    prompt: initial.prompt,
    brief: { ...(saved?.brief ?? { custom_definition: '', theme: '', gameplay: '', details: '' }), category: initial.category },
  } : saved;
  if (usesAuth0() && !currentPlayer()) {
    if (draft) store.setCreationDraft(draft);
    dialog.querySelector('#creation-modal-title')!.textContent = t('auth.create_title');
    const login = h('button', { type: 'button', class: 'pill primary big',
      onclick: () => void signIn('/#/create').catch(() => undefined) }, t('auth.sign_in'));
    content.append(card('narrow', h('p', null, t('auth.create_help')), login));
    document.addEventListener('keydown', keydown, true);
    login.focus();
    return close;
  }
  cleanup = creationPage(content, draft, undefined, true, { kind: 'game' }, (draftId) => {
    cleanup?.();
    content.replaceChildren();
    dialog.classList.add('creation-modal-chat');
    dialog.querySelector('#creation-modal-title')!.textContent = t('builder.title');
    dialog.querySelector('#creation-modal-description')!.textContent = 'Watch your world take shape. Keep adding your ideas.';
    cleanup = imagineScreen(content, draftId, { compact: true });
    dialog.querySelector<HTMLTextAreaElement>('.builder-composer textarea')?.focus();
  });
  document.addEventListener('keydown', keydown, true);
  if (initial?.sketch) {
    content.querySelector('.creation-canvas-field')?.scrollIntoView({ block: 'center' });
    content.querySelector<HTMLButtonElement>('.creation-canvas-field button')?.focus();
  } else if (initial) content.querySelector<HTMLTextAreaElement>('#create-prompt')?.focus();
  else if (window.matchMedia('(max-width: 760px)').matches) dialog.querySelector<HTMLButtonElement>('button')?.focus();
  else content.querySelector<HTMLSelectElement>('#create-category')?.focus();
  return close;
}

function creationPage(root: HTMLElement, saved: CreationDraft | null, resumedDraft?: string, compact = false, intent: CreationIntent = { kind: 'game' }, onGenerated?: (draftId: string) => void): () => void {
  const isLevel = intent.kind === 'level';
  const level = isLevel ? intent : undefined;
  const slot = level?.levelId ?? 'new';
  let gameId = level?.gameId ?? (saved?.kind === 'game' ? saved.gameId : null);
  let disposed = false;
  let completed = false;
  let busy = false;
  let editor: EditorHandle | null = null;
  let drawing: EditorDocData = { ...(saved?.doc ?? emptyDoc()), gameId, parent: null };
  if (!isLevel) drawing = { ...drawing, title: '', library: [], keptStatuses: {}, parentStrokes: undefined };
  const category = h('select', { id: 'create-category', class: 'text' },
    ...GAME_CATEGORIES.map((option) => h('option', { value: option.id }, `${option.symbol}  ${t(`create.category.${option.id}`)}`)));
  category.value = level?.category ?? saved?.brief.category ?? 'platformer';
  const prompt = h('textarea', { id: 'create-prompt', class: 'text', rows: 7, required: true, maxLength: 8000,
    placeholder: t('create.prompt_placeholder'), value: creationPrompt(saved) });
  const graphics = graphicsOption(drawing.betterGraphics ?? false, () => save());
  const multiplayer = multiplayerOption(drawing.multiplayer ?? false, () => save());
  const status = h('p', { class: 'creation-status small', role: 'status', 'aria-live': 'polite' });
  const go = h('button', { class: 'pill primary big', type: 'submit' }, icon('plus'), level?.append ? 'Create level' : level?.levelId ? 'Update level' : compact ? 'Make it playable' : t('create.submit'));
  const inputs = h('fieldset', { class: 'creation-inputs' },
    isLevel ? h('p', { class: 'muted small' }, `Game: ${level!.gameTitle} · ${t(`create.category.${level!.category}`)}`) :
      h('div', { class: 'creation-field' }, h('label', { htmlFor: category.id }, t('create.category_label')),
        h('div', { class: 'creation-category-select' }, category, h('span', { 'aria-hidden': 'true' }, '⌄'))),
    h('div', { class: 'creation-field' }, h('label', { htmlFor: prompt.id }, isLevel ? 'Describe this level' : t('create.prompt')), prompt), h('div', { class: 'generation-options' }, graphics.element, multiplayer.element));
  const canvasHost = h('div', { class: 'creation-context-canvas' });
  const liveContext = h('p', { class: 'muted small creation-live-context', role: 'status' });
  const canvasField = h('section', { class: 'creation-canvas-field' },
    h('div', { class: 'creation-section-heading' }, h('h2', null, icon('pencil'), t('create.canvas')),
      h('span', { class: 'creation-optional' }, 'Optional')),
    h('p', { class: 'muted small' }, isLevel ? 'Sketch this level’s layout. Your prompt and drawing stay with this level.' : t('create.canvas_help')), canvasHost, liveContext);
  const form = h('form', { class: 'creation-form' }, inputs, canvasField, h('div', { class: 'creation-submit' }, status, go,
    h('p', { class: 'muted small creation-save-note' }, icon('check'), t('create.saved_help'))));
  const intro = isLevel ? `Create a new challenge for ${level!.gameTitle}. Its characters and controls carry into this level.` : t('create.intro');
  root.append(h('div', { class: 'create-game-screen creation-simple' },
    compact ? null :
      h('div', { class: 'creation-heading' }, h('a', { class: 'small muted', href: level ? `#/game/${encodeURIComponent(level.gameId)}` : '#/studio' }, level ? '← Back to game' : t('create.back')),
        h('h1', { class: 'marker-underline' }, level?.append ? 'Create level' : level?.levelId ? 'Edit this level' : t('create.heading')), h('p', { class: 'muted' }, intro)),
    compact ? form : card('creation-prompt-card', form)));

  function brief(): GameBrief {
    return { category: category.value as GameBrief['category'],
      custom_definition: category.value === 'custom' ? prompt.value.trim().slice(0, 500) : '',
      theme: '', gameplay: '', details: '' };
  }
  function doc() {
    return { ...(editor?.doc.snapshot() ?? drawing), gameId, imaginationContext: prompt.value, betterGraphics: graphics.input.checked, multiplayer: multiplayer.input.checked };
  }
  function save(): void {
    if (completed) return;
    const draft: CreationDraft = { title: saved?.title ?? '', author: saved?.author ?? store.author(),
      kind: intent.kind, brief: brief(), prompt: prompt.value, doc: doc(), gameId, appendLevel: level?.append, levelId: level?.levelId };
    if (level) store.setLevelCreationDraft(level.gameId, slot, draft);
    else store.setCreationDraft(draft);
    if (resumedDraft !== undefined) {
      store.setEditorDoc(draft.doc);
      if (resumedDraft) store.setDraftDoc(resumedDraft, draft.doc);
    }
  }
  function sync(): void { go.disabled = busy || !prompt.value.trim(); }
  prompt.addEventListener('input', () => { prompt.setCustomValidity(''); sync(); save(); });
  category.addEventListener('change', save);
  sync();

  form.addEventListener('submit', (event) => { event.preventDefault(); void create(); });
  async function create(): Promise<void> {
    if (busy || disposed || !prompt.value.trim() || !form.reportValidity()) return;
    busy = true;
    inputs.disabled = true;
    sync();
    status.textContent = t('create.saving');
    save();
    editor?.setReadOnly(() => undefined);
    const snapshot = doc();
    try {
      async function reserveGame(): Promise<void> {
        const author = currentPlayer()?.name || saved?.author || store.author() || t('create.default_author');
        store.setAuthor(author);
        const game = await api.createGame(t('create.pending_title'), author, brief(), true);
        gameId = game.id;
        save();
        if (currentPlayer()) await collab.join(game.id).catch(() => undefined);
      }
      if (!gameId) await reserveGame();
      if (disposed) return;
      const submit = () => api.imagineGame({ game_id: gameId, category: brief().category,
        context: prompt.value.trim(), title: '', ink: creationInk(snapshot), better_graphics: graphics.input.checked, multiplayer: multiplayer.input.checked,
        ...(level?.append ? { append_level: true } : {}), ...(level?.levelId ? { level_id: level.levelId } : {}) });
      let generated;
      try { generated = await submit(); }
      catch (error) {
        // A vanished pending new game can be recreated without losing the idea or borrowing a level.
        if (level || !(error instanceof ApiError) || error.status !== 404) throw error;
        gameId = null;
        await reserveGame();
        if (disposed) return;
        generated = await submit();
      }
      if (disposed) return;
      store.setEditorDoc(doc());
      store.setDraftDoc(generated.draft_id, doc());
      completed = true;
      if (level) store.setLevelCreationDraft(level.gameId, slot, null);
      else store.setCreationDraft(null);
      if (onGenerated) onGenerated(generated.draft_id);
      else navigate(`#/imagine/${encodeURIComponent(generated.draft_id)}`);
    } catch (error) {
      if (!disposed) status.textContent = t(error instanceof ApiError ? error.messageKey : 'error.build_failed');
    } finally {
      busy = false;
      if (!disposed) { inputs.disabled = false; editor?.setReadOnly(null); sync(); }
    }
  }
  function syncContext(d: EditorDocData): void {
    liveContext.textContent = t('create.canvas_live', { strokes: d.strokes.length, notes: d.rules.length });
  }
  editor = createEditor(canvasHost, { doc: drawing, rules: DEFAULT_RULES, canSaveToLibrary: false,
    freeSketch: true, showSubmit: false, simpleToolbar: true,
    onChange: (next) => { drawing = next; syncContext(next); save(); },
    onSubmit: async () => create() });
  syncContext(drawing);
  const flush = (): void => save();
  window.addEventListener('pagehide', flush);
  return () => { save(); disposed = true; window.removeEventListener('pagehide', flush); editor?.destroy(); };
}
