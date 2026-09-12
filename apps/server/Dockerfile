# Builds the server, and optionally the PWA it can serve alongside it.
#
# Multi-stage so the runtime image carries no toolchain: only production
# dependencies and compiled JavaScript.

FROM node:22-bookworm-slim AS build
WORKDIR /repo

# better-sqlite3 needs a toolchain to build its native addon when no prebuilt
# binary matches the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web

RUN npm run build --workspace @kvitto/shared \
  && npm run build --workspace @kvitto/server \
  && npm run build --workspace @kvitto/web

# Prune to production dependencies for the runtime stage.
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data && chown node:node /data

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build /repo/apps/server/package.json ./apps/server/package.json
COPY --from=build /repo/apps/server/dist ./apps/server/dist
COPY --from=build /repo/apps/web/dist ./web

ENV KVITTO_DATA_DIR=/data \
    KVITTO_STATIC_DIR=/app/web \
    HOST=0.0.0.0 \
    PORT=8787

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
