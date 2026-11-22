import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://localhost:3000';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': backend,
      '/uploads': backend,
      '/theme': backend,
      '/preview': backend,
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
