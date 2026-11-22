import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';
import { config } from '../config.ts';
import * as schema from './schema.ts';

fs.mkdirSync(config.uploadsDir, { recursive: true });

export const sqlite = new DatabaseSync(config.dbFile);
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

const statements = new Map<string, StatementSync>();
function prepare(sql: string) {
  let stmt = statements.get(sql);
  if (!stmt) {
    if (statements.size > 500) statements.clear();
    stmt = sqlite.prepare(sql);
    stmt.setReturnArrays(true);
    statements.set(sql, stmt);
  }
  return stmt;
}

/*
 * 单连接 + 异步调用方：事务进行期间，事务之外的查询必须排队，
 * 否则会混进别人的事务里。用 AsyncLocalStorage 区分“事务持有者”。
 */
const txContext = new AsyncLocalStorage<symbol>();
let txOwner: symbol | null = null;
let txDone: Promise<void> = Promise.resolve();

export const db = drizzle(
  async (sql, params, method) => {
    while (txOwner && txContext.getStore() !== txOwner) await txDone;
    const stmt = prepare(sql);
    if (method === 'run') {
      stmt.run(...(params as any[]));
      return { rows: [] };
    }
    if (method === 'get') return { rows: stmt.get(...(params as any[])) as any };
    return { rows: stmt.all(...(params as any[])) as any[] };
  },
  { schema },
);

export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txOwner && txContext.getStore() === txOwner) return fn(); // 已在事务内
  while (txOwner) await txDone;
  const owner = Symbol('tx');
  let release!: () => void;
  txOwner = owner;
  txDone = new Promise((r) => (release = r));
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    const result = await txContext.run(owner, fn);
    sqlite.exec('COMMIT');
    return result;
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  } finally {
    txOwner = null;
    release();
  }
}

export async function runMigrations() {
  await migrate(
    db,
    async (queries) => {
      sqlite.exec('BEGIN');
      try {
        for (const q of queries) sqlite.exec(q);
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
    { migrationsFolder: config.migrationsDir },
  );
}

export { schema };
