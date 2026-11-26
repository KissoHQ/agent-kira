# Images of KIRA, built from the repository root:
#   docker build --target server -t kira-server .
#   docker build --target agent -t kira-agent .
#   docker build --target web -t kira-web .
# The web image also runs the migrations (see compose.production.yaml). All run as the unprivileged
# node user, on the Node.js version the project requires, pinned by digest. The code belongs to root
# and is only readable by node, so a compromised process cannot rewrite it.

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS node

# pnpm, at the version of package.json, only in the build stages: the final images run node alone.
FROM node AS pnpm
RUN npm install --global pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent/package.json apps/agent/
COPY apps/agent/test/scripted/package.json apps/agent/test/scripted/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/

# The server: Node.js runs its TypeScript directly, with the production dependencies only. The
# business core stays in packages/core, outside node_modules, where Node.js strips the types.
FROM pnpm AS server-build
RUN pnpm install --frozen-lockfile --prod --filter "@request-agent/server..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/server apps/server

FROM node AS server
ENV NODE_ENV=production \
    SERVER_PORT=4111 \
    WIDGET_HOST=0.0.0.0 \
    WIDGET_PORT=4113
WORKDIR /app
COPY --from=server-build /app ./
# Owned by node, so a volume mounted here starts writable by the server.
RUN mkdir -p /data/attachments && chown node:node /data/attachments
USER node
# Only the widget is reached from outside. /health and /ready listen inside the container, where
# the health check reads /health, which says the process answers. Not /ready: a reverse proxy such
# as Traefik sends no one to an unhealthy container, and the widget keeps receiving messages while
# Ollama is down, for the team to answer. /ready tells what is missing.
EXPOSE 4113
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4111/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/server/src/main.ts"]

# The agent: eve builds it into .output, a Node.js server that holds the code it needs. eve sends
# no usage statistics while it builds. The build reads the public list of models of Vercel, with
# no data of KIRA; without network, it goes on and the agent uses the context window it sets.
FROM pnpm AS agent-build
RUN pnpm install --frozen-lockfile --filter "@request-agent/agent..."
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/agent apps/agent
RUN EVE_TELEMETRY_DISABLED=1 pnpm --filter @request-agent/agent build

FROM node AS agent
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4120 \
    EVE_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=agent-build /app/apps/agent/.output .output
# eve keeps there the session of each message while it is handled. Owned by node, so a volume
# mounted here starts writable by the agent.
RUN mkdir -p /app/.eve && chown node:node /app/.eve
USER node
# Reached by the server only, through the network of Docker, with the password of the agent.
EXPOSE 4120
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4120/eve/v1/kira/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", ".output/server/index.mjs"]

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
COPY --from=web-build /app ./
USER node
EXPOSE 4112
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4112/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/src/main.ts"]
