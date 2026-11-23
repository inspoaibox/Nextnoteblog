/**
 * YAML Front Matter 的拆分、读取与回写。
 * 原则：正文一个字符都不改；不认识的字段、注释和字段顺序原样保留。
 */
import { Document, parseDocument, isMap } from 'yaml';

// 输出时不重新折行、不给 [a, b] 加内边距，尽量保持作者原来的写法
const OUTPUT = { lineWidth: 0, flowCollectionPadding: false } as const;

export interface SplitResult {
  /** --- 之间的原文（不含分隔线）；文件没有 Front Matter 时为 null */
  raw: string | null;
  body: string;
}

/** 拆出 Front Matter。正文只去掉分隔线后紧跟的那一个空行，其余原样保留 */
export function splitFrontMatter(text: string): SplitResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // 去掉 BOM
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { raw: null, body: source };
  return { raw: match[1], body: source.slice(match[0].length).replace(/^\r?\n/, '') };
}

export function parseFrontMatter(raw: string | null): { data: Record<string, unknown>; error: string | null } {
  if (!raw?.trim()) return { data: {}, error: null };
  const doc = parseDocument(raw);
  if (doc.errors.length) return { data: {}, error: doc.errors[0].message.split('\n')[0] };
  const data = doc.toJS();
  return data && typeof data === 'object' && !Array.isArray(data) ? { data, error: null } : { data: {}, error: 'Front Matter 不是键值结构' };
}

/**
 * 以原有的 Front Matter 为底，写入系统掌握的字段后输出。
 * 值为 undefined 的键不动；值为 null 的键会被删除。
 */
export function buildFrontMatter(existing: string, known: Record<string, unknown>): string {
  const fresh = () => {
    const doc = new Document({});
    for (const [key, value] of Object.entries(known)) if (value != null) doc.set(key, value);
    return doc.toString(OUTPUT);
  };
  if (!existing?.trim()) return fresh();
  const doc = parseDocument(existing);
  // 原有内容无法解析时不冒险改写：重新生成一份只含已知字段的
  if (doc.errors.length || !isMap(doc.contents)) return fresh();
  for (const [key, value] of Object.entries(known)) {
    if (value === undefined) continue;
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
  return doc.toString(OUTPUT);
}

/** 拼成完整的 .md 文件内容 */
export function joinFrontMatter(yaml: string, body: string): string {
  const block = yaml.trim();
  return block && block !== '{}' ? `---\n${block}\n---\n\n${body}` : body;
}

export function toTimestamp(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
  return [];
}
