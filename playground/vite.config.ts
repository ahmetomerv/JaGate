import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../assets/', import.meta.url)),
  plugins: [vue()],
  build: { outDir: '.vite-dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    cors: { origin: 'http://127.0.0.1:5173' },
    proxy: { '/api': 'http://127.0.0.1:3081' },
  },
});
