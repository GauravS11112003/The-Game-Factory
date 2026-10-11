/** Original creation inputs for Sonnet games, backed by the saved server snapshot. */
import { api, ApiError } from './api.ts';
import { h, icon } from './dom.ts';
import { t } from './messages.ts';

export function gameInputTools(draftId: string, title: string): { element: HTMLElement; dispose(): void } {
  let close: (() => void) | undefined;
  return {
    element: h('button', { type: 'button', class: 'game-action generated-input-button',
      title: t('game.inputs'), 'aria-label': t('game.inputs'),
      onclick: () => { close?.(); close = openGameInputs(draftId, title); } }, icon('eye')),
    dispose: () => close?.(),
  };
}

function openGameInputs(draftId: string, title: string): () => void {
  let disposed = false;
  const previous = document.activeElement as HTMLElement | null;
  const heading = h('h2', { id: 'generated-input-title' }, t('game.inputs'));
  const content = h('div', { class: 'generated-input-body' }, h('p', { role: 'status' }, t('game.input_loading')));
  const dialog = h('dialog', { class: 'generated-input-dialog', 'aria-labelledby': heading.id });
  dialog.append(h('header', { class: 'row between' }, h('div', null, h('p', { class: 'muted small' }, title), heading),
    h('button', { class: 'tool', type: 'button', 'aria-label': t('ui.close'), onclick: () => dialog.close() }, '×')),
    content, h('p', { class: 'muted small' }, t('game.input_original')));
  document.body.append(dialog); dialog.showModal();
  void api.imaginedInputs(draftId).then((source) => {
    if (disposed) return;
    content.replaceChildren(
      h('section', { 'aria-label': t('game.input_prompt') }, h('h3', null, t('game.input_prompt')),
        h('textarea', { class: 'text', rows: 5, readOnly: true, value: source.prompt, 'aria-label': t('game.input_prompt') })),
      h('section', { 'aria-label': t('game.input_canvas') }, h('h3', null, t('game.input_canvas')),
        ...(source.canvases.length ? source.canvases.map((url, index) =>
          h('figure', null, h('img', { src: url, alt: t('game.input_section', { n: index + 1 }) }))) :
          [h('p', { class: 'muted' }, t('game.input_empty'))]),
        ...(source.ink.typed_rules ?? []).map((note) => h('p', { class: 'muted small' }, note.text))));
  }).catch((error) => {
    if (!disposed) content.replaceChildren(h('p', { role: 'alert' }, t(error instanceof ApiError ? error.messageKey : 'error.network')));
  });
  const cleanup = (): void => { if (disposed) return; disposed = true; dialog.remove(); if (previous?.isConnected) previous.focus(); };
  dialog.addEventListener('close', cleanup);
  return () => { dialog.close(); cleanup(); };
}

/** Sonnet's own description and implemented controls are the generated game's guidelines. */
export function generatedGuidelines(title: string, summary: string, controls: string[]): { element: HTMLElement; dispose(): void } {
  let dialog: HTMLDialogElement | undefined;
  const close = (): void => { dialog?.close(); dialog?.remove(); dialog = undefined; };
  return { element: h('button', { type: 'button', class: 'game-action', title: t('ui.rules_sheet'), 'aria-label': t('ui.rules_sheet'),
    onclick: () => {
      close();
      dialog = h('dialog', { class: 'generated-input-dialog', 'aria-labelledby': 'generated-rules-title' },
        h('header', { class: 'row between' }, h('h2', { id: 'generated-rules-title' }, title),
          h('button', { type: 'button', class: 'tool', 'aria-label': t('ui.close'), onclick: close }, '×')),
        h('p', null, summary), h('h3', null, t('imagine.controls')), h('ul', null, ...controls.map((control) => h('li', null, control))));
      const current = dialog;
      current.addEventListener('close', () => { current.remove(); if (dialog === current) dialog = undefined; });
      document.body.append(current); current.showModal();
    } }, icon('rules')), dispose: close };
}
