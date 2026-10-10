/**
 * The standalone player's look: the same paper-and-marker feel as draw.play (cream paper, ink outlines, a yellow
 * highlighter), injected from code so the build stays one JS file. `--dp-paper` follows the game's paper theme.
 * The game stage itself is styled by the engine (web/src/engine/chrome.ts, `.dalg-*`).
 */
import { HAND_FONT } from '../render/fonts.ts';

const CSS = `
:root{--dp-paper:#FBF6EA;--dp-card:#FFFDF6;--dp-ink:#1F1B18;--dp-soft:#5D554D;--dp-hi:#FFE36E;--dp-green:#3E9E4F;--dp-blue:#2C7BE5;
  --dp-r:14px 11px 16px 12px / 12px 16px 11px 14px;--dp-shadow:2px 3px 0 rgba(31,27,24,.14);--dp-bar:52px}
html,body{margin:0;padding:0;background:var(--dp-paper);color:var(--dp-ink);-webkit-text-size-adjust:100%;transition:background-color .3s}
*{box-sizing:border-box}
.dp-root{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;font-family:${HAND_FONT};color:var(--dp-ink);
  padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.dp-root button{font:inherit;color:inherit}
.dp-screen{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px 16px;text-align:center}
.dp-screen.top{justify-content:flex-start}
.dp-h1{font-size:clamp(2.1rem,7vw,4.2rem);line-height:1.05;margin:0;transform:rotate(-1.2deg);font-weight:400;
  background:linear-gradient(transparent 60%,var(--dp-hi) 60%,var(--dp-hi) 88%,transparent 88%);padding:0 .2em;overflow-wrap:anywhere}
.dp-h2{font-size:clamp(1.6rem,4.5vw,2.4rem);margin:0;font-weight:400;transform:rotate(-1deg)}
.dp-h3{font-size:1.35rem;margin:18px 0 6px;font-weight:400;text-decoration:underline;text-decoration-color:var(--dp-hi);text-decoration-thickness:6px;text-underline-offset:-2px}
.dp-sub{color:var(--dp-soft);font-size:1.2rem;margin:0}
.dp-small{color:var(--dp-soft);font-size:.95rem}
.dp-cover{width:min(560px,88vw);aspect-ratio:16/9;border:2.5px solid var(--dp-ink);border-radius:var(--dp-r);overflow:hidden;
  box-shadow:var(--dp-shadow);transform:rotate(1deg);background:var(--dp-card)}
.dp-cover canvas,.dp-level canvas{display:block;width:100%;height:100%}
.dp-menu{display:flex;flex-direction:column;gap:10px;align-items:stretch;min-width:min(260px,80vw)}
.dp-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center}
.dp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:2.5px solid var(--dp-ink);border-radius:999px;
  background:var(--dp-card);color:var(--dp-ink);padding:6px 18px;font-size:1.25rem;cursor:pointer;text-decoration:none;
  box-shadow:1px 2px 0 rgba(31,27,24,.18);transition:transform .08s ease,background .12s;touch-action:manipulation}
.dp-btn:hover:not(:disabled){transform:rotate(-1deg) translateY(-1px);background:#FFF8D8}
.dp-btn:active:not(:disabled){transform:translateY(1px);box-shadow:none}
.dp-btn:disabled{opacity:.45;cursor:default}
.dp-btn.primary{background:var(--dp-ink);color:var(--dp-paper)}
.dp-btn.primary:hover:not(:disabled){background:#3A332D}
.dp-btn.small{padding:2px 12px;font-size:1rem;border-width:2px}
.dp-btn:focus-visible{outline:3px solid rgba(44,123,229,.5);outline-offset:2px}
.dp-foot{margin-top:auto;padding-top:18px;color:var(--dp-soft);font-size:.95rem}
.dp-play{flex:1;display:flex;flex-direction:column;gap:6px;padding:6px 8px 8px;min-height:0}
.dp-bar,.dp-stage{width:100%;max-width:calc((100vh - var(--dp-bar) - 20px) * 16 / 9);max-width:calc((100dvh - var(--dp-bar) - 20px) * 16 / 9);margin:0 auto}
.dp-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:calc(var(--dp-bar) - 8px)}
.dp-bar .dp-name{font-size:1.2rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;text-align:left}
.dp-bar .dp-name b{font-weight:400;background:var(--dp-hi);padding:0 .3em;border-radius:6px;margin-right:.35em}
.dp-bar .dp-row{flex-wrap:nowrap;flex:none}
.dp-stage{position:relative}
.dp-stage-host{width:100%}
.dp-over{position:absolute;inset:0;display:grid;place-items:center;background:rgba(251,246,234,.55);z-index:5;padding:12px}
.dp-card{background:var(--dp-card);border:2.5px solid var(--dp-ink);border-radius:var(--dp-r);box-shadow:var(--dp-shadow);
  padding:16px 22px;text-align:center;min-width:min(320px,86%);max-width:min(460px,96%);transform:rotate(-.8deg);display:flex;flex-direction:column;gap:8px;align-items:center}
.dp-big{font-size:clamp(1.8rem,5vw,2.6rem);line-height:1}
.dp-stats{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;color:var(--dp-soft);font-size:1.1rem}
.dp-badge{display:inline-block;border:2px solid var(--dp-ink);border-radius:999px;padding:0 10px;font-size:.95rem;background:var(--dp-hi)}
.dp-badge.green{background:#CFEBD3}
.dp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:16px;width:min(1040px,100%);margin-top:6px}
.dp-level{position:relative;display:flex;flex-direction:column;gap:6px;padding:8px;border:2.5px solid var(--dp-ink);border-radius:var(--dp-r);
  background:var(--dp-card);box-shadow:var(--dp-shadow);cursor:pointer;text-align:left;transition:transform .08s ease}
.dp-level:nth-child(odd){transform:rotate(-.6deg)}.dp-level:nth-child(even){transform:rotate(.6deg)}
.dp-level:hover:not(:disabled){transform:rotate(0) translateY(-2px)}
.dp-level:disabled{cursor:default;opacity:.55}
.dp-level .thumb{aspect-ratio:16/9;border:1.5px solid rgba(31,27,24,.35);border-radius:8px;overflow:hidden;background:var(--dp-paper)}
.dp-level .t{font-size:1.15rem;line-height:1.15;overflow-wrap:anywhere}
.dp-level .n{display:inline-block;min-width:1.6em;text-align:center;background:var(--dp-hi);border-radius:6px;margin-right:.3em}
.dp-level .m{font-size:.92rem;color:var(--dp-soft);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dp-level .lock{position:absolute;top:14px;right:14px;font-size:1.5rem}
.dp-credits{width:min(640px,100%);display:flex;flex-direction:column;align-items:center}
.dp-credits ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:1.15rem}
.dp-credits li .dp-small{margin-left:.35em}
.dp-msg{max-width:520px;font-size:1.25rem}
.dp-rotate{display:none;font-size:1rem;color:var(--dp-soft);text-align:center}
@media (orientation:portrait) and (pointer:coarse){.dp-play .dp-rotate{display:block}}
@media (max-height:520px){.dp-cover{display:none}.dp-screen{padding:12px 16px;gap:10px}}
@media (max-width:560px){.dp-bar .dp-btn .lbl{display:none}.dp-bar .dp-btn{padding:2px 9px}}
@media (prefers-reduced-motion:reduce){.dp-btn,.dp-level,.dp-card,.dp-cover,.dp-h1,.dp-h2{transform:none!important;transition:none}}
`;

let injected = false;

export function injectPlayerCss(): void {
  if (injected || document.getElementById('dp-css')) return;
  injected = true;
  const s = document.createElement('style');
  s.id = 'dp-css';
  s.textContent = CSS;
  document.head.append(s);
}
