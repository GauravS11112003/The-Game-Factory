/**
 * v2 web app (lane F): the main app since the P6 switch-over, at http://localhost:5173/ (index.html; /v2.html is an
 * alias). v1 stays reachable at /v1.html.
 * Routes: home feed, draw (long-canvas editor), scan (pack tray), prompt (tell me a level), preview/:draft, play/:id,
 * game/:id, game/:id/rules, game/:id/library (or library?game=), tree/:id, dev.
 * v3 collaboration (lane 5): bible/:game, review/:game, quests/:game, credits/:game, profile/:id, me, activity, jams.
 * v4 workspace (docs/v4/CONTRACTS_V4.md §7): the sidebar shell, #/ workspace home, #/games, #/new, #/blocks
 * (+ /new, /:id), #/styles, #/templates; the v2 home feed moved to #/explore; #/game/:id is the game workspace.
 * Chrome is paper and ink (§7.9); every sentence comes from shared/spec/messages.json and the v4 lane files.
 */
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/patrick-hand/400.css';
import './style.css';
import { card, h, icon } from './dom.ts';
import { t } from './messages.ts';
import { parseHash } from './router.ts';
import { mountShell } from './shell.ts';
import { devScreen } from './screens/dev.ts';
import { drawScreen } from './screens/draw.ts';
import { homeScreen } from './screens/home.ts';
import { libraryScreen } from './screens/library.ts';
import { playScreen } from './screens/play.ts';
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
import { captureContribution } from './collab/contribute.ts';
import { refreshPlayer } from './identity.ts';
// v4 workspace
import { gamesScreen } from './screens/games.ts';
import { newGameScreen } from './screens/new_game.ts';
import { workspaceScreen } from './screens/workspace.ts';
import { blockStudioScreen } from './ws/block_studio.ts';
import { blocksScreen } from './ws/blocks.ts';
import { gameWorkspaceScreen } from './ws/game_workspace.ts';
import { stylesScreen } from './ws/styles.ts';
import { templatesScreen } from './ws/templates.ts';

type Cleanup = (() => void) | void;

function soon(titleKey: string): (root: HTMLElement) => Cleanup {
  return (root) => {
    root.append(card(null, h('h2', null, t(titleKey)), h('p', { class: 'muted' }, t('error.not_implemented')), h('a', { class: 'pill', href: '#/' }, icon('home'), t('ui.home'))));
  };
}

const app = document.getElementById('app')!;
const shell = mountShell();

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
  shell.setActive(path);
  document.body.dataset.screen = first || 'home';
  if (first === 'game' && second) shell.noteGame(second);
  if (first === 'draw' || first === 'scan' || first === 'prompt' || (first === 'game' && path[2] === 'library')) captureContribution(query);
  try {
    switch (first) {
      case '':
        cleanup = workspaceScreen(app, shell);
        break;
      case 'explore':
        cleanup = homeScreen(app);
        break;
      case 'games':
        cleanup = gamesScreen(app, shell);
        break;
      case 'new':
        cleanup = newGameScreen(app, query, shell);
        break;
      case 'blocks':
        if (second) cleanup = blockStudioScreen(app, second === 'new' ? null : second, query);
        else cleanup = blocksScreen(app, query);
        break;
      case 'styles':
        cleanup = stylesScreen(app);
        break;
      case 'templates':
        cleanup = templatesScreen(app);
        break;
      case 'draw':
        cleanup = drawScreen(app, query);
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
      case 'game':
        if (second && path[2] === 'rules') cleanup = rulesScreen(app, second);
        else if (second && path[2] === 'library') cleanup = libraryScreen(app, second);
        else if (second) cleanup = gameWorkspaceScreen(app, second, query);
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
