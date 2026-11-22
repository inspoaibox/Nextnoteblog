import { sql } from 'drizzle-orm';
import { db, schema } from '../db/index.ts';

export interface SiteSettings {
  siteName: string;
  tagline: string;
  description: string;
  /** 站点对外地址（用于 canonical 等），可留空 */
  siteUrl: string;
  defaultLocale: string;
  timezone: string;
  postsPerPage: number;
  /** 亮暗策略由管理员统一决定，访客不能切换 */
  appearance: 'light' | 'dark' | 'auto';
  activeTheme: string;
  icp: string;
  footerText: string;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  siteName: '我的博客',
  tagline: '',
  description: '',
  siteUrl: '',
  defaultLocale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  postsPerPage: 10,
  appearance: 'auto',
  activeTheme: 'default',
  icp: '',
  footerText: '',
};

let cache: SiteSettings | null = null;
let installed = false;

export async function getSettings(): Promise<SiteSettings> {
  if (cache) return cache;
  const rows = await db.select().from(schema.settings);
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      /* 忽略损坏的值，使用默认 */
    }
  }
  cache = { ...DEFAULT_SETTINGS, ...stored } as SiteSettings;
  return cache;
}

export async function updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    const json = JSON.stringify(value);
    await db.insert(schema.settings).values({ key, value: json }).onConflictDoUpdate({ target: schema.settings.key, set: { value: json } });
  }
  cache = null;
  return getSettings();
}

/** 是否已完成安装向导（存在管理员账号） */
export async function isInstalled(): Promise<boolean> {
  if (installed) return true;
  const row = await db.select({ n: sql<number>`count(*)` }).from(schema.users).get();
  installed = (row?.n ?? 0) > 0;
  return installed;
}
