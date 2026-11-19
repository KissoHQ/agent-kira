import { ConsoleLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import { ollamaHeaders, pingDatabase } from "@request-agent/core";
import { createOllama } from "ollama-ai-provider-v2";

import { type ChannelHandler, createChannelHandler } from "../channel-handler";
import { loadEnv } from "../config";
import { startEmailIfConfigured } from "../email/start";
import { createReadiness, ollamaHasModel, readinessRoute } from "../readiness";
import { startSlackIfConfigured } from "../slack/start";
import { startWidgetIfConfigured, widgetRoutes } from "../widget/start";
import { createRequestAgent } from "./agents/request-agent";
import { apiGuard } from "./api-guard";

// No data leaves the machine (decision 001): the usage statistics Mastra sends by default are off,
// unless MASTRA_TELEMETRY_DISABLED says otherwise.
process.env.MASTRA_TELEMETRY_DISABLED ??= "1";

const env = loadEnv();
const ollama = createOllama({
  baseURL: env.OLLAMA_BASE_URL,
  headers:
    env.OLLAMA_API_KEY === undefined
      ? undefined
      : { authorization: `Bearer ${env.OLLAMA_API_KEY}` },
});
const requestAgent = createRequestAgent(ollama(env.OLLAMA_MODEL));

const readiness = createReadiness({
  database: () => pingDatabase(handler().db),
  model: () =>
    ollamaHasModel({
      baseUrl: env.OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL,
      headers: ollamaHeaders(env.OLLAMA_API_KEY),
    }),
});

export const mastra = new Mastra({
  agents: { requestAgent },
  logger: new ConsoleLogger({ name: "KIRA", level: env.LOG_LEVEL }),
  server: {
    host: env.MASTRA_HOST,
    apiRoutes: [...widgetRoutes(), readinessRoute(readiness)],
    // `mastra dev` sets MASTRA_DEV; `mastra start` and the built server do not.
    middleware: apiGuard({ development: process.env.MASTRA_DEV === "true" }),
  },
});

const logger = mastra.getLogger();

// One database pool and one classifier for every channel, created only when a channel needs them.
let channelHandler: ChannelHandler | undefined;
const handler = () => {
  channelHandler ??= createChannelHandler(requestAgent, (error) => {
    logger.error("Database connection lost", { error: error.message });
  });
  return channelHandler;
};

// Starts one channel and records its state for /ready: on, off when it is not configured, or in
// error.
async function startChannel(name: string, start: typeof startSlackIfConfigured): Promise<void> {
  readiness.setChannel(name, "starting");
  try {
    readiness.setChannel(name, (await start(handler, logger)) ? "on" : "off");
  } catch (error) {
    readiness.setChannel(name, "error");
    logger.error(`${name} could not be started`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Channels connect in the background: the server answers its API even while they are starting.
for (const [name, start] of [
  ["Slack", startSlackIfConfigured],
  ["Email", startEmailIfConfigured],
  ["Widget", startWidgetIfConfigured],
] as const) {
  void startChannel(name, start);
}
