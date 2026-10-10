/** Live drawing styles, injected once (style.css belongs to lane 5; every rule here is prefixed `live-`). */

const CSS = `
.live-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 8px; padding: 6px 10px;
  border: 2px dashed var(--pencil, #6a5acd); border-radius: 12px; background: var(--card, #fffdf6); }
.live-status { display: inline-flex; align-items: center; gap: 6px; font-family: var(--hand); font-size: 1.05rem; }
.live-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--graphite, #8a8178); flex: none; }
.live-dot.live { background: var(--green, #3e9e4f); box-shadow: 0 0 0 3px rgba(62, 158, 79, 0.22); }
.live-dot.offline, .live-dot.connecting { background: #d9822b; animation: live-blink 1s ease-in-out infinite; }
.live-avs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.live-av { position: relative; width: 36px; height: 36px; border-radius: 50%; border: 3px solid; padding: 0; display: grid;
  place-items: center; font-family: var(--hand); font-size: 1.05rem; color: #fff; cursor: default; flex: none; }
.live-av img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; background: #fffdf6; }
.live-av.can-pass { cursor: pointer; }
.live-av.can-pass:hover { transform: translateY(-2px) rotate(-3deg); }
.live-av.me { outline: 2px dotted var(--ink, #1f1b18); outline-offset: 2px; }
.live-av .live-badge { position: absolute; right: -8px; bottom: -6px; font-size: 15px; line-height: 1; }
.live-av.wiggle { animation: live-wiggle 0.5s ease-in-out; }
.live-reacts { display: inline-flex; gap: 2px; }
.live-reacts button { font-size: 1.25rem; line-height: 1; background: none; border: none; cursor: pointer; padding: 3px 4px;
  border-radius: 8px; }
.live-reacts button:hover { background: var(--tint, #efe7d6); transform: scale(1.15); }
.live-bar .live-grow { flex: 1; }
.live-bubble { position: absolute; z-index: 6; pointer-events: none; font-size: 30px; line-height: 1;
  transform: translate(-50%, -100%); animation: live-rise 2.2s ease-out forwards; filter: drop-shadow(1px 2px 0 rgba(31, 27, 24, 0.18)); }
.live-bubble small { display: block; font-family: var(--hand); font-size: 12px; text-align: center; color: #fff;
  border-radius: 8px; padding: 0 5px; margin-top: 2px; }
.live-share .live-link { display: flex; gap: 6px; align-items: center; }
.live-share .live-link input { flex: 1; min-width: 0; font: inherit; font-size: 0.9rem; padding: 7px 9px;
  border: 2px solid var(--ink, #1f1b18); border-radius: 9px; background: #fff; }
.live-share .live-qr { display: block; width: 184px; height: 184px; margin: 12px auto 2px; background: #fff;
  border-radius: 10px; border: 2px solid var(--tint, #efe7d6); }
.live-share .live-qr-cap { text-align: center; margin: 0 0 8px; }
.live-share .live-pass { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 4px; }
@keyframes live-rise {
  0% { opacity: 0; transform: translate(-50%, -60%) scale(0.4); }
  12% { opacity: 1; transform: translate(-50%, -100%) scale(1.2); }
  25% { transform: translate(-50%, -100%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -100%) translateY(-110px); }
}
@keyframes live-blink { 50% { opacity: 0.35; } }
@keyframes live-wiggle { 25% { transform: rotate(-12deg); } 75% { transform: rotate(12deg); } }
@media (prefers-reduced-motion: reduce) {
  .live-bubble { animation: live-fade 2.2s ease-out forwards; }
  .live-dot.offline, .live-dot.connecting, .live-av.wiggle { animation: none; }
}
@keyframes live-fade { 0% { opacity: 0; } 10% { opacity: 1; } 100% { opacity: 0; } }
`;

let injected = false;

export function injectLiveStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const el = document.createElement('style');
  el.dataset.owner = 'live';
  el.textContent = CSS;
  document.head.append(el);
}
