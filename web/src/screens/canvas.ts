/**
 * #/draw?parent=&game=&draft= Canvas (PLAN.md section 10). Owned by lane D.
 *
 * 768x432 drawing canvas with the four palette brushes (8 px round), eraser,
 * undo and clear; a 128x128 character canvas; a rules textarea. With ?parent=
 * the parent level is drawn in light gray on a separate layer under the canvas
 * (not part of the submitted PNG, exactly like the gray ink on a remix sheet).
 * Submit composes the drawing on white and posts mode=canvas with prompt =
 * rules text and the character canvas as a second file, then shows the same
 * preview as the scan screen.
 */
import { assetUrl, getDraft, getLevel, scanImage, type ScanResponse } from '../api';
import type { Level } from '../types';
import { button, clear, el, errorBox, errorMessage, link, qs, setTitle, spinner } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { renderPreview } from './preview';

const W = 768;
const H = 432;
const CHAR = 128;
const BRUSH_PX = 8;
const ERASER_PX = 24;
const UNDO_DEPTH = 25;
const RULES_SWITCH_MS = 2500;

const PALETTE = [
  { name: 'black', hex: '#000000', meaning: 'ground' },
  { name: 'red', hex: '#e53935', meaning: 'spikes / enemies' },
  { name: 'green', hex: '#43a047', meaning: 'goal' },
  { name: 'blue', hex: '#1e88e5', meaning: 'coins / keys' },
] as const;

interface Tool {
  color: string;
  eraser: boolean;
}

interface Surface {
  canvas: HTMLCanvasElement;
  undo(): void;
  clear(): void;
  isEmpty(): boolean;
}

function makeSurface(canvas: HTMLCanvasElement, tool: Tool, brushScale = 1): Surface {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas not supported');
  const undoStack: ImageData[] = [];
  let drawing = false;
  let last: { x: number; y: number } | null = null;

  const pos = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height };
  };
  const snapshot = (): void => {
    undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  };
  const applyTool = (): void => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (tool.eraser ? ERASER_PX : BRUSH_PX) * brushScale;
    ctx.strokeStyle = tool.color;
    ctx.globalCompositeOperation = tool.eraser ? 'destination-out' : 'source-over';
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    snapshot();
    applyTool();
    const p = pos(e);
    drawing = true;
    last = p;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y); // a tap leaves a dot
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    e.preventDefault();
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });
  const end = (e: PointerEvent): void => {
    if (!drawing) return;
    drawing = false;
    last = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  return {
    canvas,
    undo() {
      const s = undoStack.pop();
      if (s) ctx.putImageData(s, 0, 0);
    },
    clear() {
      snapshot();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    isEmpty() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) return false;
      return true;
    },
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = url;
  });
}

/** The parent level as light gray ink: its backdrop when it has one, else its grid. */
async function drawParentUnderlay(under: HTMLCanvasElement, level: Level): Promise<void> {
  const ctx = under.getContext('2d');
  if (!ctx) return;
  const c = level.grid.cell;
  let drawn = false;
  const url = assetUrl(level.source.backdrop_url);
  if (url) {
    try {
      const img = await loadImage(url);
      ctx.drawImage(img, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        const ink = (d[i] ?? 255) + (d[i + 1] ?? 255) + (d[i + 2] ?? 255) < 720;
        if (ink) {
          d[i] = d[i + 1] = d[i + 2] = 176;
          d[i + 3] = 255;
        } else {
          d[i + 3] = 0;
        }
      }
      ctx.putImageData(id, 0, 0);
      drawn = true;
    } catch {
      drawn = false;
    }
  }
  if (!drawn) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#b0b0b0';
    level.grid.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] !== '0') ctx.fillRect(x * c, y * c, c, c);
    });
    for (const e of level.entities) {
      if (e.bbox) {
        const [x0, y0, x1, y1] = e.bbox;
        ctx.fillRect(x0 * c, y0 * c, (x1 - x0 + 1) * c, (y1 - y0 + 1) * c);
      }
    }
  }
  ctx.fillStyle = '#8c8c8c';
  ctx.font = 'bold 11px system-ui, sans-serif';
  for (const comp of level.components) {
    ctx.fillText(String(comp.id), comp.bbox[0] * c + 2, Math.max(10, comp.bbox[1] * c - 2));
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not export the drawing'))), 'image/png');
  });
}

async function composeDrawing(surface: Surface): Promise<Blob> {
  const out = el('canvas', { width: W, height: H });
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2D canvas not supported');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(surface.canvas, 0, 0);
  return toBlob(out);
}

export async function render(root: HTMLElement, ctx: RouteCtx): Promise<Cleanup> {
  const parentId = ctx.query.get('parent');
  const gameId = ctx.query.get('game');
  const draftId = ctx.query.get('draft');
  setTitle('Draw a level');

  let alive = true;
  let previewCleanup: (() => void) | null = null;
  const baseHash = `#/draw${qs({ parent: parentId, game: gameId })}`;
  const draftHash = (id: string): string => `#/draw${qs({ parent: parentId, game: gameId, draft: id })}`;

  const tool: Tool = { color: PALETTE[0].hex, eraser: false };
  const drawCanvas = el('canvas', { width: W, height: H, className: 'draw-canvas' });
  const underCanvas = el('canvas', { width: W, height: H, className: 'under-canvas' });
  const charCanvas = el('canvas', { width: CHAR, height: CHAR, className: 'char-canvas' });
  const drawing = makeSurface(drawCanvas, tool);
  const character = makeSurface(charCanvas, tool, 0.75);

  const paletteButtons = PALETTE.map((p) => {
    const b = button('', () => select(p.hex, false), 'swatch');
    b.style.setProperty('--swatch', p.hex);
    b.title = `${p.name}: ${p.meaning}`;
    b.setAttribute('aria-label', `${p.name} brush`);
    return b;
  });
  const eraserBtn = button('Eraser', () => select(tool.color, true), 'tool');
  const select = (hex: string, eraser: boolean): void => {
    tool.color = hex;
    tool.eraser = eraser;
    paletteButtons.forEach((b, i) => b.classList.toggle('active', !eraser && PALETTE[i]?.hex === hex));
    eraserBtn.classList.toggle('active', eraser);
  };
  select(tool.color, false);

  const rules = el('textarea', {
    rows: 3,
    placeholder: 'e.g. the platform moves right 8 cells; the door opens with the key; timer 60',
    className: 'rules',
  });

  const context = el('div', { className: 'context' });
  if (parentId) {
    context.append(el('p', { className: 'muted' }, 'Remixing ', parentId, '. The original shows in gray; draw your additions in color.'));
    getLevel(parentId)
      .then((d) => {
        context.replaceChildren(el('p', { className: 'muted' }, 'Remixing “', d.level.title, '” by ', d.author, '. The original shows in gray; draw your additions in color.'));
        return drawParentUnderlay(underCanvas, d.level);
      })
      .catch((err: unknown) => context.replaceChildren(errorBox(`Couldn’t load the parent level: ${errorMessage(err)}`)));
  } else if (gameId) {
    context.append(el('p', { className: 'muted' }, 'Adding a level to ', el('a', { href: `#/game/${encodeURIComponent(gameId)}` }, gameId), '.'));
  } else {
    context.append(el('p', { className: 'muted' }, 'Publishing a drawing with no game creates a new game.'));
  }

  const status = el('div', { className: 'publish-status' });
  const submitBtn = button('Make it a level', () => void submit(), 'primary big');

  const view = el(
    'div',
    { className: 'draw-screen stack' },
    el('h1', null, 'Draw a level'),
    context,
    el(
      'div',
      { className: 'toolbar card' },
      el('div', { className: 'row' }, ...paletteButtons, eraserBtn, button('Undo', () => drawing.undo(), 'tool'), button('Clear', () => drawing.clear(), 'tool')),
      el('p', { className: 'muted small legend' }, 'black = ground · red = spikes · green = goal · blue = coins. Draw thick; one cell is 16 px.'),
    ),
    el('div', { className: 'draw-wrap' }, underCanvas, drawCanvas),
    el(
      'div',
      { className: 'draw-side' },
      el(
        'div',
        { className: 'card char-card' },
        el('h2', null, 'Your character'),
        el('p', { className: 'muted small' }, 'Any color. It becomes the player.'),
        charCanvas,
        el('div', { className: 'row' }, button('Undo', () => character.undo(), 'tool'), button('Clear', () => character.clear(), 'tool')),
      ),
      el('div', { className: 'card rules-card' }, el('h2', null, 'Rules (plain words)'), rules),
    ),
    el('div', { className: 'row' }, submitBtn, link(`#/scan${qs({ parent: parentId, game: gameId })}`, 'Scan a sheet instead', 'btn')),
    status,
  );

  const showPreview = (scan: ScanResponse): void => {
    if (!alive) return;
    previewCleanup?.();
    view.hidden = true;
    view.remove();
    clear(root);
    history.replaceState(null, '', draftHash(scan.draft_id));
    previewCleanup = renderPreview(root, {
      scan,
      gameId,
      parentId,
      backHash: draftHash(scan.draft_id),
      retakeLabel: 'Back to drawing',
      onRetake: () => {
        previewCleanup?.();
        previewCleanup = null;
        history.replaceState(null, '', baseHash);
        clear(root);
        view.hidden = false;
        status.replaceChildren();
        submitBtn.disabled = false;
        root.append(view);
      },
    });
  };

  async function submit(): Promise<void> {
    if (drawing.isEmpty() && !parentId) {
      status.replaceChildren(errorBox('Draw something first: some black ground and a green goal.'));
      return;
    }
    submitBtn.disabled = true;
    const progress = spinner('Reading your drawing…');
    status.replaceChildren(progress);
    const textNode = progress.querySelector('.progress-text');
    const timer = window.setTimeout(() => {
      if (textNode) textNode.textContent = 'Reading your rules…';
    }, RULES_SWITCH_MS);
    try {
      const form = new FormData();
      form.append('image', await composeDrawing(drawing), 'drawing.png');
      form.append('mode', 'canvas');
      const prompt = rules.value.trim();
      if (prompt) form.append('prompt', prompt);
      if (parentId) form.append('parent_id', parentId);
      if (gameId) form.append('game_id', gameId);
      if (!character.isEmpty()) form.append('character', await toBlob(charCanvas), 'character.png');
      const scan = await scanImage(form);
      showPreview(scan);
    } catch (err) {
      if (!alive) return;
      submitBtn.disabled = false;
      status.replaceChildren(errorBox(errorMessage(err)));
    } finally {
      window.clearTimeout(timer);
    }
  }

  if (draftId) {
    root.append(spinner('Loading your draft…'));
    try {
      showPreview(await getDraft(draftId));
    } catch (err) {
      if (alive) {
        clear(root);
        root.append(view);
        status.replaceChildren(errorBox(`Couldn’t load draft ${draftId}: ${errorMessage(err)}`));
      }
    }
  } else {
    root.append(view);
  }

  return () => {
    alive = false;
    previewCleanup?.();
    previewCleanup = null;
  };
}
