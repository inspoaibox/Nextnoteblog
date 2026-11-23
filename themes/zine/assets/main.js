(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  // 界面文字由模板按当前语言输出在 <body> 上，脚本里不写死任何语言
  const T = document.body.dataset;

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
      if (await copyText(pre.innerText.replace(/\n$/, ''))) flash(e.currentTarget, T.tCopied);
    });
    if (Number(block.dataset.lines) > 30) {
      block.classList.add('is-collapsed');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-expand';
      btn.textContent = (T.tExpand || '').replace('{n}', block.dataset.lines);
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
    if (await copyText(location.origin + location.pathname)) flash(copyLink, copyLink.dataset.done || T.tCopied);
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

  /*
   * 语言：记住访客手动选择的语言；首次访问时按浏览器语言给出提示，但不自动跳转。
   * 只存一个表示语言的 Cookie，不涉及主题或其他偏好。
   */
  const langLinks = $$('.lang-switch a[data-lang]');
  if (langLinks.length) {
    const current = T.locale;
    const saved = (document.cookie.match(/(?:^|; )nb_lang=([^;]+)/) || [])[1];
    const remember = (code) => (document.cookie = `nb_lang=${code}; path=/; max-age=31536000; samesite=lax`);
    for (const a of langLinks) a.addEventListener('click', () => remember(a.dataset.lang));
    const available = langLinks.filter((a) => !('missing' in a.dataset));
    const fromOutside = !document.referrer || new URL(document.referrer).origin !== location.origin;
    const savedLink = saved && saved !== current ? available.find((a) => a.dataset.lang === saved) : null;
    if (savedLink && fromOutside) {
      // 访客之前选过别的语言，而且这一页有那个语言的版本：直接带过去
      location.replace(savedLink.href);
    } else if (!saved) {
      const wanted = (navigator.languages || [navigator.language]).map((l) => l.toLowerCase());
      const matches = (code) => wanted.some((w) => w === code.toLowerCase() || w.split('-')[0] === code.toLowerCase().split('-')[0]);
      const suggestion = !matches(current) ? available.find((a) => matches(a.dataset.lang)) : null;
      const bar = $('.lang-hint');
      if (suggestion && bar) {
        $('.lang-hint-text', bar).textContent = bar.dataset.text.replace('{name}', suggestion.textContent);
        const go = $('.lang-hint-go', bar);
        go.href = suggestion.href;
        go.addEventListener('click', () => remember(suggestion.dataset.lang));
        $('.lang-hint-close', bar).addEventListener('click', () => {
          remember(current); // 明确留在当前语言，以后不再提示
          bar.hidden = true;
        });
        bar.hidden = false;
      }
    }
  }

  /* 按 / 聚焦搜索框（正在输入时不拦截） */
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const input = $('.search-form input') || $('.site-search input');
    if (input) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  /* 图片灯箱 */
  for (const img of $$('.post-content img')) {
    img.addEventListener('click', () => {
      const box = document.createElement('div');
      box.className = 'lightbox';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-label', img.alt || T.tImage);
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
