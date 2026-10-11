import { defineConfig } from 'vite';

// The browser (and a phone on the LAN) only ever talks to the Vite port:
// /api and /uploads are proxied to the FastAPI port selected by scripts/dev.sh.
const API = `http://localhost:${process.env.DAL_PORT || '8000'}`;

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // '..' is the project root, so shared/fixtures/levels/*.json can be imported in dev.
    fs: { allow: ['..'] },
    proxy: {
      // ws: live drawing (WebSocket /api/v2/live/<room>, docs/v3/CONTRACTS_V3.md)
      '/api': { target: API, changeOrigin: true, ws: true },
      '/uploads': { target: API, changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // index.html boots the v2 app (PLAN_V2 P6 switch-over); v2.html is kept as an alias for old links.
    // v1.html is the v1 app, still reachable; dev.html is the v1 engine dev page.
    rollupOptions: { input: { main: 'index.html', v2: 'v2.html', v1: 'v1.html', dev: 'dev.html' } },
  },
});
