/**
 * #/play/:id, #/play/draft/:id and #/play/fixture/:name Play (PLAN.md section 10). Owned by lane D.
 *
 * Mounts the engine via mountGame(container, level, { assetBase: apiBase });
 * the HUD (coins, timer, deaths) comes from the engine. On 'win' an overlay
 * offers Next level (when the game has one), Remix this and Home.
 */
import { apiBase, getDraft, getFixture, getLevel, likeLevel, type LevelDetail } from '../api';
import { mountGame, type GameHandle } from '../game/index';
import type { Level } from '../types';
import { button, clear, el, errorBox, errorMessage, link, navigate, setTitle, spinner } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { renderThumbnail } from '../ui/thumbnails';

type Kind = 'level' | 'draft' | 'fixture';

export async function render(root: HTMLElement, ctx: RouteCtx): Promise<Cleanup> {
  const kind: Kind = ctx.path.startsWith('/play/draft/') ? 'draft' : ctx.path.startsWith('/play/fixture/') ? 'fixture' : 'level';
  const id = kind === 'fixture' ? (ctx.params.name ?? '') : (ctx.params.id ?? '');
  const back = ctx.query.get('back');

  let alive = true;
  let handle: GameHandle | null = null;
  document.body.classList.add('playing');
  const dispose = (): void => {
    alive = false;
    document.body.classList.remove('playing');
    handle?.destroy();
    handle = null;
  };

  root.append(spinner('Loading level…'));
  let level: Level;
  let detail: LevelDetail | null = null;
  try {
    if (kind === 'draft') level = (await getDraft(id)).level;
    else if (kind === 'fixture') level = await getFixture(id);
    else {
      detail = await getLevel(id);
      level = detail.level;
    }
  } catch (err) {
    if (alive) {
      clear(root);
      root.append(errorBox(`Couldn’t load this level: ${errorMessage(err)}`, link('#/', 'Home', 'btn')));
    }
    return dispose;
  }
  if (!alive) return dispose;
  setTitle(level.title);
  clear(root);

  let likes = detail?.likes ?? 0;
  const likeBtn = button(`♥ ${likes}`, () => void like(), 'tool like');
  async function like(): Promise<void> {
    likeBtn.disabled = true;
    try {
      likes = await likeLevel(id);
      likeBtn.textContent = `♥ ${likes}`;
    } catch {
      likeBtn.disabled = false;
    }
  }

  const actions = el('div', { className: 'row play-actions' }, button('Restart', () => handle?.restart(), 'tool'));
  if (kind === 'level') {
    actions.append(likeBtn, link(`#/remix/${encodeURIComponent(id)}`, 'Remix', 'btn tool'), link(`#/tree/${encodeURIComponent(id)}`, 'Tree', 'btn tool'));
    if (detail?.game) actions.append(link(`#/game/${encodeURIComponent(detail.game.id)}`, detail.game.title, 'btn tool'));
  } else if (kind === 'draft' && back) {
    actions.append(link(back, 'Back to preview', 'btn tool'));
  }

  const badge = kind === 'level' ? null : el('span', { className: 'badge' }, kind);
  const header = el(
    'div',
    { className: 'play-head' },
    el('div', { className: 'play-title' }, el('h1', null, level.title), el('span', { className: 'muted' }, 'by ', level.author, ' ', badge)),
    actions,
  );

  const stage = el('div', { className: 'game-stage' });
  const stageWrap = el('div', { className: 'stage-wrap' }, stage);
  const hint = el('p', { className: 'muted small play-hint' }, 'Arrows or WASD to move, Space or Up to jump. Touch buttons appear on phones.');
  root.append(header, stageWrap, hint);

  const showWin = (): void => {
    if (!alive || stageWrap.querySelector('.win-overlay')) return;
    const buttons = el('div', { className: 'row center' });
    if (detail?.next_level_id) {
      const nextId = detail.next_level_id;
      buttons.append(button('Next level', () => navigate(`#/play/${encodeURIComponent(nextId)}`), 'primary big'));
    }
    if (kind === 'level') buttons.append(link(`#/remix/${encodeURIComponent(id)}`, 'Remix this', 'btn big'));
    buttons.append(
      button(
        'Play again',
        () => {
          overlay.remove();
          handle?.restart();
        },
        'big',
      ),
    );
    if (kind === 'draft' && back) buttons.append(link(back, 'Back to preview', 'btn big'));
    buttons.append(link('#/', 'Home', 'btn big'));
    const overlay = el('div', { className: 'win-overlay' }, el('h2', null, 'You made it!'), buttons);
    stageWrap.append(overlay);
  };

  try {
    handle = mountGame(stage, level, { assetBase: apiBase });
    handle.on('win', showWin);
  } catch (err) {
    stage.classList.add('static');
    stage.append(renderThumbnail(level, level.grid.w * level.grid.cell));
    root.append(errorBox(`The engine isn’t ready yet (${errorMessage(err)}). This is the level’s grid.`));
  }

  return dispose;
}
