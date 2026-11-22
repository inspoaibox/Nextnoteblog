# ---------- 构建 ----------
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
COPY packages/markdown/package.json packages/markdown/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# 只保留服务端运行所需的生产依赖
RUN pnpm --filter @nexemc/server deploy --prod --legacy /out/server

# ---------- 运行 ----------
FROM node:24-slim
ENV NODE_ENV=production \
    APP_ROOT=/app \
    DATA_DIR=/data \
    PORT=3000 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=build /out/server/node_modules apps/server/node_modules
COPY --from=build /src/apps/server/dist apps/server/dist
COPY --from=build /src/apps/server/drizzle apps/server/drizzle
COPY --from=build /src/apps/admin/dist apps/admin/dist
COPY --from=build /src/themes themes
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/server.js"]
