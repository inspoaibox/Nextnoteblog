import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

const id = () => integer('id').primaryKey({ autoIncrement: true });
/** 时间一律存毫秒时间戳 */
const ts = (name: string) => integer(name);

export const users = sqliteTable('users', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: ts('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // 令牌的 SHA-256，原始令牌只在 Cookie 里
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  userAgent: text('user_agent'),
  ip: text('ip'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON
});

export const languages = sqliteTable('languages', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(1),
  isDefault: integer('is_default').notNull().default(0),
  sort: integer('sort').notNull().default(0),
});

/** 文章主体：与语言无关的属性 */
export const posts = sqliteTable('posts', {
  id: id(),
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
  pinned: integer('pinned').notNull().default(0),
  featured: integer('featured').notNull().default(0),
  createdAt: ts('created_at').notNull(),
  updatedAt: ts('updated_at').notNull(),
  deletedAt: ts('deleted_at'), // 非空 = 在回收站
});

/** 文章的一个语言版本：独立的状态、地址与修订链 */
export const postTranslations = sqliteTable(
  'post_translations',
  {
    id: id(),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    slug: text('slug').notNull(),
    status: text('status').notNull().default('draft'), // draft | scheduled | published | unpublished | archived
    publishedRevisionId: integer('published_revision_id'), // 前台只读这个指针
    draftRevisionId: integer('draft_revision_id'), // 编辑只推进这个指针
    scheduledAt: ts('scheduled_at'),
    firstPublishedAt: ts('first_published_at'), // 前台展示的发布日期
    publishedAt: ts('published_at'), // 最近一次发布动作
    contentUpdatedAt: ts('content_updated_at'), // 最后一次实质更新
    viewCount: integer('view_count').notNull().default(0),
    lockVersion: integer('lock_version').notNull().default(0), // 乐观锁
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('post_translations_locale_slug').on(t.locale, t.slug),
    uniqueIndex('post_translations_post_locale').on(t.postId, t.locale),
    index('post_translations_status').on(t.status, t.firstPublishedAt),
  ],
);

/** 修订：一次保存的完整快照 */
export const revisions = sqliteTable(
  'revisions',
  {
    id: id(),
    translationId: integer('translation_id')
      .notNull()
      .references(() => postTranslations.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
    subtitle: text('subtitle').notNull().default(''),
    excerpt: text('excerpt').notNull().default(''),
    cover: text('cover').notNull().default(''),
    markdown: text('markdown').notNull().default(''),
    frontMatter: text('front_matter').notNull().default(''), // 原样保留
    meta: text('meta').notNull().default('{}'), // JSON：SEO、显示开关等
    kind: text('kind').notNull().default('auto'), // auto | manual | publish | restore
    note: text('note').notNull().default(''),
    authorId: integer('author_id'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('revisions_translation').on(t.translationId, t.createdAt)],
);

export const publishLog = sqliteTable(
  'publish_log',
  {
    id: id(),
    translationId: integer('translation_id')
      .notNull()
      .references(() => postTranslations.id, { onDelete: 'cascade' }),
    revisionId: integer('revision_id'),
    action: text('action').notNull(), // publish | unpublish | archive | rollback
    userId: integer('user_id'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('publish_log_translation').on(t.translationId, t.createdAt)],
);

export const media = sqliteTable('media', {
  id: id(),
  path: text('path').notNull().unique(), // 相对 uploads/ 的路径
  originalName: text('original_name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  hash: text('hash').notNull().unique(),
  alt: text('alt').notNull().default(''),
  caption: text('caption').notNull().default(''),
  uploaderId: integer('uploader_id'),
  createdAt: ts('created_at').notNull(),
});

export const redirects = sqliteTable('redirects', {
  id: id(),
  fromPath: text('from_path').notNull().unique(),
  toPath: text('to_path').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    userId: integer('user_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull().default(''),
    entityId: text('entity_id').notNull().default(''),
    detail: text('detail').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('audit_logs_created').on(t.createdAt)],
);
