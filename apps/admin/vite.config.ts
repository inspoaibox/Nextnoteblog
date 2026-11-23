import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时服务端跑在 3100（避开常被占用的 3000），可用 BLOG_BACKEND 覆盖
const backend = process.env.BLOG_BACKEND || 'http://localhost:3100';

export default defineConfig({
  base: '/admin/',
  plugins: [
    react(),
    {
      // 开发服务器上访问 /admin（不带斜杠）时跳到 /admin/
      name: 'admin-trailing-slash',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/admin' || req.url?.startsWith('/admin?')) {
            res.statusCode = 302;
            res.setHeader('location', `/admin/${req.url.slice(6)}`);
            return res.end();
          }
          next();
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': backend,
      // 除后台页面（/admin/…，由 Vite 提供）之外的所有地址都转给服务端，
      // 这样在 5173 上前台和后台是同一个站点：“查看站点”、文章预览、主题预览等链接都能直接用
      '^/(?!admin(?:/|$))': { target: backend, changeOrigin: false },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
