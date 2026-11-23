import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时服务端跑在 3100（避开常被占用的 3000），可用 BLOG_BACKEND 覆盖
const backend = process.env.BLOG_BACKEND || 'http://localhost:3100';

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
