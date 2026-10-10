/**
 * #/scan?parent=&game=&draft= Scan (PLAN.md section 10). Owned by lane D.
 *
 * <input type="file" accept="image/*" capture="environment"> -> POST /api/scan
 * with progress states ("Reading your drawing… / Reading your rules…") ->
 * Preview (screens/preview.ts): engine stage + solver overlay -> Play test /
 * Publish / Retake. With ?draft=<id> the stored draft's preview opens directly
 * (that is how "Back to preview" from a play test works).
 */
import { blankSheetUrl, getDraft, getLevel, scanImage, type ScanResponse } from '../api';
import { clear, el, errorBox, errorMessage, externalLink, link, qs, setTitle, spinner, button } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { renderPreview } from './preview';

const RULES_SWITCH_MS = 2500;

export async function render(root: HTMLElement, ctx: RouteCtx): Promise<Cleanup> {
  const parentId = ctx.query.get('parent');
  const gameId = ctx.query.get('game');
  const draftId = ctx.query.get('draft');
  setTitle('Scan a sheet');

  let alive = true;
  let previewCleanup: (() => void) | null = null;
  const baseHash = `#/scan${qs({ parent: parentId, game: gameId })}`;
  const draftHash = (id: string): string => `#/scan${qs({ parent: parentId, game: gameId, draft: id })}`;

  const dispose = (): void => {
    alive = false;
    previewCleanup?.();
    previewCleanup = null;
  };

  const showPreview = (scan: ScanResponse): void => {
    if (!alive) return;
    previewCleanup?.();
    clear(root);
    history.replaceState(null, '', draftHash(scan.draft_id));
    previewCleanup = renderPreview(root, {
      scan,
      gameId,
      parentId,
      backHash: draftHash(scan.draft_id),
      retakeLabel: 'Retake',
      onRetake: () => {
        previewCleanup?.();
        previewCleanup = null;
        history.replaceState(null, '', baseHash);
        showInput();
      },
    });
  };

  const showError = (err: unknown): void => {
    if (!alive) return;
    clear(root);
    root.append(el('h1', null, 'Scan a sheet'), errorBox(errorMessage(err), button('Try again', () => showInput(), 'primary')));
  };

  const upload = async (file: File): Promise<void> => {
    clear(root);
    const progress = spinner('Reading your drawing…');
    root.append(el('div', { className: 'card center' }, progress, el('p', { className: 'muted small' }, file.name || 'photo')));
    const textNode = progress.querySelector('.progress-text');
    const timer = window.setTimeout(() => {
      if (textNode) textNode.textContent = 'Reading your rules…';
    }, RULES_SWITCH_MS);
    try {
      const form = new FormData();
      form.append('image', file, file.name || 'photo.jpg');
      form.append('mode', 'paper');
      if (parentId) form.append('parent_id', parentId);
      if (gameId) form.append('game_id', gameId);
      const scan = await scanImage(form);
      showPreview(scan);
    } catch (err) {
      showError(err);
    } finally {
      window.clearTimeout(timer);
    }
  };

  const fileButton = (label: string, capture: boolean, className: string): HTMLElement => {
    const input = el('input', { type: 'file', accept: 'image/*', capture: capture ? 'environment' : false, className: 'visually-hidden' });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void upload(file);
      input.value = '';
    });
    return el('label', { className: `btn file-btn ${className}` }, input, label);
  };

  function showInput(): void {
    if (!alive) return;
    clear(root);
    const context = el('div', { className: 'context' });
    if (parentId) {
      context.append(el('p', { className: 'muted' }, 'Remixing ', el('a', { href: `#/play/${encodeURIComponent(parentId)}` }, parentId), '…'));
      getLevel(parentId)
        .then((d) => {
          context.replaceChildren(el('p', { className: 'muted' }, 'Remixing “', d.level.title, '” by ', d.author, '. Scan the printed remix sheet with your additions.'));
        })
        .catch(() => undefined);
    } else if (gameId) {
      context.append(el('p', { className: 'muted' }, 'Adding a level to ', el('a', { href: `#/game/${encodeURIComponent(gameId)}` }, gameId), '.'));
    } else {
      context.append(el('p', { className: 'muted' }, 'A sheet with no game becomes a new game when you publish it.'));
    }

    root.append(
      el('h1', null, 'Scan a sheet'),
      context,
      el(
        'div',
        { className: 'card stack' },
        el('div', { className: 'row' }, fileButton('📷 Take a photo', true, 'primary big'), fileButton('Choose a file', false, 'big')),
        el(
          'ul',
          { className: 'tips' },
          el('li', null, 'Keep all four corner markers in the photo.'),
          el('li', null, 'Even light, no shadows across the sheet.'),
          el('li', null, 'Thick markers: black ground, red spikes, green goal, blue coins.'),
          el('li', null, 'Write rules in the Rules box: “this platform moves”, “timer 60”.'),
        ),
      ),
      el(
        'p',
        { className: 'row' },
        externalLink(blankSheetUrl(gameId), 'Print a blank sheet', 'btn'),
        link(`#/draw${qs({ parent: parentId, game: gameId })}`, 'No camera? Draw on screen', 'btn'),
      ),
    );
  }

  if (draftId) {
    root.append(spinner('Loading your draft…'));
    try {
      const scan = await getDraft(draftId);
      showPreview(scan);
    } catch (err) {
      showError(err);
    }
  } else {
    showInput();
  }
  return dispose;
}
