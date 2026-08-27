import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // En desarrollo el API vive en el contenedor 'api'; en local, en 3000.
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
