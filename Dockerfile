# Images of KIRA, built from the repository root:
#   docker build --target server -t kira-server .
#   docker build --target web -t kira-web .
# The web image also runs the migrations (see compose.production.yaml). Both run as the unprivileged
# node user, on the Node.js version the project requires, pinned by digest.

FROM node:26.12.1-bookworm-slim@sha256:88e480776c6149ff1d098cd304f44bf18057fb5d284a3329b78162d29821e28c AS node

# pnpm, at the version of package.json, only in the build stages: the final images run node alone.
FROM node AS pnpm
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/

# The agent server: Mastra bundles it into .mastra/output with the dependencies it needs.
FROM pnpm AS server-build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/server apps/server
RUN pnpm --filter @request-agent/server build

FROM node AS server
ENV NODE_ENV=production \
    MASTRA_HOST=0.0.0.0 \
    PORT=4111 \
    MASTRA_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=server-build --chown=node:node /app/apps/server/.mastra/output ./
# Owned by node, so a volume mounted here starts writable by the server.
RUN mkdir -p /data/attachments && chown node:node /data/attachments
USER node
EXPOSE 4111
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4111/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "index.mjs"]

# The web interface: Node.js runs its TypeScript directly, with the production dependencies only.
# The business core stays in packages/core, outside node_modules, where Node.js strips the types.
FROM pnpm AS web-build
RUN pnpm install --frozen-lockfile --prod --filter "@request-agent/web..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web

FROM node AS web
ENV NODE_ENV=production \
    WEB_HOST=0.0.0.0 \
    WEB_PORT=4112
WORKDIR /app
COPY --from=web-build --chown=node:node /app ./
USER node
EXPOSE 4112
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4112/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/src/main.ts"]
