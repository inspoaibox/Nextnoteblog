(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }
  function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => (button.textContent = original), 1500);
  }

  /* 阅读进度与返回顶部 */
  const bar = $('.progress span');
  const toTop = $('.to-top');
  const article = $('.post');
  function onScroll() {
    const y = window.scrollY;
    if (toTop) toTop.hidden = y < 600;
    if (bar && article) {
      const total = article.offsetTop + article.offsetHeight - window.innerHeight;
      bar.style.width = total > 0 ? `${Math.min(100, Math.max(0, (y / total) * 100))}%` : '0';
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  toTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

  /* 代码块：复制与长代码折叠 */
  for (const block of $$('.code-block')) {
    const pre = $('pre', block);
    $('.code-copy', block)?.addEventListener('click', async (e) => {
      if (await copyText(pre.innerText.replace(/\n$/, ''))) flash(e.currentTarget, '已复制');
    });
    if (Number(block.dataset.lines) > 30) {
      block.classList.add('is-collapsed');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-expand';
      btn.textContent = `展开全部代码（共 ${block.dataset.lines} 行）`;
      btn.addEventListener('click', () => {
        block.classList.remove('is-collapsed');
        btn.remove();
      });
      block.appendChild(btn);
    }
  }

  /* 标题锚点：点击复制该标题链接 */
  for (const a of $$('.heading-anchor')) {
    a.addEventListener('click', () => copyText(location.origin + location.pathname + a.getAttribute('href')));
  }
  const copyLink = $('.copy-link');
  copyLink?.addEventListener('click', async () => {
    if (await copyText(location.origin + location.pathname)) flash(copyLink, copyLink.dataset.done || '已复制');
  });

  /* 目录定位高亮 */
  const tocLinks = $$('.toc a');
  if (tocLinks.length) {
    const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const headings = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const update = () => {
      let current = headings[0];
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= 100) current = h;
        else break;
      }
      for (const a of tocLinks) a.classList.toggle('active', a === byId.get(current?.id));
    };
    window.addEventListener('scroll', update, { passive: true });
    update();
    if (window.matchMedia('(max-width: 960px)').matches) $('.toc details')?.removeAttribute('open');
  }

  /* 图片灯箱 */
  for (const img of $$('.post-content img')) {
    img.addEventListener('click', () => {
      const box = document.createElement('div');
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', img.alt || '图片');
      const big = document.createElement('img');
      big.src = img.currentSrc || img.src;
      big.alt = img.alt;
      box.appendChild(big);
      const close = () => {
        box.remove();
        document.removeEventListener('keydown', onKey);
      };
      const onKey = (e) => e.key === 'Escape' && close();
      box.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      document.body.appendChild(box);
    });
  }
})();
