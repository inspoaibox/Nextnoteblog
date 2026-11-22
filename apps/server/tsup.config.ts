import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // node:sqlite 只能带 node: 前缀导入，不能让打包器把前缀去掉
  removeNodeProtocol: false,
  // 工作区内的包直接打进产物，运行时只需要 node_modules 里的第三方依赖
  noExternal: [/^@nexemc\//],
});
