import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    hmr: mode === 'webgpu-test' ? false : undefined,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
    },
  },
  build: {
    sourcemap: true,
  },
}));
