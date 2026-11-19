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

import { type HandledMessage, handleMessage } from "./mastra/agents/handle-message";

// Longest wait for one classification. On a CPU a classification takes up to about a minute.
const classificationTimeoutMs = 300_000;

// Longest run of the agent on one message. On a CPU an answer takes from 2 to 8 minutes, with the
// retries of the answer check.
const agentTimeoutMs = 15 * 60 * 1000;

// Longest wait for the vector of a question: about 0.3 s on a CPU, more while the model loads.
const embeddingTimeoutMs = 60_000;

export interface ChannelHandler {
  db: Database;
  handle: (input: TurnInput) => Promise<HandledMessage>;
}

// What every channel adapter needs: the database, with the restricted role of the server, and the
// agent bound to the classifier and the knowledge base.
export function createChannelHandler(
  agent: Agent,
  onDatabaseError: (error: Error) => void,
): ChannelHandler {
  const classifierEnv = loadClassifierEnv();
  const { db } = connectDatabase(loadServerDatabaseEnv().SERVER_DATABASE_URL, {
    onError: onDatabaseError,
  });
  const ollama = {
    baseUrl: classifierEnv.OLLAMA_BASE_URL,
    model: classifierEnv.OLLAMA_MODEL,
    timeoutMs: classificationTimeoutMs,
    apiKey: classifierEnv.OLLAMA_API_KEY,
  };
  const classify = createOllamaClassifier(ollama);
  const judgeDuplicate = createOllamaDuplicateJudge(ollama);
  const embedder = createOllamaEmbedder({
    baseUrl: classifierEnv.OLLAMA_BASE_URL,
    model: loadKnowledgeEnv().OLLAMA_EMBEDDING_MODEL,
    timeoutMs: embeddingTimeoutMs,
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
        agentTimeoutMs,
      }),
  };
}
