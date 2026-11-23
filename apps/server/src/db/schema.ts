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
    // 译文：它译自哪个语言版本、当时原文发布到了哪一条修订（原文再发布后据此提示“译文待更新”）
    sourceTranslationId: integer('source_translation_id'),
    sourceRevisionId: integer('source_revision_id'),
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

/* ====================== M2：内容组织 ====================== */

/** 分类主体：树结构与排序（与语言无关，保证各语言结构一致） */
export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    parentId: integer('parent_id'),
    sort: integer('sort').notNull().default(0),
    visible: integer('visible').notNull().default(1),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('categories_parent').on(t.parentId, t.sort)],
);

export const categoryTranslations = sqliteTable(
  'category_translations',
  {
    id: id(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(), // 只要求在同级中唯一，地址是整条路径
    description: text('description').notNull().default(''),
    seoTitle: text('seo_title').notNull().default(''),
    seoDescription: text('seo_description').notNull().default(''),
  },
  (t) => [uniqueIndex('category_translations_cat_locale').on(t.categoryId, t.locale)],
);

export const postCategories = sqliteTable(
  'post_categories',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    isPrimary: integer('is_primary').notNull().default(0),
  },
  (t) => [uniqueIndex('post_categories_pk').on(t.postId, t.categoryId), index('post_categories_cat').on(t.categoryId)],
);

export const tags = sqliteTable('tags', { id: id(), createdAt: ts('created_at').notNull() });

export const tagTranslations = sqliteTable(
  'tag_translations',
  {
    id: id(),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
  },
  (t) => [uniqueIndex('tag_translations_tag_locale').on(t.tagId, t.locale), uniqueIndex('tag_translations_locale_slug').on(t.locale, t.slug), uniqueIndex('tag_translations_locale_name').on(t.locale, t.name)],
);

export const postTags = sqliteTable(
  'post_tags',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('post_tags_pk').on(t.postId, t.tagId), index('post_tags_tag').on(t.tagId)],
);

/** 专题（topic，一组相关文章）与系列（series，有先后顺序的章节）共用一套结构 */
export const collections = sqliteTable('collections', {
  id: id(),
  kind: text('kind').notNull(), // topic | series
  cover: text('cover').notNull().default(''),
  visible: integer('visible').notNull().default(1),
  sort: integer('sort').notNull().default(0),
  createdAt: ts('created_at').notNull(),
});

export const collectionTranslations = sqliteTable(
  'collection_translations',
  {
    id: id(),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
  },
  (t) => [uniqueIndex('collection_translations_col_locale').on(t.collectionId, t.locale), uniqueIndex('collection_translations_locale_slug').on(t.locale, t.slug)],
);

export const collectionItems = sqliteTable(
  'collection_items',
  {
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('collection_items_pk').on(t.collectionId, t.postId), index('collection_items_post').on(t.postId)],
);

/** 自定义页面：草稿与线上内容并存 */
export const pages = sqliteTable('pages', { id: id(), createdAt: ts('created_at').notNull() });

export const pageTranslations = sqliteTable(
  'page_translations',
  {
    id: id(),
    pageId: integer('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    slug: text('slug').notNull(),
    title: text('title').notNull().default(''),
    markdown: text('markdown').notNull().default(''),
    seoDescription: text('seo_description').notNull().default(''),
    status: text('status').notNull().default('draft'), // draft | published
    publishedTitle: text('published_title').notNull().default(''),
    publishedMarkdown: text('published_markdown').notNull().default(''),
    publishedAt: ts('published_at'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('page_translations_page_locale').on(t.pageId, t.locale), uniqueIndex('page_translations_locale_slug').on(t.locale, t.slug)],
);

export const navItems = sqliteTable(
  'nav_items',
  {
    id: id(),
    menu: text('menu').notNull(), // header | footer
    parentId: integer('parent_id'),
    sort: integer('sort').notNull().default(0),
    type: text('type').notNull(), // home | posts | archive | category | tag | collection | page | post | url
    targetId: integer('target_id'),
    url: text('url').notNull().default(''),
    newTab: integer('new_tab').notNull().default(0),
    visible: integer('visible').notNull().default(1),
  },
  (t) => [index('nav_items_menu').on(t.menu, t.sort)],
);

export const navItemTranslations = sqliteTable(
  'nav_item_translations',
  {
    id: id(),
    navItemId: integer('nav_item_id')
      .notNull()
      .references(() => navItems.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    label: text('label').notNull().default(''),
  },
  (t) => [uniqueIndex('nav_item_translations_pk').on(t.navItemId, t.locale)],
);

/** 搜索词统计：用于“无结果词”反向辅助选题 */
export const searchTerms = sqliteTable('search_terms', {
  term: text('term').primaryKey(),
  count: integer('count').notNull().default(0),
  results: integer('results').notNull().default(0),
  lastAt: ts('last_at').notNull(),
});

/* ====================== M3：多语言 ====================== */

/** 后台维护的界面文案覆盖项（优先于主题自带的语言包） */
export const uiTranslations = sqliteTable(
  'ui_translations',
  {
    id: id(),
    locale: text('locale').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [uniqueIndex('ui_translations_pk').on(t.locale, t.key)],
);

/* ====================== M4：主题 ====================== */

/** 每个主题的运行状态与配置（主题文件本身在磁盘上，版本目录即版本列表） */
export const themeState = sqliteTable('theme_state', {
  themeId: text('theme_id').primaryKey(),
  /** 已上传主题当前使用的版本；内置主题为空 */
  activeVersion: text('active_version').notNull().default(''),
  /** 上一个使用的版本，用于一键回滚 */
  previousVersion: text('previous_version').notNull().default(''),
  /** 是否受信任：未受信任的主题，其脚本会被内容安全策略禁用 */
  trusted: integer('trusted').notNull().default(0),
  configDraft: text('config_draft').notNull().default('{}'),
  configApplied: text('config_applied').notNull().default('{}'),
  configPrevious: text('config_previous').notNull().default('{}'),
  updatedAt: ts('updated_at').notNull(),
});

export const themeLog = sqliteTable(
  'theme_log',
  {
    id: id(),
    themeId: text('theme_id').notNull(),
    action: text('action').notNull(), // install | upgrade | activate | rollback | version | uninstall | trust | config_apply | config_revert | config_reset | error
    detail: text('detail').notNull().default(''),
    userId: integer('user_id'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('theme_log_created').on(t.createdAt)],
);

/* ---------- 友链 ---------- */

/** 友链：对方站点的名称与地址本身不随语言变化，所以不做翻译表 */
export const links = sqliteTable(
  'links',
  {
    id: id(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    /** 头像 / 站标图片地址，可留空（前台用名称首字代替） */
    avatar: text('avatar').notNull().default(''),
    /** 分组名，留空归入默认组 */
    groupName: text('group_name').notNull().default(''),
    sort: integer('sort').notNull().default(0),
    visible: integer('visible').notNull().default(1),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('links_sort').on(t.sort)],
);

/* ---------- 开源项目 ---------- */

/** 开源项目：地址标识与仓库信息各语言共用；名称、一句话介绍、正文按语言存放 */
export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    slug: text('slug').notNull(),
    repoUrl: text('repo_url').notNull().default(''),
    homepage: text('homepage').notNull().default(''),
    docsUrl: text('docs_url').notNull().default(''),
    downloadUrl: text('download_url').notNull().default(''),
    license: text('license').notNull().default(''),
    language: text('language').notNull().default(''),
    logo: text('logo').notNull().default(''),
    /** active 活跃开发 | maintained 维护中 | experimental 实验性 | archived 已归档 */
    status: text('status').notNull().default('active'),
    featured: integer('featured').notNull().default(0),
    sort: integer('sort').notNull().default(0),
    visible: integer('visible').notNull().default(1),
    /** 相关文章：带这个标签的文章显示在项目页（发布说明、教程等） */
    tagId: integer('tag_id').references(() => tags.id, { onDelete: 'set null' }),
    /** 以下来自 GitHub 同步，也可以手填 */
    stars: integer('stars').notNull().default(0),
    forks: integer('forks').notNull().default(0),
    latestVersion: text('latest_version').notNull().default(''),
    releaseUrl: text('release_url').notNull().default(''),
    releasedAt: ts('released_at'),
    syncedAt: ts('synced_at'),
    syncError: text('sync_error').notNull().default(''),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('projects_slug').on(t.slug), index('projects_sort').on(t.featured, t.sort)],
);

export const projectTranslations = sqliteTable(
  'project_translations',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    name: text('name').notNull().default(''),
    tagline: text('tagline').notNull().default(''),
    markdown: text('markdown').notNull().default(''),
  },
  (t) => [uniqueIndex('project_translations_pk').on(t.projectId, t.locale)],
);
