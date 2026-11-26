import type { Agent } from "@mastra/core/agent";
import {
  connectDatabase,
  createOllamaClassifier,
  createOllamaDuplicateJudge,
  createOllamaEmbedder,
  type Database,
  loadClassifierEnv,
  loadKnowledgeEnv,
  loadServerDatabaseEnv,
  searchKnowledge,
  type TurnInput,
} from "@request-agent/core";

import { loadHandlingLimits } from "./config";
import { type AgentRun, type HandledMessage, handleMessage } from "./mastra/agents/handle-message";

export interface ChannelHandler {
  db: Database;
  handle: (input: TurnInput) => Promise<HandledMessage>;
}

// What every channel adapter needs: the database, with the restricted role of the server, and the
// agent bound to the classifier and the knowledge base. A run of the agent that a limit cut is
// reported, so the team sees whether the limits fit the machine that runs Ollama.
export function createChannelHandler(
  agent: Agent,
  onDatabaseError: (error: Error) => void,
  onLimitCut: (run: AgentRun) => void,
): ChannelHandler {
  // The limits first: a wrong one is named, even when the settings of Ollama are missing too.
  const limits = loadHandlingLimits();
  const classifierEnv = loadClassifierEnv();
  const { db } = connectDatabase(loadServerDatabaseEnv().SERVER_DATABASE_URL, {
    onError: onDatabaseError,
  });
  const ollama = {
    baseUrl: classifierEnv.OLLAMA_BASE_URL,
    model: classifierEnv.OLLAMA_MODEL,
    timeoutMs: limits.classificationTimeoutMs,
    apiKey: classifierEnv.OLLAMA_API_KEY,
  };
  const classify = createOllamaClassifier(ollama);
  const judgeDuplicate = createOllamaDuplicateJudge(ollama);
  const embedder = createOllamaEmbedder({
    baseUrl: classifierEnv.OLLAMA_BASE_URL,
    model: loadKnowledgeEnv().OLLAMA_EMBEDDING_MODEL,
    timeoutMs: limits.embeddingTimeoutMs,
    apiKey: classifierEnv.OLLAMA_API_KEY,
  });
  return {
    db,
    handle: (input) =>
      handleMessage(agent, db, input, {
        classify,
        judgeDuplicate,
        reviewThreshold: classifierEnv.CLASSIFICATION_REVIEW_THRESHOLD,
        searchKnowledge: (actor, question) => searchKnowledge(db, embedder, actor, question),
        agentTimeoutMs: limits.agentTimeoutMs,
        onAgentRun: (run) => {
          if (run.cutBy !== undefined) {
            onLimitCut(run);
          }
        },
      }),
  };
}
