/**
 * 把一个主题目录打包成可上传的 ZIP，并先做一遍与后台相同的检查。
 * 用法：tsx scripts/pack-theme.ts <主题目录> [输出.zip]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';

const [dir, outArg] = process.argv.slice(2);
if (!dir || !fs.existsSync(path.join(dir, 'theme.json'))) {
  console.error('用法：tsx scripts/pack-theme.ts <主题目录> [输出.zip]\n主题目录里必须有 theme.json');
  process.exit(1);
}

const files: Record<string, Uint8Array> = {};
const walk = (d: string, rel: string) => {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) walk(path.join(d, entry.name), `${rel}${entry.name}/`);
    else files[rel + entry.name] = new Uint8Array(fs.readFileSync(path.join(d, entry.name)));
  }
};
walk(path.resolve(dir), '');
const zip = Buffer.from(zipSync(files, { level: 9 }));

// 检查要用到主题服务，它依赖数据目录：指向一个临时目录，避免碰到真实数据
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pack-'));
const { runMigrations, sqlite } = await import('../src/db/index.ts');
await runMigrations();
const { initThemes, inspectPackage } = await import('../src/services/themes.ts');
await initThemes();
const report = await inspectPackage(zip);
sqlite.close();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

for (const w of report.warnings) console.log(`提示：${w}`);
if (!report.ok) {
  console.error(`\n检查未通过，没有生成安装包：\n${report.errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
const out = path.resolve(outArg ?? `${report.manifest!.id}-${report.manifest!.version}.zip`);
fs.writeFileSync(out, zip);
console.log(`\n检查通过：${report.manifest!.name}（${report.manifest!.id} ${report.manifest!.version}），共 ${report.fileCount} 个文件\n已生成 ${out}`);
