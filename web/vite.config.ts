import { defineConfig } from 'vite';

// The browser (and a phone on the LAN) only ever talks to the Vite port:
// /api and /uploads are proxied to the FastAPI app on 8000.
const API = 'http://localhost:8000';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // '..' is the project root, so shared/fixtures/levels/*.json can be imported in dev.
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: API, changeOrigin: true },
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
    // dev.html is the engine dev page (lane B); building it keeps it type-checked and bundled.
    rollupOptions: { input: { main: 'index.html', dev: 'dev.html' } },
  },
});
