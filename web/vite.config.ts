import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.GATEWAY_URL || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target, changeOrigin: true },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 3000,
  },
});
