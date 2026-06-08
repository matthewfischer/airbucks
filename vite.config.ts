import { defineConfig } from 'vite';

// Electron loads the renderer from this dev server (port 5173) in development
// and from ./dist after `vite build` in production.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
