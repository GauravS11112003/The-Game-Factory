/**
 * Hash router (PLAN.md section 10). Owned by lane D.
 *
 * Patterns are path segments with ':name' captures ('/play/draft/:id'). The
 * query string after the path ('#/scan?parent=lvl_x') arrives as URLSearchParams.
 * A screen may return a cleanup function (the play screen destroys the engine
 * there) and may be async; a render that finishes after the route changed is
 * cleaned up immediately so it never leaks a Phaser instance.
 */

export interface RouteCtx {
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Cleanup = void | (() => void);
export type Screen = (root: HTMLElement, ctx: RouteCtx) => Cleanup | Promise<Cleanup>;

export interface RouteDef {
  pattern: string;
  screen: Screen;
}

export function parseHash(hash: string): { path: string; query: URLSearchParams } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qIndex = raw.indexOf('?');
  const path = (qIndex >= 0 ? raw.slice(0, qIndex) : raw) || '/';
  const query = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : '');
  return { path: path.startsWith('/') ? path : `/${path}`, query };
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export function matchRoute(routes: RouteDef[], path: string): { route: RouteDef; params: Record<string, string> } | null {
  const want = segments(path);
  for (const route of routes) {
    const have = segments(route.pattern);
    if (have.length !== want.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const h = have[i];
      const w = want[i];
      if (h === undefined || w === undefined) {
        ok = false;
        break;
      }
      if (h.startsWith(':')) params[h.slice(1)] = decodeURIComponent(w);
      else if (h !== w) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export function startRouter(root: HTMLElement, routes: RouteDef[], notFound: Screen): void {
  let token = 0;
  let activeCleanup: (() => void) | null = null;

  const render = async (): Promise<void> => {
    const myToken = ++token;
    if (activeCleanup) {
      try {
        activeCleanup();
      } catch (err) {
        console.error('cleanup failed', err);
      }
      activeCleanup = null;
    }
    const { path, query } = parseHash(location.hash);
    const match = matchRoute(routes, path);
    const ctx: RouteCtx = { path, params: match?.params ?? {}, query };
    const screen = match?.route.screen ?? notFound;
    root.replaceChildren();
    root.dataset.route = path;
    window.scrollTo(0, 0);
    let cleanup: Cleanup;
    try {
      cleanup = await screen(root, ctx);
    } catch (err) {
      console.error(err);
      if (myToken === token) {
        const box = document.createElement('div');
        box.className = 'card error';
        box.textContent = `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
        root.replaceChildren(box);
      }
      return;
    }
    if (myToken !== token) {
      if (cleanup) cleanup();
      return;
    }
    activeCleanup = cleanup ?? null;
  };

  window.addEventListener('hashchange', () => void render());
  void render();
}
