import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { renderMarkdown } from '@nexemc/markdown';

export interface PreviewHandle {
  scrollToLine(line: number): void;
}

interface Props {
  markdown: string;
  title: string;
  subtitle: string;
  themeCss: string;
  appearance: 'light' | 'dark' | 'auto';
}

/**
 * 预览与前台使用同一条渲染管线、同一份主题样式。
 * 放在不允许执行脚本的 iframe 里：样式互不污染，内容也无法运行代码。
 */
export const Preview = forwardRef<PreviewHandle, Props>(function Preview({ markdown, title, subtitle, themeCss, appearance }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  const doc = () => frame.current?.contentDocument ?? null;

  useEffect(() => {
    const d = doc();
    if (!d || !ready) return;
    d.getElementById('nb-title')!.textContent = title || '（无标题）';
    const sub = d.getElementById('nb-subtitle')!;
    sub.textContent = subtitle;
    sub.hidden = !subtitle;
  }, [title, subtitle, ready]);

  useEffect(() => {
    if (!ready) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const result = await renderMarkdown(markdown, { sourceLines: true });
        if (mine !== seq.current) return; // 已有更新的输入
        const container = doc()?.getElementById('nb-content');
        if (container) container.innerHTML = result.html; // 管线输出已经过白名单过滤
        setError('');
      } catch (e) {
        if (mine === seq.current) setError(`预览渲染失败：${(e as Error).message}`);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [markdown, ready]);

  useImperativeHandle(ref, () => ({
    scrollToLine(line) {
      const d = doc();
      if (!d) return;
      const scroller = d.scrollingElement!;
      if (line <= 1) return void (scroller.scrollTop = 0);
      const blocks = [...d.querySelectorAll<HTMLElement>('#nb-content > [data-line]')];
      if (!blocks.length) return;
      // 找到包含该行的块，在它与下一个块之间按行号插值
      let i = 0;
      while (i + 1 < blocks.length && Number(blocks[i + 1].dataset.line) <= line) i++;
      const cur = blocks[i];
      const next = blocks[i + 1];
      const curLine = Number(cur.dataset.line);
      const top = cur.getBoundingClientRect().top + scroller.scrollTop;
      const nextTop = next ? next.getBoundingClientRect().top + scroller.scrollTop : top + cur.offsetHeight;
      const nextLine = next ? Number(next.dataset.line) : curLine + Math.max(1, Math.round(cur.offsetHeight / 28));
      const ratio = nextLine > curLine ? Math.min(1, Math.max(0, (line - curLine) / (nextLine - curLine))) : 0;
      scroller.scrollTop = top + (nextTop - top) * ratio - 24;
    },
  }));

  const srcDoc = `<!doctype html><html lang="zh-CN" data-mode="${appearance}"><head><meta charset="utf-8"><link rel="stylesheet" href="${themeCss}"><style>body{padding:28px 28px 40vh}.post{max-width:760px;margin:0 auto}.heading-anchor,.code-copy{pointer-events:none}a{pointer-events:none}</style></head><body><article class="post"><header class="post-header"><h1 class="post-title" id="nb-title"></h1><p class="post-subtitle" id="nb-subtitle" hidden></p></header><div class="post-content" id="nb-content"></div></article></body></html>`;

  return (
    <div className="preview">
      {error && <div className="preview-error">{error}</div>}
      <iframe ref={frame} title="文章预览" sandbox="allow-same-origin" srcDoc={srcDoc} onLoad={() => setReady(true)} />
    </div>
  );
});
