/**
 * Markdown 渲染管线 —— 服务端渲染与后台编辑器预览共用同一份代码。
 * 原文 → 解析(CommonMark+GFM) → 扩展(容器) → HTML 结构 → 白名单过滤 → 增强 → HTML
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import { toString as hastToString } from 'hast-util-to-string';
import { createHighlighter, bundledLanguages, type Highlighter } from 'shiki';

/** 管线版本：渲染规则变化时递增，使缓存失效 */
export const PIPELINE_VERSION = 1;

export interface TocItem {
  depth: number;
  id: string;
  text: string;
}
export interface MarkdownStats {
  chars: number;
  words: number;
  paragraphs: number;
  readingMinutes: number;
}
export interface RenderResult {
  html: string;
  toc: TocItem[];
  stats: MarkdownStats;
  /** 正文引用的图片地址 */
  images: string[];
  /** 正文中的站内链接 */
  links: string[];
}
/** 管线自己输出的少量界面文字，由调用方按语言传入 */
export interface RenderLabels {
  footnotes?: string;
  footnoteBack?: string;
  copy?: string;
  unsupported?: string;
}

export interface RenderOptions {
  labels?: RenderLabels;
  /** 给顶层块加 data-line，供编辑器滚动同步 */
  sourceLines?: boolean;
}

const CALLOUTS = new Set(['note', 'tip', 'info', 'warning', 'danger']);
const CODE_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/* ---------- 统计 ---------- */

export function computeStats(markdown: string): MarkdownStats {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ');
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*/g) || []).length;
  const paragraphs = body.split(/\r?\n\s*\r?\n/).filter((p) => p.trim()).length;
  const minutes = cjk / 400 + latin / 220;
  return {
    chars: body.replace(/\s/g, '').length,
    words: cjk + latin,
    paragraphs,
    readingMinutes: Math.max(1, Math.ceil(minutes)),
  };
}

/** 从 Markdown 提取纯文本摘要（文章未填写摘要时兜底） */
export function plainExcerpt(markdown: string, max = 140): string {
  const text = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^:::.*$/gm, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // 表格
    .replace(/^\[\^[^\]]+\]:.*$/gm, ' ') // 脚注定义
    .replace(/\[\^[^\]]+\]/g, '') // 脚注引用
    .replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gm, '') // 任务清单标记
    .replace(/^\s{0,3}([-*_])(\s*\1){2,}\s*$/gm, ' ') // 分割线
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

/* ---------- remark：容器语法 ::: ---------- */

function remarkContainers(options: { unsupported: string }) {
  return (tree: any, file: any) => {
    const source = String(file.value);
    visit(tree, (node: any, index: number | undefined, parent: any) => {
      if (node.type === 'containerDirective') {
        const data = (node.data ||= {});
        const label = node.children?.[0]?.data?.directiveLabel ? node.children[0] : null;
        if (node.name === 'details') {
          data.hName = 'details';
          if (label) label.data = { ...label.data, hName: 'summary' };
        } else if (CALLOUTS.has(node.name)) {
          data.hName = 'div';
          data.hProperties = { className: ['callout', `callout-${node.name}`] };
          if (label) label.data = { ...label.data, hName: 'p', hProperties: { className: ['callout-title'] } };
        } else {
          // 未知容器：明确标记，而不是静默丢弃
          data.hName = 'div';
          data.hProperties = { className: ['md-unsupported'] };
          node.children.unshift({
            type: 'paragraph',
            data: { hProperties: { className: ['callout-title'] } },
            children: [{ type: 'text', value: `${options.unsupported} :::${node.name}` }],
          });
        }
        return;
      }
      // 行内 / 单行指令不启用：还原成原文，避免 “时间:abc” 之类的文本被吞掉
      if ((node.type === 'textDirective' || node.type === 'leafDirective') && parent && index !== undefined) {
        const raw = node.position ? source.slice(node.position.start.offset, node.position.end.offset) : `:${node.name}`;
        const text = { type: 'text', value: raw };
        parent.children[index] = node.type === 'leafDirective' ? { type: 'paragraph', children: [text] } : text;
        return [SKIP, index + 1];
      }
    });
  };
}

/* ---------- 白名单 ---------- */

const sanitizeSchema = {
  ...defaultSchema,
  // 不允许原始 HTML，id 只来自管线本身，因此不需要再加前缀
  clobber: [],
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div || []), ['className', 'callout', /^callout-/, 'md-unsupported']],
    p: [...(defaultSchema.attributes?.p || []), ['className', 'callout-title']],
  },
} as any;

/* ---------- 代码高亮 ---------- */

let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter() {
  highlighterPromise ||= createHighlighter({ themes: Object.values(CODE_THEMES), langs: [] });
  return highlighterPromise;
}
const LANG_ALIAS: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', js: 'javascript', ts: 'typescript', py: 'python', md: 'markdown', 'c++': 'cpp', golang: 'go', rs: 'rust', plaintext: 'text', txt: 'text' };

async function highlight(code: string, rawLang: string): Promise<any> {
  const hl = await getHighlighter();
  let lang = (LANG_ALIAS[rawLang] || rawLang || 'text').toLowerCase();
  if (lang !== 'text') {
    if (!(lang in bundledLanguages)) lang = 'text';
    else if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang as any);
  }
  const root = hl.codeToHast(code, { lang, themes: CODE_THEMES, defaultColor: 'light' });
  return root.children.find((n: any) => n.type === 'element' && n.tagName === 'pre');
}

const h = (tagName: string, properties: Record<string, any>, children: any[] = []) => ({ type: 'element', tagName, properties, children });
const txt = (value: string) => ({ type: 'text', value });

/* ---------- rehype：增强 ---------- */

interface Collected {
  toc: TocItem[];
  images: string[];
  links: string[];
}

function rehypeEnhance(options: { collected: Collected; sourceLines: boolean; copyLabel: string }) {
  const { collected, sourceLines, copyLabel } = options;
  return async (tree: any) => {
    const codeJobs: Promise<void>[] = [];

    if (sourceLines) {
      for (const node of tree.children) {
        if (node.type === 'element' && node.position) node.properties = { ...node.properties, 'data-line': node.position.start.line };
      }
    }

    visit(tree, 'element', (node: any, index: number | undefined, parent: any) => {
      const tag = node.tagName;

      if (/^h[1-6]$/.test(tag) && node.properties?.id) {
        const depth = Number(tag[1]);
        const id = String(node.properties.id);
        const text = hastToString(node);
        if (depth >= 2 && depth <= 4) collected.toc.push({ depth, id, text });
        node.children.push(h('a', { className: ['heading-anchor'], href: `#${id}`, ariaLabel: text }, [txt('#')]));
        return SKIP;
      }

      if (tag === 'a') {
        const href = String(node.properties?.href || '');
        if (/^https?:\/\//i.test(href)) {
          node.properties.target = '_blank';
          node.properties.rel = ['noopener', 'noreferrer', 'nofollow'];
        } else if (href.startsWith('/')) {
          collected.links.push(href);
        }
        return;
      }

      if (tag === 'img') {
        const src = String(node.properties?.src || '');
        if (src) collected.images.push(src);
        node.properties.loading = 'lazy';
        node.properties.decoding = 'async';
        return;
      }

      // 段落里只有一张图 → figure，title 作为图片说明
      if (tag === 'p' && parent && index !== undefined) {
        const meaningful = node.children.filter((c: any) => !(c.type === 'text' && !c.value.trim()));
        if (meaningful.length === 1 && meaningful[0].tagName === 'img') {
          const img = meaningful[0];
          const caption = img.properties?.title ? String(img.properties.title) : '';
          const figure = h('figure', { className: ['md-figure'], ...(node.properties?.['data-line'] ? { 'data-line': node.properties['data-line'] } : {}) }, [img]);
          if (caption) figure.children.push(h('figcaption', {}, [txt(caption)]));
          parent.children[index] = figure;
          return; // 继续下探，让 img 分支处理懒加载与引用收集
        }
      }

      if (tag === 'table' && parent && index !== undefined && !parent.properties?.className?.includes?.('table-wrap')) {
        parent.children[index] = h('div', { className: ['table-wrap'], ...(node.properties?.['data-line'] ? { 'data-line': node.properties['data-line'] } : {}) }, [node]);
        return SKIP;
      }

      if (tag === 'pre' && parent && index !== undefined) {
        const codeEl = node.children.find((c: any) => c.tagName === 'code');
        if (!codeEl) return;
        const cls: string[] = (codeEl.properties?.className as string[]) || [];
        const rawLang = (cls.find((c) => String(c).startsWith('language-')) || '').replace('language-', '');
        const code = hastToString(codeEl).replace(/\n$/, '');
        const line = node.properties?.['data-line'];
        codeJobs.push(
          highlight(code, rawLang).then((pre) => {
            const lines = code.split('\n').length;
            parent.children[index] = h(
              'div',
              { className: ['code-block'], 'data-lang': rawLang || 'text', 'data-lines': lines, ...(line ? { 'data-line': line } : {}) },
              [
                h('div', { className: ['code-head'] }, [
                  h('span', { className: ['code-lang'] }, [txt(rawLang || 'text')]),
                  h('button', { className: ['code-copy'], type: 'button' }, [txt(copyLabel)]),
                ]),
                pre,
              ],
            );
          }),
        );
        return SKIP;
      }
    });

    await Promise.all(codeJobs);
  };
}

/* ---------- 入口 ---------- */

export async function renderMarkdown(markdown: string, options: RenderOptions = {}): Promise<RenderResult> {
  const collected: Collected = { toc: [], images: [], links: [] };
  const labels = options.labels ?? {};
  const file = await unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkContainers, { unsupported: labels.unsupported ?? '不支持的容器语法' })
    .use(remarkRehype, { footnoteLabel: labels.footnotes ?? '脚注', footnoteBackLabel: labels.footnoteBack ?? '返回正文' })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeSlug)
    .use(rehypeEnhance, { collected, sourceLines: !!options.sourceLines, copyLabel: labels.copy ?? '复制' })
    .use(rehypeStringify)
    .process(markdown);

  return {
    html: String(file),
    toc: collected.toc,
    stats: computeStats(markdown),
    images: [...new Set(collected.images)],
    links: [...new Set(collected.links)],
  };
}
