FROM postgres:17.11-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994 AS postgres-tools
RUN mkdir /pgtools && cp /usr/lib/postgresql/17/bin/pg_dump /usr/lib/postgresql/17/bin/pg_restore /pgtools/ \
    && cp -L /usr/lib/*-linux-gnu/libpq.so.5 /pgtools/libpq.so.5

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS guardian-builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY src/server/subprocess/guardian.c /build/guardian.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror /build/guardian.c -o /build/may-be-guardian

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg flac util-linux tini ca-certificates libpq5 liblz4-1 libzstd1 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/var/media /app/var/mail /app/var/service /app/var/logs /app/var/recovery /app/var/native /app/var/backups /app/var/secrets \
    && chown -R node:node /app/var && chmod 700 /app/var/*
COPY --from=guardian-builder --chmod=0755 /build/may-be-guardian /usr/local/libexec/may-be-guardian
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

FROM dependencies AS development
COPY --chown=node:node . .
RUN mkdir -p /app/.next && chown node:node /app /app/.next
ENV NODE_ENV=development
USER node
CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0"]

FROM dependencies AS migrator
COPY tsconfig.json ./
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY src ./src
USER node
CMD ["npm", "run", "db:migrate"]

FROM dependencies AS builder
COPY . .
# The initial foundation need not contain public assets.
RUN mkdir -p public && npm run build

# The worker executes bounded TypeScript subprocesses and operator recovery CLIs.
# PostgreSQL tools and libpq come from the same pinned server major; distro
# libraries supply their TLS/compression dependencies. No DB service runs here.
FROM dependencies AS worker
COPY --from=postgres-tools /pgtools/pg_dump /pgtools/pg_restore /usr/local/bin/
COPY --from=postgres-tools /pgtools/libpq.so.5 /usr/local/lib/libpq.so.5
RUN ldconfig
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node drizzle ./drizzle
RUN npm run worker:build && chown -R node:node .worker
ENV NODE_ENV=production WORKER_USE_BUNDLE=1
USER node
CMD ["node", "--conditions=react-server", "--import", "tsx", "scripts/worker.ts"]

FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/src/server/media/parser.cjs ./src/server/media/parser.cjs
USER node
EXPOSE 3000
CMD ["node", "server.js"]
