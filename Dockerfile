# Relay image (06 §5.1): one origin serves the API, the WebSocket hub and the PWA.
# Base image pinned by digest (multi-arch index of node:24-bookworm-slim, Node 24.21.0,
# resolved 2026-10-14; ADR 0011). Bump the tag and the digest together.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true
RUN npm install --global --no-fund --no-audit pnpm@11.11.0

# Dependency layer: only the lockfile and workspace manifest, so source edits keep it cached.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

# The relay bundles the workspace packages (tsdown); npm dependencies stay external.
# The PWA build runs here as soon as apps/web gains a build script.
RUN pnpm --filter @remote-control/relay --filter @remote-control/web --if-present run build
RUN pnpm --filter @remote-control/relay deploy --prod --legacy /out/relay \
  && mkdir -p /out/relay/public \
  && if [ -f apps/web/dist/index.html ]; then cp -R apps/web/dist/. /out/relay/public/; fi

FROM ${NODE_IMAGE} AS runtime
# The relay needs only `node`. The base image's bundled npm and corepack are dropped (they
# carry the image scanner's language findings), and Debian security updates newer than
# the pinned digest are applied so the Trivy gate (M0-25) stays meaningful between bumps.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && apt-get update \
 && apt-get upgrade --yes --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    RC_PUBLIC_DIR=/app/public
WORKDIR /app
# Root-owned and read-only for the runtime user: the process cannot rewrite its own code.
COPY --from=build /out/relay ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
