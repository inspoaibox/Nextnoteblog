/**
 * 全站备份与恢复。
 * 一个备份就是一个 ZIP：数据库的一致性快照 + 上传的媒体文件 + 已安装的主题 + 一份清单。
 * 备份放在 data/backups/ 下；把别处的备份文件拷进这个目录，后台也能看到并恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from 'fflate';
import { sql } from 'drizzle-orm';
import { db, schema, sqlite } from '../db/index.ts';
import { config } from '../config.ts';
import { HttpError, badRequest, notFound } from '../lib/errors.ts';
import { PENDING_DIR } from '../lib/restore.ts';

export const backupsDir = path.join(config.dataDir, 'backups');
const NAME = /^backup-[\w-]+\.zip$/;
const KEEP_AUTO = 7;
const DAY = 86400_000;

export interface BackupManifest {
  format: 1;
  createdAt: number;
  kind: 'manual' | 'auto';
  note: string;
  posts: number;
  pages: number;
  mediaFiles: number;
  themes: string[];
  dbBytes: number;
}

function walk(dir: string, rel = ''): { rel: string; abs: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [{ rel: rel + e.name, abs: path.join(dir, e.name) }]));
}

/** 边读边写，不把整个备份装进内存 */
function writeZip(out: string, entries: { name: string; abs?: string; data?: Buffer; compress?: boolean }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(out);
    stream.on('error', reject);
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err);
      stream.write(chunk);
      if (final) stream.end(resolve);
    });
    for (const entry of entries) {
      // 图片等已经压缩过的文件直接存，文本类才压缩
      const file = entry.compress ? new ZipDeflate(entry.name, { level: 6 }) : new ZipPassThrough(entry.name);
      zip.add(file);
      file.push(new Uint8Array(entry.data ?? fs.readFileSync(entry.abs!)), true);
    }
    zip.end();
  });
}

const count = async (table: any) => (await db.select({ n: sql<number>`count(*)` }).from(table).get())?.n ?? 0;

export async function createBackup(kind: 'manual' | 'auto' = 'manual', note = ''): Promise<{ name: string; manifest: BackupManifest; size: number }> {
  fs.mkdirSync(backupsDir, { recursive: true });
  // 精确到毫秒：恢复前的留底备份可能与手动备份落在同一秒
  const stamp = new Date().toISOString().replace('Z', '').replace(/[:T.]/g, '-');
  const name = `backup-${stamp}-${kind}.zip`;
  const snapshot = path.join(backupsDir, `.snapshot-${stamp}.db`);
  // VACUUM INTO 生成一份独立、完整的数据库副本，不受正在进行的写入影响
  sqlite.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  try {
    const uploads = walk(config.uploadsDir);
    const themes = walk(path.join(config.dataDir, 'themes'));
    const manifest: BackupManifest = {
      format: 1,
      createdAt: Date.now(),
      kind,
      note: note.slice(0, 200),
      posts: await count(schema.postTranslations),
      pages: await count(schema.pageTranslations),
      mediaFiles: uploads.length,
      themes: fs.existsSync(path.join(config.dataDir, 'themes')) ? fs.readdirSync(path.join(config.dataDir, 'themes')) : [],
      dbBytes: fs.statSync(snapshot).size,
    };
    await writeZip(path.join(backupsDir, name), [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), compress: true },
      { name: 'blog.db', abs: snapshot, compress: true },
      ...uploads.map((f) => ({ name: `uploads/${f.rel}`, abs: f.abs })),
      ...themes.map((f) => ({ name: `themes/${f.rel}`, abs: f.abs, compress: true })),
    ]);
    fs.writeFileSync(path.join(backupsDir, `${name}.json`), JSON.stringify(manifest));
    return { name, manifest, size: fs.statSync(path.join(backupsDir, name)).size };
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

function fileOf(name: string) {
  if (!NAME.test(name)) throw badRequest('备份文件名不合法');
  const abs = path.join(backupsDir, name);
  if (!fs.existsSync(abs)) throw notFound('备份');
  return abs;
}

function manifestOf(name: string): BackupManifest | null {
  const side = path.join(backupsDir, `${name}.json`);
  try {
    if (fs.existsSync(side)) return JSON.parse(fs.readFileSync(side, 'utf8'));
    // 从别处拷进来的备份没有旁边的清单文件：从压缩包里读一次并补上
    const entries = unzipSync(new Uint8Array(fs.readFileSync(path.join(backupsDir, name))), { filter: (f) => f.name === 'manifest.json' });
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8'));
    fs.writeFileSync(side, JSON.stringify(manifest));
    return manifest;
  } catch {
    return null;
  }
}

export function listBackups() {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((n) => NAME.test(n))
    .map((name) => ({ name, size: fs.statSync(path.join(backupsDir, name)).size, manifest: manifestOf(name) }))
    .sort((a, b) => (b.manifest?.createdAt ?? 0) - (a.manifest?.createdAt ?? 0));
}

export const backupPath = (name: string) => fileOf(name);

export function deleteBackup(name: string) {
  fs.rmSync(fileOf(name));
  fs.rmSync(path.join(backupsDir, `${name}.json`), { force: true });
}

/**
 * 准备恢复：校验备份并解压到待恢复目录。真正的替换在下次启动时完成（见 lib/restore.ts）。
 * 调用方负责在响应发出后让进程退出，由 Docker / systemd 重新拉起。
 */
export function prepareRestore(name: string): BackupManifest {
  const abs = fileOf(name);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(fs.readFileSync(abs)));
  } catch {
    throw badRequest('备份文件已损坏，无法解压');
  }
  if (!entries['blog.db'] || !entries['manifest.json']) throw badRequest('这不是一个有效的备份文件（缺少数据库或清单）');
  if (Buffer.from(entries['blog.db'].subarray(0, 15)).toString('latin1') !== 'SQLite format 3') throw badRequest('备份里的数据库文件不是有效的 SQLite 数据库');
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8')) as BackupManifest;

  const staging = path.join(config.dataDir, `${PENDING_DIR}.tmp`);
  const pending = path.join(config.dataDir, PENDING_DIR);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(pending, { recursive: true, force: true });
  try {
    for (const [rel, data] of Object.entries(entries)) {
      if (rel.endsWith('/') || rel === 'manifest.json') continue;
      if (rel !== 'blog.db' && !rel.startsWith('uploads/') && !rel.startsWith('themes/')) continue;
      const target = path.join(staging, rel);
      if (!path.resolve(target).startsWith(path.resolve(staging) + path.sep)) throw new Error(`非法路径：${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    // 备份里没有媒体或主题时也要建空目录，否则旧的会被保留下来
    fs.mkdirSync(path.join(staging, 'uploads'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'themes'), { recursive: true });
    fs.renameSync(staging, pending); // 解压完整了才算数
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new HttpError(500, `解压备份失败：${(err as Error).message}`);
  }
  return manifest;
}

export const cancelRestore = () => fs.rmSync(path.join(config.dataDir, PENDING_DIR), { recursive: true, force: true });

/** 每天自动备份一次，只保留最近若干份自动备份；手动备份不会被自动清理 */
export async function autoBackupIfDue() {
  const autos = listBackups().filter((b) => b.manifest?.kind === 'auto');
  if (autos.length && Date.now() - (autos[0].manifest?.createdAt ?? 0) < DAY) return null;
  const created = await createBackup('auto', '每日自动备份');
  for (const old of listBackups().filter((b) => b.manifest?.kind === 'auto').slice(KEEP_AUTO)) deleteBackup(old.name);
  return created.name;
}
