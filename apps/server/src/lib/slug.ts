import { pinyin } from 'pinyin-pro';

/** 页面地址里已被系统占用的名字，不能用作 slug */
export const RESERVED_SLUGS = new Set(['admin', 'api', 'posts', 'category', 'tag', 'topic', 'series', 'search', 'archive', 'uploads', 'theme', 'feed', 'sitemap', 'en', 'zh', 'tags', 'preview', 'healthz', 'robots', 'favicon', 'links', 'projects']);

/** 标题 → slug：中文转拼音，其余保留字母数字，用连字符连接 */
export function slugify(input: string, maxLength = 80): string {
  const latin = pinyin(input, { toneType: 'none', type: 'array', nonZh: 'consecutive' }).join(' ');
  const slug = latin
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/, '');
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 120;
}
