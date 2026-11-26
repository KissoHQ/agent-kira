import { serve } from "@hono/node-server";
import {
  cachedCheck,
  ollamaHeaders,
  pingDatabase,
  readinessCheckPeriodMs,
} from "@request-agent/core";

import { createAgentClient } from "./agent/client.ts";
import { type ChannelHandler, createChannelHandler } from "./channel-handler.ts";
import { loadAgentEnv, loadEnv } from "./config.ts";
import { startEmailIfConfigured } from "./email/start.ts";
import { createLogger, errorMessage } from "./logger.ts";
import { createHealthApp, createReadiness, ollamaHasModel } from "./readiness.ts";
import { startSlackIfConfigured } from "./slack/start.ts";
import { startWidgetIfConfigured } from "./widget/start.ts";

// The server of KIRA: it receives the messages of the channels, classifies them, has the agent
// handle them in its own process, checks the answers and sends them.

const env = loadEnv();
const agentEnv = loadAgentEnv();
const logger = createLogger("KIRA", env.LOG_LEVEL);
const agent = createAgentClient({ url: agentEnv.AGENT_URL, password: agentEnv.AGENT_PASSWORD });

// One database pool and one classifier for every channel, created only when a channel needs them.
let channelHandler: ChannelHandler | undefined;
const handler = () => {
  channelHandler ??= createChannelHandler(agent, {
    onDatabaseError: (error) => {
      logger.error("Database connection lost", { error: error.message });
    },
    onLimitCut: (run) => {
      // Expected for a message that makes the agent loop. Frequent cuts mean the limits do not fit
      // the machine that runs Ollama, or the context window the prompts of the agent: docs/agent.md
      // tells how to measure them again.
      logger.warn("The agent was stopped by a limit before it ended its answer", {
        messageId: run.messageId,
        limit: run.cutBy,
        modelCalls: run.modelCalls.length,
      });
    },
    onSessionNotEnded: (messageId, error) => {
      logger.warn("The agent could not end the session of a handled message", {
        messageId,
        error: errorMessage(error),
      });
    },
  });
  return channelHandler;
};

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
  agent: cachedCheck(() => agent.ready(), readinessCheckPeriodMs),
});

const health = serve(
  { fetch: createHealthApp(readiness).fetch, hostname: env.SERVER_HOST, port: env.SERVER_PORT },
  () => {
    logger.info(`Health checks on ${env.SERVER_HOST}:${env.SERVER_PORT}: /health and /ready`);
  },
);
health.once("error", (error) => {
  logger.error("The health checks could not listen", { error: errorMessage(error) });
  process.exitCode = 1;
});

// Starts one channel and records its state for /ready: on, off when it is not configured, or in
// error.
async function startChannel(name: string, start: typeof startSlackIfConfigured): Promise<void> {
  readiness.setChannel(name, "starting");
  try {
    readiness.setChannel(name, (await start(handler, logger)) ? "on" : "off");
  } catch (error) {
    readiness.setChannel(name, "error");
    logger.error(`${name} could not be started`, { error: errorMessage(error) });
  }
}

// Channels connect in the background: /health and /ready answer even while they are starting.
for (const [name, start] of [
  ["Slack", startSlackIfConfigured],
  ["Email", startEmailIfConfigured],
  ["Widget", startWidgetIfConfigured],
] as const) {
  void startChannel(name, start);
}
