import {
  connectDatabase,
  createOllamaClassifier,
  createOllamaDuplicateJudge,
  type Database,
  loadClassifierEnv,
  loadServerDatabaseEnv,
  type TurnInput,
} from "@request-agent/core";

import type { AgentClient } from "./agent/client.ts";
import { type AgentRun, type HandledMessage, handleMessage } from "./agent/handle-message.ts";
import { loadHandlingLimits } from "./config.ts";

export interface ChannelHandler {
  db: Database;
  handle: (input: TurnInput) => Promise<HandledMessage>;
}

export interface ChannelHandlerEvents {
  onDatabaseError: (error: Error) => void;
  // A run of the agent that a limit cut is reported, so the team sees whether the limits fit the
  // machine that runs Ollama.
  onLimitCut: (run: AgentRun) => void;
  onSessionNotEnded: (messageId: string, error: unknown) => void;
}

// What every channel adapter needs: the database, with the restricted role of the server, and the
// agent, reached through its client, after the classifier.
export function createChannelHandler(
  agent: AgentClient,
  events: ChannelHandlerEvents,
): ChannelHandler {
  const classifierEnv = loadClassifierEnv();
  const limits = loadHandlingLimits();
  const { db } = connectDatabase(loadServerDatabaseEnv().SERVER_DATABASE_URL, {
    onError: events.onDatabaseError,
  });
  const ollama = {
    baseUrl: classifierEnv.OLLAMA_BASE_URL,
    model: classifierEnv.OLLAMA_MODEL,
    timeoutMs: limits.classificationTimeoutMs,
    apiKey: classifierEnv.OLLAMA_API_KEY,
  };
  const classify = createOllamaClassifier(ollama);
  const judgeDuplicate = createOllamaDuplicateJudge(ollama);
  return {
    db,
    handle: (input) =>
      handleMessage(agent, db, input, {
        classify,
        judgeDuplicate,
        reviewThreshold: classifierEnv.CLASSIFICATION_REVIEW_THRESHOLD,
        agentTimeoutMs: limits.agentTimeoutMs,
        onAgentRun: (run) => {
          if (run.cutBy !== undefined) {
            events.onLimitCut(run);
          }
        },
        onSessionNotEnded: events.onSessionNotEnded,
      }),
  };
}
