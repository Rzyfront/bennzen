import { defineConfig } from 'vite';

// La PWA vive en pwa/, pero importa tipos de ../shared → permitir fs fuera del root.
export default defineConfig({
  root: 'pwa',
  server: {
    port: 5180,
    fs: { allow: ['..'] },
  },
  build: {
    outDir: '../dist-pwa',
    emptyOutDir: true,
  },
});
