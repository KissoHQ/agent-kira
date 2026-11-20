import type { Server } from "node:net";

import { serve } from "@hono/node-server";
import type { IMastraLogger } from "@mastra/core/logger";

import type { ChannelHandler } from "../channel-handler";
import { loadWidgetEnv } from "../config";
import { createWidgetApp } from "./adapter";

type Fetch = Parameters<typeof serve>[0]["fetch"];

// Listens for the widget, and resolves once it listens. A busy port is told in plain words.
export function listenForWidget(fetch: Fetch, hostname: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname, port }, () => {
      server.off("error", onError);
      resolve(server);
    });
    function onError(error: NodeJS.ErrnoException) {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} of ${hostname} is already in use, often by another agent server still running. Stop it, or choose another port with WIDGET_PORT in .env.`,
              { cause: error },
            )
          : error,
      );
    }
    server.once("error", onError);
  });
}

// Starts the widget when the origins of the applications that embed it are configured. Returns
// false otherwise, so the server keeps running without it.
//
// The widget listens on its own port, not as a route of the Mastra server: Mastra hands its routes
// a copy of the request without the connection, so every person would share one address and one
// limit, and it reads JSON bodies whole before any route can limit their size.
export async function startWidgetIfConfigured(
  handler: () => ChannelHandler,
  logger: IMastraLogger,
): Promise<boolean> {
  const env = loadWidgetEnv();
  if (env === undefined) {
    logger.info("The widget is not configured: set WIDGET_ALLOWED_ORIGINS and ATTACHMENTS_DIR");
    return false;
  }
  if (env.WIDGET_IDENTITY_SECRETS.size === 0) {
    logger.warn("WIDGET_IDENTITY_SECRETS is not set: every person of the widget is unverified");
  }
  const { db, handle } = handler();
  const { app } = await createWidgetApp({
    db,
    handle,
    allowedOrigins: env.WIDGET_ALLOWED_ORIGINS,
    identitySecrets: env.WIDGET_IDENTITY_SECRETS,
    attachmentsDir: env.ATTACHMENTS_DIR,
    attachmentsQuotaBytes: env.WIDGET_ATTACHMENTS_QUOTA_MB * 1024 * 1024,
    trustProxy: env.WIDGET_TRUST_PROXY,
    logger: {
      info: (message) => {
        logger.info(message);
      },
      error: (message, error) => {
        logger.error(message, { error: error instanceof Error ? error.message : String(error) });
      },
    },
  });
  await listenForWidget(app.fetch, env.WIDGET_HOST, env.WIDGET_PORT);
  logger.info(`Widget listening on ${env.WIDGET_HOST}:${env.WIDGET_PORT}`);
  return true;
}
