/**
 * v2 web app (lane F): the main app since the P6 switch-over, at http://localhost:5173/ (index.html; /v2.html is an
 * alias). v1 stays reachable at /v1.html.
 * Routes: home feed, draw (long-canvas editor), scan (pack tray), prompt (tell me a level), preview/:draft, play/:id,
 * game/:id, game/:id/rules, game/:id/library (or library?game=), tree/:id, dev.
 * v3 collaboration (lane 5): bible/:game, review/:game, quests/:game, credits/:game, profile/:id, me, activity, jams.
 * Chrome is paper and ink (§7.9); every sentence comes from shared/spec/messages.json.
 */
import './style.css';
import { arcadeScreen, arcadePlayScreen } from '../arcade/index.ts';
import { card, h, icon } from './dom.ts';
import { t } from './messages.ts';
import { parseHash } from './router.ts';
import { store } from './store.ts';
import { devScreen } from './screens/dev.ts';
import { drawScreen } from './screens/draw.ts';
import { gameScreen } from './screens/game.ts';
import { homeScreen } from './screens/home.ts';
import { createGameScreen } from './screens/create-game.ts';
import { imagineScreen } from './screens/imagine.ts';
import { libraryScreen } from './screens/library.ts';
import { playScreen } from './screens/play.ts';
import { raceScreen } from './screens/race.ts';
import { previewScreen } from './screens/preview.ts';
import { promptScreen } from './screens/prompt.ts';
import { rulesScreen } from './screens/rules.ts';
import { scanScreen } from './screens/scan.ts';
import { treeScreen } from './screens/tree.ts';
// v3 lane 5: collaboration screens, the bell and identity
import { activityScreen } from './screens/activity.ts';
import { bibleScreen } from './screens/bible.ts';
import { creditsScreen } from './screens/credits.ts';
import { jamsScreen } from './screens/jams.ts';
import { profileScreen } from './screens/profile.ts';
import { questsScreen } from './screens/quests.ts';
import { reviewScreen } from './screens/review.ts';
import { collabChrome } from './collab/bell.ts';
import { captureContribution } from './collab/contribute.ts';
import { refreshPlayer } from './identity.ts';

type Cleanup = (() => void) | void;

function soon(titleKey: string): (root: HTMLElement) => Cleanup {
  return (root) => {
    root.append(card(null, h('h2', null, t(titleKey)), h('p', { class: 'muted' }, t('error.not_implemented')), h('a', { class: 'pill', href: '#/' }, icon('home'), t('ui.home'))));
  };
}

function header(): HTMLElement {
  const mute = h('button', { type: 'button', class: 'tool', title: t('ui.mute') });
  const sync = (): void => {
    const m = store.flag('muted');
    mute.replaceChildren(h('span', { class: 'emo' }, m ? '🔇' : '🔊'));
    mute.title = t(m ? 'ui.unmute' : 'ui.mute');
  };
  mute.onclick = () => {
    store.setFlag('muted', !store.flag('muted'));
    sync();
  };
  sync();
  const el = h('header', { class: 'app-head' },
    h('a', { class: 'logo', href: '#/' }, h('span', { class: 'logo-mark' }, '✎'), ' draw-a-level'),
    h('nav', null,
      h('a', { href: '#/', data: { nav: '' } }, icon('home'), h('span', null, t('ui.home'))),
      h('a', { href: '#/studio', data: { nav: 'studio' } }, icon('marker'), h('span', null, t('creator_studio.title')))),
    collabChrome(),
    mute);
  for (const link of el.querySelectorAll<HTMLAnchorElement>('nav a')) {
    link.setAttribute('aria-label', link.textContent ?? '');
    link.title = link.textContent ?? '';
  }
  return el;
}

const app = document.getElementById('app')!;
const head = header();
document.body.prepend(head);

let cleanup: Cleanup;

function route(): void {
  try {
    if (typeof cleanup === 'function') cleanup();
  } catch (e) {
    console.warn('screen cleanup failed', e);
  }
  cleanup = undefined;
  app.replaceChildren();
  document.querySelectorAll('.modal-back').forEach((n) => n.remove());
  const { path, query } = parseHash();
  const [first = '', second] = path;
  for (const a of head.querySelectorAll<HTMLAnchorElement>('nav a')) a.classList.toggle('on', a.dataset.nav === first);
  document.body.dataset.screen = first === 'arcade' ? 'arcade' : first || 'home';
  if (first === 'draw' || first === 'scan' || first === 'prompt' || (first === 'game' && path[2] === 'library')) captureContribution(query);
  try {
    switch (first) {
      case '':
        cleanup = arcadeScreen(app, query);
        break;
      case 'arcade':
        cleanup = second ? arcadePlayScreen(app, second) : arcadeScreen(app, query);
        break;
      case 'studio':
        cleanup = homeScreen(app);
        break;
      case 'draw':
        cleanup = query.size ? drawScreen(app, query) : homeScreen(app, true);
        break;
      case 'create':
        cleanup = query.has('from') || query.has('game') ? createGameScreen(app, query) : homeScreen(app, true);
        break;
      case 'imagine':
        cleanup = imagineScreen(app, second ?? '');
        break;
      case 'scan':
        cleanup = scanScreen(app, query);
        break;
      case 'preview':
        if (second) cleanup = previewScreen(app, second, query);
        else app.append(card(null, h('p', null, t('error.not_found'))));
        break;
      case 'play':
        if (second) cleanup = playScreen(app, second, query);
        break;
      case 'race':
        if (second) cleanup = raceScreen(app, second, query);
        break;
      case 'game':
        if (second && path[2] === 'rules') cleanup = rulesScreen(app, second);
        else if (second && path[2] === 'library') cleanup = libraryScreen(app, second);
        else if (second) cleanup = gameScreen(app, second);
        break;
      case 'tree':
        if (second) cleanup = treeScreen(app, second);
        break;
      case 'library':
        cleanup = libraryScreen(app, second ?? query.get('game'));
        break;
      case 'prompt':
        cleanup = promptScreen(app, query);
        break;
      case 'golden':
        cleanup = soon('ui.golden')(app);
        break;
      case 'dev':
        cleanup = devScreen(app);
        break;
      // ---- v3 collaboration (lane 5) ----
      case 'bible':
        if (second) cleanup = bibleScreen(app, second);
        break;
      case 'review':
        if (second) cleanup = reviewScreen(app, second);
        break;
      case 'quests':
        if (second) cleanup = questsScreen(app, second);
        break;
      case 'credits':
        if (second) cleanup = creditsScreen(app, second);
        break;
      case 'profile':
        cleanup = profileScreen(app, second ?? null);
        break;
      case 'me':
        cleanup = profileScreen(app, null);
        break;
      case 'activity':
        cleanup = activityScreen(app, query);
        break;
      case 'jams':
        cleanup = jamsScreen(app, query);
        break;
      default:
        app.append(card(null, h('p', null, t('error.not_found'))));
    }
  } catch (e) {
    console.error('screen failed', e);
    app.replaceChildren(card(null, h('p', null, t('error.build_failed'))));
  }
}

window.addEventListener('hashchange', route);
route();
void refreshPlayer();
