import './inputs.css';
import { h, icon } from '../app/dom.ts';
import type { ArcadeEntry } from './catalog.ts';
import type { ArcadeLevel } from './levels.ts';
import { W, H } from './engine.ts';
import { levelSource, sourceSectionCount, drawLevelInput } from './level-source.ts';

/** A read-only view of the selected level's creation inputs. */
export function openGameInputs(entry: ArcadeEntry, selected: ArcadeLevel | null, onClose: () => void): () => void {
  const source = levelSource(entry.id, selected);
  let section = 0, closed = false;
  const dialog = h('dialog', { class: 'arcade ar-input-dialog', 'aria-labelledby': 'ar-input-title' });
  const heading = h('h2', { id: 'ar-input-title' }, 'Prompt & canvas');
  const closeButton = h('button', { type: 'button', class: 'ar-source-close', 'aria-label': 'Close inputs', onclick: close }, icon('close'));
  const originalPrompt = source.prompt ? h('textarea', { id: 'ar-original-prompt', class: 'ar-prompt-text', rows: 5, readOnly: true, value: source.prompt, 'aria-label': 'Original prompt' }) : null;
  const promptPanel = h('section', { id: 'ar-input-prompt', class: 'ar-prompt-panel', 'aria-labelledby': 'ar-prompt-heading' },
    h('h3', { id: 'ar-prompt-heading' }, 'Original prompt'),
    h('p', { class: 'ar-input-help' }, source.builtIn ? 'The request used to create this game in the starting collection.' : 'The prompt recorded when this level was created.'),
    originalPrompt ?? h('div', { class: 'ar-source-empty' }, icon('pencil'), h('strong', null, 'No original prompt recorded'), h('p', null, 'This level was created in the level editor.')));
  const canvas = h('canvas', { class: 'ar-input-canvas ar-source-canvas', width: W, height: H, role: 'img', 'aria-label': `${entry.title} · ${source.level.name} · Level input layout` });
  const image = h('img', { class: 'ar-source-image', alt: `${entry.title} · ${source.level.name} · Original level editor input canvas` });
  const surface = h('div', { class: 'ar-sketch-surface' }, source.canvases.length ? image : canvas);
  const note = source.canvases.length ? 'The input canvas saved when this level was created in the editor.' : source.builtIn ? 'No original drawing was used for this built-in level. This is its level layout.' : 'No original input image was saved for this level. This is its saved layout.';
  const pages = h('div', { class: 'ar-source-sections', role: 'group', 'aria-label': 'Input canvas sections' });
  const pageCount = source.canvases.length || sourceSectionCount(source.level);
  const canvasPanel = h('section', { id: 'ar-input-sketch', 'aria-labelledby': 'ar-canvas-heading' }, h('h3', { id: 'ar-canvas-heading' }, 'Input canvas'), h('p', { class: 'ar-input-help' }, note), surface, pages);
  dialog.append(h('header', { class: 'ar-input-header' }, h('div', null, h('p', { class: 'ar-input-eyebrow' }, `${entry.title} · ${source.level.name}`), heading), closeButton), promptPanel, canvasPanel,
    h('footer', { class: 'ar-input-footer' }, h('span', { class: 'ar-input-status' }, 'Original level source · Read only'), h('button', { type: 'button', class: 'ar-btn ar-input-done', onclick: close }, 'Close')));
  document.body.append(dialog); dialog.showModal(); draw();
  function draw(): void {
    if (source.canvases.length) image.src = source.canvases[section]; else drawLevelInput(canvas.getContext('2d')!, source.level, section);
    pages.hidden = pageCount <= 1;
    pages.replaceChildren(...Array.from({ length: pageCount }, (_, index) => h('button', {
      type: 'button', 'aria-label': `Section ${index + 1}`, 'aria-pressed': String(section === index), onclick: () => { section = index; draw(); },
    }, String(index + 1))));
  }
  dialog.addEventListener('close', cleanup);
  function cleanup(): void { if (closed) return; closed = true; dialog.remove(); onClose(); }
  function close(): void { if (closed) return; dialog.close(); cleanup(); }
  return close;
}
