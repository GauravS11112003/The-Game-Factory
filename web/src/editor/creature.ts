/**
 * Creature Studio (§8.1 "Make one" 1 and 2): draw it, name it, then pick chips (walks, hops, flies, shoots, chases,
 * crushes, stays still; spiky; slow ↔ fast) or type a sentence. "Read it" asks the CREATURE call
 * (POST /api/v2/library/interpret); offline, or before the kid asks, the keyword reader pre-selects the chips.
 * A mini-stage shows it moving with gravity against a dummy player. Optionally "draw its symbol 3 times" registers a
 * paper symbol. Saving writes an immutable LibraryType (editing an existing type saves version n + 1, D21).
 * Opened from the library screen, from the editor toolbar, or with a level object's strokes ("Save to library":
 * its strokes and behavior are kept).
 * The drawing part (`inkPad`: the 3 × 3-cell pad with its own tools) and the symbol cells (`symbolCells`) need no
 * game, so the v4 Block Studio and the workspace legend reuse them.
 */
import type { Behavior, InkColor, InkStroke, LibrarySymbol, LibraryType, Rig } from '../core/types.gen.ts';
import { extractRig } from '../core/index.ts';
import { LIBRARY } from '../core/params.ts';
import { api, ApiError } from '../app/api.ts';
import { h, icon, toast } from '../app/dom.ts';
import { kidText, t } from '../app/messages.ts';
import { store } from '../app/store.ts';
import {
  ARCHETYPES, assignLetter, chipsOfBehavior, creatureBehavior, readCreature, type CreatureArchetype,
} from '../app/creature_words.ts';
import { bindingTag, type Speed } from './chips.ts';
import { CreatureStage, creatureSize } from './creature_stage.ts';
import { strokesBBox } from './geom.ts';
import { INK } from './paint.ts';
import { SketchPad } from './sketchpad.ts';

export interface CreatureStudioOptions {
  gameId: string;
  /** The game's library (latest versions): letters in use, and the base type when editing. */
  library: LibraryType[];
  /** Edit an existing type: saving makes version n + 1. */
  base?: LibraryType | null;
  /** "Save to library" from a level: the object's strokes (world cells) and its behavior. */
  strokes?: InkStroke[];
  behavior?: Behavior | null;
  onSaved(type: LibraryType): void;
}

const VIEW = { x0: -0.5, y0: -0.5, size: 3 }; // 3 × 3 cells; the creature's box is (0,0)-(2,2), feet on y = 2
const BOX = 2;
const PEN = 0.1;
const SYMBOL_VIEW = { x0: 0, y0: 0, size: 1.5 };

const ARCH_CHIP: Record<CreatureArchetype, { key: string; icon: string }> = {
  walker: { key: 'chip.walks', icon: '🚶' },
  hopper: { key: 'chip.hops', icon: '🐸' },
  flyer: { key: 'chip.flies', icon: '🦇' },
  shooter: { key: 'chip.shoots', icon: '💥' },
  chaser: { key: 'chip.chases', icon: '😠' },
  crusher: { key: 'chip.crushes', icon: '⬇' },
  static: { key: 'chip.stays', icon: '🗿' },
};

/** Move and scale strokes so their box sits on the studio's feet line, centred, longest side ≤ 2 cells. */
export function normalizeArt(strokes: readonly InkStroke[], prefix = 'k'): InkStroke[] {
  const bb = strokesBBox(strokes);
  if (!bb) return [];
  const w = Math.max(0.05, bb[2] - bb[0]);
  const hh = Math.max(0.05, bb[3] - bb[1]);
  const k = Math.min(1, (BOX * 0.95) / Math.max(w, hh)) * (Math.max(w, hh) < 0.6 ? 1.6 : 1);
  const cx = (bb[0] + bb[2]) / 2;
  const q = (v: number): number => Math.round(v * 64) / 64;
  let n = 1;
  return strokes.map((s) => ({
    id: `${prefix}${n++}`, color: s.color === 'draft' || s.color === 'pencil' ? 'black' : s.color, kind: s.kind,
    pts: s.pts.map(([x, y]) => [q(BOX / 2 + (x - cx) * k), q(BOX + (y - bb[3]) * k)]),
    w: s.w.map((v) => Math.max(0.06, q(v * k))), closed: s.closed, sheet: 0, origin: 'kid', t: n,
  }));
}

function kindOf(b: Behavior): LibraryType['kind'] {
  switch (b.kind) {
    case 'enemy':
      return 'creature';
    case 'move':
    case 'crumble':
    case 'falling':
    case 'spring':
      return 'platform';
    case 'saw':
    case 'firebar':
      return 'hazard';
    default:
      return 'creature';
  }
}

function collisionOf(b: Behavior): LibraryType['collision'] {
  return b.kind === 'move' || b.kind === 'crumble' || b.kind === 'falling' ? 'one_way' : b.kind === 'spring' ? 'solid' : 'none';
}

function newTypeId(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'creature';
  return `lt_${slug}_${Math.random().toString(36).slice(2, 7)}`;
}

// ---- the drawing pad and the symbol cells (no game needed) ------------------------------------------------------------

export interface InkPad {
  readonly pad: SketchPad;
  /** Marker, eraser, the four inks, undo, redo, clear. */
  readonly toolrow: HTMLElement;
  /** Ctrl/Cmd-Z and Shift-Ctrl/Cmd-Z on the pad; true when the key was used. */
  undoKey(e: KeyboardEvent): boolean;
}

/** The 3 × 3-cell drawing pad with the body box and feet line, and its own tool row. */
export function inkPad(o: { strokes?: InkStroke[]; onChange?: (strokes: InkStroke[]) => void }): InkPad {
  const pad = new SketchPad({
    px: 640, view: VIEW, pen: PEN, strokes: o.strokes ?? [], idPrefix: 'k',
    guide: (ctx, P, S) => {
      const [x0, y0] = P(0, 0);
      ctx.save();
      ctx.setLineDash([10, 7]);
      ctx.strokeStyle = 'rgba(106,90,205,0.5)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x0, y0, BOX * S, BOX * S);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(31,27,24,0.4)';
      ctx.beginPath();
      ctx.moveTo(0, y0 + BOX * S);
      ctx.lineTo(ctx.canvas.width, y0 + BOX * S);
      ctx.stroke();
      ctx.restore();
    },
    onChange: (s) => {
      syncTools();
      o.onChange?.(s);
    },
  });
  pad.canvas.setAttribute('aria-label', t('creature.help'));
  const swatches = (['black', 'red', 'green', 'blue'] as InkColor[]).map((c) => {
    const b = h('button', { type: 'button', class: 'swatch', title: t(`color.${c}`), 'aria-label': t(`color.${c}`), style: { background: INK[c] }, onclick: () => { pad.setColor(c); syncTools(); } });
    b.dataset.color = c;
    return b;
  });
  const markerBtn = h('button', { type: 'button', class: 'tool', onclick: () => { pad.tool = 'marker'; syncTools(); } }, icon('marker'), h('span', { class: 'lbl' }, t('tool.marker')));
  const eraserBtn = h('button', { type: 'button', class: 'tool', onclick: () => { pad.tool = 'eraser'; syncTools(); } }, icon('eraser'), h('span', { class: 'lbl' }, t('tool.eraser')));
  const undoBtn = h('button', { type: 'button', class: 'tool', title: t('tool.undo'), 'aria-label': t('tool.undo'), onclick: () => pad.undo() }, icon('undo'));
  const redoBtn = h('button', { type: 'button', class: 'tool', title: t('tool.redo'), 'aria-label': t('tool.redo'), onclick: () => pad.redo() }, icon('redo'));
  const clearBtn = h('button', { type: 'button', class: 'tool', onclick: () => pad.clear() }, icon('trash'), h('span', { class: 'lbl' }, t('studio.clear')));
  const toolrow = h('div', { class: 'toolrow' }, markerBtn, eraserBtn, ...swatches, undoBtn, redoBtn, clearBtn);

  function syncTools(): void {
    markerBtn.classList.toggle('on', pad.tool === 'marker');
    eraserBtn.classList.toggle('on', pad.tool === 'eraser');
    for (const s of swatches) s.classList.toggle('on', pad.tool === 'marker' && s.dataset.color === pad.color);
    undoBtn.disabled = !pad.canUndo();
    redoBtn.disabled = !pad.canRedo();
  }
  syncTools();
  return {
    pad, toolrow,
    undoKey(e: KeyboardEvent): boolean {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return false;
      e.preventDefault();
      if (e.shiftKey) pad.redo();
      else pad.undo();
      return true;
    },
  };
}

export interface SymbolCells {
  /** A `<details>` box (the help line, the ink swatches and the three cells); a plain box when `bare`. */
  readonly el: HTMLElement;
  /** The symbol when all three cells are drawn, else null. */
  value(): LibrarySymbol | null;
  /** How many cells have ink. */
  filled(): number;
}

/** "Draw one little sign 3 times" (§8.1): three small one-colour pads. */
export function symbolCells(o: { symbol?: LibrarySymbol | null; open?: boolean; bare?: boolean; onChange?: () => void } = {}): SymbolCells {
  let color: InkColor = o.symbol?.color ?? 'black';
  const pads = [0, 1, 2].map((i) => new SketchPad({
    px: 192, view: SYMBOL_VIEW, pen: 0.09, idPrefix: `y${i}_`, singleColor: true,
    strokes: o.symbol?.samples[i] ?? [], onChange: () => sync(),
  }));
  for (const sp of pads) sp.color = color;
  const swatches = (['black', 'red', 'green', 'blue'] as InkColor[]).map((c) => {
    const b = h('button', {
      type: 'button', class: 'swatch small', title: t(`color.${c}`), 'aria-label': t(`color.${c}`), style: { background: INK[c] },
      onclick: () => { color = c; for (const sp of pads) sp.setColor(c); sync(); },
    });
    b.dataset.color = c;
    return b;
  });
  const note = h('span', { class: 'small muted', role: 'status' });
  const body = [
    h('div', { class: 'row wrap' }, ...swatches, note),
    h('div', { class: 'symbol-cells' }, ...pads.map((sp, i) => h('div', { class: 'symbol-cell' }, sp.canvas,
      h('button', { type: 'button', class: 'tool small', title: t('studio.clear'), onclick: () => sp.clear() }, icon('trash'), h('span', { class: 'lbl' }, String(i + 1)))))),
  ];
  const el = o.bare ? h('div', { class: 'symbol-box' }, ...body)
    : h('details', { class: 'symbol-box', open: o.open ?? !!o.symbol },
      h('summary', null, t('creature.symbol')),
      h('p', { class: 'small muted' }, t('creature.symbol_help')),
      ...body);
  const filled = (): number => pads.filter((sp) => sp.value.length).length;
  function sync(): void {
    for (const s of swatches) s.classList.toggle('on', s.dataset.color === color);
    const n = filled();
    note.textContent = n === 0 ? '' : n < 3 ? t('creature.symbol_more', { n: 3 - n }) : t('creature.symbol_ready');
    o.onChange?.();
  }
  sync();
  return {
    el, filled,
    value: () => {
      const s = pads.map((sp) => sp.value);
      return s.every((x) => x.length) ? { samples: [s[0], s[1], s[2]], color } : null;
    },
  };
}

/** A library type's art for a version: strokes as drawn, size from the drawing, and its rig when one is found. */
export function artOf(strokes: InkStroke[]): LibraryType['art'] {
  let rig: Rig | null = null;
  try {
    rig = extractRig(strokes);
  } catch {
    rig = null;
  }
  return { strokes, size_cells: creatureSize(strokes), rig };
}

export function openCreatureStudio(o: CreatureStudioOptions): () => void {
  const base = o.base ?? null;
  const fromLevel = !base && !!o.strokes?.length;
  const startStrokes = base ? normalizeArt(base.art.strokes) : o.strokes?.length ? normalizeArt(o.strokes) : [];
  const keptBehavior: Behavior | null = base ? base.behavior : o.behavior ?? null;
  const fromChips = chipsOfBehavior(keptBehavior);
  // A non-creature behavior (a moving ledge, a spring) is kept as it was: chips choose creature behaviors only.
  let kept: Behavior | null = keptBehavior && !fromChips ? keptBehavior : null;
  let archetype: CreatureArchetype = fromChips?.archetype ?? 'walker';
  let speed: Speed = fromChips?.speed ?? 'normal';
  let spiky = base?.spiky ?? fromChips?.spiky ?? false;
  let manual = !!(base || keptBehavior); // the kid (or the source object) already chose; the words only pre-fill
  let source: 'model' | 'keywords' | null = null;
  let saving = false;

  const stage = new CreatureStage(512);
  const behavior = (): Behavior => kept ?? creatureBehavior(archetype, speed, spiky);

  const ink = inkPad({ strokes: startStrokes, onChange: () => sync() });
  const pad = ink.pad;
  const symbol = symbolCells({ symbol: base?.symbol ?? null });

  // ---- DOM ------------------------------------------------------------------------------------------------------
  const nameIn = h('input', { type: 'text', class: 'text', maxLength: LIBRARY.name_max, placeholder: t('creature.name_placeholder'), value: base?.name ?? '' });
  const letterEl = h('span', { class: 'letter-badge', title: t('creature.letter_help') });
  const whatIn = h('input', { type: 'text', class: 'text', maxLength: 160, placeholder: t('creature.what_placeholder') });
  const readBtn = h('button', { type: 'button', class: 'pill small accent' }, icon('question'), t('creature.read'));
  const readNote = h('p', { class: 'small muted read-note' });
  const archRow = h('div', { class: 'chips' });
  const speedRow = h('div', { class: 'chips' });
  const spikyBtn = h('button', { type: 'button', class: 'chip big' });
  const keptRow = h('div', { class: 'chips' });
  const status = h('p', { class: 'small muted', role: 'status' });
  const saveBtn = h('button', { type: 'button', class: 'pill primary' }, icon('star'), t(base ? 'creature.save_version' : 'creature.save'));
  const cancel = h('button', { type: 'button', class: 'pill', onclick: () => close() }, t('ui.cancel'));

  const panel = h('div', { class: 'modal-back', role: 'dialog', 'aria-label': t('creature.title') },
    h('div', { class: 'card paper studio creature-studio' },
      h('h2', { class: 'marker-underline' }, base ? t('creature.title_edit', { name: base.name }) : t(fromLevel ? 'creature.title_from_level' : 'creature.title')),
      h('p', { class: 'muted' }, t('creature.help')),
      h('div', { class: 'studio-body' },
        h('div', { class: 'studio-left' },
          ink.toolrow,
          pad.canvas,
          symbol.el),
        h('div', { class: 'studio-right' },
          h('label', { class: 'field' }, h('span', null, t('creature.name')), h('span', { class: 'row' }, nameIn, letterEl)),
          h('div', { class: 'field' }, h('span', null, t('creature.what')), h('span', { class: 'row' }, whatIn, readBtn)),
          readNote,
          keptRow,
          h('div', { class: 'small muted' }, t('creature.does')), archRow,
          h('div', { class: 'small muted' }, t('chip.speed')), speedRow,
          h('div', { class: 'chips' }, spikyBtn),
          h('h3', null, t('creature.watch')),
          stage.canvas,
          status)),
      h('div', { class: 'row end' }, cancel, saveBtn)));
  document.body.append(panel);
  stage.start();

  function usedLetters(): string[] {
    return o.library.filter((x) => !base || x.id !== base.id).map((x) => x.letter);
  }

  function letter(): string {
    return base?.letter ?? assignLetter(nameIn.value.trim() || 'A', usedLetters());
  }

  function renderChips(): void {
    archRow.replaceChildren(...ARCHETYPES.map((a) => h('button', {
      type: 'button', class: `chip big${!kept && archetype === a ? ' on' : ''}`,
      onclick: () => { kept = null; archetype = a; manual = true; renderChips(); sync(); },
    }, h('span', { class: 'emo' }, ARCH_CHIP[a].icon), t(ARCH_CHIP[a].key))));
    speedRow.replaceChildren(...(['slow', 'normal', 'fast'] as Speed[]).map((sp) => h('button', {
      type: 'button', class: `chip${!kept && speed === sp ? ' on' : ''}`, disabled: !!kept || archetype === 'static',
      onclick: () => { speed = sp; manual = true; renderChips(); sync(); },
    }, t(`chip.speed_${sp}`))));
    spikyBtn.className = `chip big${spiky ? ' on' : ''}`;
    spikyBtn.replaceChildren(h('span', { class: 'emo' }, '▲'), t('creature.spiky'));
    spikyBtn.onclick = () => {
      spiky = !spiky;
      manual = true;
      renderChips();
      sync();
    };
    const keptTag = keptBehavior && !chipsOfBehavior(keptBehavior) ? bindingTag({ id: 'x', color: 'black', kind: 'line', pts: [[0, 0]], w: [0.5], closed: false, sheet: 0, origin: 'kid', rule: keptBehavior }) : null;
    keptRow.replaceChildren(...(keptTag ? [h('button', {
      type: 'button', class: `chip big${kept ? ' on' : ''}`, onclick: () => { kept = kept ? null : keptBehavior; renderChips(); sync(); },
    }, t('creature.keeps', { what: keptTag }))] : []));
  }

  function sync(): void {
    stage.set(pad.value, behavior(), spiky);
    letterEl.textContent = letter();
    letterEl.title = t('creature.letter', { letter: letter() });
  }

  // ---- words → chips -------------------------------------------------------------------------------------------
  let wordsTimer = 0;
  const readLocal = (announce: boolean): void => {
    const r = readCreature(nameIn.value, whatIn.value);
    if (!r.matched) {
      if (announce) readNote.textContent = t('creature.read_nothing');
      return;
    }
    kept = null;
    archetype = r.archetype;
    speed = r.speed;
    spiky = r.spiky;
    source = 'keywords';
    readNote.textContent = t('creature.read_words', { what: summary() });
    renderChips();
    sync();
  };
  whatIn.oninput = () => {
    window.clearTimeout(wordsTimer);
    if (manual) return;
    wordsTimer = window.setTimeout(() => readLocal(false), 350);
  };
  whatIn.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') readBtn.click();
  };
  nameIn.onkeydown = (e) => e.stopPropagation();
  nameIn.oninput = () => sync();
  readBtn.onclick = async () => {
    const text = whatIn.value.trim();
    if (!text) {
      whatIn.focus();
      return;
    }
    readBtn.disabled = true;
    try {
      const r = await api.interpret(nameIn.value.trim(), text, pad.value);
      if (!r.spec || !ARCHETYPES.includes(r.spec.archetype)) throw new ApiError(422, 'error.bad_request');
      if (!r.spec.safety_ok) {
        readNote.textContent = t('creature.not_ok');
        return;
      }
      kept = null;
      archetype = r.spec.archetype;
      speed = r.spec.speed;
      spiky = r.spec.spiky;
      source = r.source;
      manual = true;
      readNote.textContent = t(r.source === 'model' ? 'creature.read_model' : 'creature.read_words', { what: summary() });
      renderChips();
      sync();
    } catch {
      manual = false;
      readLocal(true);
      manual = true;
    } finally {
      readBtn.disabled = false;
    }
  };

  function summary(): string {
    const bits = [t(ARCH_CHIP[archetype].key)];
    if (archetype !== 'static' && speed !== 'normal') bits.push(t(`chip.speed_${speed}`));
    if (spiky) bits.push(t('creature.spiky_short'));
    return bits.join(' · ');
  }

  // ---- save -------------------------------------------------------------------------------------------------------
  saveBtn.onclick = async () => {
    if (saving) return;
    const strokes = pad.value;
    const name = kidText(nameIn.value.trim()).slice(0, LIBRARY.name_max);
    if (!strokes.length) {
      status.textContent = t('creature.need_drawing');
      return;
    }
    if (!name) {
      status.textContent = t('creature.need_name');
      nameIn.focus();
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    status.textContent = t('ui.saving');
    const b = behavior();
    const type: LibraryType = {
      id: base?.id ?? newTypeId(name), game_id: o.gameId, version: base ? base.version + 1 : 1, name, letter: letter(),
      kind: kindOf(b), behavior: b, spiky: b.kind === 'enemy' ? !!b.spiky : spiky, collision: collisionOf(b),
      art: artOf(strokes), symbol: symbol.value(),
      author: store.author() || t('ui.someone'), created_at: new Date().toISOString(),
    };
    try {
      const saved = base ? await api.newLibraryVersion(o.gameId, type) : await api.addLibrary(o.gameId, type);
      const out: LibraryType = saved && typeof saved === 'object' && 'id' in saved ? { ...type, ...saved } : type;
      toast(base ? t('library.new_version', { name: out.name }) : t('library.saved'));
      void source;
      close();
      o.onSaved(out);
    } catch (e) {
      status.textContent = t(e instanceof ApiError ? e.messageKey : 'error.build_failed', e instanceof ApiError ? e.args : {});
      saving = false;
      saveBtn.disabled = false;
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else ink.undoKey(e);
  };
  window.addEventListener('keydown', onKey);

  function close(): void {
    stage.stop();
    window.removeEventListener('keydown', onKey);
    window.clearTimeout(wordsTimer);
    panel.remove();
  }

  renderChips();
  sync();
  if (!base) nameIn.focus();
  return close;
}
