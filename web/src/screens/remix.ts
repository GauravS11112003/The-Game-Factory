/**
 * #/remix/:levelId Remix (PLAN.md section 10). Owned by lane D.
 *
 * "Print this sheet, draw your additions in color, then scan it." Link to
 * GET /api/templates/remix/{id}.pdf, button Scan now (#/scan?parent=<id>),
 * button Remix on screen (#/draw?parent=<id>).
 */
import { getLevel, remixSheetUrl } from '../api';
import { el, errorBox, errorMessage, externalLink, link, qs, setTitle, spinner } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { thumbnailFor } from '../ui/thumbnails';

export async function render(root: HTMLElement, ctx: RouteCtx): Promise<Cleanup> {
  const id = ctx.params.id ?? '';
  let alive = true;
  root.append(spinner('Loading level…'));
  try {
    const detail = await getLevel(id);
    if (!alive) return;
    const { level } = detail;
    setTitle(`Remix ${level.title}`);
    root.replaceChildren(
      el('h1', null, 'Remix “', level.title, '”'),
      el('p', { className: 'muted' }, 'by ', detail.author, detail.game ? [' · from ', link(`#/game/${encodeURIComponent(detail.game.id)}`, detail.game.title)] : null),
      el(
        'div',
        { className: 'remix-grid' },
        thumbnailFor(level, 480, 'remix-thumb'),
        el(
          'div',
          { className: 'stack' },
          el(
            'ol',
            { className: 'steps' },
            el('li', null, el('strong', null, 'Print the remix sheet.'), ' The level is printed in light gray with the corner markers and a QR code that points back here.'),
            el('li', null, el('strong', null, 'Draw your additions in color.'), ' Black ground, red spikes, green goal, blue coins. Write a rule in the Rules box: “this platform moves”, “timer 45”.'),
            el('li', null, el('strong', null, 'Scan it.'), ' Your level is published as a remix that credits ', detail.author, '.'),
          ),
          el(
            'div',
            { className: 'row' },
            externalLink(remixSheetUrl(id), '🖨 Print remix sheet (PDF)', 'btn primary big'),
            link(`#/scan${qs({ parent: id })}`, '📷 Scan now', 'btn big'),
            link(`#/draw${qs({ parent: id })}`, '✎ Remix on screen', 'btn big'),
          ),
          el('p', { className: 'muted small' }, link(`#/tree/${encodeURIComponent(id)}`, 'See the remix tree'), ' · ', link(`#/play/${encodeURIComponent(id)}`, 'Play the original')),
        ),
      ),
    );
  } catch (err) {
    if (alive) root.replaceChildren(errorBox(`Couldn’t load this level: ${errorMessage(err)}`, link('#/', 'Home', 'btn')));
  }
  return () => {
    alive = false;
  };
}
