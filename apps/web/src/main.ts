import { connectDatabase } from "@request-agent/core";

import { createWebApp } from "./app.ts";
import { loadWebEnv } from "./config.ts";
import { listen } from "./listen.ts";

const env = loadWebEnv();
const { db, close } = connectDatabase(env.APP_DATABASE_URL, {
  onError: (error) => {
    console.error("Database connection lost:", error.message);
  },
});
const app = createWebApp({
  db,
  timeZone: env.WEB_TIME_ZONE,
  trustProxy: env.WEB_TRUST_PROXY,
  attachmentsDir: env.ATTACHMENTS_DIR,
  publicOrigin: env.WEB_PUBLIC_ORIGIN,
  onError: (error) => {
    console.error("Request failed:", error.stack ?? error.message);
  },
  onAudit: (event) => {
    console.info(`${new Date().toISOString()} ${event}`);
  },
});

const server = await listen(app.fetch, env.WEB_HOST, env.WEB_PORT).catch(async (error: Error) => {
  console.error(error.message);
  await close();
  process.exit(1);
});
console.info(`Web interface listening on http://${env.WEB_HOST}:${env.WEB_PORT}`);

// Waits this long for the requests in progress when stopping, then stops anyway, so a slow client
// cannot keep the process alive until an orchestrator kills it.
const shutdownTimeoutMs = 10_000;

// Stops accepting requests, then closes the database pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(1), shutdownTimeoutMs).unref();
    server.close(() => {
      void close().then(() => process.exit(0));
    });
    // Connections kept open between requests would hold the close; an HTTP/1 server drops them.
    if ("closeIdleConnections" in server) {
      server.closeIdleConnections();
    }
  });
}
