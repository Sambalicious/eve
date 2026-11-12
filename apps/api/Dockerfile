# One image, two processes (ADR 0004). Build from the repository root:
#   docker build -f apps/api/Dockerfile .
# Run with command ["node", "dist/main.api.js"] or ["node", "dist/main.worker.js"].
# node:22 tracks the latest 22.x, which satisfies engines ">=22.15" (CR2-04; module.registerHooks).
FROM node:22-bookworm-slim AS base
RUN npm install --global pnpm@10.14.0
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @eve/api... --ignore-scripts
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @eve/contracts build \
 && pnpm --filter @eve/api build \
 && pnpm --filter @eve/api deploy --legacy --prod /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
# Per-Candidate file root (CANDIDATE_STORAGE_DIR, EPIC-0002 A2):
# <root>/<candidate_id>/{resumes,documents,exports}. Created here, owned by the runtime
# user and owner-only, so a fresh named volume mounted on it inherits node:node 0700
# (QA-F2, F-QA4-01: without it Docker created the volume root:root 755 and every write
# failed EACCES). The pre-A2 /data/resumes and /data/documents are no longer created:
# only the storage-migrate one-shot mounts them, and those volumes already exist with
# node:node 0700 from earlier images (on a fresh install they hold nothing to move).
RUN mkdir -p /data/candidates && chown node:node /data/candidates && chmod 0700 /data/candidates
# Slice 5 (ADR 0008): per-attempt upload copies and the egress allowlist, written by
# the worker. 0755 so the browser (uid 1000) and Squid (proxy) can read what the
# worker writes; the files themselves keep the documents' owner-only mode.
RUN mkdir -p /data/uploads /data/egress && chown node:node /data/uploads /data/egress && chmod 0755 /data/uploads /data/egress
# Worker heartbeat directory (SEC-211): owned by the runtime user, not the shared /tmp.
RUN mkdir -p /app/run && chown node:node /app/run && chmod 0700 /app/run
USER node
EXPOSE 3000
CMD ["node", "dist/main.api.js"]
