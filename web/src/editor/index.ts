/**
 * The long-canvas vector editor (lane F, PLAN_V2 §6.3 and §7.11).
 *
 * Surface: vector strokes in cells on a 48·k × 27 strip (k ≤ 6) with a dot grid and perforated screen boundaries.
 * Tools: marker in 4 colours (12 px, pressure ±20%), tap → 14 px dot, hold still 400 ms → straight line (residual
 * < 0.4 cell) with an optional row snap, eraser (tap deletes a stroke, scrub splits), select (tap or lasso; move,
 * delete, recolour, "What does it do?"), stamps, pan. Two-finger pan, space/middle drag, wheel and trackpad pan, pinch
 * or Ctrl-wheel zoom 0.5-3×, "Fit screen", + Add screen / trim, minimap, undo/redo 200.
 * Live hints run in the browser core worker, debounced 150 ms: role chips (fade after 2 s, stay on selection), reach
 * halo, too-far markers ("needs a run-up"), snap ghosts and a pulsing unreachable goal; "Hints off" hides them.
 * ▶ builds locally (Faithful, repairUnsolvable false) and plays with the real camera; long-press ▶ or drag the player
 * flag to play from here; ✎ returns to the drawing.
 */
import type { CellXY, GameRules, InkColor, InkDoc, InkStroke, LevelV2, LibraryType, Rig, Role, StampKind } from '../core/types.gen.ts';
import { CANVAS, PROMPT_LEVEL, WORLD } from '../core/params.ts';
import type { GameHandle } from '../engine/types.ts';
import { coreClient, CoreError } from '../app/core_client.ts';
import type { HintsResult } from '../app/core_types.ts';
import { snapStandable } from '../app/core_tasks.ts';
import { h, icon, isPhone, prefersReducedMotion, toast } from '../app/dom.ts';
import { roleChip, t } from '../app/messages.ts';
import { store } from '../app/store.ts';
import { applyChip, CHIPS, DEFAULT_CHIP_OPTIONS, linkKey, rolesFor, type ChipId, type ChipOptions, type Speed } from './chips.ts';
import { openCreatureStudio } from './creature.ts';
import { EditorDoc, type EditorDocData } from './doc.ts';
import {
  chordAngleDeg, chordResidual, eraseStroke, finishPoints, insideFraction, iou, markerWidth, moved, padBox, polyLength, q,
  resample, samePts, strokeHitDist, strokesBBox, toStrokeArrays, type Pt,
} from './geom.ts';
import { Minimap } from './minimap.ts';
import { INK, paintFit } from './paint.ts';
import { flagHit, render, type RenderState } from './render.ts';
import { STAMP_KINDS, makeLibraryStamp, makeStamp, stampPreview } from './stamps.ts';
import { openStudio } from './studio.ts';
import { View } from './view.ts';

import { isTap } from './tools.ts';

export { MARKER_COLORS, STAMPS, isTap } from './tools.ts';
export type { EditorDocData } from './doc.ts';
export { emptyDoc, isDoc } from './doc.ts';

export interface EditorOptions {
  doc: EditorDocData;
  rules: GameRules;
  onChange(doc: EditorDocData): void;
  onSubmit(doc: EditorDocData, ink: InkDoc): Promise<void>;
  onSaveCharacter?(strokes: InkStroke[], rig: Rig | null): Promise<void>;
  canSaveToLibrary: boolean;
  submitLabel?: string;
  /** Remix: the published parent (perception matches remixed objects to it; the remix diff outlines what changed). */
  parentLevel?: LevelV2 | null;
}

export interface EditorHandle {
  readonly doc: EditorDoc;
  /** The local Faithful build of the current drawing, when the hints are up to date. */
  lastBuild(): { level: LevelV2; ink: InkDoc } | null;
  /** Pick a library type as the current stamp (#/draw?stamp=<type id>); false while the library is not loaded. */
  useLibraryStamp(typeId: string): boolean;
  /** The remix parent arrived (Back to drawing on a remix). */
  setParentLevel(level: LevelV2 | null): void;
  destroy(): void;
  // ---- live drawing hooks (lane 6, src/editor/live.ts) ----
  readonly view: View;
  readonly canvas: HTMLCanvasElement;
  /** The stroke being drawn right now (shared with the room as an in-progress stroke). */
  liveStroke(): { pts: readonly Pt[]; color: InkColor } | null;
  /** Painted on top of every frame; return true while it animates. */
  setOverlay(fn: EditorOverlay | null): void;
  /** Pass the pencil: while set, drawing tools are off (pan and zoom still work) and a press calls `onBlocked`. */
  setReadOnly(onBlocked: (() => void) | null): void;
  requestDraw(): void;
}

export type EditorOverlay = (ctx: CanvasRenderingContext2D, view: View, now: number) => boolean | void;

/** Marker colour for a draft object's role when it is inked (§8.3 "Ink it", K1). */
const ROLE_INK: Partial<Record<Role, InkColor>> = {
  spikes: 'red', lava: 'red', saw: 'red', enemy: 'red', goal: 'green', checkpoint: 'green', coin: 'blue', big_coin: 'blue', key: 'blue',
};

type Tool = 'marker' | 'eraser' | 'select' | 'stamp' | 'pan';

type Mode =
  | { k: 'idle' }
  | { k: 'draw'; pid: number; raw: Pt[]; t0: number; px0: [number, number]; movedPx: number; straight: boolean; holdAt: number; lastHoldPx: [number, number] }
  | { k: 'erase'; pid: number; path: { x: number; y: number }[]; startPx: [number, number]; movedPx: number; t0: number }
  | { k: 'lasso'; pid: number; path: { x: number; y: number }[]; additive: boolean }
  | { k: 'move'; pid: number; from: [number, number]; offset: [number, number] }
  | { k: 'pan'; pid: number; last: [number, number] }
  | { k: 'gesture'; mid: [number, number]; dist: number }
  | { k: 'flag'; pid: number; at: CellXY; px0: [number, number]; movedPx: number }
  | { k: 'stamp'; pid: number };

const FONT = '13px "Patrick Hand", "Comic Sans MS", "Chalkboard SE", system-ui, sans-serif';

const MARKERS: { color: InkColor; meaning: string; glyph: string }[] = [
  { color: 'black', meaning: 'color.black', glyph: '▁' },
  { color: 'red', meaning: 'color.red', glyph: '▲' },
  { color: 'green', meaning: 'color.green', glyph: '⚑' },
  { color: 'blue', meaning: 'color.blue', glyph: '●' },
];

export function createEditor(root: HTMLElement, o: EditorOptions): EditorHandle {
  const doc = new EditorDoc(o.doc);
  const view = new View();
  let tool: Tool = 'marker';
  let color: InkColor = 'black';
  let stampKind: StampKind = 'coin';
  let stampLib: string | null = null; // library type id when stampKind === 'library'
  let mode: Mode = { k: 'idle' };
  let selection = new Set<string>();
  let hidden = new Set<string>(); // strokes hidden during an eraser scrub
  let extra: InkStroke[] = []; // pieces created during an eraser scrub
  let hints: HintsResult | null = null;
  let hintsOn = !store.flag('hintsOff');
  let rowSnap = store.flag('rowSnap');
  let hintsResting = false;
  const chipUntil = new Map<string, number>();
  let recentStrokes = new Set<string>();
  let pick: 'door' | 'start' | null = null;
  let stampGhostAt: CellXY | null = null;
  let spaceDown = false;
  let flash = 0;
  let chipOpts: ChipOptions = { ...DEFAULT_CHIP_OPTIONS };
  let destroyed = false;
  let game: GameHandle | null = null;
  const pointers = new Map<number, { x: number; y: number; type: string }>();
  const highlight = new Set<string>();
  let parentLevel: LevelV2 | null = o.parentLevel ?? null;
  let remixAdded: Set<string> | null = null; // strokes the object-level remix diff calls new
  let showChanges = !store.flag('hideChanges'); // remix outlines are on until the kid hides them
  let groundWinsTold = false;
  let overlay: EditorOverlay | null = null; // live drawing: remote cursors and strokes
  let overlayAnim = false;
  let readOnly: (() => void) | null = null; // live drawing: someone else holds the pencil

  // ---- DOM -----------------------------------------------------------------------------------------------------
  const canvas = h('canvas', { class: 'ed-canvas', tabIndex: 0, 'aria-label': t('editor.canvas_label') });
  const addScreenBtn = h('button', { type: 'button', class: 'add-screen', title: t('editor.add_screen') }, icon('plus'), h('span', null, t('editor.add_screen')));
  const playOverlay = h('div', { class: 'ed-play hidden' });
  const canvasWrap = h('div', { class: 'ed-canvas-wrap' }, canvas, addScreenBtn, playOverlay);
  const minimap = new Minimap(view, () => doc.data, (origin) => origin === 'parent' && !doc.data.parentUnlocked, () => requestDraw());
  const trimBtn = h('button', { type: 'button', class: 'pill small', title: t('editor.trim_screen') }, icon('close'), t('editor.trim_screen'));
  const status = h('div', { class: 'ed-status muted small', role: 'status' });
  const selBar = h('div', { class: 'ed-selbar hidden' });
  const sidePanel = h('div', { class: 'ed-side hidden' });

  const colorBtns = MARKERS.map((m) =>
    h('button', {
      type: 'button', class: 'marker-btn', title: t(m.meaning), data: { color: m.color },
      onclick: () => { color = m.color; setTool('marker'); },
    }, h('span', { class: 'dot', style: { background: INK[m.color] } }, m.glyph), h('span', { class: 'lbl' }, t(m.meaning))));
  const toolBtn = (id: Tool, ic: string, label: string): HTMLButtonElement =>
    h('button', { type: 'button', class: 'tool', data: { tool: id }, title: label, onclick: () => setTool(id) }, icon(ic), h('span', { class: 'lbl' }, label));
  const eraserBtn = toolBtn('eraser', 'eraser', t('tool.eraser'));
  const selectBtn = toolBtn('select', 'select', t('tool.select'));
  const panBtn = toolBtn('pan', 'pan', t('tool.pan'));
  const stampBtn = h('button', { type: 'button', class: 'tool', data: { tool: 'stamp' }, title: t('tool.stamps'), onclick: () => toggleStampPicker() }, icon('stamp'), h('span', { class: 'lbl' }, t('tool.stamps')));
  const stampPicker = h('div', { class: 'stamp-picker hidden' });
  const undoBtn = h('button', { type: 'button', class: 'tool', title: t('tool.undo'), onclick: () => doc.undo() }, icon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'tool', title: t('tool.redo'), onclick: () => doc.redo() }, icon('redo'));
  const zoomOut = h('button', { type: 'button', class: 'tool', title: t('tool.zoom_out'), onclick: () => zoomBy(1 / 1.25) }, icon('minus'));
  const zoomIn = h('button', { type: 'button', class: 'tool', title: t('tool.zoom_in'), onclick: () => zoomBy(1.25) }, icon('plus'));
  const fitBtn = h('button', { type: 'button', class: 'tool', title: t('editor.fit_screen'), onclick: () => { view.fitScreen(); requestDraw(); } }, icon('fit'), h('span', { class: 'lbl' }, t('editor.fit_screen')));
  const snapBtn = h('button', { type: 'button', class: 'tool', title: t('editor.row_snap'), onclick: () => { rowSnap = !rowSnap; store.setFlag('rowSnap', rowSnap); syncTools(); } }, icon('snap'), h('span', { class: 'lbl' }, t('editor.row_snap')));
  const hintsBtn = h('button', { type: 'button', class: 'tool', onclick: () => { hintsOn = !hintsOn; store.setFlag('hintsOff', !hintsOn); syncTools(); if (hintsOn) scheduleHints(0); requestDraw(); } });
  const charBtn = h('button', { type: 'button', class: 'tool', title: t('studio.title'), onclick: () => openCharacter() }, icon('person'), h('span', { class: 'lbl' }, t('editor.character')));
  const rulesBtn = h('button', { type: 'button', class: 'tool', title: t('editor.rules'), onclick: () => toggleRules() }, icon('rules'), h('span', { class: 'lbl' }, t('editor.rules')));
  const unlockBtn = h('button', { type: 'button', class: 'tool hidden', onclick: () => doc.setMeta({ parentUnlocked: !doc.data.parentUnlocked }) });
  const changesBtn = h('button', {
    type: 'button', class: 'tool hidden', title: t('remix.show_changes'),
    onclick: () => { showChanges = !showChanges; store.setFlag('hideChanges', !showChanges); syncTools(); renderStatus(); requestDraw(); },
  }, icon('remix'), h('span', { class: 'lbl' }, t('remix.changes')));
  const creatureBtn = h('button', { type: 'button', class: 'tool hidden', title: t('library.make'), onclick: () => makeCreature() }, icon('star'), h('span', { class: 'lbl' }, t('editor.creature')));
  const inkItBtn = h('button', { type: 'button', class: 'tool hidden', title: t('prompt.ink_it_help'), onclick: () => inkIt() }, icon('marker'), h('span', { class: 'lbl' }, t('prompt.ink_it')));
  const playBtn = h('button', { type: 'button', class: 'pill play', title: t('editor.play_hint') }, icon('play'), t('editor.test_play'));
  const submitBtn = h('button', { type: 'button', class: 'pill primary big' }, icon('check'), o.submitLabel ?? t('editor.make_level'));

  const toolbar = h('div', { class: 'ed-toolbar' },
    h('div', { class: 'grp markers' }, ...colorBtns),
    h('div', { class: 'grp' }, eraserBtn, selectBtn, h('div', { class: 'stamp-wrap' }, stampBtn, stampPicker), panBtn),
    h('div', { class: 'grp' }, undoBtn, redoBtn),
    h('div', { class: 'grp' }, zoomOut, zoomIn, fitBtn, snapBtn, hintsBtn),
    h('div', { class: 'grp' }, charBtn, creatureBtn, rulesBtn, unlockBtn, changesBtn, inkItBtn),
    h('div', { class: 'grp right' }, playBtn, submitBtn));
  const bottom = h('div', { class: 'ed-bottom' }, minimap.el, trimBtn);
  const shell = h('div', { class: 'editor' }, toolbar, h('div', { class: 'ed-main' }, canvasWrap, sidePanel), selBar, bottom, status);
  root.append(shell);

  // ---- tool state ----------------------------------------------------------------------------------------------------
  function setTool(next: Tool): void {
    tool = next;
    if (tool !== 'select') setSelection(new Set());
    stampPicker.classList.add('hidden');
    syncTools();
  }

  function syncTools(): void {
    for (const b of colorBtns) b.classList.toggle('on', tool === 'marker' && b.dataset.color === color);
    for (const b of [eraserBtn, selectBtn, panBtn, stampBtn]) b.classList.toggle('on', b.dataset.tool === tool);
    undoBtn.disabled = !doc.canUndo();
    redoBtn.disabled = !doc.canRedo();
    snapBtn.classList.toggle('on', rowSnap);
    hintsBtn.replaceChildren(icon(hintsOn ? 'eye' : 'eyeoff'), h('span', { class: 'lbl' }, t(hintsOn ? 'editor.hints_on' : 'hint.hints_off')));
    hintsBtn.classList.toggle('on', hintsOn);
    hintsBtn.title = t(hintsOn ? 'editor.hints_on' : 'hint.hints_off');
    const hasParent = doc.data.strokes.some((s) => s.origin === 'parent');
    unlockBtn.classList.toggle('hidden', !hasParent);
    changesBtn.classList.toggle('hidden', !doc.data.parent);
    changesBtn.classList.toggle('on', showChanges);
    creatureBtn.classList.toggle('hidden', !doc.data.gameId);
    inkItBtn.classList.toggle('hidden', !doc.data.strokes.some((s) => s.origin === 'draft'));
    unlockBtn.replaceChildren(icon(doc.data.parentUnlocked ? 'unlock' : 'lock'), h('span', { class: 'lbl' }, t(doc.data.parentUnlocked ? 'editor.lock_gray' : 'editor.unlock_gray')));
    addScreenBtn.classList.toggle('hidden', doc.data.screens >= WORLD.max_screens);
    trimBtn.classList.toggle('hidden', !doc.lastScreenEmpty());
    canvas.dataset.tool = spaceDown ? 'pan' : tool;
  }

  function setSelection(next: Set<string>): void {
    selection = next;
    const now = performance.now();
    if (hints) for (const ob of hints.objects) if (ob.strokes.some((id) => next.has(id))) chipUntil.set(ob.id, now + CANVAS.chip_fade_s * 1000);
    renderSelBar();
    if (sidePanel.dataset.panel === 'chips') renderChips();
    else if (sidePanel.dataset.panel === 'rules') renderRules();
    requestDraw();
  }

  const locked = (s: InkStroke): boolean => doc.isLocked(s);
  const sheetOf = (x: number): number => Math.max(0, Math.min(doc.data.screens - 1, Math.floor(x / WORLD.screen_w)));
  const stampCtx = { newId: () => doc.newId('s'), nextT: () => doc.nextT(), sheetOf };

  // ---- stamps picker -----------------------------------------------------------------------------------------------
  function toggleStampPicker(): void {
    const open = stampPicker.classList.contains('hidden');
    stampPicker.replaceChildren();
    if (open) {
      for (const kind of STAMP_KINDS) {
        const c = h('canvas', { width: 64, height: 64 });
        const pv = stampPreview(kind);
        paintFit(c, pv, strokesBBox(pv), { pad: 0.3 });
        stampPicker.append(h('button', {
          type: 'button', class: `stamp${tool === 'stamp' && stampKind === kind ? ' on' : ''}`, title: t(`stamp.${kind}`),
          onclick: () => { stampKind = kind; stampLib = null; setTool('stamp'); },
        }, c, h('span', null, t(`stamp.${kind}`))));
      }
      for (const lt of doc.data.library) {
        const c = h('canvas', { width: 64, height: 64 });
        paintFit(c, lt.art.strokes, strokesBBox(lt.art.strokes), { pad: 0.3 });
        stampPicker.append(h('button', {
          type: 'button', class: `stamp${stampLib === lt.id ? ' on' : ''}`, title: lt.name,
          onclick: () => { stampKind = 'library'; stampLib = lt.id; setTool('stamp'); },
        }, c, h('span', null, lt.name)));
      }
    }
    stampPicker.classList.toggle('hidden', !open);
  }

  function stampStrokes(at: CellXY): InkStroke[] {
    if (stampKind === 'library') {
      const lt = doc.data.library.find((x) => x.id === stampLib);
      return lt ? makeLibraryStamp(lt, at, stampCtx) : [];
    }
    return makeStamp(stampKind, at, stampCtx);
  }

  function ghostStamp(at: CellXY): InkStroke[] {
    let n = 0;
    const ctx = { newId: () => `ghost${n++}`, nextT: () => 0, sheetOf };
    if (stampKind === 'library') {
      const lt = doc.data.library.find((x) => x.id === stampLib);
      return lt ? makeLibraryStamp(lt, at, ctx) : [];
    }
    return makeStamp(stampKind, at, ctx);
  }

  // ---- selection bar + "What does it do?" -------------------------------------------------------------------------
  function selectedStrokes(): InkStroke[] {
    return doc.data.strokes.filter((s) => selection.has(s.id));
  }

  function renderSelBar(): void {
    const sel = selectedStrokes();
    selBar.classList.toggle('hidden', !sel.length);
    if (!sel.length) return;
    const obj = hints?.objects.find((ob) => ob.strokes.some((id) => selection.has(id)));
    const relabel = h('div', { class: 'chips' }, h('span', { class: 'muted' }, t('editor.this_is')),
      ...rolesFor(sel.map((s) => s.color)).map((r) => h('button', {
        type: 'button', class: `chip${obj?.role === r ? ' on' : ''}`,
        onclick: () => replace(sel, sel.map((s) => ({ ...s, label: r }))),
      }, roleChip(r))));
    selBar.replaceChildren(
      h('div', { class: 'row' },
        h('strong', null, t('editor.selected', { n: sel.length })),
        h('button', { type: 'button', class: 'pill small', onclick: () => deleteSelection() }, icon('trash'), t('ui.delete')),
        ...(['black', 'red', 'green', 'blue'] as InkColor[]).map((c) => h('button', {
          type: 'button', class: 'swatch small', title: t(`color.${c}`), style: { background: INK[c] },
          onclick: () => replace(sel, sel.map((s) => ({ ...s, color: c }))),
        })),
        h('button', { type: 'button', class: 'pill small accent', onclick: () => toggleChips() }, icon('question'), t('editor.what_does_it_do')),
        doc.data.gameId ? h('button', { type: 'button', class: 'pill small', title: t('library.save_object_help'), onclick: () => saveToLibrary() }, icon('star'), t('library.save_object')) : '',
        h('button', { type: 'button', class: 'pill small', onclick: () => setSelection(new Set()) }, t('ui.done'))),
      relabel);
  }

  // ---- the library: make a creature, save an object, place by stamp (§8.1) ---------------------------------------------
  function addToLibrary(lt: LibraryType): void {
    doc.setMeta({ library: [...doc.data.library.filter((x) => x.id !== lt.id), lt] });
  }

  function pickLibraryStamp(typeId: string): boolean {
    if (!doc.data.library.some((x) => x.id === typeId)) return false;
    stampKind = 'library';
    stampLib = typeId;
    setTool('stamp');
    toast(t('library.tap_to_place'));
    return true;
  }

  function makeCreature(): void {
    const gameId = doc.data.gameId;
    if (!gameId) {
      toast(t('studio.library_needs_game'));
      return;
    }
    openCreatureStudio({
      gameId, library: doc.data.library,
      onSaved: (lt) => {
        addToLibrary(lt);
        pickLibraryStamp(lt.id);
      },
    });
  }

  function saveToLibrary(): void {
    const gameId = doc.data.gameId;
    const sel = selectedStrokes();
    if (!gameId || !sel.length) return;
    const ob = hints?.objects.find((x) => x.strokes.some((id) => selection.has(id)));
    openCreatureStudio({
      gameId, library: doc.data.library, strokes: sel, behavior: sel.find((s) => s.rule)?.rule ?? ob?.behavior ?? null,
      onSaved: (lt) => {
        addToLibrary(lt);
        // the object becomes an instance of its new type (pinned, conf 1.0)
        const now = doc.data.strokes.filter((s) => sel.some((x) => x.id === s.id) && !locked(s));
        if (now.length) replace(now, now.map((s) => ({ ...s, stamp: 'library' as const, lib: { type_id: lt.id, version: lt.version }, rule: lt.behavior })));
      },
    });
  }

  // ---- prompt drafts: "your ground wins" and "Ink it" (§8.3) -------------------------------------------------------------
  /** Draft objects (blue lines) the new kid ink covers (IoU ≥ 0.3): the kid's version replaces them. */
  function draftsCoveredBy(added: InkStroke[]): InkStroke[] {
    const drafts = doc.data.strokes.filter((s) => s.origin === 'draft');
    if (!drafts.length || !added.length) return [];
    const nb = strokesBBox(added);
    if (!nb) return [];
    const box = padBox(nb);
    const groups: InkStroke[][] = [];
    const seen = new Set<string>();
    for (const d of drafts) {
      if (seen.has(d.id)) continue;
      const ob = hints?.objects.find((x) => x.strokes.includes(d.id));
      const ids = new Set(ob ? ob.strokes : [d.id]);
      const g = drafts.filter((x) => ids.has(x.id));
      for (const x of g) seen.add(x.id);
      groups.push(g.length ? g : [d]);
    }
    const out: InkStroke[] = [];
    for (const g of groups) {
      const gb = strokesBBox(g);
      if (gb && iou(box, padBox(gb)) >= PROMPT_LEVEL.draft_replace_iou) out.push(...g);
    }
    return out;
  }

  /** Add kid strokes; drafts they cover go in the same undo step. */
  function addKidStrokes(added: InkStroke[]): void {
    const covered = draftsCoveredBy(added);
    doc.apply({ removed: covered, added });
    if (covered.length && !groundWinsTold) {
      groundWinsTold = true;
      toast(t('prompt.your_ground_wins'));
    }
  }

  function inkIt(): void {
    const drafts = doc.data.strokes.filter((s) => s.origin === 'draft');
    if (!drafts.length) return;
    const roleOf = (s: InkStroke): Role | null => s.label ?? hints?.objects.find((x) => x.strokes.includes(s.id))?.role ?? null;
    replace(drafts, drafts.map((s) => {
      const role = roleOf(s);
      return { ...s, origin: 'kid' as const, color: (role && ROLE_INK[role]) ?? (s.color === 'draft' || s.color === 'pencil' ? 'black' : s.color) };
    }));
    toast(t('prompt.inked', { n: drafts.length }));
  }

  // ---- remix: what changed vs the parent (§6.5) ----------------------------------------------------------------------
  let changesMemo: { rev: number; diff: Set<string> | null; value: ReturnType<typeof computeChanges> } | null = null;
  function remixChanges(): ReturnType<typeof computeChanges> {
    if (!changesMemo || changesMemo.rev !== doc.rev || changesMemo.diff !== remixAdded) changesMemo = { rev: doc.rev, diff: remixAdded, value: computeChanges() };
    return changesMemo.value;
  }

  function computeChanges(): { added: Set<string>; moved: Set<string>; removed: InkStroke[] } | null {
    if (!doc.data.parent) return null;
    const orig = new Map((doc.data.parentStrokes ?? []).map((s) => [s.id, s]));
    const added = new Set(remixAdded ?? doc.data.strokes.filter((s) => s.origin !== 'parent').map((s) => s.id));
    const movedIds = new Set<string>();
    for (const s of doc.data.strokes) {
      const was = orig.get(s.id);
      if (s.origin === 'parent' && was && !samePts(s, was)) movedIds.add(s.id);
    }
    const present = new Set(doc.data.strokes.map((s) => s.id));
    return { added, moved: movedIds, removed: [...orig.values()].filter((s) => !present.has(s.id)) };
  }

  function replace(before: InkStroke[], after: InkStroke[]): void {
    doc.apply({ removed: before, added: after });
  }

  function deleteSelection(): void {
    const sel = selectedStrokes().filter((s) => !locked(s));
    if (!sel.length) return;
    doc.apply({ removed: sel, added: [] });
    setSelection(new Set());
  }

  function toggleChips(): void {
    if (!sidePanel.classList.contains('hidden') && sidePanel.dataset.panel === 'chips') return closeSide();
    sidePanel.dataset.panel = 'chips';
    sidePanel.classList.remove('hidden');
    renderChips();
  }

  function renderChips(): void {
    const sel = selectedStrokes();
    const slider = h('input', { type: 'range', min: '2', max: '20', step: '1', value: String(chipOpts.cells) });
    const sliderVal = h('span', { class: 'val' }, String(chipOpts.cells));
    slider.oninput = () => {
      chipOpts = { ...chipOpts, cells: Number(slider.value) };
      sliderVal.textContent = slider.value;
    };
    const speedRow = h('div', { class: 'chips' }, h('span', { class: 'muted' }, t('chip.speed')),
      ...(['slow', 'normal', 'fast'] as Speed[]).map((sp) => h('button', {
        type: 'button', class: `chip${chipOpts.speed === sp ? ' on' : ''}`,
        onclick: () => { chipOpts = { ...chipOpts, speed: sp }; renderChips(); },
      }, t(`chip.speed_${sp}`))));
    const dirBtn = h('button', { type: 'button', class: `chip${chipOpts.reverse ? ' on' : ''}`, onclick: () => { chipOpts = { ...chipOpts, reverse: !chipOpts.reverse }; renderChips(); } }, t(chipOpts.reverse ? 'chip.dir_back' : 'chip.dir_forward'));
    const groups: Record<string, HTMLElement> = {};
    for (const c of CHIPS) {
      groups[c.group] ??= h('div', { class: 'chips' }, h('span', { class: 'muted' }, t(`chip.group_${c.group}`)));
      groups[c.group].append(h('button', {
        type: 'button', class: 'chip big', disabled: !sel.length, onclick: () => useChip(c.id),
      }, h('span', { class: 'emo' }, c.icon), t(c.key)));
    }
    sidePanel.replaceChildren(
      h('div', { class: 'row between' }, h('h3', null, t('editor.what_does_it_do')),
        h('button', { type: 'button', class: 'tool', title: t('ui.close'), onclick: () => closeSide() }, icon('close'))),
      h('p', { class: 'muted small' }, t(sel.length ? 'chip.help' : 'chip.select_first')),
      groups.move, h('div', { class: 'chips' }, h('span', { class: 'muted' }, t('chip.distance')), slider, sliderVal, dirBtn), speedRow,
      groups.creature, groups.platform, groups.thing);
  }

  function useChip(id: ChipId): void {
    const sel = selectedStrokes().filter((s) => !locked(s));
    if (!sel.length) return;
    replace(sel, applyChip(sel, id, chipOpts));
    if (id === 'key') {
      pick = 'door';
      toast(t('editor.pick_door'));
    }
    renderSelBar();
    requestDraw();
  }

  function closeSide(): void {
    sidePanel.classList.add('hidden');
    sidePanel.dataset.panel = '';
  }

  // ---- typed rules (§7.11: a rule typed while a stroke is selected binds to it) -------------------------------------
  function toggleRules(): void {
    if (!sidePanel.classList.contains('hidden') && sidePanel.dataset.panel === 'rules') return closeSide();
    sidePanel.dataset.panel = 'rules';
    sidePanel.classList.remove('hidden');
    renderRules(true);
  }

  function renderRules(focus = false): void {
    const input = h('input', { type: 'text', class: 'text', maxLength: 160, placeholder: t('editor.rule_placeholder') });
    const add = (): void => {
      const text = input.value.trim();
      if (!text) return;
      const target = selectedStrokes()[0]?.id ?? null;
      const id = `r${Date.now().toString(36)}`;
      doc.apply({ removed: [], added: [], rules: [doc.data.rules, [...doc.data.rules, { id, text, strokeId: target }]] });
      input.value = '';
      renderRules(true);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') add();
      e.stopPropagation();
    };
    const sel = selectedStrokes();
    const list = h('ul', { class: 'rules-list' }, ...doc.data.rules.map((r) => {
      const li = h('li', null, h('span', null, `“${r.text}”`),
        r.strokeId ? h('span', { class: 'tag' }, t('editor.rule_bound')) : null,
        h('button', {
          type: 'button', class: 'tool small', title: t('ui.delete'),
          onclick: () => { doc.apply({ removed: [], added: [], rules: [doc.data.rules, doc.data.rules.filter((x) => x.id !== r.id)] }); renderRules(); },
        }, icon('close')));
      if (r.strokeId) {
        li.onmouseenter = () => { highlight.add(r.strokeId!); requestDraw(); };
        li.onmouseleave = () => { highlight.clear(); requestDraw(); };
      }
      return li;
    }));
    sidePanel.replaceChildren(
      h('div', { class: 'row between' }, h('h3', null, t('editor.rules')),
        h('button', { type: 'button', class: 'tool', title: t('ui.close'), onclick: () => closeSide() }, icon('close'))),
      h('p', { class: 'muted small' }, t(sel.length ? 'editor.rule_for_selected' : 'editor.rule_help')),
      h('div', { class: 'row' }, input, h('button', { type: 'button', class: 'pill small', onclick: add }, t('ui.add'))),
      list);
    if (focus) input.focus();
  }

  // ---- character studio -----------------------------------------------------------------------------------------------
  function openCharacter(): void {
    openStudio({
      strokes: doc.data.character,
      canSaveToLibrary: o.canSaveToLibrary && !!o.onSaveCharacter,
      onDone: (strokes) => doc.apply({ removed: [], added: [], character: [doc.data.character, strokes] }),
      onSaveToLibrary: o.onSaveCharacter,
    });
  }

  // ---- hints ----------------------------------------------------------------------------------------------------------
  let hintsTimer = 0;
  function scheduleHints(ms: number = CANVAS.hints_debounce_ms): void {
    window.clearTimeout(hintsTimer);
    hintsTimer = window.setTimeout(() => void runHints(), ms);
  }

  async function runHints(): Promise<HintsResult | null> {
    const rev = doc.rev;
    try {
      const r = await coreClient().hints({
        rev, strokes: doc.data.strokes, screens: doc.data.screens, character: doc.data.character, rules: doc.data.rules,
        parent: doc.data.parent, rules_game: o.rules, library: doc.data.library, parentLevel,
      });
      if (!r || destroyed) return null;
      if (parentLevel && doc.data.parent) {
        // the object-level remix diff; until the core has it, "new" means ink that is not the parent's
        coreClient().remix({ parent: parentLevel, ink: r.ink }).then((d) => {
          if (destroyed || r.rev !== doc.rev) return;
          remixAdded = new Set(d.added);
          renderStatus();
          requestDraw();
        }, () => {
          remixAdded = null;
        });
      }
      hintsResting = false;
      if (!hints || r.rev >= hints.rev) {
        const now = performance.now();
        for (const ob of r.objects) if (ob.strokes.some((id) => recentStrokes.has(id))) chipUntil.set(ob.id, now + CANVAS.chip_fade_s * 1000);
        hints = r;
        renderStatus();
        renderSelBar();
        requestDraw();
      }
      return r;
    } catch (e) {
      hintsResting = true;
      hints = null;
      renderStatus(e);
      requestDraw();
      return null;
    }
  }

  function renderStatus(err?: unknown): void {
    const bits: (string | HTMLElement)[] = [];
    if (hintsResting) bits.push(t(err instanceof CoreError && err.notImplemented ? 'editor.hints_resting' : 'editor.hints_failed'));
    else if (hints && hintsOn) {
      if (!hints.solvable) bits.push(h('span', { class: 'warn' }, t('hint.goal_unreachable')));
      const runUps = hints.tooFar.filter((m) => !m.blocking).length;
      if (runUps) bits.push(t('editor.run_ups', { n: runUps }));
      if (hints.snaps.length) bits.push(t('hint.snap_ghost'));
    }
    const ch = showChanges ? remixChanges() : null;
    if (ch) bits.push(h('span', { class: 'pencil-text' }, t('remix.counts', { added: ch.added.size, moved: ch.moved.size, removed: ch.removed.length })));
    bits.push(h('span', { class: 'muted' }, t('editor.screens_n', { n: doc.data.screens, max: WORLD.max_screens })));
    status.replaceChildren(...bits.flatMap((b, i) => (i ? [' · ', b] : [b])));
  }

  // ---- rendering --------------------------------------------------------------------------------------------------------
  let dirty = true;
  let raf = 0;
  function requestDraw(): void {
    dirty = true;
  }

  function resize(): void {
    const r = canvasWrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(100, Math.floor(r.width));
    const hgt = Math.max(120, Math.floor(r.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    view.worldW = WORLD.screen_w * doc.data.screens;
    view.resize(w, hgt, isPhone());
    requestDraw();
  }

  function frame(now: number): void {
    if (destroyed) return;
    raf = requestAnimationFrame(frame);
    const animating = (hints && !hints.solvable && hintsOn) || [...chipUntil.values()].some((u) => u > now) || flash > 0 || overlayAnim;
    if (!dirty && !animating) return;
    dirty = false;
    if (flash > 0) flash = Math.max(0, flash - 0.06);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = canvas.width / Math.max(1, view.w);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.worldW = WORLD.screen_w * doc.data.screens;
    const dataView: EditorDocData = hidden.size || extra.length
      ? { ...doc.data, strokes: [...doc.data.strokes.filter((s) => !hidden.has(s.id)), ...extra] }
      : doc.data;
    const st: RenderState = {
      view, doc: dataView, locked, selection, highlight, pick, now, font: FONT, hints, hintsOn, chipUntil,
      flagGhost: hints?.start ?? null,
      live: mode.k === 'draw' ? { pts: mode.raw, color, straight: mode.straight, flash } : null,
      lasso: mode.k === 'lasso' ? mode.path : null,
      eraser: tool === 'eraser' && lastPointer ? { x: lastPointer[0], y: lastPointer[1], r: eraserR() } : null,
      dragOffset: mode.k === 'move' ? mode.offset : null,
      stampGhost: tool === 'stamp' && stampGhostAt ? { strokes: ghostStamp(stampGhostAt) } : null,
      changes: showChanges ? remixChanges() : null,
    };
    if (mode.k === 'flag') st.doc = { ...st.doc, startAt: mode.at };
    render(ctx, st);
    overlayAnim = overlay ? overlay(ctx, view, now) === true : false;
    // "+ Add screen" sits on the world's right edge.
    const [rx] = view.toPx(view.worldW, 0);
    addScreenBtn.style.left = `${Math.min(view.w - 44, Math.max(4, rx + 6))}px`;
    addScreenBtn.style.visibility = rx > 0 && rx < view.w - 12 ? 'visible' : 'hidden';
    minimap.draw();
  }

  // ---- pointer input ------------------------------------------------------------------------------------------------------
  let lastPointer: CellXY | null = null;
  const local = (e: PointerEvent | WheelEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const eraserR = (): number => Math.max(0.35, 9 / view.scale);

  function hitStroke(x: number, y: number, o2: { allowLocked?: boolean } = {}): InkStroke | null {
    const tol = Math.max(0.2, 6 / view.scale);
    let best: InkStroke | null = null;
    let bestD = tol;
    for (let i = doc.data.strokes.length - 1; i >= 0; i--) {
      const s = doc.data.strokes[i];
      if (!o2.allowLocked && locked(s)) continue;
      const d = strokeHitDist(s, x, y);
      if (d < bestD) {
        bestD = d;
        best = s;
        if (d < 0) break;
      }
    }
    return best;
  }

  function startGesture(): void {
    const [a, b] = [...pointers.values()];
    mode = { k: 'gesture', mid: [(a.x + b.x) / 2, (a.y + b.y) / 2], dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    hidden = new Set();
    extra = [];
    requestDraw();
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    const [px, py] = local(e);
    pointers.set(e.pointerId, { x: px, y: py, type: e.pointerType });
    if (pointers.size === 2 && [...pointers.values()].every((p) => p.type === 'touch')) {
      startGesture();
      return;
    }
    if (pointers.size > 1 || mode.k !== 'idle') return;
    canvas.setPointerCapture(e.pointerId);
    const [cx, cy] = view.toCells(px, py);
    lastPointer = [cx, cy];
    if (e.button === 1 || spaceDown || tool === 'pan' || (e.button === 2)) {
      mode = { k: 'pan', pid: e.pointerId, last: [px, py] };
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    if (pick) {
      handlePick(cx, cy);
      return;
    }
    const flagAt = doc.data.startAt ?? hints?.start ?? null;
    if (flagAt && flagHit(flagAt, view, px, py)) {
      mode = { k: 'flag', pid: e.pointerId, at: flagAt, px0: [px, py], movedPx: 0 };
      return;
    }
    if (readOnly) {
      readOnly();
      return;
    }
    switch (tool) {
      case 'marker':
        mode = {
          k: 'draw', pid: e.pointerId, raw: [{ x: cx, y: cy, w: markerWidth(e.pressure, e.pointerType) }], t0: performance.now(),
          px0: [px, py], movedPx: 0, straight: false, holdAt: performance.now(), lastHoldPx: [px, py],
        };
        armHold();
        break;
      case 'eraser':
        mode = { k: 'erase', pid: e.pointerId, path: [{ x: cx, y: cy }], startPx: [px, py], movedPx: 0, t0: performance.now() };
        hidden = new Set();
        extra = [];
        break;
      case 'select': {
        const hit = hitStroke(cx, cy);
        if (hit) {
          if (!selection.has(hit.id)) {
            const next = e.shiftKey ? new Set(selection) : new Set<string>();
            // Select the whole object the stroke belongs to when the hints know it.
            const ob = hints?.objects.find((x) => x.strokes.includes(hit.id));
            for (const id of ob ? ob.strokes : [hit.id]) next.add(id);
            next.add(hit.id);
            setSelection(next);
          }
          mode = { k: 'move', pid: e.pointerId, from: [cx, cy], offset: [0, 0] };
        } else {
          mode = { k: 'lasso', pid: e.pointerId, path: [{ x: cx, y: cy }], additive: e.shiftKey };
        }
        break;
      }
      case 'stamp':
        stampGhostAt = [cx, cy];
        mode = { k: 'stamp', pid: e.pointerId };
        break;
    }
    requestDraw();
  });

  let holdTimer = 0;
  function armHold(): void {
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(checkHold, CANVAS.line_hold_ms);
  }

  /** Holding still 400 ms at the end of a stroke straightens it when the residual is < 0.4 cell (§6.3). */
  function checkHold(): void {
    if (mode.k !== 'draw' || mode.straight || mode.raw.length < 2) return;
    const pts = resample(mode.raw);
    if (polyLength(pts) < 0.75) return;
    if (chordResidual(pts) >= CANVAS.line_residual_max_c) return;
    const a = mode.raw[0];
    const b = mode.raw[mode.raw.length - 1];
    const w = mode.raw.reduce((s, p) => s + p.w, 0) / mode.raw.length;
    mode.raw = straightLine({ ...a, w }, { ...b, w });
    mode.straight = true;
    flash = 1;
    requestDraw();
  }

  function straightLine(a: Pt, b: Pt): Pt[] {
    if (!rowSnap) return [a, b];
    const ang = Math.abs(chordAngleDeg([a, b]));
    if (ang <= 10) {
      // Row snap: the ink top lands exactly on a row (y_top = y − w/2 is an integer, §2.4) and ends on cell edges.
      const yTop = Math.round(((a.y + b.y) / 2) - a.w / 2);
      const y = yTop + a.w / 2;
      return [{ ...a, x: Math.round(a.x), y }, { ...b, x: Math.round(b.x), y }];
    }
    return [{ ...a, x: Math.round(a.x * 2) / 2, y: Math.round(a.y * 2) / 2 }, { ...b, x: Math.round(b.x * 2) / 2, y: Math.round(b.y * 2) / 2 }];
  }

  canvas.addEventListener('pointermove', (e) => {
    const [px, py] = local(e);
    const p = pointers.get(e.pointerId);
    if (p) {
      p.x = px;
      p.y = py;
    }
    const [cx, cy] = view.toCells(px, py);
    lastPointer = [cx, cy];
    if (tool === 'stamp' && (mode.k === 'idle' || mode.k === 'stamp')) {
      stampGhostAt = [cx, cy];
      requestDraw();
    }
    if (tool === 'eraser') requestDraw();
    switch (mode.k) {
      case 'gesture': {
        if (pointers.size < 2) return;
        const [a, b] = [...pointers.values()];
        const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        view.panBy(mid[0] - mode.mid[0], mid[1] - mode.mid[1]);
        view.zoomAt(d / mode.dist, mid[0], mid[1]);
        mode.mid = mid;
        mode.dist = d;
        requestDraw();
        return;
      }
      case 'pan':
        if (e.pointerId !== mode.pid) return;
        view.panBy(px - mode.last[0], py - mode.last[1]);
        mode.last = [px, py];
        requestDraw();
        return;
      case 'draw': {
        if (e.pointerId !== mode.pid) return;
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const samples = evs.length ? evs : [e];
        for (const s of samples) {
          const [sx, sy] = local(s);
          const [qx, qy] = view.toCells(sx, sy);
          const last = mode.raw[mode.raw.length - 1];
          const dpx = Math.hypot(qx - last.x, qy - last.y) * view.scale;
          if (dpx < 0.75) continue;
          mode.movedPx = Math.max(mode.movedPx, Math.hypot(sx - mode.px0[0], sy - mode.px0[1]));
          const w = markerWidth(s.pressure, s.pointerType);
          if (mode.straight) mode.raw = straightLine(mode.raw[0], { x: qx, y: qy, w: mode.raw[0].w });
          else mode.raw.push({ x: qx, y: qy, w });
        }
        if (Math.hypot(px - mode.lastHoldPx[0], py - mode.lastHoldPx[1]) > 2) {
          mode.lastHoldPx = [px, py];
          armHold();
        }
        requestDraw();
        return;
      }
      case 'erase': {
        if (e.pointerId !== mode.pid) return;
        mode.movedPx = Math.max(mode.movedPx, Math.hypot(px - mode.startPx[0], py - mode.startPx[1]));
        const prev = mode.path[mode.path.length - 1];
        mode.path.push({ x: cx, y: cy });
        if (mode.movedPx >= CANVAS.tap_max_move_px) scrub([prev, { x: cx, y: cy }]);
        requestDraw();
        return;
      }
      case 'lasso':
        if (e.pointerId !== mode.pid) return;
        mode.path.push({ x: cx, y: cy });
        requestDraw();
        return;
      case 'move':
        if (e.pointerId !== mode.pid) return;
        mode.offset = [q(cx - mode.from[0], 1 / 16), q(cy - mode.from[1], 1 / 16)];
        requestDraw();
        return;
      case 'flag':
        if (e.pointerId !== mode.pid) return;
        mode.movedPx = Math.max(mode.movedPx, Math.hypot(px - mode.px0[0], py - mode.px0[1]));
        if (mode.movedPx >= CANVAS.tap_max_move_px) mode.at = [cx, cy];
        requestDraw();
        return;
      default:
        return;
    }
  });

  /** Eraser scrub against the current working set (hidden originals + pieces). */
  function scrub(path: { x: number; y: number }[]): void {
    const r = eraserR();
    const working = [...doc.data.strokes.filter((s) => !hidden.has(s.id) && !locked(s)), ...extra];
    for (const s of working) {
      const res = eraseStroke(s, path, r);
      if (!res) continue;
      const isExtra = extra.includes(s);
      if (isExtra) extra = extra.filter((x) => x !== s);
      else hidden.add(s.id);
      for (const piece of res) {
        const arr = toStrokeArrays(piece.pts);
        extra.push({ ...s, id: doc.newId('s'), pts: arr.pts, w: arr.w, closed: false, sheet: sheetOf(arr.pts[0][0]) });
      }
    }
  }

  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (mode.k === 'gesture') {
      if (pointers.size < 2) mode = { k: 'idle' };
      return;
    }
    if ('pid' in mode && mode.pid !== e.pointerId) return;
    const [px, py] = local(e);
    const [cx, cy] = view.toCells(px, py);
    const m = mode;
    mode = { k: 'idle' };
    window.clearTimeout(holdTimer);
    switch (m.k) {
      case 'draw':
        if (e.type === 'pointercancel') break;
        finishDraw(m);
        break;
      case 'erase': {
        const tap = m.movedPx < CANVAS.tap_max_move_px && performance.now() - m.t0 < 400;
        if (tap) {
          const hit = hitStroke(cx, cy);
          if (hit) doc.apply({ removed: [hit], added: [] });
        } else if (hidden.size || extra.length) {
          const removed = doc.data.strokes.filter((s) => hidden.has(s.id));
          doc.apply({ removed, added: extra });
        }
        hidden = new Set();
        extra = [];
        break;
      }
      case 'lasso': {
        if (m.path.length < 4 || polyLength(m.path) < 0.5) {
          if (!m.additive) setSelection(new Set());
          break;
        }
        const next = m.additive ? new Set(selection) : new Set<string>();
        for (const s of doc.data.strokes) if (!locked(s) && insideFraction(s, m.path) >= 0.6) next.add(s.id);
        setSelection(next);
        break;
      }
      case 'move': {
        const [dx, dy] = m.offset;
        if (Math.abs(dx) + Math.abs(dy) < 1 / 16) break;
        const sel = selectedStrokes().filter((s) => !locked(s));
        replace(sel, sel.map((s) => moved(s, dx, dy)));
        break;
      }
      case 'stamp': {
        const strokes = stampStrokes([q(cx, 1 / 8), q(cy, 1 / 8)]);
        if (strokes.length) {
          recentStrokes = new Set(strokes.map((s) => s.id));
          addKidStrokes(strokes);
        }
        break;
      }
      case 'flag': {
        // Tap the flag: play from here. Drag it: move where "play from here" starts.
        if (m.movedPx < CANVAS.tap_max_move_px) {
          void testPlay(m.at);
          break;
        }
        const at = hints?.level ? snapStandable(hints.level, m.at) ?? m.at : m.at;
        doc.apply({ removed: [], added: [], startAt: [doc.data.startAt, [q(at[0], 1 / 16), q(at[1], 1 / 16)]] });
        break;
      }
      default:
        break;
    }
    requestDraw();
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    if (tool === 'stamp' && mode.k === 'idle') {
      stampGhostAt = null;
      requestDraw();
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function finishDraw(m: Extract<Mode, { k: 'draw' }>): void {
    const dt = performance.now() - m.t0;
    const id = doc.newId('s');
    const first = m.raw[0];
    let stroke: InkStroke;
    if (isTap(m.movedPx, dt)) {
      // A tap stamps a 14 px dot (coin-sized) [B F7].
      stroke = {
        id, color, kind: 'dot', pts: [[q(first.x), q(first.y)]], w: [CANVAS.tap_dot_c], closed: true, sheet: sheetOf(first.x),
        origin: 'kid', t: doc.nextT(),
      };
    } else if (m.raw.length < 2) {
      return;
    } else {
      const pts = m.straight ? m.raw.map((p) => ({ x: q(p.x), y: q(p.y), w: p.w })) : finishPoints(m.raw);
      if (pts.length < 2 || polyLength(pts) < 0.1) return;
      const arr = toStrokeArrays(pts);
      const L = polyLength(pts);
      const a = pts[0];
      const b = pts[pts.length - 1];
      const closed = !m.straight && L > 2.5 && Math.hypot(a.x - b.x, a.y - b.y) <= 0.6;
      stroke = { id, color, kind: 'line', pts: arr.pts, w: arr.w, closed, sheet: sheetOf(a.x), origin: 'kid', t: doc.nextT() };
    }
    recentStrokes = new Set([stroke.id]);
    addKidStrokes([stroke]);
  }

  function handlePick(cx: number, cy: number): void {
    if (pick === 'door') {
      const door = hitStroke(cx, cy);
      pick = null;
      if (!door) {
        toast(t('editor.pick_cancelled'));
        return;
      }
      const keys = selectedStrokes().filter((s) => s.id !== door.id && !locked(s));
      if (!keys.length) return;
      const linked = linkKey(keys, door.id);
      const doorLabelled: InkStroke = { ...door, label: 'door' };
      doc.apply({ removed: [...keys, door], added: [...linked, doorLabelled] });
      toast(t('understand.linked'));
    } else if (pick === 'start') {
      pick = null;
      void testPlay([cx, cy]);
    }
    requestDraw();
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = local(e);
    if (e.ctrlKey || e.metaKey) {
      view.zoomAt(Math.exp(-e.deltaY * 0.01), px, py);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      view.panBy(-e.deltaX, 0);
    } else if (e.shiftKey || view.cellsH >= WORLD.h) {
      view.panBy(-e.deltaY, 0);
    } else {
      view.panBy(0, -e.deltaY);
    }
    requestDraw();
  }, { passive: false });

  function zoomBy(k: number): void {
    view.zoomAt(k, view.w / 2, view.h / 2);
    requestDraw();
  }

  // ---- keyboard -----------------------------------------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!shell.isConnected || isTyping(e)) return;
    if (document.querySelector('.modal-back')) return; // a studio is open: its own keys
    if (!playOverlay.classList.contains('hidden')) {
      if (e.key === 'Escape') stopTestPlay();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ' && !spaceDown) {
      spaceDown = true;
      syncTools();
      e.preventDefault();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doc.redo();
      else doc.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doc.redo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selection.size) {
        e.preventDefault();
        deleteSelection();
      }
    } else if (e.key === 'Escape') {
      pick = null;
      setSelection(new Set());
      closeSide();
    } else if (!mod) {
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '4') {
        color = MARKERS[Number(k) - 1].color;
        setTool('marker');
      } else if (k === 'b' || k === 'm') setTool('marker');
      else if (k === 'e') setTool('eraser');
      else if (k === 'v') setTool('select');
      else if (k === 'h') setTool('pan');
      else if (k === 'p') void testPlay(null);
      else if (k === 'f') {
        view.fitScreen();
        requestDraw();
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      spaceDown = false;
      syncTools();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ---- screens ---------------------------------------------------------------------------------------------------------
  addScreenBtn.onclick = () => {
    if (doc.data.screens >= WORLD.max_screens) return;
    const k = doc.data.screens;
    doc.apply({ removed: [], added: [], screens: [k, k + 1] });
    view.worldW = WORLD.screen_w * (k + 1);
    view.centerOn(k * WORLD.screen_w + WORLD.screen_w / 2);
    requestDraw();
  };
  trimBtn.onclick = () => {
    if (!doc.lastScreenEmpty()) return;
    const k = doc.data.screens;
    doc.apply({ removed: [], added: [], screens: [k, k - 1] });
    view.worldW = WORLD.screen_w * (k - 1);
    view.clamp();
    requestDraw();
  };

  // ---- ▶ test-play (local core, Faithful, repairUnsolvable false) -----------------------------------------------------
  let pressTimer = 0;
  let longPressed = false;
  playBtn.addEventListener('pointerdown', () => {
    longPressed = false;
    pressTimer = window.setTimeout(() => {
      longPressed = true;
      pick = 'start';
      toast(t('editor.pick_start'));
      requestDraw();
    }, 550);
  });
  playBtn.addEventListener('pointerup', () => window.clearTimeout(pressTimer));
  playBtn.addEventListener('pointerleave', () => window.clearTimeout(pressTimer));
  playBtn.addEventListener('click', () => {
    if (longPressed) return;
    void testPlay(null);
  });

  async function freshHints(): Promise<HintsResult | null> {
    window.clearTimeout(hintsTimer);
    if (hints && hints.rev === doc.rev) return hints;
    return runHints();
  }

  async function testPlay(from: CellXY | null): Promise<void> {
    if (!doc.data.strokes.length) {
      toast(t('editor.draw_first'));
      return;
    }
    playBtn.disabled = true;
    try {
      const r = await freshHints();
      if (!r) {
        toast(t('editor.test_resting'));
        return;
      }
      let startAt: CellXY | undefined;
      if (from) {
        const snapped = snapStandable(r.level, from);
        if (snapped) {
          startAt = snapped;
          const cur = doc.data.startAt;
          if (!cur || Math.abs(cur[0] - snapped[0]) > 1e-6 || Math.abs(cur[1] - snapped[1]) > 1e-6) {
            doc.apply({ removed: [], added: [], startAt: [cur, snapped] });
          }
        }
      }
      await startTestPlay(r.level, r.ink, startAt);
    } finally {
      playBtn.disabled = false;
    }
  }

  async function startTestPlay(level: LevelV2, ink: InkDoc, startAt?: CellXY): Promise<void> {
    stopTestPlay();
    let mountGame: typeof import('../engine/index.ts').mountGame;
    try {
      ({ mountGame } = await import('../engine/index.ts'));
    } catch (err) {
      console.warn('engine failed to load', err);
      toast(t('editor.test_resting'));
      return;
    }
    if (destroyed) return;
    const host = h('div', { class: 'game-host' });
    const back = h('button', { type: 'button', class: 'pill', onclick: () => stopTestPlay() }, icon('pencil'), t('editor.back_to_drawing'));
    const again = h('button', { type: 'button', class: 'pill', onclick: () => game?.restart('start') }, icon('retry'), t('results.retry'));
    playOverlay.replaceChildren(h('div', { class: 'play-bar' }, back, again, h('span', { class: 'muted small' }, t('editor.test_note'))), host);
    playOverlay.classList.remove('hidden');
    try {
      game = mountGame(host, level, ink, {
        mode: 'test', rules: level.rules ?? o.rules, startAt, audio: !store.flag('muted'), reducedMotion: prefersReducedMotion(),
      });
      game.on('win', () => toast(t('editor.test_won'), { action: { label: t('editor.back_to_drawing'), run: stopTestPlay } }));
      game.on('entity_error', (p: { thing?: string; where?: string } | undefined) => toast(t('error.entity', { thing: p?.thing ?? t('editor.something'), where: p?.where ?? t('editor.here') })));
    } catch (err) {
      console.warn('test-play mount failed', err);
      stopTestPlay();
      toast(t('editor.test_resting'));
    }
  }

  function stopTestPlay(): void {
    game?.destroy();
    game = null;
    playOverlay.classList.add('hidden');
    playOverlay.replaceChildren();
    canvas.focus({ preventScroll: true });
  }

  // ---- submit -------------------------------------------------------------------------------------------------------
  submitBtn.onclick = async () => {
    if (!doc.data.strokes.length) {
      toast(t('editor.draw_first'));
      return;
    }
    submitBtn.disabled = true;
    try {
      const ink = await coreClient().ink({
        strokes: doc.data.strokes, screens: doc.data.screens, character: doc.data.character, rules: doc.data.rules, parent: doc.data.parent,
        allowBare: true,
      });
      await o.onSubmit(doc.snapshot(), ink);
    } catch (err) {
      console.warn('submit failed', err);
      toast(t('error.build_failed'));
    } finally {
      submitBtn.disabled = false;
    }
  };

  // ---- wiring ----------------------------------------------------------------------------------------------------------
  let saveTimer = 0;
  const off = doc.on((why) => {
    syncTools();
    renderStatus();
    requestDraw();
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => o.onChange(doc.snapshot()), 400);
    if (why === 'meta') return;
    if (why === 'undo' || why === 'redo' || why === 'load') recentStrokes = new Set();
    // Drop selections of strokes that no longer exist.
    const ids = new Set(doc.data.strokes.map((s) => s.id));
    if ([...selection].some((id) => !ids.has(id))) setSelection(new Set([...selection].filter((id) => ids.has(id))));
    if (sidePanel.dataset.panel === 'rules') renderRules();
    if (hintsOn || mode.k === 'idle') scheduleHints();
  });

  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap);
  resize();
  view.fitScreen();
  // Start at the first screen.
  view.x = -0.5;
  view.clamp();
  syncTools();
  renderStatus();
  scheduleHints(0);
  raf = requestAnimationFrame(frame);

  return {
    doc,
    lastBuild: () => (hints && hints.rev === doc.rev ? { level: hints.level, ink: hints.ink } : null),
    useLibraryStamp: (typeId: string) => pickLibraryStamp(typeId),
    setParentLevel(level: LevelV2 | null) {
      parentLevel = level;
      remixAdded = null;
      changesMemo = null;
      if (level && doc.data.parent && !doc.data.parentStrokes) {
        doc.data.parentStrokes = (level.ink?.strokes ?? []).map((s) => ({ ...s, origin: 'parent' as const }));
      }
      scheduleHints(0);
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(hintsTimer);
      window.clearTimeout(saveTimer);
      o.onChange(doc.snapshot());
      off();
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      stopTestPlay();
      shell.remove();
    },
    view,
    canvas,
    liveStroke: () => (mode.k === 'draw' ? { pts: mode.raw, color } : null),
    setOverlay(fn: EditorOverlay | null) {
      overlay = fn;
      requestDraw();
    },
    setReadOnly(onBlocked: (() => void) | null) {
      readOnly = onBlocked;
    },
    requestDraw,
  };
}

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

