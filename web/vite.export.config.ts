/**
 * "Export to Phaser" player build (docs/v3/CONTRACTS_V3.md, lane 7): `npx vite build --config vite.export.config.ts`
 * turns export.html + src/export/main.ts (the standalone player around mountGame) into web/dist-export/:
 *
 *   index.html                 relative URLs only (base './'), so the folder runs from any static host or sub-path
 *   player/drawplay-<hash>.js  one bundle: the player, the engine, the core sim and Phaser 3
 *   fonts/                     the hand font, when web/public/fonts has it
 *
 * The API (vision/app/routers/v2/export_phaser.py) rebuilds this on demand when the sources are newer, and adds
 * game.json + assets/ next to index.html in every exported zip.
 */
import { cpSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const WEB = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(WEB, 'dist-export');

/** export.html → index.html, and the bundled hand font (if present) → fonts/. */
function finishExport(): Plugin {
  return {
    name: 'drawplay-export-finish',
    apply: 'build',
    closeBundle() {
      const html = resolve(OUT, 'export.html');
      if (existsSync(html)) {
        rmSync(resolve(OUT, 'index.html'), { force: true });
        renameSync(html, resolve(OUT, 'index.html'));
      }
      const fonts = resolve(WEB, 'public', 'fonts');
      if (existsSync(fonts) && readdirSync(fonts).some((f) => /\.(woff2?|ttf|otf)$/i.test(f))) {
        cpSync(fonts, resolve(OUT, 'fonts'), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  root: WEB,
  base: './',
  // web/public is the app's (default_player.png, …); the player needs none of it
  publicDir: false,
  plugins: [finishExport()],
  build: {
    target: 'es2022',
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'player',
    // keep it one JS file: small imported files are inlined, nothing is split
    assetsInlineLimit: 512 * 1024,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 4096,
    reportCompressedSize: false,
    rollupOptions: {
      input: { export: resolve(WEB, 'export.html') },
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'player/drawplay-[hash].js',
        assetFileNames: 'player/[name]-[hash][extname]',
      },
    },
  },
});
