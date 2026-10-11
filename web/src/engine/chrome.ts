/**
 * The game's DOM chrome (PLAN_V2 §5.1, §7.9): the 16:9 paper stage the canvas letterboxes into, the HUD's
 * mute / music / restart / pause buttons (marker-outlined paper pills, sized in stage % so they line up with the HUD
 * plates at any scale) and the landscape touch controls (left thumb ◀ ▶ with slide-between, a big Jump on the right,
 * a small ↓ above it, "Always run"). Styles are injected once and prefixed. v4 modes reshape them (setControls):
 * runner and flappy get one big Jump / Flap button, top-down an ▲ ▼ pair; a rule's key (action, Space) gets its own.
 * A level skinned with Adobe Firefly art carries a small credit pill at the bottom centre ("Art: Adobe Firefly ·
 * drawn by Maya"); a click folds it to "✦ Art" (remembered), and the host can switch it off.
 */
import { paperBase } from '../render/paper.ts';
import { loadHandFont } from '../render/fonts.ts';
import { msg } from '../render/text.ts';
import type { Theme } from '../core/types.gen.ts';
import type { TouchLayout } from './controls.ts';
import type { Input, TouchKey } from './input.ts';
import { writeAlwaysRun } from './input.ts';

const CSS = `
.dalg-root{position:relative;width:100%;max-width:calc(100dvh * 16 / 9);margin:0 auto;aspect-ratio:16/9;overflow:hidden;user-select:none;-webkit-user-select:none;border-radius:10px;outline:none;container-type:inline-size;transition:background-color .3s}
.dalg-root:focus-visible{box-shadow:0 0 0 3px rgba(44,123,229,.45)}
.dalg-stage{position:absolute;inset:0}
.dalg-stage canvas{display:block}
.dalg-ui{position:absolute;inset:0;pointer-events:none;font-family:"Patrick Hand","Comic Sans MS","Chalkboard SE","Marker Felt",system-ui,sans-serif}
.dalg-btns{position:absolute;top:1.85%;right:1.05%;display:flex;gap:0.8cqw;width:auto;pointer-events:auto;justify-content:flex-end}
.dalg-btn{width:clamp(22px,4.4cqw,40px);aspect-ratio:1;height:auto;border-radius:50%;border:2px solid #1F1B18;background:#FFFDF6;
  display:grid;place-items:center;padding:0;cursor:pointer;box-shadow:1px 2px 0 rgba(31,27,24,.25);transform:rotate(-2deg)}
.dalg-btn[hidden]{display:none}
.dalg-btn[aria-pressed=false] svg{opacity:.55}
.dalg-btn:nth-child(2){transform:rotate(1.5deg)}
.dalg-btn:hover{background:#FFF6D9}.dalg-btn:active{transform:translateY(1px)}
.dalg-btn svg{width:62%;height:62%;stroke:#1F1B18;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.dalg-touch{position:absolute;inset:0;pointer-events:none;display:none}
.dalg-touch.on{display:block}
.dalg-pad{position:absolute;left:2%;bottom:4%;width:30%;height:30%;display:flex;gap:4%;pointer-events:auto;touch-action:none}
.dalg-pad div,.dalg-jump,.dalg-down{border:2.5px solid rgba(31,27,24,.75);background:rgba(255,253,246,.55);border-radius:50%;
  display:grid;place-items:center;color:#1F1B18;font-size:clamp(16px,3vw,28px);touch-action:none}
.dalg-pad div{flex:1;aspect-ratio:1;max-height:100%}
.dalg-pad div.held,.dalg-jump.held,.dalg-down.held{background:rgba(44,123,229,.25)}
.dalg-jump{position:absolute;right:3%;bottom:5%;width:17%;aspect-ratio:1;pointer-events:auto;font-size:clamp(14px,2.4vw,22px)}
.dalg-down{position:absolute;right:8.5%;bottom:40%;width:8%;aspect-ratio:1;pointer-events:auto}
.dalg-runbtn{position:absolute;right:22%;bottom:6%;width:10%;aspect-ratio:1;pointer-events:auto;border:2.5px solid rgba(31,27,24,.75);
  background:rgba(255,253,246,.55);border-radius:50%;display:grid;place-items:center;color:#1F1B18;font-size:clamp(11px,1.9vw,17px);touch-action:none}
.dalg-runbtn.held{background:rgba(62,158,79,.3)}
.dalg-run{position:absolute;left:2%;bottom:36%;pointer-events:auto;border:2px solid rgba(31,27,24,.7);border-radius:999px;
  background:rgba(255,253,246,.7);padding:2px 10px;font-size:clamp(11px,1.8vw,15px);color:#1F1B18}
.dalg-run[aria-pressed=true]{background:rgba(62,158,79,.3)}
.dalg-act,.dalg-spc{position:absolute;width:9%;aspect-ratio:1;pointer-events:auto;border:2.5px solid rgba(31,27,24,.75);border-radius:50%;
  background:rgba(255,236,170,.6);display:grid;place-items:center;color:#1F1B18;font-size:clamp(10px,1.7vw,15px);touch-action:none}
.dalg-act{right:23%;bottom:25%}
.dalg-spc{right:33%;bottom:11%;background:rgba(214,206,250,.6)}
.dalg-act.held,.dalg-spc.held{background:rgba(44,123,229,.25)}
.dalg-touch [hidden]{display:none}
.dalg-touch.big .dalg-jump{width:24%;right:4%;bottom:6%;font-size:clamp(16px,3vw,28px)}
.dalg-touch.big .dalg-act{right:31%;bottom:8%}
.dalg-touch.big .dalg-spc{right:31%;bottom:32%}
.dalg-touch.updown .dalg-jump{width:11%;right:7%;bottom:36%;font-size:clamp(16px,3vw,28px)}
.dalg-touch.updown .dalg-down{width:11%;right:7%;bottom:6%}
.dalg-credit{position:absolute;left:50%;bottom:1.6%;transform:translateX(-50%) rotate(-.6deg);pointer-events:auto;cursor:pointer;
  border:1.5px solid rgba(31,27,24,.5);border-radius:999px;background:rgba(255,253,246,.8);color:#1F1B18;font:inherit;
  font-size:clamp(9px,1.45cqw,13px);line-height:1.3;padding:1px 10px 2px;max-width:62%;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;opacity:.8;box-shadow:1px 1px 0 rgba(31,27,24,.14);transition:opacity .2s}
.dalg-credit:hover,.dalg-credit:focus-visible{opacity:1}
.dalg-credit[hidden]{display:none}
.dalg-credit.min{padding:1px 8px 2px;opacity:.6}
@media (prefers-reduced-motion: reduce){.dalg-btn,.dalg-btn:nth-child(2){transform:none}.dalg-credit{transform:translateX(-50%)}}
`;

let injected = false;
function injectCss(): void {
  if (injected || document.getElementById('dalg-css')) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'dalg-css';
  s.textContent = CSS;
  document.head.append(s);
}

/** The bundled "Patrick Hand" (OFL) at /fonts/PatrickHand-Regular.woff2; falls back to system hands. */
export const loadHudFont = loadHandFont;

const ICON = {
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5c1.4 1.8 1.4 5.2 0 7"/><path d="M19 6c2.6 3.3 2.6 8.7 0 12"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 0 2.2-5.1"/><path d="M5 4v4h4"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 17V5l10-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/></svg>',
  musicOff: '<svg viewBox="0 0 24 24"><path d="M9 17V5l10-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/><path d="M3 3l18 18"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
};

export interface Chrome {
  root: HTMLDivElement;
  stage: HTMLDivElement;
  /** Logical px (of the 768-px view) the buttons take at the top right; the HUD keeps its plates left of it. */
  readonly reserve: number;
  setMuted(m: boolean): void;
  setPaused(p: boolean): void;
  /** The ♪ button: shown when the level has music, pressed when the player's music setting is on. */
  setMusicAvailable(on: boolean): void;
  setMusicOn(on: boolean): void;
  setTheme(t: Theme): void;
  showTouch(on: boolean): void;
  /** True while the touch controls show (a coarse pointer, or the stage was touched). */
  readonly touchShown: boolean;
  /** The touch buttons for the level's mode and the keys its rules listen to (engine/controls.ts). */
  setControls(t: TouchLayout): void;
  /** The skin credit line ("Art: Adobe Firefly · drawn by Maya"); null hides the pill. */
  setCredit(text: string | null): void;
  /** The credit pill allowed at all (MountOptions.credits / GameHandle.setCredits). */
  setCreditsOn(on: boolean): void;
  destroy(): void;
}

const CREDIT_MIN_KEY = 'dal.skin_credit_min';

function readCreditMin(): boolean {
  try {
    return localStorage.getItem(CREDIT_MIN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCreditMin(on: boolean): void {
  try {
    if (on) localStorage.setItem(CREDIT_MIN_KEY, '1');
    else localStorage.removeItem(CREDIT_MIN_KEY);
  } catch {
    /* storage refused: the fold just isn't remembered */
  }
}

const BTN_PCT = 4.4; // button size, % of the stage width (≈ 34 logical px)
const GAP_PCT = 0.8;
const RIGHT_PCT = 1.05;

export function createChrome(
  el: HTMLElement,
  o: {
    theme: Theme; buttons: boolean; touch: boolean; input: Input | null; onMute(): void; onRestart(): void; onPause(): void; muted: boolean;
    /** The ♪ toggle (the player's music setting); omitted = no music button. */
    music?: { available: boolean; on: boolean; onToggle(): void };
    /** The skin credit pill may show (default true). */
    credits?: boolean;
  },
): Chrome {
  injectCss();
  const root = document.createElement('div');
  root.className = 'dalg-root';
  root.dataset.role = 'game';
  root.tabIndex = 0;
  root.style.background = paperBase(o.theme);
  const stage = document.createElement('div');
  stage.className = 'dalg-stage';
  const ui = document.createElement('div');
  ui.className = 'dalg-ui';
  root.append(stage, ui);
  el.replaceChildren(root);

  let muteBtn: HTMLButtonElement | null = null;
  let pauseBtn: HTMLButtonElement | null = null;
  let musicBtn: HTMLButtonElement | null = null;
  let nButtons = 0;
  let btnBox: HTMLDivElement | null = null;
  if (o.buttons) {
    const box = document.createElement('div');
    box.className = 'dalg-btns';
    const mk = (role: string, label: string, icon: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dalg-btn';
      b.dataset.role = role;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.innerHTML = icon;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        fn();
        root.focus({ preventScroll: true });
      });
      box.append(b);
      return b;
    };
    muteBtn = mk('mute', o.muted ? 'Sound on (M)' : 'Mute (M)', o.muted ? ICON.muted : ICON.sound, o.onMute);
    if (o.music) {
      // a toggle: a fixed name, the state in aria-pressed
      musicBtn = mk('music', 'Music', o.music.on ? ICON.music : ICON.musicOff, o.music.onToggle);
      musicBtn.setAttribute('aria-pressed', String(o.music.on));
      musicBtn.hidden = !o.music.available;
    }
    mk('restart', 'Restart from checkpoint (R)', ICON.restart, o.onRestart);
    pauseBtn = mk('pause', 'Pause (Esc)', ICON.pause, o.onPause);
    nButtons = box.children.length;
    btnBox = box;
    ui.append(box);
  }

  // touch controls
  const touch = document.createElement('div');
  touch.className = 'dalg-touch';
  const cleanups: (() => void)[] = [];
  let applyLayout: ((t: TouchLayout) => void) | null = null;
  if (o.touch && o.input) {
    const input = o.input;
    const pad = document.createElement('div');
    pad.className = 'dalg-pad';
    const lb = document.createElement('div');
    lb.textContent = '◀';
    const rb = document.createElement('div');
    rb.textContent = '▶';
    pad.append(lb, rb);
    // one pointer can slide between ◀ and ▶ without lifting
    const padPointers = new Map<number, 'left' | 'right' | null>();
    const which = (x: number): 'left' | 'right' | null => {
      const r = pad.getBoundingClientRect();
      if (x < r.left - 20 || x > r.right + 20) return null;
      return x < r.left + r.width / 2 ? 'left' : 'right';
    };
    const syncPad = (): void => {
      const vals = [...padPointers.values()];
      const L = vals.includes('left');
      const R = vals.includes('right');
      input.setTouch('left', L);
      input.setTouch('right', R);
      lb.classList.toggle('held', L);
      rb.classList.toggle('held', R);
    };
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pad.setPointerCapture(e.pointerId);
      padPointers.set(e.pointerId, which(e.clientX));
      syncPad();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!padPointers.has(e.pointerId)) return;
      padPointers.set(e.pointerId, which(e.clientX));
      syncPad();
    });
    const padUp = (e: PointerEvent): void => {
      padPointers.delete(e.pointerId);
      syncPad();
    };
    pad.addEventListener('pointerup', padUp);
    pad.addEventListener('pointercancel', padUp);
    const hold = (node: HTMLElement, k: Exclude<TouchKey, 'left' | 'right'>): void => {
      const ids = new Set<number>();
      node.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        node.setPointerCapture(e.pointerId);
        ids.add(e.pointerId);
        input.setTouch(k, true);
        node.classList.add('held');
      });
      const up = (e: PointerEvent): void => {
        ids.delete(e.pointerId);
        if (!ids.size) {
          input.setTouch(k, false);
          node.classList.remove('held');
        }
      };
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    };
    const jump = document.createElement('div');
    jump.className = 'dalg-jump';
    jump.textContent = 'Jump';
    const down = document.createElement('div');
    down.className = 'dalg-down';
    down.textContent = '↓';
    const runBtn = document.createElement('div');
    runBtn.className = 'dalg-runbtn';
    runBtn.textContent = 'Run';
    hold(jump, 'jump');
    hold(down, 'down');
    hold(runBtn, 'run');
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'dalg-run';
    run.textContent = 'Always run';
    run.setAttribute('aria-pressed', String(input.alwaysRun));
    run.addEventListener('click', () => {
      input.alwaysRun = !input.alwaysRun;
      writeAlwaysRun(input.alwaysRun);
      run.setAttribute('aria-pressed', String(input.alwaysRun));
    });
    // v4: buttons for the keys a rule listens to (E / Enter, and Space when Space has its own rule)
    const act = document.createElement('div');
    act.className = 'dalg-act';
    act.dataset.role = 'touch-action';
    act.textContent = msg('play4.touch_action', {}, 'Action');
    act.hidden = true;
    const spc = document.createElement('div');
    spc.className = 'dalg-spc';
    spc.dataset.role = 'touch-space';
    spc.textContent = msg('play4.touch_space', {}, 'Space');
    spc.hidden = true;
    hold(act, 'action');
    hold(spc, 'space');
    touch.append(pad, jump, down, runBtn, run, act, spc);
    ui.append(touch);
    applyLayout = (t) => {
      pad.hidden = !t.pad;
      down.hidden = !t.down;
      runBtn.hidden = !t.run;
      run.hidden = !t.alwaysRun;
      act.hidden = !t.action;
      spc.hidden = !t.space;
      touch.classList.toggle('big', t.big);
      touch.classList.toggle('updown', t.jump === 'up');
      jump.textContent = t.jump === 'up' ? '▲' : t.jump === 'flap' ? msg('play4.touch_flap', {}, 'Flap') : msg('play4.touch_jump', {}, 'Jump');
      down.textContent = t.jump === 'up' ? '▼' : '↓';
    };
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (coarse) touch.classList.add('on');
    const firstTouch = (): void => touch.classList.add('on');
    root.addEventListener('touchstart', firstTouch, { passive: true });
    cleanups.push(() => root.removeEventListener('touchstart', firstTouch));
  }

  // the skin credit pill (bottom centre: clear of the HUD plates, the buttons and both thumbs' touch controls)
  const credit = document.createElement('button');
  credit.type = 'button';
  credit.className = 'dalg-credit';
  credit.dataset.role = 'credit';
  credit.hidden = true;
  let creditText: string | null = null;
  let creditsOn = o.credits !== false;
  let creditMin = readCreditMin();
  const syncCredit = (): void => {
    credit.hidden = !creditText || !creditsOn;
    if (!creditText) return;
    credit.textContent = creditMin ? '✦ Art' : `✦ ${creditText}`;
    credit.title = creditText;
    credit.setAttribute('aria-label', creditText);
    credit.setAttribute('aria-expanded', String(!creditMin));
    credit.classList.toggle('min', creditMin);
  };
  credit.addEventListener('click', (e) => {
    e.preventDefault();
    creditMin = !creditMin;
    writeCreditMin(creditMin);
    syncCredit();
    root.focus({ preventScroll: true });
  });
  ui.append(credit);

  const visibleButtons = (): number => (musicBtn && musicBtn.hidden ? nButtons - 1 : nButtons);
  return {
    root,
    stage,
    get reserve() {
      const n = visibleButtons();
      if (!n) return 0;
      // measured when laid out (the buttons have a minimum CSS size on small stages), else from the CSS percentages
      const rw = root.clientWidth;
      if (btnBox && rw > 0) {
        const b = btnBox.getBoundingClientRect();
        const r = root.getBoundingClientRect();
        if (b.width > 0) return Math.ceil(((r.right - b.left) / rw) * 768 + 6);
      }
      // buttons + gaps + the right inset, in logical px of the 768-px view, plus a little air
      return Math.ceil(((n * BTN_PCT + (n - 1) * GAP_PCT + RIGHT_PCT) / 100) * 768 + 6);
    },
    setMusicAvailable(on) {
      if (musicBtn) musicBtn.hidden = !on;
    },
    setMusicOn(on) {
      if (!musicBtn) return;
      musicBtn.innerHTML = on ? ICON.music : ICON.musicOff;
      musicBtn.setAttribute('aria-pressed', String(on));
      musicBtn.title = on ? 'Music: on' : 'Music: off';
    },
    setTheme(t) {
      root.style.background = paperBase(t);
    },
    setMuted(m) {
      if (!muteBtn) return;
      muteBtn.innerHTML = m ? ICON.muted : ICON.sound;
      muteBtn.setAttribute('aria-label', m ? 'Sound on (M)' : 'Mute (M)');
      muteBtn.title = muteBtn.getAttribute('aria-label') ?? '';
    },
    setPaused(p) {
      if (!pauseBtn) return;
      pauseBtn.innerHTML = p ? ICON.play : ICON.pause;
      pauseBtn.setAttribute('aria-label', p ? 'Keep playing (Esc)' : 'Pause (Esc)');
    },
    showTouch(on) {
      touch.classList.toggle('on', on);
    },
    get touchShown() {
      return touch.classList.contains('on');
    },
    setControls(t) {
      applyLayout?.(t);
    },
    setCredit(text) {
      creditText = text && text.trim() ? text.trim() : null;
      syncCredit();
    },
    setCreditsOn(on) {
      creditsOn = on;
      syncCredit();
    },
    destroy() {
      for (const c of cleanups) c();
      root.remove();
    },
  };
}
