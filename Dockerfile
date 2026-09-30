# agentmemory daemon: one Node process, one SQLite file under /data.
#
#   docker build -t agentmemory-sqlite .
#   docker run -v /srv/agentmemory:/data -p 3111:3111 -p 3113:3113 agentmemory-sqlite
#
# /data must be writable by uid 1000. The REST secret is /data/.hmac
# (generated on first start); see docker/entrypoint.sh. docker/compose.example.yml
# is a complete service definition.

# Node 24 is the Active LTS; node:sqlite is unflagged from 22.13 (ADR 0001).
ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Optional deps (local embeddings, CJK segmenters) are not shipped, so they
# are not built either; --ignore-scripts keeps onnxruntime's download out.
RUN npm ci --omit=optional --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build \
 && npm prune --omit=dev --omit=optional --no-audit --no-fund

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/agentmemory-entrypoint

ENV NODE_ENV=production \
    AGENTMEMORY_SQLITE_PATH=/data/agentmemory.sqlite \
    AGENTMEMORY_REST_HOST=0.0.0.0 \
    AGENTMEMORY_VERBOSE=1

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3111 3113

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3111/agentmemory/livez').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# tini forwards SIGTERM to node, whose handler closes the listeners and
# checkpoints the WAL; give it the compose stop_grace_period to finish.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint"]
CMD ["node", "/app/dist/index.mjs"]
