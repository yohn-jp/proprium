ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
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
COPY packages/contracts/package.json packages/contracts/package.json
COPY app/package.json app/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/api ./packages/api
COPY packages/core ./packages/core
COPY packages/contracts ./packages/contracts
COPY app ./app
COPY scripts/audit-runtime-deps.mjs ./scripts/audit-runtime-deps.mjs
RUN pnpm build

FROM pnpm-base AS runtime-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY app/package.json app/package.json
COPY scripts/audit-runtime-deps.mjs ./scripts/audit-runtime-deps.mjs
RUN pnpm install --prod --frozen-lockfile --filter '@scriptorium/api...' --ignore-scripts \
 && mkdir -p packages/api/node_modules packages/core/node_modules packages/contracts/node_modules \
 && node scripts/audit-runtime-deps.mjs --node-modules node_modules --production
COPY --from=build /app/packages/api/dist/server.js ./packages/api/dist/server.js
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/app/dist/index.html ./app/dist/index.html
COPY --from=build /app/app/dist/styles.css ./app/dist/styles.css
COPY --from=build /app/app/dist/main.js ./app/dist/main.js
COPY --from=build /app/app/dist/api.js ./app/dist/api.js
COPY --from=build /app/app/dist/drafts.js ./app/dist/drafts.js
RUN node scripts/audit-runtime-deps.mjs --node-modules node_modules --production \
      --dist packages/api/dist --dist packages/core/dist --dist app/dist

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SCRIPTORIUM_DATA_DIR=/data \
    HOME=/data \
    TMPDIR=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data \
 && chown node:node /data
WORKDIR /app

COPY LICENSE ./LICENSE
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=runtime-deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=runtime-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=runtime-deps /app/packages/api/package.json ./packages/api/package.json
COPY --from=runtime-deps /app/packages/api/dist/server.js ./packages/api/dist/server.js
COPY --from=runtime-deps /app/packages/core/package.json ./packages/core/package.json
COPY --from=runtime-deps /app/packages/core/dist ./packages/core/dist
COPY --from=runtime-deps /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=runtime-deps /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=runtime-deps /app/app/dist ./app/dist

USER node
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/api/dist/server.js"]
