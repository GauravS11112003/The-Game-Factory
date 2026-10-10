/**
 * Preview + publish, shared by #/scan and #/draw (PLAN.md section 10). Owned by lane D.
 *
 * The draft level runs in the engine inside a 16:9 stage; an overlay canvas
 * aligned to it draws the solver result (green = standing cells the player can
 * reach, red goal = unreachable), the collision tiles and entity markers.
 * Publish posts to /api/levels and opens the published level.
 */
import { apiBase, publishLevel, type ScanResponse } from '../api';
import { mountGame, type GameHandle } from '../game/index';
import { solve, type SolveResult } from '../solver/solve';
import type { Entity, Level } from '../types';
import { button, el, errorBox, errorMessage, navigate, rememberAuthor, rememberedAuthor, spinner } from '../ui/dom';
import { renderThumbnail } from '../ui/thumbnails';

export interface PreviewOptions {
  scan: ScanResponse;
  /** From the route; falls back to the scan's QR hints. */
  gameId: string | null;
  parentId: string | null;
  /** Hash that re-opens this preview after a play test. */
  backHash: string;
  retakeLabel: string;
  onRetake: () => void;
}

interface OverlayState {
  solver: boolean;
  tiles: boolean;
  markers: boolean;
}

const WARNING_TEXT: Record<string, string> = {
  rules_not_read: 'Handwritten rules were not read (vision model offline). The level plays from the drawing alone.',
  no_goal: 'No green goal found; one was placed on the rightmost ground.',
  thin_ink: 'The ink is thin. Thicker markers scan better.',
};

const MARKER: Record<Entity['type'], { label: string; color: string }> = {
  player_start: { label: 'S', color: '#333333' },
  goal: { label: 'G', color: '#43a047' },
  coin: { label: '•', color: '#1e88e5' },
  key: { label: 'K', color: '#1e88e5' },
  checkpoint: { label: 'C', color: '#43a047' },
  moving_platform: { label: 'moves', color: '#000000' },
  enemy: { label: 'enemy', color: '#e53935' },
  bounce_pad: { label: 'bounce', color: '#000000' },
  door: { label: 'door', color: '#000000' },
};

function drawOverlay(canvas: HTMLCanvasElement, level: Level, result: SolveResult | null, state: OverlayState): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const c = level.grid.cell;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.tiles) {
    level.grid.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === '1') ctx.fillStyle = 'rgba(0,0,0,0.35)';
        else if (row[x] === '2') ctx.fillStyle = 'rgba(229,57,53,0.5)';
        else continue;
        ctx.fillRect(x * c, y * c, c, c);
      }
    });
  }

  if (state.solver && result) {
    ctx.fillStyle = 'rgba(67,160,71,0.45)';
    for (const key of result.reachable) {
      const [xs, ys] = key.split(',');
      const x = Number(xs);
      const y = Number(ys);
      if (Number.isFinite(x) && Number.isFinite(y)) ctx.fillRect(x * c, y * c, c, c);
    }
  }

  if (state.markers) {
    ctx.font = `bold ${c - 3}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const e of level.entities) {
      const m = MARKER[e.type];
      if (e.bbox) {
        const [x0, y0, x1, y1] = e.bbox;
        ctx.strokeStyle = m.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x0 * c + 1, y0 * c + 1, (x1 - x0 + 1) * c - 2, (y1 - y0 + 1) * c - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = m.color;
        ctx.font = `bold 11px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(m.label, x0 * c + 2, y0 * c - 7);
        ctx.font = `bold ${c - 3}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        continue;
      }
      if (e.x === undefined || e.x === null || e.y === undefined || e.y === null) continue;
      const cx = (e.x + 0.5) * c;
      const cy = (e.y + 0.5) * c;
      ctx.beginPath();
      ctx.arc(cx, cy, c * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, cx, cy + 1);
    }
  }

  const goal = level.entities.find((e) => e.type === 'goal');
  if (goal && goal.x !== undefined && goal.x !== null && goal.y !== undefined && goal.y !== null && result && state.solver) {
    if (result.solvable) {
      ctx.strokeStyle = '#43a047';
      ctx.lineWidth = 3;
      ctx.strokeRect(goal.x * c - 3, goal.y * c - 3, c + 6, c + 6);
    } else {
      ctx.fillStyle = 'rgba(229,57,53,0.7)';
      ctx.fillRect(goal.x * c - 4, goal.y * c - 4, c + 8, c + 8);
    }
  }
}

function warningText(code: string): string {
  return WARNING_TEXT[code] ?? code.replace(/_/g, ' ');
}

export function renderPreview(root: HTMLElement, opts: PreviewOptions): () => void {
  const { scan } = opts;
  const level = scan.level;
  const parentId = opts.parentId ?? scan.parent_hint;
  const gameId = opts.gameId ?? scan.game_hint;

  let solveResult: SolveResult | null = null;
  let solveError: string | null = null;
  try {
    solveResult = solve(level);
  } catch (err) {
    solveError = errorMessage(err);
  }

  const stage = el('div', { className: 'game-stage' });
  const overlay = el('canvas', { width: level.grid.w * level.grid.cell, height: level.grid.h * level.grid.cell, className: 'overlay-canvas' });
  const stageWrap = el('div', { className: 'stage-wrap' }, stage, overlay);
  let handle: GameHandle | null = null;

  const state: OverlayState = { solver: true, tiles: false, markers: true };
  const redraw = (): void => {
    drawOverlay(overlay, level, solveResult, state);
    overlay.classList.toggle('pulse', state.solver && solveResult !== null && !solveResult.solvable);
  };
  redraw();

  const toggle = (label: string, key: keyof OverlayState): HTMLElement => {
    const input = el('input', { type: 'checkbox', checked: state[key] });
    input.addEventListener('change', () => {
      state[key] = input.checked;
      redraw();
    });
    return el('label', { className: 'toggle' }, input, ' ', label);
  };

  let solverMessage: HTMLElement;
  if (solveError) {
    solverMessage = el('p', { className: 'muted small' }, `Solver not available yet (${solveError}).`);
  } else if (solveResult && !solveResult.solvable) {
    solverMessage = el(
      'p',
      { className: 'notice bad' },
      'Goal can’t be reached. Green shows where the player can get to.',
      solveResult.reason ? el('span', { className: 'muted' }, ` ${solveResult.reason}`) : null,
    );
  } else {
    solverMessage = el('p', { className: 'notice good' }, 'Looks solvable: the goal is reachable from the start.');
  }

  const warnings = scan.warnings.length
    ? el('ul', { className: 'warnings' }, ...scan.warnings.map((w) => el('li', null, warningText(w))))
    : null;

  const authorInput = el('input', { type: 'text', placeholder: 'Your name', value: rememberedAuthor(), maxLength: 40, autocomplete: 'nickname' });
  const titleInput = el('input', { type: 'text', placeholder: 'Level title', value: level.title, maxLength: 60 });
  const status = el('div', { className: 'publish-status' });

  const context = parentId
    ? el('p', { className: 'muted small' }, 'Remix of ', el('a', { href: `#/play/${encodeURIComponent(parentId)}` }, parentId), '. It will appear in the remix tree with your name.')
    : gameId
      ? el('p', { className: 'muted small' }, 'This level will be added to game ', el('a', { href: `#/game/${encodeURIComponent(gameId)}` }, gameId), '.')
      : el('p', { className: 'muted small' }, 'Publishing creates a new game named after the level.');

  const publishBtn = button('Publish', () => void publish(), 'primary big');
  const playBtn = button('Play test', () => navigate(`#/play/draft/${encodeURIComponent(scan.draft_id)}?back=${encodeURIComponent(opts.backHash)}`), 'big');
  const retakeBtn = button(opts.retakeLabel, () => opts.onRetake(), 'big');
  if (!scan.safety.ok) {
    publishBtn.disabled = true;
    status.append(errorBox(`This drawing can’t be published: ${scan.safety.reason ?? 'it was flagged by the safety check'}.`));
  }

  async function publish(): Promise<void> {
    const author = authorInput.value.trim();
    if (!author) {
      authorInput.focus();
      authorInput.classList.add('invalid');
      return;
    }
    rememberAuthor(author);
    publishBtn.disabled = true;
    playBtn.disabled = true;
    status.replaceChildren(spinner('Publishing…'));
    try {
      const published = await publishLevel({
        draft_id: scan.draft_id,
        author,
        title: titleInput.value.trim() || level.title,
        solvable: solveResult ? solveResult.solvable : null,
        game_id: gameId,
        parent_id: parentId,
      });
      handle?.destroy();
      handle = null;
      navigate(`#/play/${encodeURIComponent(published.id)}`);
    } catch (err) {
      publishBtn.disabled = false;
      playBtn.disabled = false;
      status.replaceChildren(errorBox(`Publish failed: ${errorMessage(err)}`));
    }
  }

  root.append(
    el(
      'div',
      { className: 'preview-screen' },
      el('h1', null, 'Preview'),
      el('p', { className: 'muted' }, 'Walk around with the arrow keys or the touch buttons. Green cells are where the solver says you can stand.'),
      stageWrap,
      el('div', { className: 'row overlay-toggles' }, toggle('Solver', 'solver'), toggle('Tiles', 'tiles'), toggle('Markers', 'markers')),
      solverMessage,
      warnings,
      el(
        'section',
        { className: 'card publish' },
        el('h2', null, 'Publish'),
        context,
        el('div', { className: 'form-grid' }, el('label', null, 'Your name', authorInput), el('label', null, 'Title', titleInput)),
        el('div', { className: 'row' }, publishBtn, playBtn, retakeBtn),
        status,
      ),
      level.meta.notes_transcript ? el('p', { className: 'muted small' }, 'Read from the sheet: “', level.meta.notes_transcript, '”') : null,
    ),
  );

  // Mount only once the stage is in the document: Phaser sizes its canvas from the parent's box.
  try {
    handle = mountGame(stage, level, { assetBase: apiBase });
  } catch (err) {
    stage.classList.add('static');
    stage.append(renderThumbnail(level, level.grid.w * level.grid.cell));
    solverMessage.after(el('p', { className: 'muted small' }, `Live preview unavailable (${errorMessage(err)}); showing the drawn grid.`));
  }

  return () => {
    handle?.destroy();
    handle = null;
  };
}
