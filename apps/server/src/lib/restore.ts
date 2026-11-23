/**
 * 恢复备份的“落地”步骤，在数据库打开之前执行（因此这里不能依赖数据库模块）。
 *
 * 后台点“恢复”时只是把备份解压到 data/restore-pending/，然后让进程退出；
 * 进程被 Docker / systemd 拉起后，由这里把待恢复的数据换上去。
 * 被替换下来的数据不会删除，挪到 data/replaced-{时间}/ 里，恢复错了还能找回来。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PENDING_DIR = 'restore-pending';

export function applyPendingRestore(dataDir: string): string | null {
  const pending = path.join(dataDir, PENDING_DIR);
  if (!fs.existsSync(path.join(pending, 'blog.db'))) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const replaced = path.join(dataDir, `replaced-${stamp}`);
  fs.mkdirSync(replaced, { recursive: true });
  const swap = (name: string) => {
    const current = path.join(dataDir, name);
    const incoming = path.join(pending, name);
    if (fs.existsSync(current)) fs.renameSync(current, path.join(replaced, name));
    if (fs.existsSync(incoming)) fs.renameSync(incoming, current);
  };
  // WAL 文件属于旧数据库，必须一起挪走，否则会被套用到新库上
  for (const extra of ['blog.db-wal', 'blog.db-shm']) {
    const file = path.join(dataDir, extra);
    if (fs.existsSync(file)) fs.renameSync(file, path.join(replaced, extra));
  }
  swap('blog.db');
  swap('uploads');
  swap('themes');
  fs.rmSync(pending, { recursive: true, force: true });
  return replaced;
}
