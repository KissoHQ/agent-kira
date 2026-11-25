import { ConsoleLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import {
  cachedCheck,
  ollamaHeaders,
  pingDatabase,
  readinessCheckPeriodMs,
} from "@request-agent/core";
import { createOllama } from "ollama-ai-provider-v2";

import { type ChannelHandler, createChannelHandler } from "../channel-handler";
import { loadEnv } from "../config";
import { startEmailIfConfigured } from "../email/start";
import { createReadiness, ollamaHasModel, readinessRoute } from "../readiness";
import { startSlackIfConfigured } from "../slack/start";
import { startWidgetIfConfigured } from "../widget/start";
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

// Each check runs at most once per period, however often /ready is asked.
const readiness = createReadiness({
  database: cachedCheck(() => pingDatabase(handler().db), readinessCheckPeriodMs),
  model: cachedCheck(
    () =>
      ollamaHasModel({
        baseUrl: env.OLLAMA_BASE_URL,
        model: env.OLLAMA_MODEL,
        headers: ollamaHeaders(env.OLLAMA_API_KEY),
      }),
    readinessCheckPeriodMs,
  ),
});

export const mastra = new Mastra({
  agents: { requestAgent },
  logger: new ConsoleLogger({ name: "KIRA", level: env.LOG_LEVEL }),
  server: {
    host: env.MASTRA_HOST,
    apiRoutes: [readinessRoute(readiness)],
    // `mastra dev` sets MASTRA_DEV; `mastra start` and the built server do not.
    middleware: apiGuard({ development: process.env.MASTRA_DEV === "true" }),
  },
});

const logger = mastra.getLogger();

// One database pool and one classifier for every channel, created only when a channel needs them.
let channelHandler: ChannelHandler | undefined;
const handler = () => {
  channelHandler ??= createChannelHandler(
    requestAgent,
    (error) => {
      logger.error("Database connection lost", { error: error.message });
    },
    (run) => {
      // Expected for a message that makes the agent loop. Frequent cuts mean the limits do not fit
      // the machine that runs Ollama, or the context window the prompts of the agent: docs/agent.md
      // tells how to measure them again.
      logger.warn("The agent was stopped by a limit before it ended its answer", {
        messageId: run.messageId,
        limit: run.cutBy,
        modelCalls: run.modelCalls,
      });
    },
  );
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
