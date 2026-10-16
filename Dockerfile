ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG PNPM_VERSION=12.10.1
ARG PROFILE=core

FROM ${NODE_IMAGE} AS pnpm-base
ARG PNPM_VERSION
ENV CI=true
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM pnpm-base AS build
ARG PROFILE
ENV SCRIPTORIUM_PROFILE=${PROFILE}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE ./
COPY packages/ ./packages/
COPY modules/ ./modules/
COPY app/ ./app/
COPY profiles/ ./profiles/
COPY scripts/ ./scripts/
RUN pnpm install --frozen-lockfile
RUN node scripts/profile-package.mjs --profile "${PROFILE}" --out /runtime

FROM ${NODE_IMAGE} AS runtime
ARG PROFILE
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    SCRIPTORIUM_PROFILE=${PROFILE} \
    SCRIPTORIUM_MODULE_PROFILE_PATH=/app/generated/server.mjs \
    SCRIPTORIUM_DATA_DIR=/data \
    SCRIPTORIUM_USAGE_DIR=/history \
    HOME=/data \
    TMPDIR=/tmp
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data /history \
 && chmod 0700 /history \
 && chown node:node /data /history
WORKDIR /app
COPY --chown=node:node --from=build /runtime/ ./

USER node
VOLUME ["/data", "/history"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "launch.mjs"]
