/**
 * #/draw — the long-canvas editor screen (§6.3, §7.11).
 * Query: `game=<id>` (a level for that game), `remix=<level id>` (the parent's strokes locked in gray, §6.5),
 * `from=<draft id>` (Back to drawing from the preview, edits kept by id; `from=prompt` opens a prompt draft, §8.3),
 * `new=1` (a fresh sheet), `stamp=<library type id>` (start with that library stamp, §8.1), `mode=<game mode>` (v4).
 * "Make my level!" posts the InkDoc to POST /api/v2/builds and opens the preview.
 * v4 (docs/v4/CONTRACTS_V4.md §3): a game mode chooser in the head. The mode is kept in the drawing, used by the local
 * test-play build, sent with the build as `mode`, and for a game saved in the game's rules (GameRules.mode). The
 * library stamps include blocks added to the game: they arrive as ordinary library types.
 */
import type { GameMode, GameRules, InkDoc, InkStroke, LevelV2, LibraryType, Rig } from '../../core/types.gen.ts';
import { setHandoff } from '../handoff.ts';
import { api, ApiError } from '../api.ts';
import { h, icon, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { DEFAULT_RULES } from '../rules.ts';
import { store } from '../store.ts';
import { createEditor, emptyDoc, isDoc, type EditorDocData, type EditorHandle } from '../../editor/index.ts';
import { liveDoc, liveRoom, mountLive } from '../live/index.ts';
import { mountCreativeDraw } from '../creative/index.ts';
import { isMode, MODES } from '../ws/model.ts';
import { modeName } from '../ws/ui.ts';

async function loadRemix(levelId: string): Promise<{ doc: EditorDocData; level: LevelV2 }> {
  const { level } = await api.level(levelId);
  let t0 = 1;
  const strokes: InkStroke[] = (level.ink?.strokes ?? []).map((s) => ({ ...s, origin: 'parent', t: t0++ }));
  const doc = emptyDoc({
    screens: level.world.screens, strokes, gameId: level.game_id ?? null,
    parent: { level_id: level.id, version: level.version, level_hash: level.meta.level_hash },
    title: kidText(level.title ? `${level.title} (remix)` : ''), character: level.ink?.character?.strokes ?? [],
    nextId: t0 + 1, parentStrokes: strokes.map((s) => ({ ...s, pts: s.pts.map((p) => [p[0], p[1]] as [number, number]), w: s.w.slice() })),
  });
  return { doc, level };
}

async function gameRules(gameId: string | null): Promise<GameRules> {
  if (!gameId) return DEFAULT_RULES;
  try {
    const r = await fetch(`/api/v2/games/${encodeURIComponent(gameId)}/rules`);
    if (!r.ok) return DEFAULT_RULES;
    const j = (await r.json()) as GameRules | { rules?: GameRules };
    const rules = 'version' in j ? j : j.rules;
    return rules ? { ...DEFAULT_RULES, ...rules } : DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

export function drawScreen(root: HTMLElement, query: URLSearchParams): () => void {
  let editor: EditorHandle | null = null;
  let offLive: (() => void) | null = null;
  let offCreative: (() => void) | null = null; // v3 lane 2: tray + background art
  let disposed = false;
  const wrap = h('div', { class: 'draw-screen' });
  root.append(wrap);

  void (async () => {
    const gameId = query.get('game');
    const remix = query.get('remix');
    const from = query.get('from');
    let doc: EditorDocData;
    let parentLevel: LevelV2 | null = null;
    const liveAt = liveRoom(query);
    const live = liveAt ? liveDoc(liveAt, gameId) : null; // live drawing: #/draw?live=<room>
    try {
      if (live) doc = live.doc;
      else if (remix) ({ doc, level: parentLevel } = await loadRemix(remix));
      else if (from) doc = store.editorDoc() ?? (from === 'prompt' ? null : store.draftDoc(from)) ?? emptyDoc({ gameId });
      else if (query.get('new')) doc = emptyDoc({ gameId });
      else {
        const cur = store.editorDoc();
        doc = cur && isDoc(cur) && (!gameId || cur.gameId === gameId) ? cur : emptyDoc({ gameId });
      }
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.not_found'));
      doc = emptyDoc({ gameId });
    }
    if (gameId && !doc.gameId) doc = { ...doc, gameId };
    const asked = query.get('mode');
    if (isMode(asked)) doc = { ...doc, mode: asked };
    const rules: GameRules = { ...(await gameRules(doc.gameId)) }; // a copy: the mode chooser changes it for local builds
    if (disposed) return;
    if (doc.mode) rules.mode = doc.mode;

    const title = h('input', { type: 'text', class: 'title-in', maxLength: 40, placeholder: t('preview.title_placeholder'), value: doc.title });
    const fresh = h('button', {
      type: 'button', class: 'pill small',
      onclick: () => {
        if (editor && editor.doc.data.strokes.length && !confirm(t('editor.new_confirm'))) return;
        store.setEditorDoc(null);
        navigate(`#/draw?new=1${doc.gameId ? `&game=${encodeURIComponent(doc.gameId)}` : ''}`);
      },
    }, icon('plus'), t('editor.new_drawing'));
    const modeSel = h('select', { class: 'draw-mode', 'aria-label': t('studio4.mode_label'), title: t('studio4.mode_label') },
      ...MODES.map((m) => h('option', { value: m, selected: (rules.mode ?? 'platformer') === m }, modeName(m))));
    const setMode = (m: GameMode): void => {
      if ((rules.mode ?? 'platformer') === m) return;
      rules.mode = m;
      modeSel.value = m;
      editor?.doc.setMeta({ mode: m });
      const gid = editor?.doc.data.gameId ?? doc.gameId;
      if (!gid) return;
      // for a game, the mode is the game's: save it in its rules (published levels keep their own snapshot)
      api.rules(gid).then((cur) => api.putRules(gid, { ...DEFAULT_RULES, ...(cur ?? {}), mode: m }))
        .then(() => toast(t('studio4.mode_saved', { mode: modeName(m) })), () => toast(t('studio4.mode_level_only')));
    };
    modeSel.onchange = () => {
      if (isMode(modeSel.value)) setMode(modeSel.value);
    };
    const head = h('div', { class: 'draw-head row wrap' }, h('h2', { class: 'marker-underline' }, t(remix ? 'editor.remix_title' : 'editor.title')), title,
      h('label', { class: 'row small draw-mode-wrap' }, h('span', { class: 'muted' }, t('studio4.mode_label')), modeSel), fresh);
    const host = h('div', { class: 'editor-host' });
    const isDraft = doc.strokes.some((s) => s.origin === 'draft');
    const note = isDraft ? h('p', { class: 'draft-note small' }, icon('pencil'), ' ', t('prompt.draft_note'))
      : doc.parent ? h('p', { class: 'draft-note small' }, icon('remix'), ' ', t('remix.editor_note')) : '';
    wrap.append(head, note, host);

    editor = createEditor(host, {
      doc, rules, canSaveToLibrary: !!doc.gameId, parentLevel,
      onChange: (d) => store.setEditorDoc(d, live?.slot),
      onSubmit: async (d: EditorDocData, ink: InkDoc) => submit({ ...d, title: title.value.trim() }, ink, rules, editor?.lastBuild() ?? null),
      onSaveCharacter: doc.gameId ? (strokes, rig) => saveCharacter(doc.gameId!, strokes, rig) : undefined,
      onSuggestMode: (m) => setMode(m),
    });
    title.oninput = () => editor?.doc.setMeta({ title: title.value });
    offLive = mountLive({ head, editor, join: live && liveAt ? { room: liveAt, role: live.role } : null });
    offCreative = mountCreativeDraw({ editor, root: host, rules });
    const stampId = query.get('stamp');
    if (doc.gameId) {
      api.library(doc.gameId).then((lib) => {
        if (disposed || !editor) return;
        if (lib.length) editor.doc.setMeta({ library: lib });
        if (stampId) editor.useLibraryStamp(stampId);
      }).catch(() => undefined);
    }
    if (doc.parent && !parentLevel) {
      // Back to drawing on a remix: fetch the parent for the remix diff
      api.level(doc.parent.level_id, doc.parent.version).then((r) => !disposed && editor?.setParentLevel(r.level)).catch(() => undefined);
    }
  })();

  return () => {
    disposed = true;
    offLive?.();
    offCreative?.();
    editor?.destroy();
  };
}

async function submit(doc: EditorDocData, ink: InkDoc, rules: GameRules, local: { level: LevelV2; ink: InkDoc } | null): Promise<void> {
  const form = new FormData();
  form.append('ink', new Blob([JSON.stringify(ink)], { type: 'application/json' }), 'ink.json');
  if (ink.typed_rules.length) form.append('typed_rules', JSON.stringify(ink.typed_rules));
  if (doc.gameId) form.append('game_id', doc.gameId);
  if (doc.parent) form.append('parent_id', doc.parent.level_id);
  form.append('dial', rules.default_dial ?? 'polished');
  if (rules.default_dial === 'challenging') form.append('band', rules.default_band ?? 'normal');
  if (doc.title) form.append('title', doc.title);
  if (rules.mode) form.append('mode', rules.mode); // v4: the level's game mode (the builder reads it once lane C takes it)
  try {
    const b = await api.createBuild(form);
    store.setDraftBuild(b.draft_id, { build_id: b.build_id, events_url: b.events_url });
    store.setDraftDoc(b.draft_id, doc);
    if (local) setHandoff(b.draft_id, local.level, local.ink);
    if (Object.keys(doc.keptStatuses).length) store.setDraftKept(b.draft_id, doc.keptStatuses);
    const tier = rules.default_dial === 'faithful' ? 'faithful' : rules.default_dial === 'challenging' ? (rules.default_band === 'hard' ? 'hard' : 'normal') : 'polished';
    navigate(`#/preview/${encodeURIComponent(b.draft_id)}?b=${encodeURIComponent(b.build_id)}&dial=${tier}`);
  } catch (e) {
    toast(t(e instanceof ApiError ? e.messageKey : 'error.upload_failed', e instanceof ApiError ? e.args : {}));
    throw e;
  }
}

async function saveCharacter(gameId: string, strokes: InkStroke[], rig: Rig | null): Promise<void> {
  const author = store.author() || t('ui.someone');
  const type: LibraryType = {
    id: `lt_${Math.random().toString(36).slice(2, 10)}`, game_id: gameId, version: 1, name: t('library.my_player').slice(0, 16), letter: 'P',
    kind: 'player', behavior: { kind: 'static' }, spiky: false, collision: 'none',
    art: { strokes, size_cells: [0.75, 1.75], rig: rig ?? null }, symbol: null, author, created_at: new Date().toISOString(),
  };
  await api.addLibrary(gameId, type);
}
