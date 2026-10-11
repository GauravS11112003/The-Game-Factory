import { startGeneratedRoom } from '../rooms/api.ts';
import { api, ApiError, type ImaginedGameStatus } from '../api.ts';
import { h, icon } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { store } from '../store.ts';
import { gameInputTools } from '../game-inputs.ts';
import { creationInk } from '../game-brief.ts';
import { emptyDoc, type EditorDocData } from '../../editor/doc.ts';
import { createEditor, type EditorHandle } from '../../editor/index.ts';
import { DEFAULT_RULES } from '../rules.ts';
import { addIdea, briefReply, gameSuggestions, nextIdeas, type GameSuggestion } from '../builder-ideas.ts';
import { graphicsOption, multiplayerOption } from '../graphics-option.ts';

/** The creation modal and saved drafts share the same persistent conversation workspace. */
export function imagineScreen(root: HTMLElement, initialDraftId: string, options: { compact?: boolean } = {}): () => void {
  let draftId = initialDraftId;
  let disposed = false;
  let timer = 0;
  let current: ImaginedGameStatus | undefined;
  let busy = true;
  let publishing = false;
  let connectionLost = false;
  let previewDraft = '';
  let historyKey = '';
  let inputs: ReturnType<typeof gameInputTools> | undefined;
  let canvasEditor: EditorHandle | undefined;
  let offCanvasChange: (() => void) | undefined;
  let canvasDoc = store.chatCanvas(draftId);
  let canvasDirty = !!canvasDoc;
  let canvasBaseline = '';
  let canvasLoading = false;
  let canvasLoadVersion = 0;
  let canvasOpen = false;
  let graphicsDirty = false;
  let multiplayerDirty = false;
  const multiplayer = multiplayerOption(false, () => { multiplayerDirty = true; sync(); });
  const graphics = graphicsOption(false, () => { graphicsDirty = true; sync(); });
  const title = h('h1', null, t('builder.title'));
  const publication = h('span', { class: 'builder-publication small', role: 'status' }, t('imagine.draft_short'));
  const publish = h('button', { class: 'pill primary', type: 'button', disabled: true }, t('imagine.publish'));
  const messages = h('div', { class: 'builder-messages', role: 'log', 'aria-label': t('builder.conversation'), 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: 0 });
  const activity = h('p', { class: 'builder-activity small', role: 'status', 'aria-live': 'polite' }, t('imagine.working_body'));
  const recovery = h('button', { class: 'pill small', type: 'button', hidden: true }, t('imagine.check_again'));
  const prompt = h('textarea', { class: 'text', rows: 2, maxLength: 8000, 'aria-label': t('builder.message'),
    placeholder: t('builder.placeholder'), value: store.chatInput(draftId) });
  const send = h('button', { class: 'builder-send', type: 'submit', 'aria-label': t('builder.send'), disabled: true }, icon('star'), h('span', null, t('builder.update_game')));
  const canvasAttachment = h('button', { class: 'builder-canvas-attachment small', type: 'button', hidden: !canvasDirty,
    onclick: () => showCanvas(true) }, icon('pencil'), t('builder.canvas_attached'));
  graphics.element.querySelector('label')!.title = t('create.graphics_help');
  const composer = h('form', { class: 'builder-composer' }, canvasAttachment, prompt, h('div', { class: 'generation-options' }, graphics.element, multiplayer.element),
    h('div', { class: 'row between' }, h('span', { class: 'muted small' }, t('builder.send_hint')), send));
  const previewLabel = h('span', { class: 'small muted' }, t('builder.preview'));
  const restart = h('button', { class: 'tool', type: 'button', title: t('imagine.restart'), 'aria-label': t('imagine.restart'), disabled: true }, icon('retry'));
  const fullscreen = h('button', { class: 'tool', type: 'button', title: t('imagine.fullscreen'), 'aria-label': t('imagine.fullscreen'), disabled: true }, icon('fit'));
  const sketch = h('button', { class: 'pill small', type: 'button', onclick: () => showCanvas(true) }, icon('pencil'), t('builder.sketch'));
  const previewTab = h('button', { class: 'builder-view-tab active', type: 'button', role: 'tab', 'aria-selected': 'true',
    'aria-controls': 'builder-preview-panel', onclick: () => showCanvas(false) }, t('builder.preview'));
  const canvasTab = h('button', { class: 'builder-view-tab', type: 'button', role: 'tab', 'aria-selected': 'false',
    'aria-controls': 'builder-canvas-panel', tabindex: -1, onclick: () => showCanvas(true) }, icon('pencil'), t('builder.canvas'));
  const canvasStatus = h('p', { class: 'muted small', role: 'status' }, t('builder.canvas_help'));
  const canvasHost = h('div', { class: 'builder-canvas-host creation-context-canvas' });
  const canvasTools = h('fieldset', { class: 'builder-canvas-tools', disabled: true }, canvasHost);
  const canvasRetry = h('button', { class: 'pill small', type: 'button', hidden: true, onclick: () => void loadCanvas() }, t('imagine.check_again'));
  const canvasApply = h('button', { class: 'builder-canvas-apply', type: 'button', disabled: true,
    onclick: () => { if (!send.disabled) composer.requestSubmit(); } }, icon('star'), t('builder.apply_canvas'));
  const canvasPanel = h('div', { class: 'builder-canvas-panel', id: 'builder-canvas-panel', role: 'tabpanel',
    'aria-label': t('builder.canvas'), hidden: true },
    h('div', { class: 'builder-canvas-heading' }, h('div', null, h('h2', null, t('builder.sketch_title')), canvasStatus), canvasApply),
    canvasRetry, canvasTools,
    h('div', { class: 'builder-canvas-hint' }, icon('pencil'), t('builder.sketch_hint')));
  const preview = h('div', { class: 'builder-preview' }, h('div', { class: 'builder-empty' },
    h('span', { class: 'imagine-orb', 'aria-hidden': 'true' }, '✦'), h('h2', null, t('builder.first_build')),
    h('p', { class: 'muted' }, t('builder.first_build_help'))));
  const details = h('div', { class: 'builder-details' });
  const friend = h('button', { class: 'pill primary small', type: 'button', hidden: true, onclick: () => { if (current) void startGeneratedRoom(current.draft_id, friend); } }, 'Play with a friend');
  const gameLink = h('a', { class: 'pill small', hidden: true }, t('imagine.saved_game'));
  const previewPanel = h('div', { id: 'builder-preview-panel', role: 'tabpanel', 'aria-label': t('builder.preview') },
    preview, h('div', { class: 'builder-result-actions row wrap' }, sketch, gameLink, friend), details);
  const workspace = h('section', { class: `builder-workspace${options.compact ? ' compact' : ''}`, 'aria-label': t('builder.title') },
    h('header', { class: 'builder-heading row between' }, h('div', null,
      options.compact ? '' : h('a', { class: 'small muted', href: '#/studio' }, t('create.back')), title),
      h('div', { class: 'row' }, publication, publish)),
    h('div', { class: 'builder-body' },
      h('section', { class: 'builder-chat', 'aria-label': t('builder.conversation') }, messages,
        h('div', { class: 'builder-feedback' }, activity, recovery), composer),
      h('section', { class: 'builder-result', 'aria-label': t('builder.preview') },
        h('div', { class: 'builder-preview-toolbar row between' },
          h('div', { class: 'builder-view-tabs', role: 'tablist', 'aria-label': t('builder.views') }, previewTab, canvasTab),
          h('div', { class: 'row builder-preview-controls' }, restart, fullscreen)), previewLabel, previewPanel, canvasPanel)));
  root.append(workspace);
  for (const tab of [previewTab, canvasTab]) tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const open = event.key === 'Home' ? false : event.key === 'End' ? true : !canvasOpen;
    showCanvas(open); (open ? canvasTab : previewTab).focus();
  });

  function sync(): void {
    const canEdit = !!current && (!!store.draftToken(draftId) || !!current.can_publish);
    multiplayer.input.disabled = busy || publishing || !canEdit;
    if (!multiplayerDirty) multiplayer.input.checked = current?.multiplayer ?? false;
    friend.hidden = !current?.multiplayer || current.status !== 'ready';
    graphics.input.disabled = busy || publishing || !canEdit;
    if (!graphicsDirty) graphics.input.checked = current?.better_graphics ?? false;
    prompt.disabled = !canEdit;
    send.disabled = busy || publishing || canvasLoading || connectionLost || !canEdit || (!prompt.value.trim() && !canvasDirty && !(multiplayerDirty && multiplayer.input.checked !== (current?.multiplayer ?? false)) && !(graphicsDirty && graphics.input.checked !== (current?.better_graphics ?? false))) || current?.status !== 'ready';
    publish.hidden = !!current && (!current.game_id || !canEdit);
    publish.disabled = busy || publishing || canvasDirty || connectionLost || current?.status !== 'ready' || current.publication === 'published';
    publish.textContent = t(publishing ? 'imagine.publishing' : current?.publication === 'published' ? 'imagine.published_short' : 'imagine.publish');
    publication.textContent = t(current?.publication === 'published' ? 'imagine.published_short' : 'imagine.draft_short');
    workspace.setAttribute('aria-busy', String(busy));
    canvasAttachment.hidden = !canvasDirty;
    canvasTools.disabled = busy || publishing || canvasLoading || !canEdit;
    canvasEditor?.setReadOnly(canvasTools.disabled ? () => undefined : null);
    canvasApply.disabled = send.disabled || !canvasDirty;
    workspace.classList.toggle('is-building', busy);
    for (const button of messages.querySelectorAll<HTMLButtonElement>('.builder-idea')) {
      const queued = prompt.value.includes(button.dataset.prompt ?? '\u0000');
      button.disabled = busy || publishing || connectionLost || !canEdit || queued;
      button.classList.toggle('is-queued', queued);
      button.querySelector('.builder-idea-add')!.textContent = t(queued ? 'builder.idea_queued' : 'builder.use_idea');
    }
    if (!canvasLoading && canvasEditor) canvasStatus.textContent = t(canvasDirty ? 'builder.canvas_pending' : 'builder.canvas_help');
  }
  function showCanvas(open: boolean): void {
    canvasOpen = open;
    previewPanel.hidden = open;
    canvasPanel.hidden = !open;
    previewLabel.hidden = open;
    workspace.querySelector<HTMLElement>('.builder-preview-controls')!.hidden = open;
    for (const [tab, selected] of [[previewTab, !open], [canvasTab, open]] as const) {
      tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    }
    if (open) { void loadCanvas(); canvasEditor?.requestDraw(); }
  }
  async function loadCanvas(): Promise<void> {
    if (canvasEditor || canvasLoading || disposed) return;
    const loadingDraft = draftId;
    const version = ++canvasLoadVersion;
    canvasLoading = true; canvasRetry.hidden = true; canvasStatus.textContent = t('game.input_loading'); sync();
    try {
      const source = await api.imaginedInputs(loadingDraft);
      if (disposed || version !== canvasLoadVersion || loadingDraft !== draftId) return;
      const accepted = emptyDoc({ gameId: current?.game_id ?? null, strokes: source.ink.strokes,
        character: source.ink.character?.strokes ?? [], screens: source.ink.world.screens, parent: source.ink.parent,
        imaginationContext: source.prompt,
        rules: source.ink.typed_rules.map((rule, index) => ({ id: `note${index}`, text: rule.text, strokeId: null })) });
      canvasBaseline = JSON.stringify(creationInk(accepted));
      store.setDraftDoc(draftId, accepted);
      canvasDoc = store.chatCanvas(draftId) ?? accepted;
      saveCanvas();
      if (!canvasOpen) return;
      canvasEditor = createEditor(canvasHost, { doc: canvasDoc, rules: DEFAULT_RULES, canSaveToLibrary: false,
        freeSketch: true, showSubmit: false, simpleToolbar: true,
        onChange: (next) => { if (!disposed && canvasEditor) { canvasDoc = next; saveCanvas(); } }, onSubmit: async () => refine() });
      // Update the attachment immediately, including edits made just before closing the workspace.
      offCanvasChange = canvasEditor.doc.on(() => { canvasDoc = canvasEditor!.doc.snapshot(); saveCanvas(); });
      saveCanvas();
    } catch (error) {
      if (!disposed && version === canvasLoadVersion) {
        canvasStatus.textContent = t(error instanceof ApiError ? error.messageKey : 'error.network'); canvasRetry.hidden = false;
      }
    } finally {
      if (!disposed && version === canvasLoadVersion) { canvasLoading = false; sync(); }
    }
  }
  function saveCanvas(): void {
    if (!canvasDoc) return;
    canvasDirty = JSON.stringify(creationInk(canvasDoc)) !== canvasBaseline;
    store.setChatCanvas(draftId, canvasDirty ? canvasDoc : null);
    sync();
  }
  function history(game: ImaginedGameStatus): void {
    const entries = game.conversation?.length ? game.conversation : [
      ...(game.context ? [{ role: 'user', content: game.context }] : []),
      ...(game.status === 'ready' ? [{ role: 'assistant', content: game.summary ?? t('builder.ready') }] : [])];
    const key = JSON.stringify([entries, game.status, game.suggestions, game.category]);
    if (key === historyKey) return;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    const first = !historyKey;
    historyKey = key;
    const renderEntry = (entry: typeof entries[number], index: number) => {
      const assistant = entry.role === 'assistant';
      const latest = assistant && index === entries.length - 1 && game.status === 'ready';
      const text = kidText(entry.content);
      if (!assistant) return h('article', { class: 'builder-message user' },
        h('details', { class: 'builder-request-details' }, h('summary', { title: text },
          h('strong', null, t('builder.you') + ': '), briefReply(text, 90),
          'canvas_updated' in entry && entry.canvas_updated ? icon('pencil') : ''), h('p', null, text)));
      const changes = 'changes' in entry ? entry.changes : latest ? game.changes : [];
      const brief = briefReply(text);
      const content = h('div', null, h('p', null, brief),
        brief !== text ? h('details', { class: 'builder-response-details' },
          h('summary', null, t(assistant ? 'builder.read_more' : 'builder.read_request')),
          brief !== text ? h('p', null, text) : '',
          changes?.length ? h('ul', { class: 'builder-changes' }, ...changes.map(change => h('li', null, icon('check'), kidText(change)))) : '') : '');
      const article = h('article', { class: `builder-message ${entry.role}` },
        h('div', { class: 'builder-message-author small' }, assistant ? h('span', { class: 'builder-ai-avatar', 'aria-hidden': 'true' }, '✦') : '',
          t(assistant ? 'builder.assistant' : 'builder.you'),
          'canvas_updated' in entry && entry.canvas_updated ? h('span', { class: 'builder-canvas-badge small', title: t('builder.canvas_sent') }, icon('pencil')) : '',
          latest ? h('span', { class: 'builder-ready-badge' }, icon('check'), t('builder.playable')) : ''), content);
      if (latest) {
        const suggestions = nextIdeas(gameSuggestions({ ...game, suggestions: 'suggestions' in entry ? entry.suggestions : game.suggestions }));
        article.append(h('section', { class: 'builder-ideas', 'aria-label': t('builder.ideas_title') },
          h('div', { class: 'builder-ideas-heading' }, h('h3', null, t('builder.ideas_title'))),
          ...suggestions.map(suggestion => h('button', { type: 'button', class: `builder-idea idea-${suggestion.kind}`,
            data: { prompt: suggestion.prompt }, onclick: () => queueIdea(suggestion) },
            h('span', { class: 'builder-idea-icon', 'aria-hidden': 'true' }, icon(suggestion.kind === 'world' ? 'flag' : suggestion.kind === 'feel' ? 'star' : 'plus')),
            h('span', { class: 'builder-idea-copy' }, h('strong', null, kidText(suggestion.title)), h('span', null, briefReply(kidText(suggestion.description), 80))),
            h('span', { class: 'builder-idea-add' }, t('builder.use_idea'))))));
      }
      return article;
    };
    let visibleStart = entries.length - 1;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].role === 'user') { visibleStart = i; break; }
    visibleStart = Math.max(0, visibleStart);
    const older = visibleStart ? h('details', { class: 'builder-history' },
      h('summary', null, t('builder.earlier')), ...entries.slice(0, visibleStart).map(renderEntry)) : null;
    messages.replaceChildren(...(older ? [older] : []), ...entries.slice(visibleStart).map((entry, i) => renderEntry(entry, visibleStart + i)));
    if (first) {
      messages.scrollTop = 0;
    } else if (atBottom) messages.scrollTop = messages.scrollHeight;
  }
  function queueIdea(suggestion: GameSuggestion): void {
    const next = addIdea(prompt.value, suggestion);
    if (next === prompt.value) { activity.textContent = t('builder.request_full'); return; }
    prompt.value = next;
    store.setChatInput(draftId, next);
    sync();
    activity.textContent = t('builder.idea_added');
    prompt.focus();
  }
  function showPreview(game: ImaginedGameStatus): void {
    if (!game.play_url || game.status !== 'ready' || previewDraft === game.draft_id) return;
    previewDraft = game.draft_id;
    inputs?.dispose();
    const frame = h('iframe', { class: 'imagined-game', title: game.title, src: game.play_url,
      sandbox: 'allow-scripts', referrerPolicy: 'no-referrer', allowFullscreen: true });
    preview.replaceChildren(frame);
    restart.disabled = fullscreen.disabled = false;
    restart.onclick = () => { frame.src = game.play_url!; };
    fullscreen.onclick = () => void frame.requestFullscreen().catch(() => undefined);
    inputs = gameInputTools(game.draft_id, game.title);
    details.replaceChildren(h('details', null, h('summary', null, t('imagine.controls')),
      h('ul', null, ...(game.controls ?? []).map(control => h('li', null, kidText(control))))), inputs.element);
  }
  function move(next: ImaginedGameStatus, submittedCanvas?: EditorDocData | null): void {
    if (next.revision_of === draftId && next.context === prompt.value.trim()) {
      store.setChatInput(draftId, ''); prompt.value = '';
    }
    const token = store.draftToken(draftId);
    if (token && !store.draftToken(next.draft_id)) store.setDraftToken(next.draft_id, token);
    const doc = store.draftDoc(draftId);
    if (doc) store.setDraftDoc(next.draft_id, doc);
    if (submittedCanvas) {
      store.setDraftDoc(next.draft_id, submittedCanvas);
      store.setChatCanvas(draftId, null);
      store.setChatCanvas(next.draft_id, null);
      canvasBaseline = JSON.stringify(creationInk(submittedCanvas)); canvasDoc = submittedCanvas; canvasDirty = false;
    } else {
      if (canvasDirty && canvasDoc) store.setChatCanvas(next.draft_id, canvasDoc);
      offCanvasChange?.(); offCanvasChange = undefined;
      const previousEditor = canvasEditor; canvasEditor = undefined; previousEditor?.destroy(); canvasHost.replaceChildren();
      ++canvasLoadVersion; canvasLoading = false; canvasBaseline = '';
      canvasDoc = store.chatCanvas(next.draft_id); canvasDirty = !!canvasDoc;
    }
    draftId = next.draft_id;
    if (!prompt.value) prompt.value = store.chatInput(draftId);
    current = next;
    graphicsDirty = multiplayerDirty = false;
    busy = next.status === 'building';
    connectionLost = false;
    recovery.hidden = true;
    if (!options.compact && location.hash.startsWith('#/imagine/')) {
      window.history.replaceState(null, '', `#/imagine/${encodeURIComponent(draftId)}`);
    }
    sync();
    if ((canvasOpen || canvasDoc) && !canvasEditor) void loadCanvas();
  }
  function failed(error: unknown): void {
    busy = false;
    connectionLost = true;
    activity.textContent = t(error instanceof ApiError ? error.messageKey : 'error.network');
    recovery.textContent = t('imagine.check_again');
    recovery.hidden = false;
    // Reconcile with the server before accepting another change or publishing.
    sync(); send.disabled = publish.disabled = true;
  }
  async function poll(): Promise<void> {
    if (disposed) return;
    window.clearTimeout(timer);
    try {
      const game = await api.imaginedGame(draftId);
      if (disposed) return;
      const nextId = game.revised_as ?? game.retried_as;
      if (nextId) {
        const token = store.draftToken(draftId);
        if (token && !store.draftToken(nextId)) store.setDraftToken(nextId, token);
        const next = await api.imaginedGame(nextId);
        if (disposed) return;
        move(next);
        await poll(); return;
      }
      current = game;
      busy = game.status === 'building';
      connectionLost = false;
      title.textContent = kidText(game.title || t('builder.title'));
      history(game);
      showPreview(game);
      // Reloading mid-revision still lets the author play the last completed version.
      if (!previewDraft && game.revision_of) {
        const previous = await api.imaginedGame(game.revision_of);
        if (disposed) return;
        showPreview(previous);
      }
      gameLink.hidden = !game.game_id;
      gameLink.href = `#/game/${encodeURIComponent(game.game_id ?? '')}?level=${encodeURIComponent(game.level_id ?? draftId)}`;
      recovery.hidden = game.status !== 'failed';
      recovery.textContent = t('imagine.retry');
      if (busy) {
        const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - (game.started_at ?? Date.now() / 1000)));
        const phaseKey = game.phase === 'painting' ? 'imagine.painting' : game.phase === 'writing' ? 'imagine.writing' : 'imagine.reading';
        const artwork = game.phase === 'painting' && game.assets_total ? ` (${game.assets_done ?? 0}/${game.assets_total})` : '';
        activity.textContent = `${t(phaseKey)}${artwork} · ${t('imagine.elapsed', { minutes: Math.floor(elapsed / 60), seconds: String(elapsed % 60).padStart(2, '0') })}`;
        previewLabel.textContent = t(previewDraft ? 'builder.updating_preview' : 'builder.preview');
        timer = window.setTimeout(() => void poll(), 2000);
      } else {
        activity.textContent = game.status === 'failed' ? t(game.message_key ?? 'imagine.failed') : '';
        previewLabel.textContent = t('builder.preview');
      }
      sync();
      if (canvasDoc && !canvasBaseline && !canvasEditor) void loadCanvas();
    } catch (error) { if (!disposed) failed(error); }
  }
  prompt.addEventListener('input', () => { store.setChatInput(draftId, prompt.value); sync(); if (connectionLost) send.disabled = publish.disabled = true; });
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); if (!send.disabled) composer.requestSubmit();
    }
  });
  composer.addEventListener('submit', event => { event.preventDefault(); void refine(); });
  async function refine(): Promise<void> {
    if (send.disabled || !current) return;
    const message = prompt.value.trim();
    const submittedCanvas = canvasEditor?.doc.snapshot() ?? canvasDoc;
    const ink = canvasDirty && submittedCanvas ? creationInk(submittedCanvas) : undefined;
    busy = true; sync(); activity.textContent = t('builder.updating');
    try {
      const next = await api.refineImaginedGame(draftId, message, ink, graphics.input.checked, multiplayer.input.checked);
      if (disposed) return;
      store.setChatInput(draftId, '');
      if (prompt.value.trim() === message) prompt.value = '';
      move(next, submittedCanvas); store.setChatInput(draftId, prompt.value); history(next); showCanvas(false); await poll();
    } catch (error) { if (!disposed) failed(error); }
  }
  recovery.onclick = async () => {
    if (busy || publishing) return;
    if (connectionLost) { busy = true; recovery.hidden = true; sync(); await poll(); return; }
    busy = true; recovery.disabled = true; sync();
    try {
      const next = await api.retryImaginedGame(draftId);
      if (disposed) return;
      move(next); await poll();
    } catch (error) { if (!disposed) failed(error); }
    finally { if (!disposed) recovery.disabled = false; }
  };
  publish.onclick = async () => {
    if (publish.disabled) return;
    publishing = true; sync();
    try {
      const game = await api.publishImaginedGame(draftId);
      if (disposed) return;
      current = { ...current, ...game }; activity.textContent = t('imagine.published');
    } catch (error) { if (!disposed) activity.textContent = t(error instanceof ApiError ? error.messageKey : 'imagine.publish_failed'); }
    finally { publishing = false; if (!disposed) sync(); }
  };
  void poll();
  return () => {
    store.setChatInput(draftId, prompt.value);
    if (canvasDirty && canvasDoc) store.setChatCanvas(draftId, canvasDoc);
    disposed = true; ++canvasLoadVersion; window.clearTimeout(timer); inputs?.dispose(); offCanvasChange?.(); canvasEditor?.destroy();
  };
}
