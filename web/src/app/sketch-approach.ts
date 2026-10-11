import { h } from './dom.ts';
import { t } from './messages.ts';
import { store } from './store.ts';

export const imagineSketch = (): boolean => !store.flag('faithfulSketch');

export function sketchApproach(onChange: (imagine: boolean) => void): HTMLElement {
  const choice = h('select', { class: 'text', 'aria-label': t('imagine.approach'),
    onchange: () => {
      store.setFlag('faithfulSketch', choice.value === 'faithful');
      hint.textContent = t(imagineSketch() ? 'imagine.help' : 'imagine.faithful_help');
      onChange(imagineSketch());
    } },
  h('option', { value: 'imagine' }, t('imagine.mode')),
  h('option', { value: 'faithful' }, t('imagine.faithful')));
  choice.value = imagineSketch() ? 'imagine' : 'faithful';
  const hint = h('p', { class: 'muted small' }, t(imagineSketch() ? 'imagine.help' : 'imagine.faithful_help'));
  return h('div', { class: 'sketch-approach' }, h('label', null, h('span', null, t('imagine.approach')), choice), hint);
}
