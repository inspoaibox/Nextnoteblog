/**
 * 运维命令行（后台进不去时的救命通道）。
 *   node cli.js reset-password <用户名> <新密码>
 *   node cli.js list-users
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
} else {
  fail('可用命令：reset-password <用户名> <新密码> | list-users');
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
