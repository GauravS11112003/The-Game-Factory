/**
 * On-screen left/right/jump buttons (PLAN.md section 10).
 *
 * Plain DOM elements positioned over the game container, created only when
 * `(pointer: coarse)` matches (or `force` is set). Each button tracks the set
 * of pointer ids pressing it, so two thumbs (run + jump) work at once and a
 * second finger lifting does not release the first.
 */
export interface TouchState {
  left: boolean;
  right: boolean;
  jump: boolean;
}

export interface TouchControls {
  readonly state: TouchState;
  destroy(): void;
}

export function touchPreferred(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

const BUTTON_STYLE =
  'position:absolute;width:64px;height:64px;border-radius:50%;' +
  'background:rgba(0,0,0,0.18);border:2px solid rgba(0,0,0,0.28);color:#fff;' +
  'font:bold 24px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;' +
  'text-shadow:0 1px 2px rgba(0,0,0,0.6);touch-action:none;user-select:none;-webkit-user-select:none;' +
  '-webkit-tap-highlight-color:transparent;z-index:10;cursor:pointer;';

export function createTouchControls(container: HTMLElement, opts: { force?: boolean } = {}): TouchControls | null {
  if (!opts.force && !touchPreferred()) return null;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const state: TouchState = { left: false, right: false, jump: false };
  const cleanups: Array<() => void> = [];

  const makeButton = (label: string, key: keyof TouchState, pos: string): void => {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', key);
    el.className = `touch-btn touch-${key}`;
    el.style.cssText = BUTTON_STYLE + pos;
    el.textContent = label;
    const active = new Set<number>();
    const sync = (): void => {
      state[key] = active.size > 0;
      el.style.background = state[key] ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.18)';
    };
    const down = (e: PointerEvent): void => {
      e.preventDefault();
      active.add(e.pointerId);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // capture is best-effort; the up/cancel handlers still run
      }
      sync();
    };
    const up = (e: PointerEvent): void => {
      active.delete(e.pointerId);
      sync();
    };
    const swallow = (e: Event): void => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', swallow);
    el.addEventListener('touchstart', swallow, { passive: false });
    container.append(el);
    cleanups.push(() => {
      el.remove();
      active.clear();
      state[key] = false;
    });
  };

  makeButton('◀', 'left', 'left:16px;bottom:16px;');
  makeButton('▶', 'right', 'left:96px;bottom:16px;');
  makeButton('▲', 'jump', 'right:16px;bottom:16px;');

  // Pointer-up outside any button (e.g. the finger slid off before the capture took) releases everything.
  const release = (): void => {
    // Individual buttons already handle their captured pointers; this is a safety net on blur.
    state.left = false;
    state.right = false;
    state.jump = false;
  };
  window.addEventListener('blur', release);
  cleanups.push(() => window.removeEventListener('blur', release));

  return {
    state,
    destroy() {
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}
