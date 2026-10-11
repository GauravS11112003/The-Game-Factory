import { h, icon } from '../app/dom.ts';
import { GAME_CATEGORIES, creationPrompt } from '../app/game-brief.ts';
import { t } from '../app/messages.ts';
import { store } from '../app/store.ts';
import { openCreateGameModal } from '../app/screens/create-game.ts';
import { emptyDoc } from '../editor/doc.ts';
import './idea-desk.css';

const SPARKS = [
  { title: 'Moon delivery', note: 'One small leap. One very late pizza.', category: 'racing', color: 'moon',
    prompt: 'Drive a tiny pizza delivery rover across the moon. Bounce over craters, collect floating cheese, and deliver the pizza before it gets cold.' },
  { title: 'Pocket jungle', note: 'Big adventure. Very small explorer.', category: 'platformer', color: 'jungle',
    prompt: 'A tiny explorer jumps between giant leaves in a pocket-sized jungle. Collect fireflies, dodge sleepy frogs, and reach a treehouse in the clouds.' },
  { title: 'Cloud puzzler', note: 'A little daydream with a twist.', category: 'puzzle', color: 'cloud',
    prompt: 'Slide colorful clouds into place to connect a rainbow. Each level adds a new shape, and completing the rainbow makes a little garden bloom.' },
] as const;

/** The landing page's prompt and sketch lead into the same saved creation flow as the studio. */
export function ideaDesk(): { element: HTMLElement; dispose: () => void } {
  const saved = store.creationDraft();
  let category = saved?.brief.category ?? 'platformer';
  let closeCreation: (() => void) | undefined;
  const prompt = h('textarea', { id: 'home-game-idea', rows: 3, maxLength: 8000,
    placeholder: 'A tiny astronaut delivering pizza on the moon…', value: creationPrompt(saved),
    'aria-describedby': 'idea-desk-hint' });
  const next = h('button', { class: 'idea-next', type: 'submit', 'aria-label': 'Continue with your game idea', title: 'Continue with your idea' }, icon('next'));
  const genre = h('button', { class: 'idea-genre', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
  const hint = h('span', { id: 'idea-desk-hint', class: 'idea-hint' }, 'An idea is all you need.');
  const selected = h('span', { class: 'idea-picked', role: 'status', 'aria-live': 'polite' });
  const picker = h('dialog', { class: 'idea-picker', 'aria-labelledby': 'idea-picker-title' });
  const options = GAME_CATEGORIES.map((option) => h('button', { type: 'button', class: 'idea-type',
    data: { category: option.id }, 'aria-pressed': String(category === option.id), onclick: () => {
      category = option.id; sync(); persist(); picker.close(); genre.focus();
    } }, h('span', { class: 'idea-type-symbol', 'aria-hidden': 'true' }, option.symbol),
    h('span', null, h('strong', null, t(`create.category.${option.id}`)), h('small', null, t(`create.category.${option.id}.help`)))));
  picker.append(h('div', { class: 'idea-picker-head' }, h('div', null,
    h('span', { class: 'idea-caption' }, 'SET THE MOOD'), h('h2', { id: 'idea-picker-title' }, 'What kind of play?')),
    h('button', { type: 'button', class: 'idea-close', 'aria-label': 'Close game types', onclick: () => picker.close() }, icon('close'))),
    h('div', { class: 'idea-types' }, ...options));
  picker.addEventListener('click', (event) => {
    if (event.target !== picker) return;
    const rect = picker.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) picker.close();
  });
  picker.addEventListener('close', () => genre.setAttribute('aria-expanded', 'false'));
  genre.onclick = () => {
    document.body.append(picker); genre.setAttribute('aria-expanded', 'true'); picker.showModal();
    options.find((option) => option.dataset.category === category)?.focus();
  };
  const open = (sketch = false): void => {
    closeCreation?.();
    closeCreation = openCreateGameModal(() => {
      closeCreation = undefined;
      const draft = store.creationDraft();
      prompt.value = creationPrompt(draft);
      category = draft?.brief.category ?? 'platformer';
      selected.textContent = '';
      sparkButtons.forEach((button) => button.setAttribute('aria-pressed', 'false'));
      sync(); persist();
    }, { prompt: prompt.value, category, sketch });
  };
  const form = h('form', { class: 'idea-composer', onsubmit: (event: Event) => {
    event.preventDefault(); if (prompt.value.trim()) open();
  } }, h('label', { htmlFor: prompt.id, class: 'idea-input-label' }, 'Describe your game'), prompt,
    h('div', { class: 'idea-composer-tools' }, genre,
      h('button', { type: 'button', class: 'idea-sketch', onclick: () => open(true) }, icon('marker'), 'Sketch it'), next));
  const sparkButtons = SPARKS.map((spark) => h('button', { type: 'button', class: `idea-spark idea-spark-${spark.color}`,
    'aria-label': `Try ${spark.title}`, 'aria-pressed': 'false', onclick: () => {
      prompt.value = spark.prompt; category = spark.category;
      sparkButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.spark === spark.title)));
      selected.textContent = `${spark.title} is on your desk. Make it yours.`;
      sync(); persist(); prompt.focus();
    }, data: { spark: spark.title } }, sparkArt(spark.color),
    h('span', { class: 'idea-spark-title' }, spark.title), h('span', { class: 'idea-spark-note' }, spark.note),
    h('span', { class: 'idea-spark-arrow', 'aria-hidden': 'true' }, '↗')));
  const element = h('section', { class: 'idea-desk', 'aria-labelledby': 'idea-desk-title' },
    h('div', { class: 'idea-desk-copy' }, h('span', { class: 'idea-caption' }, 'THE NEXT GAME COULD BE YOURS'),
      h('h2', { id: 'idea-desk-title' }, 'What would ', h('span', null, 'you'), ' play?'),
      h('p', { class: 'idea-intro' }, 'Dream up a world. We’ll help you make it playable.'), form,
      h('div', { class: 'idea-desk-foot' }, hint, h('span', { class: 'idea-enter', 'aria-hidden': 'true' }, 'Enter ↵'))),
    h('div', { class: 'idea-sparks' }, h('div', { class: 'idea-sparks-label' }, 'Need a spark?', h('span', { 'aria-hidden': 'true' }, '↓')),
      h('div', { class: 'idea-spark-stack' }, ...sparkButtons), selected));
  function sync(): void {
    next.disabled = !prompt.value.trim();
    const option = GAME_CATEGORIES.find((option) => option.id === category)!;
    genre.replaceChildren(h('span', { 'aria-hidden': 'true' }, option.symbol), t(`create.category.${category}`), h('span', { 'aria-hidden': 'true' }, '⌄'));
    options.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.category === category)));
    hint.textContent = prompt.value.trim() ? 'Add a sketch or follow your idea →' : 'An idea is all you need.';
  }
  function persist(): void {
    const draft = store.creationDraft();
    const doc = draft?.doc ?? emptyDoc();
    if (!prompt.value.trim() && !draft?.gameId && !doc.strokes.length && !doc.character.length && !doc.rules.length) {
      store.setCreationDraft(null);
      return;
    }
    store.setCreationDraft({ ...(draft ?? { kind: 'game', title: '', author: store.author(), doc, gameId: null }),
      prompt: prompt.value, brief: { ...(draft?.brief ?? { custom_definition: '', theme: '', gameplay: '', details: '' }), category } });
  }
  prompt.addEventListener('input', () => {
    selected.textContent = ''; sparkButtons.forEach((button) => button.setAttribute('aria-pressed', 'false')); sync(); persist();
  });
  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  sync();
  return { element, dispose: () => { closeCreation?.(); picker.close(); picker.remove(); } };
}

function sparkArt(world: string): HTMLElement {
  const art = h('span', { class: 'idea-spark-art', 'aria-hidden': 'true' });
  const drawings: Record<string, string> = {
    moon: '<circle cx="130" cy="34" r="17" fill="#ffe574"/><path d="M0 105Q45 70 84 95T180 93V140H0" fill="#a99dde"/><ellipse cx="42" cy="114" rx="19" ry="6" fill="#8474bc"/><path d="m62 93 7-22h37l12 22z" fill="#f6ac83"/><path d="m77 75-4 14h34l-7-14" fill="#fff5d8"/><rect x="54" y="91" width="72" height="20" rx="7" fill="#f6ac83"/><circle cx="70" cy="111" r="10"/><circle cx="112" cy="111" r="10"/><path d="m10 27 5-7 5 7-5 7zM44 44l4-5 4 5-4 5" fill="#fff9db"/>',
    jungle: '<path d="M22 129V36m119 98V29" stroke="#446e4f" stroke-width="5"/><path d="M22 70Q-4 12 43 28Q57 53 22 70m0 26Q-8 44 58 65Q57 88 22 96M141 57q-49-39-44-10q12 25 44 10m0 24q43-60 37-14q-7 23-37 14" fill="#73a979"/><path d="M49 110h74v14H49" fill="#ffe574"/><path d="M66 104v-20q0-14 14-14t14 14v20" fill="#ed9c77"/><circle cx="75" cy="83" r="2"/><circle cx="86" cy="83" r="2"/><path d="M0 135q45-21 88-4t92-1v10H0" fill="#73a979"/>',
    cloud: '<path d="M45 117q44-91 89 0" fill="none" stroke="#edacb3" stroke-width="13"/><path d="M45 117q44-70 89 0" fill="none" stroke="#ffe574" stroke-width="10"/><path d="M45 117q44-52 89 0" fill="none" stroke="#a3cfa2" stroke-width="8"/><path d="M7 56q0-15 15-15q9-24 26-6q27-6 25 21zM105 39q0-14 15-13q9-23 25-6q23-4 24 19z" fill="#fffdf6"/><path d="M27 128q-3-20 12-20q8-20 25-7q21-4 20 27zM115 128q-3-17 10-19q10-22 26-7q20-1 22 26z" fill="#fffdf6"/>',
  };
  art.innerHTML = `<svg viewBox="0 0 180 140" xmlns="http://www.w3.org/2000/svg">${drawings[world]}</svg>`;
  return art;
}
