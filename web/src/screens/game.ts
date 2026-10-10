/**
 * #/game/:id Game page (PLAN.md section 10). Owned by lane D.
 *
 * Ordered levels with Play buttons, and "Add a level": draw on screen, scan a
 * sheet, or print an add-a-level sheet whose QR carries the game id.
 */
import { blankSheetUrl, getGame } from '../api';
import { el, errorBox, errorMessage, externalLink, fmtDate, link, plural, qs, setTitle, spinner } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { thumbnailFor } from '../ui/thumbnails';

export async function render(root: HTMLElement, ctx: RouteCtx): Promise<Cleanup> {
  const id = ctx.params.id ?? '';
  let alive = true;
  root.append(spinner('Loading game…'));
  try {
    const { game, levels } = await getGame(id);
    if (!alive) return;
    setTitle(game.title);
    root.replaceChildren(
      el(
        'div',
        { className: 'page-head' },
        el('h1', null, game.title),
        el('p', { className: 'muted' }, 'by ', game.author, ' · ', plural(levels.length, 'level'), ' · ', fmtDate(game.created_at)),
      ),
      levels.length
        ? el(
            'ol',
            { className: 'level-list' },
            ...levels.map((row) =>
              el(
                'li',
                { className: 'card level-row' },
                el('a', { href: `#/play/${encodeURIComponent(row.id)}`, className: 'level-thumb' }, thumbnailFor(row.level, 200)),
                el(
                  'div',
                  { className: 'level-body' },
                  el('h3', null, `${row.order_index + 1}. ${row.title}`),
                  el(
                    'p',
                    { className: 'muted small' },
                    'by ',
                    row.author,
                    ' · ♥ ',
                    String(row.likes),
                    row.solvable === false ? el('span', { className: 'badge warn' }, 'maybe impossible') : null,
                    row.parent_id ? el('span', { className: 'badge' }, 'remix') : null,
                  ),
                  el(
                    'div',
                    { className: 'row' },
                    link(`#/play/${encodeURIComponent(row.id)}`, 'Play', 'btn primary'),
                    link(`#/remix/${encodeURIComponent(row.id)}`, 'Remix', 'btn'),
                    link(`#/tree/${encodeURIComponent(row.id)}`, 'Tree', 'btn'),
                  ),
                ),
              ),
            ),
          )
        : el('p', { className: 'muted' }, 'No levels yet.'),
      el(
        'section',
        { className: 'card add-level' },
        el('h2', null, 'Add a level'),
        el('p', { className: 'muted' }, 'New levels go to the end of this game.'),
        el(
          'div',
          { className: 'row' },
          link(`#/draw${qs({ game: game.id })}`, '✎ Draw a level', 'btn primary big'),
          link(`#/scan${qs({ game: game.id })}`, '📷 Scan a sheet', 'btn big'),
          externalLink(blankSheetUrl(game.id), '🖨 Print add-a-level sheet', 'btn big'),
        ),
      ),
    );
  } catch (err) {
    if (alive) root.replaceChildren(errorBox(`Couldn’t load this game: ${errorMessage(err)}`, link('#/', 'Home', 'btn')));
  }
  return () => {
    alive = false;
  };
}
