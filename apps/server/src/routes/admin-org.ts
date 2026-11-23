/** M2 管理接口：分类、标签、专题 / 系列、页面、导航、文章归属与批量操作 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { desc } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import * as auth from '../services/auth.ts';
import * as postsSvc from '../services/posts.ts';
import * as tax from '../services/taxonomy.ts';
import * as org from '../services/organize.ts';
import * as searchSvc from '../services/search.ts';

const idOf = (req: FastifyRequest, name = 'id') => {
  const n = Number((req.params as Record<string, string>)[name]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('参数错误');
  return n;
};
function parse<T>(shape: z.ZodType<T>, data: unknown): T {
  const result = shape.safeParse(data ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`参数错误：${issue.path.join('.') || '请求体'} ${issue.message}`);
  }
  return result.data;
}
const slugField = z.string().trim().max(120).optional();

export async function adminOrgRoutes(app: FastifyInstance) {
  const log = (req: FastifyRequest, action: string, entity: string, entityId: string | number = '', detail: unknown = '') => auth.audit(req.user, action, entity, entityId, detail, req.ip);

  /* ---------- 分类 ---------- */

  const flatten = (nodes: tax.CategoryNode[]): unknown[] =>
    nodes.map((n) => ({ id: n.id, parentId: n.parentId, name: n.name, slug: n.slug, description: n.description, seoTitle: n.seoTitle, seoDescription: n.seoDescription, visible: n.visible, translated: n.translated, depth: n.depth, path: n.path, url: n.url, pathNames: n.trail.map((t) => t.name).join(' / '), postCount: n.postCount, publishedCount: n.publishedCount, totalPublished: n.totalPublished, children: flatten(n.children) }));

  app.get('/categories', async (req) => ({ tree: flatten((await tax.getTree(req.contentLocale)).roots), maxDepth: tax.MAX_CATEGORY_DEPTH }));

  app.post('/categories', async (req) => {
    const body = parse(z.object({ name: z.string().max(100), slug: slugField, parentId: z.number().int().nullable().optional(), description: z.string().max(1000).optional() }), req.body);
    const id = await tax.createCategory(req.contentLocale, body);
    await log(req, 'category_create', 'category', id, body.name);
    return { id };
  });

  app.patch('/categories/:id', async (req) => {
    const body = parse(
      z.object({ name: z.string().max(100).optional(), slug: z.string().trim().max(120).optional(), description: z.string().max(1000).optional(), visible: z.boolean().optional(), seoTitle: z.string().max(200).optional(), seoDescription: z.string().max(500).optional() }),
      req.body,
    );
    await tax.updateCategory(req.contentLocale, idOf(req), body);
    await log(req, 'category_update', 'category', idOf(req));
    return { ok: true };
  });

  app.post('/categories/:id/move', async (req) => {
    const body = parse(z.object({ parentId: z.number().int().nullable(), index: z.number().int().min(0).optional() }), req.body);
    await tax.moveCategory(req.contentLocale, idOf(req), body);
    await log(req, 'category_move', 'category', idOf(req), body);
    return { ok: true };
  });

  app.get('/categories/:id/impact', async (req) => tax.categoryImpact(req.contentLocale, idOf(req)));

  app.delete('/categories/:id', async (req) => {
    // moveTo：目标分类 id（合并 / 迁移）；clear=1：明确清空文章归属
    const q = req.query as { moveTo?: string; clear?: string };
    const moveTo = q.moveTo ? Number(q.moveTo) : q.clear === '1' ? null : undefined;
    const result = await tax.deleteCategory(req.contentLocale, idOf(req), { moveTo });
    await log(req, 'category_delete', 'category', idOf(req), { moveTo });
    await searchSvc.rebuildIndex();
    return result;
  });

  /* ---------- 标签 ---------- */

  app.get('/tags', async (req) => tax.listTags(req.contentLocale));

  app.post('/tags', async (req) => {
    const body = parse(z.object({ name: z.string().max(50) }), req.body);
    return { id: await tax.createTag(req.contentLocale, body.name) };
  });

  app.patch('/tags/:id', async (req) => {
    const body = parse(z.object({ name: z.string().max(50).optional(), slug: z.string().trim().max(120).optional(), description: z.string().max(1000).optional() }), req.body);
    await tax.updateTag(req.contentLocale, idOf(req), body);
    await searchSvc.rebuildIndex();
    return { ok: true };
  });

  app.post('/tags/merge', async (req) => {
    const body = parse(z.object({ sourceIds: z.array(z.number().int()).min(1), targetId: z.number().int() }), req.body);
    await tax.mergeTags(req.contentLocale, body.sourceIds, body.targetId);
    await log(req, 'tag_merge', 'tag', body.targetId, body.sourceIds);
    await searchSvc.rebuildIndex();
    return { ok: true };
  });

  app.post('/tags/cleanup', async (req) => {
    const removed = await tax.deleteEmptyTags(req.contentLocale);
    await log(req, 'tag_cleanup', 'tag', '', removed);
    return { removed };
  });

  app.delete('/tags/:id', async (req) => {
    await tax.deleteTags([idOf(req)]);
    await log(req, 'tag_delete', 'tag', idOf(req));
    await searchSvc.rebuildIndex();
    return { ok: true };
  });

  /* ---------- 文章归属与批量操作 ---------- */

  app.get('/posts/:id/taxonomy', async (req) => {
    const { translation } = await postsSvc.getForEdit(idOf(req));
    return tax.getPostTaxonomy(translation.locale, translation.postId);
  });

  app.put('/posts/:id/taxonomy', async (req) => {
    const body = parse(z.object({ primaryCategoryId: z.number().int().nullable(), categoryIds: z.array(z.number().int()).max(20), tags: z.array(z.string().max(50)).max(30) }), req.body);
    const { translation } = await postsSvc.getForEdit(idOf(req));
    await tax.setPostCategories(translation.locale, translation.postId, body.primaryCategoryId, body.categoryIds);
    await tax.setPostTags(translation.locale, translation.postId, body.tags);
    await searchSvc.indexPost(translation.id);
    return tax.getPostTaxonomy(translation.locale, translation.postId);
  });

  app.post('/posts/bulk', async (req) => {
    const body = parse(z.object({ ids: z.array(z.number().int()).min(1).max(200), action: z.enum(['publish', 'unpublish', 'archive', 'trash', 'restore', 'setCategory']), categoryId: z.number().int().optional() }), req.body);
    const loc = req.contentLocale;
    const failed: { id: number; error: string }[] = [];
    let done = 0;
    if (body.action === 'setCategory') {
      if (!body.categoryId) throw badRequest('请选择目标分类');
      const postIds: number[] = [];
      for (const id of body.ids) postIds.push((await postsSvc.getForEdit(id)).translation.postId);
      await tax.bulkSetPrimaryCategory(loc, postIds, body.categoryId);
      done = postIds.length;
    } else {
      for (const id of body.ids) {
        try {
          if (body.action === 'publish') await postsSvc.publish(id, { userId: req.user!.id });
          else if (body.action === 'unpublish') await postsSvc.setOffline(id, 'unpublished', req.user!.id);
          else if (body.action === 'archive') await postsSvc.setOffline(id, 'archived', req.user!.id);
          else if (body.action === 'trash') await postsSvc.trash(id);
          else await postsSvc.restoreFromTrash(id);
          done++;
        } catch (err) {
          failed.push({ id, error: (err as Error).message }); // 单篇失败不影响其余
        }
      }
    }
    tax.invalidateTaxonomy();
    await log(req, `post_bulk_${body.action}`, 'post', '', { ids: body.ids, categoryId: body.categoryId });
    await searchSvc.rebuildIndex();
    return { done, failed };
  });

  /* ---------- 专题 / 系列 ---------- */

  app.get('/collections', async (req) => org.listCollections(req.contentLocale));
  app.get('/collections/:id', async (req) => org.getCollection(req.contentLocale, idOf(req)));

  app.post('/collections', async (req) => {
    const body = parse(z.object({ kind: z.enum(['topic', 'series']), title: z.string().max(200), slug: slugField, description: z.string().max(2000).optional() }), req.body);
    const id = await org.createCollection(req.contentLocale, body);
    await log(req, 'collection_create', 'collection', id, body.title);
    return { id };
  });

  app.patch('/collections/:id', async (req) => {
    const body = parse(
      z.object({ title: z.string().max(200).optional(), slug: z.string().trim().max(120).optional(), description: z.string().max(2000).optional(), cover: z.string().max(1000).optional(), visible: z.boolean().optional(), postIds: z.array(z.number().int()).max(500).optional() }),
      req.body,
    );
    await org.updateCollection(req.contentLocale, idOf(req), body);
    return org.getCollection(req.contentLocale, idOf(req));
  });

  app.delete('/collections/:id', async (req) => {
    await org.deleteCollection(idOf(req));
    await log(req, 'collection_delete', 'collection', idOf(req));
    return { ok: true };
  });

  /* ---------- 自定义页面 ---------- */

  app.get('/pages', async (req) => org.listPages(req.contentLocale));
  app.get('/pages/:id', async (req) => org.getPage(idOf(req)));

  app.post('/pages', async (req) => {
    const body = parse(z.object({ title: z.string().max(200), slug: slugField }), req.body);
    const id = await org.createPage(req.contentLocale, body);
    await log(req, 'page_create', 'page', id, body.title);
    return { id };
  });

  app.put('/pages/:id', async (req) => {
    const body = parse(z.object({ title: z.string().max(200).optional(), markdown: z.string().max(1_000_000).optional(), slug: z.string().trim().max(120).optional(), seoDescription: z.string().max(500).optional() }), req.body);
    return org.savePage(idOf(req), body);
  });

  app.post('/pages/:id/publish', async (req) => {
    const page = await org.publishPage(idOf(req));
    await log(req, 'page_publish', 'page', idOf(req));
    return page;
  });
  app.post('/pages/:id/unpublish', async (req) => {
    const page = await org.unpublishPage(idOf(req));
    await log(req, 'page_unpublish', 'page', idOf(req));
    return page;
  });
  app.delete('/pages/:id', async (req) => {
    await org.deletePage(idOf(req));
    await log(req, 'page_delete', 'page', idOf(req));
    return { ok: true };
  });

  /* ---------- 导航 ---------- */

  const menuOf = (req: FastifyRequest) => parse(z.enum(['header', 'footer']), (req.params as { menu: string }).menu);

  app.get('/nav/:menu', async (req) => org.getMenuForEdit(req.contentLocale, menuOf(req)));

  app.put('/nav/:menu', async (req) => {
    const body = parse(
      z.object({ items: z.array(z.object({ id: z.number().int().optional(), type: z.enum(org.NAV_TYPES), targetId: z.number().int().nullable().optional(), url: z.string().max(500).optional(), label: z.string().max(100).optional(), newTab: z.boolean().optional(), visible: z.boolean().optional() })).max(50) }),
      req.body,
    );
    await org.saveMenu(req.contentLocale, menuOf(req), body.items);
    await log(req, 'nav_update', 'nav', menuOf(req));
    return org.getMenuForEdit(req.contentLocale, menuOf(req));
  });

  /* ---------- 搜索 ---------- */

  app.post('/search/rebuild', async () => ({ indexed: await searchSvc.rebuildIndex() }));
  app.get('/search/terms', async () => db.select().from(schema.searchTerms).orderBy(desc(schema.searchTerms.count)).limit(100));
}
