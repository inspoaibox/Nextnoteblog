import { config } from './config.ts';
import { buildApp } from './app.ts';

const app = await buildApp();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`数据目录：${config.dataDir}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
