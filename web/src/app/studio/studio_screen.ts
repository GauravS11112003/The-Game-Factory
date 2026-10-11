/**
 * #/studio/:id — the Studio (docs/v6/CONTRACTS_V6.md §6): full-bleed canvas with a floating tool rail, a top bar
 * (title, scene tabs, undo/redo, save state, Share, Play), and the right column with the Inspector (or the Game panel)
 * beside the Copilot chat. Play swaps the canvas for the runtime in place; Esc or Stop returns to the exact editor
 * state. Autosave: PUT 1.2 s after the last change, a local draft always, thumbnails at most every 30 s.
 * `?say=<words>` is sent to the copilot once after opening (the New game screen uses it), then dropped from the URL.
 */
import '../../studio/studio.css';
import { h, toast } from '../dom.ts';
import { t } from '../messages.ts';
import { navigate } from '../router.ts';
import { store } from '../store.ts';
import {
  dropDraft, isLocalId, isOffline, loadDraft, loadThemes, localGameFrom, saveDraft, StudioApiError, studioApi,
} from '../studio_api.ts';
import { CopilotChat } from '../../studio/editor/chat.ts';
import { StudioCanvas } from '../../studio/editor/canvas.ts';
import { gamePanel } from '../../studio/editor/game_panel.ts';
import { sicon } from '../../studio/editor/icons.ts';
import { multiInspector, objectInspector } from '../../studio/editor/inspector.ts';
import { mountRail } from '../../studio/editor/rail.ts';
import { mountBanners, Recognizer } from '../../studio/editor/recognize.ts';
import { thumbnailBlob } from '../../studio/editor/snapshot.ts';
import { Studio, type Tool } from '../../studio/editor/studio.ts';
import { closePopover, menu, popover, toggle, typingIn } from '../../studio/editor/ui.ts';
import { displayName, sceneOf, withScene } from '../../studio/model/doc.ts';
import { asGameDoc, normalizeDoc, type SDoc, type SObj } from '../../studio/model/types.ts';
import { mountRuntime, type RuntimeHandle } from '../../studio/runtime/index.ts';

type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'error' | 'readonly';

interface Loaded { doc: SDoc; synced: boolean; offline: boolean }

async function loadGame(id: string): Promise<Loaded | 'missing'> {
  const draft = loadDraft(id);
  if (isLocalId(id)) {
    if (draft) return { doc: normalizeDoc(draft.doc), synced: false, offline: false };
    return { doc: normalizeDoc({ ...localGameFrom(null), id }), synced: false, offline: false };
  }
  try {
    const server = await studioApi.game(id);
    const serverAt = Date.parse(server.updated_at ?? '') || 0;
    if (draft && !draft.synced && draft.savedAt > serverAt) return { doc: normalizeDoc(draft.doc), synced: false, offline: false };
    return { doc: normalizeDoc(server), synced: true, offline: false };
  } catch (e) {
    if (draft) return { doc: normalizeDoc(draft.doc), synced: draft.synced, offline: isOffline(e) };
    if (isOffline(e)) return { doc: normalizeDoc({ ...localGameFrom(null), id }), synced: false, offline: true };
    return 'missing';
  }
}

export function studioScreen(root: HTMLElement, gameId: string, query: URLSearchParams): () => void {
  let disposed = false;
  const cleanups: (() => void)[] = [];
  const shell = h('div', { class: 'st-root loading' }, h('div', { class: 'st-loading' }, h('span', { class: 'st-typing' }, h('i'), h('i'), h('i')), h('span', null, t('studio.opening'))));
  root.append(shell);
  document.body.classList.add('st-on');

  void loadGame(gameId).then((r) => {
    if (disposed) return;
    if (r === 'missing') {
      shell.replaceChildren(h('div', { class: 'st-missing' }, h('h2', null, t('studio.missing')), h('p', null, t('studio.missing_sub')),
        h('a', { class: 'st-btn primary', href: '#/new' }, sicon('plus'), t('studio.new_game'))));
      return;
    }
    cleanups.push(buildStudio(shell, gameId, r, query));
  });

  return () => {
    disposed = true;
    for (const f of cleanups) f();
    closePopover();
    document.body.classList.remove('st-on');
  };
}

function buildStudio(rootEl: HTMLElement, initialId: string, loaded: Loaded, query: URLSearchParams): () => void {
  let gameId = initialId;
  const studio = new Studio(loaded.doc, query.get('scene') ?? undefined);
  const offs: (() => void)[] = [];
  rootEl.classList.remove('loading');

  // ---- canvas stage ----
  const canvas = new StudioCanvas(studio);
  const rail = mountRail(studio);
  const stage = h('div', { class: 'st-stage' }, canvas.el, rail.el);
  offs.push(mountBanners(studio, stage));
  const chat = new CopilotChat(studio, () => gameId);
  const recognizer = new Recognizer(studio, canvas, stage, (text, id) => { void chat.send(text, { selection: [id] }); showSheet('chat'); });
  if (loaded.offline) chat.setOffline(true);

  // ---- inspector column ----
  const inspBody = h('div', { class: 'st-insp-scroll' });
  const insp = h('aside', { class: 'st-panel st-insp-panel', 'aria-label': t('studio.insp.label') }, inspBody);
  const chatPanel = h('aside', { class: 'st-panel st-chat-panel', 'aria-label': t('studio.chat.title') }, chat.el);
  const side = h('div', { class: 'st-side' }, insp, chatPanel);
  let inspOpen = window.innerWidth >= 1280;
  const renderInspector = (): void => {
    if (playing) return;
    const scroll = inspBody.scrollTop;
    const focusKey = (document.activeElement as HTMLElement | null)?.closest('.st-insp-scroll') ? document.activeElement?.getAttribute('aria-label') : null;
    const sel = studio.selected;
    inspBody.replaceChildren(sel.length === 1 ? objectInspector(studio, sel[0]) : sel.length > 1 ? multiInspector(studio, sel) : gamePanel(studio));
    inspBody.scrollTop = scroll;
    if (focusKey) (inspBody.querySelector(`[aria-label="${CSS.escape(focusKey)}"]`) as HTMLElement | null)?.focus();
  };

  // ---- top bar ----
  const title = h('input', { type: 'text', class: 'st-title', value: studio.doc.title, maxLength: 60, 'aria-label': t('studio.top.title'), spellcheck: false });
  title.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') title.blur(); };
  title.onchange = () => {
    const v = title.value.trim();
    if (v && v !== studio.doc.title) studio.apply([{ action: 'set_title', data: { title: v } }], { label: 'title' });
    else title.value = studio.doc.title;
  };
  const tabs = h('div', { class: 'st-tabs', role: 'tablist' });
  const undoBtn = h('button', { type: 'button', class: 'st-ibtn', title: `${t('studio.top.undo')} (Ctrl+Z)`, 'aria-label': t('studio.top.undo'), onclick: () => studio.undo() }, sicon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'st-ibtn', title: `${t('studio.top.redo')} (Ctrl+Shift+Z)`, 'aria-label': t('studio.top.redo'), onclick: () => studio.redo() }, sicon('redo'));
  const saveEl = h('span', { class: 'st-save', 'aria-live': 'polite' });
  const shareBtn = h('button', { type: 'button', class: 'st-btn ghost' }, sicon('share'), h('span', { class: 'st-hide-sm' }, t('studio.top.share')));
  const playBtn = h('button', { type: 'button', class: 'st-play-btn', title: `${t('studio.top.play')} (Ctrl+Enter)` });
  const inspBtn = h('button', { type: 'button', class: 'st-ibtn st-insp-toggle', title: t('studio.top.inspector'), 'aria-label': t('studio.top.inspector') }, sicon('sliders'));
  inspBtn.onclick = () => { inspOpen = !inspOpen; if (!inspOpen) rootEl.dataset.userClosed = '1'; else delete rootEl.dataset.userClosed; layout(); };
  const home = h('a', { class: 'st-home', href: '#/', title: t('studio.top.home'), 'aria-label': t('studio.top.home') }, h('span', { class: 'st-home-mark', 'aria-hidden': 'true' }));
  const top = h('header', { class: 'st-top' }, home, h('div', { class: 'st-title-wrap' }, title), tabs, h('span', { class: 'st-grow' }),
    h('div', { class: 'st-top-group' }, undoBtn, redoBtn), saveEl, inspBtn, shareBtn, playBtn);

  // ---- phones: bottom bar + sheets ----
  const sheetBar = h('nav', { class: 'st-sheetbar' });
  let sheet: 'none' | 'chat' | 'insp' = 'none';
  function showSheet(which: 'none' | 'chat' | 'insp'): void {
    sheet = which;
    rootEl.dataset.sheet = which;
    sheetBar.replaceChildren(
      h('button', { type: 'button', class: sheet === 'none' ? 'on' : '', onclick: () => showSheet('none') }, sicon('pen'), t('studio.sheet.draw')),
      h('button', { type: 'button', class: sheet === 'chat' ? 'on' : '', onclick: () => showSheet(sheet === 'chat' ? 'none' : 'chat') }, sicon('sparkle'), t('studio.chat.title')),
      h('button', { type: 'button', class: sheet === 'insp' ? 'on' : '', onclick: () => showSheet(sheet === 'insp' ? 'none' : 'insp') }, sicon('sliders'), t('studio.sheet.inspect')));
  }
  showSheet('none');

  const main = h('div', { class: 'st-main' }, stage, side);
  rootEl.replaceChildren(top, main, sheetBar);

  const layout = (): void => {
    rootEl.classList.toggle('insp-open', inspOpen);
    inspBtn.setAttribute('aria-pressed', String(inspOpen));
  };
  layout();

  // ---- scene tabs ----
  const renderTabs = (): void => {
    const doc = studio.doc;
    tabs.replaceChildren(...doc.scenes.map((sc) => {
      const on = sc.id === studio.sceneId;
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(on), class: `st-tab${on ? ' on' : ''}`, title: t('studio.top.scene_help') }, sc.name);
      b.onclick = () => studio.setScene(sc.id);
      b.ondblclick = () => renameScene(b, sc.id);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        menu(b, [
          { label: t('studio.scene.rename'), icon: 'pen', onPick: () => renameScene(b, sc.id) },
          { label: t('studio.scene.duplicate'), icon: 'copy', onPick: () => addScene(sc.id) },
          ...(doc.scenes.length > 1 ? [{ label: t('studio.scene.delete'), icon: 'trash', danger: true, onPick: () => deleteScene(sc.id) }] : []),
        ]);
      };
      return b;
    }), h('button', { type: 'button', class: 'st-tab add', title: t('studio.scene.add'), 'aria-label': t('studio.scene.add'), onclick: () => addScene(null) }, sicon('plus')));
  };
  const addScene = (copyFrom: string | null): void => {
    const before = new Set(studio.doc.scenes.map((s) => s.id));
    studio.apply([{ action: 'add_scene', data: { name: t('studio.scene.default_name', { n: studio.doc.scenes.length + 1 }), ...(copyFrom ? { copy_from: copyFrom } : {}) } }], { label: 'scene' });
    const added = studio.doc.scenes.find((s) => !before.has(s.id));
    if (added) studio.setScene(added.id);
  };
  const renameScene = (tab: HTMLElement, id: string): void => {
    const sc = sceneOf(studio.doc, id);
    const inp = h('input', { type: 'text', class: 'st-tab-in', value: sc.name, maxLength: 40, 'aria-label': t('studio.scene.rename') });
    tab.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (save && v && v !== sc.name) studio.commit(withScene(studio.doc, { ...sceneOf(studio.doc, id), name: v.slice(0, 40) }), { label: 'scene' });
      else renderTabs();
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
  };
  const deleteScene = (id: string): void => {
    if (studio.doc.scenes.length < 2) return;
    const scenes = studio.doc.scenes.filter((s) => s.id !== id);
    if (studio.sceneId === id) studio.setScene(scenes[0].id);
    studio.commit({ ...studio.doc, scenes }, { label: 'scene' });
    toast(t('studio.scene.deleted'), { action: { label: t('studio.top.undo'), run: () => studio.undo() } });
  };

  // ---- save state, autosave ----
  let state: SaveState = loaded.synced ? 'saved' : 'dirty';
  let saveTimer = 0;
  let draftTimer = 0;
  let retryTimer = 0;
  let inFlight = false;
  let lastThumb = 0;
  const renderSave = (): void => {
    const map: Record<SaveState, [string, string]> = {
      saved: ['cloud', 'studio.save.saved'], dirty: ['cloud', 'studio.save.dirty'], saving: ['cloud', 'studio.save.saving'],
      offline: ['cloudoff', 'studio.save.offline'], error: ['cloudoff', 'studio.save.error'], readonly: ['lock', 'studio.save.readonly'],
    };
    const [ico, key] = map[state];
    saveEl.className = `st-save ${state}`;
    saveEl.replaceChildren(sicon(ico), h('span', { class: 'st-hide-sm' }, t(key)));
    saveEl.title = t(key);
  };
  const docToSave = (): SDoc => ({ ...studio.doc, id: gameId });
  const saveNow = async (): Promise<void> => {
    window.clearTimeout(saveTimer);
    if (inFlight) { saveTimer = window.setTimeout(() => void saveNow(), 800); return; }
    if (state === 'readonly') return;
    inFlight = true;
    const doc = docToSave();
    const snapshot = studio.doc;
    state = 'saving';
    renderSave();
    try {
      if (isLocalId(gameId)) {
        const created = await studioApi.createGame({ doc: asGameDoc(doc), title: doc.title });
        const oldId = gameId;
        gameId = created.id;
        dropDraft(oldId);
        moveChat(oldId, gameId);
        history.replaceState(null, '', `#/studio/${encodeURIComponent(gameId)}`);
        toast(t('studio.save.now_online'));
      } else {
        await studioApi.saveGame(asGameDoc(doc));
      }
      saveDraft(asGameDoc(docToSave()), studio.doc === snapshot);
      state = studio.doc === snapshot ? 'saved' : 'dirty';
      chat.setOffline(false);
      if (state === 'dirty') schedule();
      maybeThumb();
    } catch (e) {
      if (isOffline(e)) {
        state = 'offline';
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => { if (state === 'offline') void saveNow(); }, 15000);
      } else if (e instanceof StudioApiError && (e.status === 403 || e.status === 401)) state = 'readonly';
      else state = 'error';
    } finally {
      inFlight = false;
      renderSave();
    }
  };
  const schedule = (): void => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveNow(), 1200);
  };
  const maybeThumb = (): void => {
    if (isLocalId(gameId) || Date.now() - lastThumb < 30000) return;
    lastThumb = Date.now();
    const id = gameId;
    void thumbnailBlob(studio.doc).then((b) => (b ? studioApi.putThumbnail(id, b) : undefined)).catch(() => undefined);
  };
  const flushDraft = (): void => { saveDraft(asGameDoc(docToSave()), state === 'saved'); };
  renderSave();
  if (!loaded.synced) schedule();

  // ---- play in place ----
  let playing = false;
  let runtime: RuntimeHandle | null = null;
  let playHost: HTMLElement | null = null;
  let watchTimer = 0;
  const renderPlayBtn = (): void => {
    playBtn.replaceChildren(sicon(playing ? 'stop' : 'play'), h('span', null, t(playing ? 'studio.top.stop' : 'studio.top.play')));
    playBtn.classList.toggle('playing', playing);
  };
  const startPlay = (): void => {
    if (playing) return;
    studio.finishPending(false);
    studio.cancelPick();
    recognizer.close();
    closePopover();
    playing = true;
    showSheet('none');
    rootEl.classList.add('playing');
    playHost = h('div', { class: 'st-play' });
    stage.append(playHost);
    const errors: string[] = [];
    try {
      runtime = mountRuntime(playHost, asGameDoc(studio.doc), {
        scene: studio.sceneId,
        muted: store.flag('muted'),
        onEvent: (e) => { if (e.type === 'error' && e.text) errors.push(e.text); },
      });
    } catch (e) {
      console.error('runtime failed', e);
      toast(t('studio.play.failed'));
    }
    const watch = h('div', { class: 'st-watch' });
    inspBody.replaceChildren(h('div', { class: 'st-insp' },
      h('div', { class: 'st-insp-head' }, h('div', { class: 'st-insp-avatar game' }, sicon('play')), h('div', { class: 'st-insp-names' }, h('div', { class: 'st-insp-title' }, t('studio.play.live')), h('div', { class: 'st-insp-sub' }, t('studio.play.live_sub')))),
      watch,
      h('div', { class: 'st-row-btns pad' }, h('button', { type: 'button', class: 'st-btn', onclick: () => runtime?.restart() }, sicon('restart'), t('studio.play.restart')))));
    const tick = (): void => {
      const c = runtime?.counters() ?? {};
      const rows: HTMLElement[] = [];
      for (const [who, vals] of Object.entries(c)) {
        const entries = Object.entries(vals ?? {});
        if (!entries.length) continue;
        const o: SObj | undefined = studio.object(who);
        rows.push(h('div', { class: 'st-watch-group' }, h('div', { class: 'st-watch-who' }, who === 'game' ? t('studio.hud.game') : o ? displayName(o) : who),
          ...entries.map(([k, v]) => h('div', { class: 'st-watch-row' }, h('span', null, k), h('b', null, String(Math.round(Number(v) * 10) / 10))))));
      }
      watch.replaceChildren(...(rows.length ? rows : [h('p', { class: 'st-empty-note' }, t('studio.play.no_counters'))]));
    };
    tick();
    watchTimer = window.setInterval(tick, 300);
    renderPlayBtn();
  };
  const stopPlay = (): void => {
    if (!playing) return;
    window.clearInterval(watchTimer);
    try { runtime?.stop(); } catch (e) { console.warn('runtime stop failed', e); }
    runtime = null;
    playHost?.remove();
    playHost = null;
    playing = false;
    rootEl.classList.remove('playing');
    renderPlayBtn();
    renderInspector();
    canvas.request();
  };
  playBtn.onclick = () => (playing ? stopPlay() : startPlay());
  renderPlayBtn();

  // ---- share ----
  shareBtn.onclick = () => {
    const url = `${location.origin}${location.pathname}#/g/${encodeURIComponent(gameId)}`;
    const link = h('input', { type: 'text', class: 'st-text', value: url, readOnly: true, 'aria-label': t('studio.share.link') });
    const copy = h('button', { type: 'button', class: 'st-btn primary small' }, sicon('copy'), t('studio.share.copy'));
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); copy.replaceChildren(sicon('check'), t('studio.share.copied')); } catch { link.select(); }
    };
    let published = false;
    const pubRow = h('div', { class: 'st-row' });
    const renderPub = (): void => {
      pubRow.replaceChildren(h('div', { class: 'st-row-label' }, t('studio.share.explore')), h('div', { class: 'st-row-ctl' }, toggle(published, async (v) => {
        try {
          const card = await studioApi.publish(gameId, v);
          published = card.published;
          toast(t(published ? 'studio.share.published' : 'studio.share.unpublished'));
        } catch (e) {
          toast(t(isOffline(e) ? 'studio.share.offline' : 'studio.share.failed'));
        }
        renderPub();
      }, t('studio.share.explore'))));
    };
    renderPub();
    const local = isLocalId(gameId);
    popover(shareBtn, h('div', { class: 'st-share' },
      h('div', { class: 'st-share-title' }, t('studio.share.title')),
      local ? h('p', { class: 'st-sec-hint' }, t('studio.share.local')) : h('div', { class: 'st-theme-describe' }, link, copy),
      local ? null : pubRow,
      h('a', { class: 'st-btn small', href: `#/g/${encodeURIComponent(gameId)}`, onclick: () => flushDraft() }, sicon('expand'), t('studio.share.open_play'))), { align: 'end', width: 340 });
  };

  // ---- reactions ----
  const renderHistory = (): void => {
    undoBtn.disabled = !studio.history.canUndo;
    redoBtn.disabled = !studio.history.canRedo;
  };
  offs.push(studio.on((c) => {
    if (c.kind === 'doc') {
      if (state !== 'readonly') {
        state = state === 'offline' ? 'offline' : 'dirty';
        if (state === 'dirty') renderSave();
        schedule();
      }
      window.clearTimeout(draftTimer);
      draftTimer = window.setTimeout(flushDraft, 300);
      if (document.activeElement !== title) title.value = studio.doc.title;
      if (!c.quiet) { renderInspector(); renderTabs(); }
    }
    if (c.kind === 'selection') {
      renderInspector();
      if (studio.selection.length && window.innerWidth < 1280 && window.innerWidth >= 760 && !inspOpen) { inspOpen = true; layout(); }
    }
    if (c.kind === 'scene') { renderInspector(); renderTabs(); }
    if (c.kind === 'history') renderHistory();
    if (c.kind === 'asks' && studio.asks.length && !['pen', 'line', 'rect', 'circle'].includes(studio.tool)) studio.setTool('pen');
  }));
  renderTabs();
  renderInspector();
  renderHistory();

  void loadThemes().then((themes) => {
    studio.themes = themes;
    if (!playing && !studio.selection.length) renderInspector();
  });

  // ---- keyboard ----
  let clipboard: SObj[] = [];
  const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'hand', p: 'pen', b: 'pen', l: 'line', r: 'rect', o: 'circle', c: 'circle', e: 'eraser' };
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (playing) { stopPlay(); e.preventDefault(); return; }
      if (typingIn(e)) return;
      if (studio.pick) studio.cancelPick();
      else if (studio.pending) studio.finishPending();
      else if (studio.selection.length) studio.select([]);
      return;
    }
    if (mod && e.key === 'Enter') { e.preventDefault(); if (playing) stopPlay(); else startPlay(); return; }
    if (typingIn(e) || playing) return;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) studio.redo(); else studio.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); studio.redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); studio.duplicateSelection(); return; }
    if (mod && k === 'a') { e.preventDefault(); studio.setTool('select'); studio.select(studio.scene.objects.map((o) => o.id)); return; }
    if (mod && k === 'c') { clipboard = studio.selected.map((o) => JSON.parse(JSON.stringify(o)) as SObj); return; }
    if (mod && k === 'x') { clipboard = studio.selected.map((o) => JSON.parse(JSON.stringify(o)) as SObj); studio.deleteSelection(); return; }
    if (mod && k === 'v') { if (clipboard.length) { e.preventDefault(); studio.paste(clipboard); clipboard = clipboard.map((o) => ({ ...o, x: o.x + 32, y: o.y + 32 })); } return; }
    if (mod && k === 'g') { e.preventDefault(); if (e.shiftKey) studio.splitSelection(); else studio.mergeSelection(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); canvas.zoomBy(1.25); return; }
    if (mod && k === '-') { e.preventDefault(); canvas.zoomBy(0.8); return; }
    if (mod && k === '0') { e.preventDefault(); canvas.zoomTo(1); return; }
    if (mod || e.altKey) return;
    if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) { canvas.fit(true); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { if (studio.selection.length) { e.preventDefault(); studio.deleteSelection(); } return; }
    if (e.key === 'Enter') { studio.finishPending(); return; }
    if (e.key === '/') { e.preventDefault(); chat.focus(); showSheet('chat'); return; }
    if (e.key === ']') { studio.shiftLayer(1); return; }
    if (e.key === '[') { studio.shiftLayer(-1); return; }
    if (e.key.startsWith('Arrow') && studio.selection.length) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      studio.apply(studio.selected.map((o) => ({ action: 'update_object', target: o.id, data: { x: o.x + dx, y: o.y + dy } })), { label: 'nudge', coalesce: 'nudge', quiet: true });
      return;
    }
    if (TOOL_KEYS[k] && !e.shiftKey) { studio.setTool(TOOL_KEYS[k]); return; }
  };
  window.addEventListener('keydown', onKey);
  const onUnload = (): void => flushDraft();
  window.addEventListener('beforeunload', onUnload);
  const onResize = (): void => { if (window.innerWidth >= 1280 && !inspOpen && !rootEl.dataset.userClosed) { inspOpen = true; layout(); } };
  window.addEventListener('resize', onResize);

  // ---- first message from New game (?say=) ----
  const say = query.get('say');
  if (say) {
    history.replaceState(null, '', `#/studio/${encodeURIComponent(gameId)}`);
    window.setTimeout(() => { void chat.send(say); }, 250);
  }

  return () => {
    stopPlay();
    flushDraft();
    if (state === 'dirty' && !inFlight) void saveNow();
    window.clearTimeout(saveTimer);
    window.clearTimeout(draftTimer);
    window.clearTimeout(retryTimer);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    window.removeEventListener('resize', onResize);
    for (const f of offs) f();
    rail.dispose();
    recognizer.dispose();
    chat.dispose();
    canvas.dispose();
    studio.dispose();
  };
}

function moveChat(from: string, to: string): void {
  try {
    const v = localStorage.getItem(`dp.studio.chat.${from}`);
    if (v) localStorage.setItem(`dp.studio.chat.${to}`, v);
    localStorage.removeItem(`dp.studio.chat.${from}`);
  } catch {
    /* storage off */
  }
}

/** Open a game in the Studio (for other screens). */
export function openStudio(id: string): void {
  navigate(`#/studio/${encodeURIComponent(id)}`);
}
