/*
 * 桌面系统风格主题（win7 / win11 / macos）共用的脚本：一个很小的窗口管理器。
 *
 * 每个地址仍然由服务端渲染成完整页面（桌面 + 一个装着该页内容的窗口），所以不开脚本也能看、能被搜索引擎收录。
 * 脚本在此之上做增强：
 *   - 窗口可以拖动、最小化、最大化、关闭，任务栏 / 程序坞里列出打开的窗口；
 *   - 点桌面图标、开始菜单或程序坞会打开新窗口；窗口里的站内链接在本窗口内跳转，支持后退 / 前进；
 *   - 内容用 fetch 取回整页后只取出窗口部分，地址栏与浏览器历史保持同步。
 * 由 scripts/build-themes.mjs 复制为各主题的 assets/main.js。
 */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const T = document.body.dataset;
  const desktop = $('#desktop');
  const taskList = $('[data-tasks]');
  if (!desktop) return;

  const isMobile = () => window.matchMedia('(max-width: 860px)').matches;
  const states = new Map(); // 窗口元素 -> { url, hist, idx, task, toc, headings }
  let zTop = 10;
  let active = null;
  let opened = 0;

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
  const sameDoc = (a, b) => {
    const x = new URL(a, location.href);
    const y = new URL(b, location.href);
    return x.pathname === y.pathname && x.search === y.search;
  };

  /* ---------- 窗口内容：代码块、锚点、目录、灯箱 ---------- */
  function initContent(win) {
    const st = states.get(win);
    const view = $('[data-view]', win);
    for (const block of $$('.code-block', view)) {
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
    const pageUrl = () => new URL(st.url, location.href).href.split('#')[0];
    for (const a of $$('.heading-anchor', view)) a.addEventListener('click', () => copyText(pageUrl() + a.getAttribute('href')));
    const copyLink = $('.copy-link', view);
    copyLink?.addEventListener('click', async () => {
      if (await copyText(pageUrl())) flash(copyLink, copyLink.dataset.done || T.tCopied);
    });
    st.toc = $$('.toc a', view);
    st.byId = new Map(st.toc.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    st.headings = [...st.byId.keys()].map((id) => view.querySelector('#' + CSS.escape(id))).filter(Boolean);
    updateToc(win);
    // 窗口较窄时目录排在正文上方，默认收起，免得把正文挤到下面
    if (view.clientWidth < 940) $('.toc details', view)?.removeAttribute('open');
    for (const img of $$('.post-content img', view)) {
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
  }
  function updateToc(win) {
    const st = states.get(win);
    if (!st || !st.headings.length) return;
    const top = $('[data-view]', win).getBoundingClientRect().top;
    let current = st.headings[0];
    for (const h of st.headings) {
      if (h.getBoundingClientRect().top - top <= 80) current = h;
      else break;
    }
    for (const a of st.toc) a.classList.toggle('active', a === st.byId.get(current?.id));
  }

  /* ---------- 窗口管理 ---------- */
  function syncChrome() {
    for (const [win, st] of states) {
      st.task?.classList.toggle('is-active', win === active);
      st.task?.classList.toggle('is-min', win.classList.contains('is-min'));
    }
    // 桌面图标、程序坞：对应页面已经有窗口时标成“运行中”
    for (const a of $$('[data-launch]')) a.classList.toggle('is-running', [...states.values()].some((st) => sameDoc(st.url, a.href)));
  }
  function setNavButtons(win) {
    const st = states.get(win);
    const back = $('[data-act="back"]', win);
    const fwd = $('[data-act="forward"]', win);
    if (back) back.disabled = st.idx <= 0;
    if (fwd) fwd.disabled = st.idx >= st.hist.length - 1;
  }
  function titleOf(win) {
    return $('[data-title]', win)?.textContent.trim() || '';
  }
  function focusWin(win, opts = {}) {
    if (!win) {
      active = null;
      syncChrome();
      return;
    }
    win.classList.remove('is-min');
    for (const w of states.keys()) w.classList.toggle('is-active', w === win);
    win.style.zIndex = String(++zTop);
    active = win;
    const st = states.get(win);
    document.title = st.docTitle || titleOf(win);
    if (!opts.keepUrl && !sameDoc(st.url, location.href)) history.replaceState(null, '', st.url);
    syncChrome();
  }
  function topMost() {
    return [...states.keys()].filter((w) => !w.classList.contains('is-min')).sort((a, b) => Number(b.style.zIndex || 0) - Number(a.style.zIndex || 0))[0];
  }
  function minimize(win) {
    win.classList.add('is-min');
    focusWin(topMost() || null);
    syncChrome();
  }
  function closeWin(win) {
    states.get(win)?.task?.remove();
    states.delete(win);
    win.remove();
    focusWin(topMost() || null);
    if (!states.size && T.home) {
      history.replaceState(null, '', T.home);
      document.title = T.site || document.title;
    }
  }
  function toggleMax(win) {
    win.classList.toggle('is-max');
  }
  function makeTask(win) {
    if (!taskList) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task';
    btn.innerHTML = '<span class="task-ico" aria-hidden="true"></span><span class="task-name"></span>';
    btn.addEventListener('click', () => {
      if (win === active && !win.classList.contains('is-min')) minimize(win);
      else focusWin(win);
    });
    taskList.appendChild(btn);
    return btn;
  }
  function setTaskTitle(win) {
    const st = states.get(win);
    if (!st.task) return;
    const title = titleOf(win);
    $('.task-name', st.task).textContent = title;
    st.task.title = title;
  }
  function register(win, url) {
    const st = { url, hist: [url], idx: 0, task: null, toc: [], headings: [], byId: new Map(), docTitle: '' };
    states.set(win, st);
    st.task = makeTask(win);
    setTaskTitle(win);
    $('[data-view]', win).addEventListener('scroll', () => updateToc(win), { passive: true });
    win.addEventListener('pointerdown', () => win !== active && focusWin(win), true);
    setNavButtons(win);
    return st;
  }

  // 新窗口从最初那个窗口的外壳复制而来
  const first = $('[data-win]', desktop);
  let shell = null;
  const tpl = $('template[data-shell]'); // 首页没有窗口，外壳在 template 里
  const proto = first || tpl?.content.querySelector('[data-win]');
  if (proto) {
    shell = proto.cloneNode(true);
    $('main', shell).innerHTML = '';
    shell.classList.remove('is-active', 'is-max', 'is-min');
  }

  async function load(win, url, mode) {
    const st = states.get(win);
    win.classList.add('is-loading');
    let doc;
    let finalUrl = url;
    try {
      const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/html' } });
      if (res.redirected) finalUrl = res.url;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/html')) throw new Error('not html');
      doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    } catch {
      location.href = url;
      return;
    }
    const src = $('[data-win]', doc);
    if (!src) {
      location.href = url; // 不是本主题渲染的页面（例如预览中途换了主题），交给浏览器整页打开
      return;
    }
    const hash = new URL(url, location.href).hash;
    if (hash && !finalUrl.includes('#')) finalUrl += hash;
    $('main', win).replaceWith(document.importNode($('main', src), true));
    for (const key of ['[data-title]', '[data-addr]']) {
      const from = $(key, src);
      const to = $(key, win);
      if (from && to) to.innerHTML = from.innerHTML;
    }
    const q = $('.site-search input', src);
    const mine = $('.site-search input', win);
    if (q && mine) mine.value = q.value;
    st.url = finalUrl;
    st.docTitle = doc.title;
    if (mode === 'push') {
      st.hist = st.hist.slice(0, st.idx + 1);
      st.hist.push(finalUrl);
      st.idx = st.hist.length - 1;
    } else if (mode === 'replace') {
      st.hist[st.idx] = finalUrl;
    }
    win.classList.remove('is-loading');
    setTaskTitle(win);
    setNavButtons(win);
    initContent(win);
    const view = $('[data-view]', win);
    const target = hash ? view.querySelector('#' + CSS.escape(decodeURIComponent(hash.slice(1)))) : null;
    if (target) target.scrollIntoView();
    else view.scrollTop = 0;
    if (win === active) {
      document.title = st.docTitle;
      if (mode === 'push') history.pushState(null, '', finalUrl);
      else if (mode !== 'pop') history.replaceState(null, '', finalUrl);
      syncChrome();
    }
  }
  function openWindow(url) {
    for (const [win, st] of states) {
      if (sameDoc(st.url, url)) {
        focusWin(win);
        return;
      }
    }
    if (!shell) {
      location.href = url;
      return;
    }
    const win = shell.cloneNode(true);
    if (!isMobile()) {
      const step = (opened++ % 6) * 26 + 26;
      win.style.left = `calc(var(--wx) + ${step}px)`;
      win.style.top = `calc(var(--wy) + ${step}px)`;
    }
    desktop.appendChild(win);
    register(win, url);
    focusWin(win, { keepUrl: true });
    history.pushState(null, '', url);
    load(win, url, 'replace');
  }
  function go(win, delta) {
    const st = states.get(win);
    const next = st.idx + delta;
    if (next < 0 || next >= st.hist.length) return;
    st.idx = next;
    setNavButtons(win);
    load(win, st.hist[next], 'keep');
  }

  if (first) {
    register(first, location.href);
    states.get(first).docTitle = document.title;
    first.style.zIndex = String(zTop);
    active = first;
    initContent(first);
    syncChrome();
  }

  /* ---------- 事件：窗口按钮、拖动、链接、表单 ---------- */
  desktop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const win = btn.closest('[data-win]');
    if (!win) return;
    const act = btn.dataset.act;
    if (act === 'close') closeWin(win);
    else if (act === 'min') minimize(win);
    else if (act === 'max') toggleMax(win);
    else if (act === 'back') go(win, -1);
    else if (act === 'forward') go(win, 1);
  });
  desktop.addEventListener('dblclick', (e) => {
    const bar = e.target.closest('[data-drag]');
    if (bar && !e.target.closest('button, a, input') && !isMobile()) toggleMax(bar.closest('[data-win]'));
  });
  desktop.addEventListener('pointerdown', (e) => {
    const bar = e.target.closest('[data-drag]');
    if (!bar || e.button !== 0 || e.target.closest('button, a, input') || isMobile()) return;
    const win = bar.closest('[data-win]');
    if (win.classList.contains('is-max')) return;
    const box = win.getBoundingClientRect();
    const area = desktop.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    bar.setPointerCapture(e.pointerId);
    win.classList.add('is-dragging');
    const move = (ev) => {
      // 标题栏不能拖出桌面：上方不越界，左右和下方至少留一截可以抓住
      const x = Math.min(area.width - 90, Math.max(90 - box.width, ev.clientX - dx - area.left));
      const y = Math.min(area.height - 30, Math.max(0, ev.clientY - dy - area.top));
      win.style.left = `${x}px`;
      win.style.top = `${y}px`;
    };
    const up = () => {
      win.classList.remove('is-dragging');
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      bar.removeEventListener('pointercancel', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  });

  const menus = () => $$('details[data-menu]');
  const closeMenus = (except) => {
    for (const m of menus()) if (m !== except) m.removeAttribute('open');
  };
  // 只接管站内的普通页面；后台、上传的文件、订阅源等交给浏览器
  const routable = (url) => url.origin === location.origin && !/^\/(admin|uploads|theme)(\/|$)/.test(url.pathname) && !/\.[a-z0-9]{2,5}$/i.test(url.pathname);
  document.addEventListener('click', (e) => {
    const menu = e.target.closest('details[data-menu]');
    closeMenus(menu);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.closest('.lang-switch, .lang-hint')) return;
    const url = new URL(a.href, location.href);
    if (!routable(url)) return;
    const win = a.closest('[data-win]');
    if (win && url.hash && sameDoc(states.get(win)?.url || location.href, url.href)) return; // 页内锚点
    e.preventDefault();
    closeMenus();
    if (win) load(win, url.href, 'push');
    else openWindow(url.href);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || (form.method || 'get').toLowerCase() !== 'get') return;
    const url = new URL(form.action, location.href);
    if (!routable(url)) return;
    url.search = new URLSearchParams(new FormData(form)).toString();
    e.preventDefault();
    closeMenus();
    const win = form.closest('[data-win]');
    if (win) load(win, url.href, 'push');
    else openWindow(url.href);
  });
  window.addEventListener('popstate', () => {
    for (const [win, st] of states) {
      if (sameDoc(st.url, location.href)) {
        focusWin(win, { keepUrl: true });
        return;
      }
    }
    if (active) load(active, location.href, 'pop');
    else location.reload();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const input = (active && ($('.search-form input', active) || $('.site-search input', active))) || $('.site-search input');
    if (input) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  /* ---------- 时钟：访客本机时间 ---------- */
  const clocks = $$('[data-clock]');
  if (clocks.length) {
    const fmt = (d, opts, isDate) => {
      try {
        return isDate ? d.toLocaleDateString(T.locale, opts) : d.toLocaleTimeString(T.locale, opts);
      } catch {
        return isDate ? d.toLocaleDateString(undefined, opts) : d.toLocaleTimeString(undefined, opts);
      }
    };
    const tick = () => {
      const d = new Date();
      for (const el of clocks) {
        el.children[0].textContent = fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false }, false);
        el.children[1].textContent = el.dataset.clock === 'long' ? fmt(d, { month: 'short', day: 'numeric', weekday: 'short' }, true) : fmt(d, { year: 'numeric', month: 'numeric', day: 'numeric' }, true);
      }
    };
    tick();
    setInterval(tick, 30000);
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
      location.replace(savedLink.href);
    } else if (!saved) {
      const wanted = (navigator.languages || [navigator.language]).map((l) => l.toLowerCase());
      const matches = (code) => wanted.some((w) => w === code.toLowerCase() || w.split('-')[0] === code.toLowerCase().split('-')[0]);
      const suggestion = !matches(current) ? available.find((a) => matches(a.dataset.lang)) : null;
      const bar = $('.lang-hint');
      if (suggestion && bar) {
        $('.lang-hint-text', bar).textContent = bar.dataset.text.replace('{name}', suggestion.textContent);
        const goLink = $('.lang-hint-go', bar);
        goLink.href = suggestion.href;
        goLink.addEventListener('click', () => remember(suggestion.dataset.lang));
        $('.lang-hint-close', bar).addEventListener('click', () => {
          remember(current);
          bar.hidden = true;
        });
        bar.hidden = false;
      }
    }
  }
})();
