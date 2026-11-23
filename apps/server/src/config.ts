import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ 与 dist/ 都位于 apps/server 下，向上三级即仓库（或安装目录）根
const root = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : path.resolve(here, '../../..');
// 数据目录：命令行 --data-dir= 优先，其次环境变量 DATA_DIR
const dataDir = path.resolve(process.argv.find((a) => a.startsWith('--data-dir='))?.slice(11) || process.env.DATA_DIR || path.join(root, 'data'));

export const config = {
  root,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: path.join(dataDir, 'blog.db'),
  themesDir: path.join(root, 'themes'),
  adminDist: path.join(root, 'apps/admin/dist'),
  migrationsDir: path.join(root, 'apps/server/drizzle'),
  // 端口：命令行 --port=3100 优先，其次环境变量 PORT
  port: Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  isProd: process.env.NODE_ENV === 'production',
  sessionDays: 30,
  maxUploadBytes: 10 * 1024 * 1024,
};
