import { h } from './dom.ts';
import { t } from './messages.ts';

/** Shared, opt-in graphics choice for creation forms and subsequent builds. */
export function graphicsOption(initial: boolean, onChange: (selected: boolean) => void): {
  element: HTMLElement; input: HTMLInputElement;
} {
  const input = h('input', { type: 'checkbox', name: 'better_graphics', checked: initial });
  const hint = h('p', { class: 'muted small' }, t('create.graphics_help'));
  const element = h('div', { class: 'graphics-option' },
    h('label', { class: 'graphics-choice' }, input, h('span', null, t('create.better_graphics'))), hint);
  input.addEventListener('change', () => onChange(input.checked));
  return { element, input };
}
