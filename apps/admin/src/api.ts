export class ApiError extends Error {
  status: number;
  data: any;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const BASE = '/admin/api';

/** 后台当前编辑的内容语言；随每个请求发给服务器 */
const LOCALE_KEY = 'nb:content-locale';
export const getContentLocale = () => localStorage.getItem(LOCALE_KEY) ?? '';
export const setContentLocale = (code: string) => localStorage.setItem(LOCALE_KEY, code);
const localeHeader = (): Record<string, string> => (getContentLocale() ? { 'x-nb-locale': getContentLocale() } : {});

async function handle(res: Response) {
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('nb:unauthorized'));
    throw new ApiError(res.status, json?.error || `请求失败（${res.status}）`, json?.data);
  }
  return json;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + url, {
      method,
      credentials: 'same-origin',
      headers: { 'x-nb-csrf': '1', ...localeHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, '网络连接失败，请检查网络后重试');
  }
  return handle(res);
}

export interface MediaItem {
  id: number;
  url: string;
  path: string;
  originalName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  caption: string;
  createdAt: number;
  duplicate?: boolean;
}

export async function uploadImage(file: File, name = ''): Promise<MediaItem> {
  const form = new FormData();
  form.append('file', file, file.name || 'image.png');
  let res: Response;
  try {
    res = await fetch(`${BASE}/media?name=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-nb-csrf': '1' }, body: form });
  } catch {
    throw new ApiError(0, '网络连接失败，上传未完成');
  }
  return handle(res);
}

export const fmtTime = (ms: number | null | undefined) => (ms ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(ms) : '—');
export const fmtSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

export const STATUS_LABEL: Record<string, string> = { draft: '草稿', scheduled: '定时发布', published: '已发布', unpublished: '已下线', archived: '已归档' };
