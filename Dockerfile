ARG NODE_IMAGE=node:24-alpine
ARG PNPM_VERSION=12.10.1

FROM ${NODE_IMAGE} AS pnpm-base
ARG PNPM_VERSION
ENV CI=true
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM pnpm-base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY app/package.json app/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/api ./packages/api
COPY packages/core ./packages/core
COPY app ./app
COPY scripts/audit-runtime-deps.mjs ./scripts/audit-runtime-deps.mjs
RUN pnpm build

FROM pnpm-base AS runtime-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY app/package.json app/package.json
COPY scripts/audit-runtime-deps.mjs ./scripts/audit-runtime-deps.mjs
RUN pnpm install --prod --frozen-lockfile --filter '@scriptorium/api...' --ignore-scripts \
 && mkdir -p packages/api/node_modules packages/core/node_modules \
 && node scripts/audit-runtime-deps.mjs --node-modules node_modules
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/app/dist ./app/dist
RUN node scripts/audit-runtime-deps.mjs --node-modules node_modules \
      --dist packages/api/dist --dist packages/core/dist --dist app/dist

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SCRIPTORIUM_DATA_DIR=/data \
    HOME=/data \
    TMPDIR=/tmp
RUN apk add --no-cache ca-certificates git tini \
 && mkdir -p /data \
 && chown node:node /data
WORKDIR /app

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/api/package.json ./packages/api/package.json
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/app/dist ./app/dist

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/api/dist/server.js"]
