import { renderMarkdown, PIPELINE_VERSION, type RenderResult } from '@nexemc/markdown';

/** 修订内容不可变（线上修订不会被原地改写），所以可以按修订号缓存渲染结果 */
const cache = new Map<string, RenderResult>();
const MAX = 300;

export async function renderRevision(revisionId: number, updatedAt: number, markdown: string): Promise<RenderResult> {
  const key = `${PIPELINE_VERSION}:${revisionId}:${updatedAt}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await renderMarkdown(markdown);
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, result);
  return result;
}

/* ---------- 整页缓存：内容或设置变化时整体失效 ---------- */

const pages = new Map<string, { html: string; status: number }>();
export const pageCache = {
  get: (key: string) => pages.get(key),
  set(key: string, value: { html: string; status: number }) {
    if (pages.size >= 1000) pages.clear();
    pages.set(key, value);
  },
  clear: () => pages.clear(),
};
