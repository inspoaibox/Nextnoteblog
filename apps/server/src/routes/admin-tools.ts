/** M5 管理接口：导入导出、备份恢复、重定向、操作日志 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { config } from '../config.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import * as auth from '../services/auth.ts';
import * as transfer from '../services/transfer.ts';
import * as backup from '../services/backup.ts';
import * as searchSvc from '../services/search.ts';
import { addRedirect } from '../services/posts.ts';

const MAX_IMPORT_FILE = 60 * 1024 * 1024;

function parse<T>(shape: z.ZodType<T>, data: unknown): T {
  const result = shape.safeParse(data ?? {});
  if (!result.success) throw badRequest(`参数错误：${result.error.issues[0].path.join('.') || '请求'} ${result.error.issues[0].message}`);
  return result.data;
}

async function filesOf(req: FastifyRequest): Promise<transfer.IncomingFile[]> {
  const out: transfer.IncomingFile[] = [];
  for await (const part of req.files({ limits: { fileSize: MAX_IMPORT_FILE, files: 500 } })) out.push({ name: part.filename || 'untitled.md', data: await part.toBuffer() });
  if (!out.length) throw badRequest('没有收到文件');
  return out;
}

const download = (reply: any, filename: string, type: string) =>
  reply.header('content-type', type).header('content-disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`).header('cache-control', 'no-store');

export async function adminToolRoutes(app: FastifyInstance) {
  const audit = (req: FastifyRequest, action: string, entity: string, id: string | number = '', detail: unknown = '') => auth.audit(req.user, action, entity, id, detail, req.ip);

  /* ---------- 导入 ---------- */

  app.post('/import/inspect', async (req) => transfer.inspectImport(await filesOf(req), req.contentLocale));

  app.post('/import/run', async (req) => {
    const q = parse(z.object({ onConflict: z.enum(['skip', 'rename', 'overwrite']).default('skip'), publish: z.enum(['0', '1']).default('0'), createCategories: z.enum(['0', '1']).default('1') }), req.query);
    const result = await transfer.runImport(await filesOf(req), { onConflict: q.onConflict, publish: q.publish === '1', createCategories: q.createCategories === '1', locale: req.contentLocale, userId: req.user!.id });
    await audit(req, 'import', 'post', '', { created: result.created, updated: result.updated, skipped: result.skipped, failed: result.failed });
    await searchSvc.rebuildIndex();
    return result;
  });

  /* ---------- 导出 ---------- */

  app.get('/export/posts/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const source = (req.query as { source?: string }).source === 'published' ? 'published' : 'draft';
    const { filename, content } = await transfer.exportPostMarkdown(id, source);
    return download(reply, filename, 'text/markdown; charset=utf-8').send(content);
  });

  app.get('/export/site', async (req, reply) => {
    const q = parse(z.object({ categoryId: z.coerce.number().int().optional(), media: z.enum(['0', '1']).default('1') }), req.query);
    const { filename, data } = await transfer.exportSite({ categoryId: q.categoryId, locale: req.contentLocale, includeMedia: q.media === '1' });
    await audit(req, 'export', 'site', '', { categoryId: q.categoryId, media: q.media, bytes: data.length });
    return download(reply, filename, 'application/zip').send(data);
  });

  /* ---------- 备份与恢复 ---------- */

  app.get('/backups', async () => ({ backups: backup.listBackups(), dir: backup.backupsDir }));

  app.post('/backups', async (req) => {
    const body = parse(z.object({ note: z.string().max(200).optional() }), req.body);
    const created = await backup.createBackup('manual', body.note ?? '');
    await audit(req, 'backup_create', 'backup', created.name);
    return created;
  });

  app.get('/backups/:name', async (req, reply) => {
    const name = String((req.params as { name: string }).name);
    return download(reply, name, 'application/zip').send(fs.createReadStream(backup.backupPath(name)));
  });

  app.delete('/backups/:name', async (req) => {
    const name = String((req.params as { name: string }).name);
    backup.deleteBackup(name);
    await audit(req, 'backup_delete', 'backup', name);
    return { ok: true };
  });

  app.post('/backups/:name/restore', async (req) => {
    const name = String((req.params as { name: string }).name);
    // 恢复前先把当前状态备份一次，万一恢复错了还能回来
    const safety = await backup.createBackup('manual', `恢复 ${name} 之前的自动留底`);
    const manifest = backup.prepareRestore(name);
    await audit(req, 'backup_restore', 'backup', name, { safety: safety.name });
    // 数据库文件要在进程重启时替换；由 Docker / systemd 负责把进程拉起来
    if (config.exitOnRestore) setTimeout(() => process.exit(0), 400).unref();
    return { ok: true, manifest, safetyBackup: safety.name, restarting: config.exitOnRestore };
  });

  /* ---------- 重定向 ---------- */

  app.get('/redirects', async (req) => {
    const q = parse(z.object({ q: z.string().max(200).optional(), page: z.coerce.number().int().min(1).default(1) }), req.query);
    const where = q.q?.trim() ? sql`${schema.redirects.fromPath} like ${`%${q.q.trim()}%`} or ${schema.redirects.toPath} like ${`%${q.q.trim()}%`}` : undefined;
    const pageSize = 50;
    const total = (await db.select({ n: sql<number>`count(*)` }).from(schema.redirects).where(where).get())!.n;
    const items = await db.select().from(schema.redirects).where(where).orderBy(desc(schema.redirects.id)).limit(pageSize).offset((q.page - 1) * pageSize);
    return { total, page: q.page, pageSize, items };
  });

  const pathField = z
    .string()
    .trim()
    .max(500)
    .regex(/^\/[^\s?#]*$/, '需为以 / 开头的站内地址，不含查询参数');

  app.post('/redirects', async (req) => {
    const body = parse(z.object({ from: pathField, to: z.string().trim().max(500).regex(/^(\/[^\s]*|https?:\/\/\S+)$/, '需为以 / 开头的站内地址或完整网址') }), req.body);
    const from = body.from.replace(/\/+$/, '') || '/';
    if (from === '/' || from.startsWith('/admin')) throw badRequest('首页和后台地址不能设置重定向');
    if (from === body.to) throw badRequest('来源和目标不能相同');
    await addRedirect(from, body.to);
    await audit(req, 'redirect_create', 'redirect', '', `${from} → ${body.to}`);
    return { ok: true };
  });

  app.delete('/redirects/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const row = await db.select().from(schema.redirects).where(eq(schema.redirects.id, id)).get();
    if (!row) throw notFound('重定向');
    await db.delete(schema.redirects).where(eq(schema.redirects.id, id));
    await audit(req, 'redirect_delete', 'redirect', id, `${row.fromPath} → ${row.toPath}`);
    return { ok: true };
  });

  /* ---------- 操作日志 ---------- */

  app.get('/audit', async (req) => {
    const q = parse(z.object({ action: z.string().max(60).optional(), page: z.coerce.number().int().min(1).default(1) }), req.query);
    const where = and(q.action?.trim() ? like(schema.auditLogs.action, `${q.action.trim()}%`) : undefined);
    const pageSize = 50;
    const total = (await db.select({ n: sql<number>`count(*)` }).from(schema.auditLogs).where(where).get())!.n;
    const items = await db
      .select({ id: schema.auditLogs.id, action: schema.auditLogs.action, entity: schema.auditLogs.entity, entityId: schema.auditLogs.entityId, detail: schema.auditLogs.detail, ip: schema.auditLogs.ip, createdAt: schema.auditLogs.createdAt, user: schema.users.displayName })
      .from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId))
      .where(where)
      .orderBy(desc(schema.auditLogs.id))
      .limit(pageSize)
      .offset((q.page - 1) * pageSize);
    return { total, page: q.page, pageSize, items };
  });
}
