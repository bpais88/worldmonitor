import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Fresh, minimal config for the single-page freight app. The upstream repo's vite
// config carries multi-variant/multi-entry machinery this app never used.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3000,
  },
});
