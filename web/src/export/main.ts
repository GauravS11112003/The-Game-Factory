/**
 * The game's bootstrap. In an exported project this file is `src/main.ts`; in the draw.play repo it is
 * `web/src/export/main.ts`, the entry of `vite.export.config.ts` (the prebuilt `dist/`).
 *
 * How the bundled game is loaded:
 *   1. `index.html` has `<div id="app">` and loads this module.
 *   2. `startPlayer` fetches `game.json` (next to index.html): the game's title, rules, credits and its levels in order.
 *      Each level is a full `dal-level` (LevelV2): the drawing (`ink`), the built world (`compiled`), the art `skin`.
 *      Image paths inside it are relative ("assets/…"), so the folder works on any static host.
 *   3. For each level the player calls `mountGame` (src/engine/index.ts): one Phaser 3 game running the deterministic
 *      core sim (src/core/sim) at 60 Hz, with the engine's HUD buttons and touch controls.
 *
 * Ways to keep coding (uncomment and try):
 *   - Hooks below: react to a level starting or being cleared, or to the whole game being beaten.
 *   - `transformLevel`: change a level right before it plays (its rules, theme, title…).
 *   - `player.handle`: the running level's engine handle (pause, restart, setRules, snapshot…).
 *   - The Phaser scene itself is src/engine/scene.ts; the menus are src/export/player.ts.
 *   - Add a level: put another LevelV2 into game.json → "levels" (export one from draw.play).
 */
import { startPlayer, type Player } from './player.ts';

const app = document.getElementById('app') ?? document.body;

startPlayer(app, {
  gameUrl: 'game.json',

  // Every level open from the start (no unlocking):
  // unlockAll: true,

  // Play one level only while you work on it (also: ?level=2 in the page URL):
  // startLevel: 0,

  // Change a level before it plays, e.g. 3 lives and 3 hearts (the paper theme and music are game.json → "rules"):
  // transformLevel: (level) => ({ ...level, rules: { ...level.rules, lives: 3, hearts: 3 } }),

  onLevelStart: ({ index, level }) => {
    console.info(`draw.play: level ${index + 1} "${level.title}"`);
  },
  onLevelClear: ({ index, win, best }) => {
    console.info(`draw.play: cleared level ${index + 1} in ${(win.time_ms / 1000).toFixed(2)} s${best ? ' (new best!)' : ''}`);
  },
  onGameClear: (game) => {
    console.info(`draw.play: "${game.game.title}" beaten!`);
  },
}).then((player: Player) => {
  // Handy in the browser console: drawplay.play(2), drawplay.handle?.pause(), drawplay.progress.reset()…
  (window as unknown as { drawplay?: Player }).drawplay = player;
}).catch(() => {
  /* the player already shows what went wrong */
});
