/**
 * #/ Home (PLAN.md section 10). Owned by lane D.
 *
 * Feed cards (thumbnail, title, authors, level count, likes) from GET /api/games.
 * Buttons: Play, Scan a sheet, Draw on screen, Print blank sheet. "New game" is
 * simply scanning or drawing with no game selected: publishing creates one.
 */
import { blankSheetUrl, getGames, getHealth, listFixtures, type FeedGame } from '../api';
import { button, el, errorBox, errorMessage, externalLink, link, plural, qs, setTitle, spinner } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { thumbnailFor } from '../ui/thumbnails';

function gameCard(game: FeedGame): HTMLElement {
  const playHref = game.cover ? `#/play/${encodeURIComponent(game.cover.id)}` : `#/game/${encodeURIComponent(game.id)}`;
  const authors = game.authors.length ? game.authors.join(', ') : game.author;
  return el(
    'article',
    { className: 'card game-card' },
    el('a', { href: playHref, className: 'card-thumb' }, thumbnailFor(game.cover, 360)),
    el(
      'div',
      { className: 'card-body' },
      el('h3', null, game.title),
      el('p', { className: 'muted' }, 'by ', authors),
      el('p', { className: 'meta' }, plural(game.level_count, 'level'), ' · ♥ ', String(game.likes)),
      el(
        'div',
        { className: 'row' },
        link(playHref, 'Play', 'btn primary'),
        link(`#/game/${encodeURIComponent(game.id)}`, 'Levels', 'btn'),
        link(`#/draw${qs({ game: game.id })}`, 'Add a level', 'btn'),
      ),
    ),
  );
}

export async function render(root: HTMLElement, _ctx: RouteCtx): Promise<Cleanup> {
  setTitle();
  let alive = true;

  const hero = el(
    'section',
    { className: 'hero' },
    el('h1', null, 'Draw a Level'),
    el(
      'p',
      { className: 'lead' },
      'Draw a platformer on a printed sheet or on screen. Black is ground, red is spikes, green is the goal, blue is coins. Write a rule next to it and it becomes a mechanic. Your doodle is the player.',
    ),
    el(
      'div',
      { className: 'row' },
      link('#/scan', '📷 Scan a sheet', 'btn primary big'),
      link('#/draw', '✎ Draw on screen', 'btn big'),
      externalLink(blankSheetUrl(), '🖨 Print blank sheet', 'btn big'),
    ),
    el('p', { className: 'muted small' }, 'New game: scan or draw without picking a game, and publishing creates one. Open a game to add levels to it or remix one.'),
  );

  const feed = el('section', { className: 'feed' }, el('h2', null, 'Games'), spinner('Loading games…'));
  const footer = el('section', { className: 'muted small footer' });
  root.append(hero, feed, footer);

  const loadFeed = async (): Promise<void> => {
    try {
      const games = await getGames();
      if (!alive) return;
      feed.replaceChildren(el('h2', null, 'Games'));
      if (!games.length) {
        feed.append(el('p', { className: 'muted' }, 'No games yet. Scan a sheet or draw one to start the first game.'));
        return;
      }
      feed.append(el('div', { className: 'cards' }, ...games.map(gameCard)));
    } catch (err) {
      if (!alive) return;
      feed.replaceChildren(el('h2', null, 'Games'), errorBox(errorMessage(err), button('Retry', () => void loadFeed())));
    }
  };
  await loadFeed();

  void Promise.all([getHealth().catch(() => null), listFixtures().catch(() => [] as string[])]).then(([health, fixtures]) => {
    if (!alive) return;
    const parts: (HTMLElement | string)[] = [];
    if (health) parts.push(`Backend ok · vision model ${health.llm}. `);
    if (fixtures.length) {
      parts.push('Engine test levels: ');
      fixtures.forEach((name, i) => {
        if (i) parts.push(', ');
        parts.push(link(`#/play/fixture/${encodeURIComponent(name)}`, name.replace(/_/g, ' ')));
      });
    }
    footer.replaceChildren(...parts);
  });

  return () => {
    alive = false;
  };
}
