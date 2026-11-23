/**
 * 内置的起步内容：“关于”页面、友链与开源项目的导航入口、友链页的说明。
 * 安装时创建；已经安装的站点升级后在启动时补一次。每个站点只做一次（settings.starterVersion），
 * 之后管理员删掉或改掉都不会再被加回来。
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';
import { getDefaultLocale } from './i18n.ts';
import * as org from './organize.ts';
import { getSettings, isInstalled, updateSettings } from './settings.ts';

const STARTER_VERSION = 1;

function aboutMarkdown(siteName: string, zh: boolean) {
  return zh
    ? `这里是 **${siteName}**。\n\n在这里介绍一下你自己：你是谁、在做什么，这个博客会写些什么，你维护着哪些开源项目。\n\n## 联系方式\n\n- 邮箱：you@example.com\n- GitHub：https://github.com/your-name\n\n> 这一页是安装时自动创建的，可以在后台“页面”里修改或删除。`
    : `Welcome to **${siteName}**.\n\nIntroduce yourself here: who you are, what you work on, what this blog is about and which open source projects you maintain.\n\n## Contact\n\n- Email: you@example.com\n- GitHub: https://github.com/your-name\n\n> This page was created during setup. Edit or delete it under “Pages” in the admin.`;
}

function linksIntro(siteName: string, siteUrl: string, zh: boolean) {
  return zh
    ? `欢迎交换友链。请先在你的网站加上本站，然后通过[关于](/about)页面里的联系方式告诉我你的站点名称、地址和一句话介绍。\n\n本站信息：\n\n- 名称：${siteName}\n- 地址：${siteUrl || '（在后台“设置”里填写站点地址）'}`
    : `Happy to exchange links. Add this site to yours first, then send me your site's name, address and a one-line description via the contacts on the [About](/about) page.\n\n- Name: ${siteName}\n- Address: ${siteUrl || '(set the site URL in Settings)'}`;
}

export async function ensureStarterContent() {
  if (!(await isInstalled())) return;
  const s = await getSettings();
  if (s.starterVersion >= STARTER_VERSION) return;
  const locale = await getDefaultLocale();
  const zh = locale.toLowerCase().startsWith('zh');

  // “关于”页面：地址 about 还空着才创建
  let aboutPageId: number | null = null;
  const taken = await db.select({ id: schema.pageTranslations.id }).from(schema.pageTranslations).where(and(eq(schema.pageTranslations.locale, locale), eq(schema.pageTranslations.slug, 'about'))).get();
  if (!taken) {
    const id = await org.createPage(locale, { title: zh ? '关于' : 'About', slug: 'about' });
    await org.savePage(id, { markdown: aboutMarkdown(s.siteName, zh), seoDescription: '' });
    await org.publishPage(id);
    aboutPageId = (await org.getPage(id)).pageId;
  }

  // 顶部导航：没配置过就给一套完整的；配置过就只补上没有的入口
  const header = await org.getMenuForEdit(locale, 'header');
  const list: org.NavInput[] = header.length
    ? header.map((i) => ({ id: i.id, type: i.type, targetId: i.targetId, url: i.url, label: i.label, newTab: i.newTab, visible: i.visible }))
    : [{ type: 'home' }, { type: 'posts' }, { type: 'archive' }];
  const has = (type: string) => list.some((i) => i.type === type);
  if (!has('projects')) list.splice(Math.min(2, list.length), 0, { type: 'projects' });
  if (!has('links')) list.push({ type: 'links' });
  if (aboutPageId && !list.some((i) => i.type === 'page' && i.targetId === aboutPageId)) list.push({ type: 'page', targetId: aboutPageId });
  await org.saveMenu(locale, 'header', list);

  await updateSettings({ starterVersion: STARTER_VERSION, ...(s.linksIntro ? {} : { linksIntro: linksIntro(s.siteName, s.siteUrl, zh) }) });
}
