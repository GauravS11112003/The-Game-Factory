/**
 * Hash router -> screens (PLAN.md section 10). Owned by lane D.
 *
 *   #/                      home: feed of games
 *   #/game/:id              one game: ordered levels, add a level
 *   #/scan?parent=&game=    photo of a sheet -> preview -> publish
 *   #/draw?parent=&game=    draw on screen -> preview -> publish
 *   #/play/:id              play a published level
 *   #/play/draft/:id        play an unpublished draft
 *   #/play/fixture/:name    play a shared/fixtures level (engine testing)
 *   #/remix/:id             print the remix sheet, scan it, or remix on screen
 *   #/tree/:id              remix tree with credits
 */
import { el, link } from './ui/dom';
import { startRouter, type RouteDef, type Screen } from './ui/router';
import { render as renderCanvas } from './screens/canvas';
import { render as renderGame } from './screens/game';
import { render as renderHome } from './screens/home';
import { render as renderPlay } from './screens/play';
import { render as renderRemix } from './screens/remix';
import { render as renderScan } from './screens/scan';
import { render as renderTree } from './screens/tree';

const ROUTES: RouteDef[] = [
  { pattern: '/', screen: renderHome },
  { pattern: '/game/:id', screen: renderGame },
  { pattern: '/scan', screen: renderScan },
  { pattern: '/draw', screen: renderCanvas },
  { pattern: '/play/draft/:id', screen: renderPlay },
  { pattern: '/play/fixture/:name', screen: renderPlay },
  { pattern: '/play/:id', screen: renderPlay },
  { pattern: '/remix/:id', screen: renderRemix },
  { pattern: '/tree/:id', screen: renderTree },
];

const notFound: Screen = (root, ctx) => {
  root.append(
    el('div', { className: 'card' }, el('h2', null, 'Nothing here'), el('p', { className: 'muted' }, `No screen for ${ctx.path}.`), link('#/', 'Back home', 'btn')),
  );
};

function mountNav(app: HTMLElement): void {
  const nav = el(
    'nav',
    { className: 'nav' },
    link('#/', [el('span', { className: 'brand-mark' }, '✎'), ' Draw a Level'], 'brand'),
    el('span', { className: 'nav-spacer' }),
    link('#/scan', 'Scan', 'nav-link'),
    link('#/draw', 'Draw', 'nav-link'),
  );
  app.before(nav);
}

const app = document.getElementById('app');
if (!app) throw new Error('#app root missing in index.html');
mountNav(app);
startRouter(app, ROUTES, notFound);
