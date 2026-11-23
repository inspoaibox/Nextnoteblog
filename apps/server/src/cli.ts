/**
 * 运维命令行（后台进不去时的救命通道）。
 *   node cli.js reset-password <用户名> <新密码>
 *   node cli.js list-users
 *   node cli.js backup [备注]
 *   node cli.js list-backups
 *   node cli.js restore <备份文件名>
 *   node cli.js theme-check <主题包.zip>
 */
import { eq } from 'drizzle-orm';
import { db, schema, runMigrations } from './db/index.ts';
import { hashPassword, passwordProblem } from './lib/password.ts';
import { destroyUserSessions } from './services/auth.ts';

const [command, ...args] = process.argv.slice(2);
await runMigrations();

if (command === 'reset-password') {
  const [username, password] = args;
  if (!username || !password) fail('用法：reset-password <用户名> <新密码>');
  const problem = passwordProblem(password);
  if (problem) fail(problem);
  const user = await db.select().from(schema.users).where(eq(schema.users.username, username)).get();
  if (!user) fail(`用户不存在：${username}`);
  await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, user!.id));
  await destroyUserSessions(user!.id);
  console.log(`已重置 ${username} 的密码，并使其所有登录会话失效。`);
} else if (command === 'list-users') {
  for (const u of await db.select().from(schema.users)) console.log(`${u.id}\t${u.username}\t${u.role}\t${u.displayName}`);
} else if (command === 'backup') {
  const { createBackup } = await import('./services/backup.ts');
  const created = await createBackup('manual', args.join(' ') || '命令行备份');
  console.log(`已备份：${created.name}（${(created.size / 1024 / 1024).toFixed(1)} MB）`);
} else if (command === 'list-backups') {
  const { listBackups } = await import('./services/backup.ts');
  for (const b of listBackups()) console.log([b.name, `${(b.size / 1024 / 1024).toFixed(1)} MB`, b.manifest?.note ?? ''].join('\t'));
} else if (command === 'restore') {
  const [name] = args;
  if (!name) fail('用法：restore <备份文件名>（可用 list-backups 查看）');
  const { createBackup, prepareRestore } = await import('./services/backup.ts');
  const safety = await createBackup('manual', `恢复 ${name} 之前的自动留底`);
  prepareRestore(name);
  console.log(`已准备好恢复 ${name}，当前状态已留底为 ${safety.name}。`);
  console.log('请重启服务（systemctl restart nexemcblog 或 docker compose restart blog），恢复会在启动时完成。');
} else if (command === 'theme-check') {
  const [file] = args;
  if (!file) fail('用法：theme-check <主题包.zip>');
  const { readFileSync } = await import('node:fs');
  const { initThemes, inspectPackage } = await import('./services/themes.ts');
  await initThemes();
  const report = await inspectPackage(readFileSync(file));
  if (report.manifest) console.log(`${report.manifest.name}（${report.manifest.id} ${report.manifest.version}），${report.fileCount} 个文件`);
  for (const w of report.warnings) console.log(`提示：${w}`);
  if (!report.ok) fail(['检查未通过：', ...report.errors.map((e) => `  - ${e}`)].join('\n'));
  console.log('检查通过，可以在后台上传安装。');
} else {
  fail('可用命令：reset-password <用户名> <新密码> | list-users | backup [备注] | list-backups | restore <备份文件名> | theme-check <主题包.zip>');
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
