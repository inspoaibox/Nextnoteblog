import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError } from '../lib/errors.ts';

export const SESSION_COOKIE = 'nb_sid';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(userId: number, meta: { ip?: string; userAgent?: string }): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  await db.insert(schema.sessions).values({
    id: hashToken(token),
    userId,
    createdAt: now,
    expiresAt: now + config.sessionDays * 86400_000,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  return token;
}

export async function getSessionUser(token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const row = await db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName, role: schema.users.role, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.id, hashToken(token)))
    .get();
  if (!row || row.expiresAt < Date.now()) return null;
  return { id: row.id, username: row.username, displayName: row.displayName, role: row.role };
}

export async function destroySession(token: string | undefined) {
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)));
}

export async function destroyUserSessions(userId: number) {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/* ---------- 登录限速：同一 IP 连续失败 5 次后锁定 15 分钟 ---------- */

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { fails: number; lockedUntil: number; last: number }>();

export function assertLoginAllowed(ip: string) {
  const entry = attempts.get(ip);
  if (entry && entry.lockedUntil > Date.now()) {
    const minutes = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
    throw new HttpError(429, `登录失败次数过多，请 ${minutes} 分钟后再试`);
  }
}

export function recordLoginResult(ip: string, ok: boolean) {
  if (ok) return void attempts.delete(ip);
  const now = Date.now();
  const entry = attempts.get(ip) ?? { fails: 0, lockedUntil: 0, last: now };
  if (now - entry.last > LOCK_MS) entry.fails = 0;
  entry.fails += 1;
  entry.last = now;
  if (entry.fails >= MAX_FAILS) {
    entry.lockedUntil = now + LOCK_MS;
    entry.fails = 0;
  }
  attempts.set(ip, entry);
  if (attempts.size > 10_000) attempts.clear();
}

export async function audit(user: AuthUser | null, action: string, entity = '', entityId: string | number = '', detail: unknown = '', ip = '') {
  await db.insert(schema.auditLogs).values({
    userId: user?.id ?? null,
    action,
    entity,
    entityId: String(entityId),
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip,
    createdAt: Date.now(),
  });
}
