import {
  connectDatabase,
  createOllamaEmbedder,
  type Database,
  type Embedder,
} from "@request-agent/core";

import { agentEnv } from "./env.ts";

interface Resources {
  db: Database;
  embedder: Embedder;
}

let resources: Resources | undefined;

// One database pool and one embedder for every message, created when the first one needs them.
export function agentResources(): Resources {
  if (resources === undefined) {
    const env = agentEnv();
    const { db } = connectDatabase(env.databaseUrl, {
      onError: (error) => {
        console.error(`Database connection lost: ${error.message}`);
      },
    });
    const embedder = createOllamaEmbedder({
      baseUrl: env.ollamaBaseUrl,
      model: env.embeddingModel,
      timeoutMs: env.embeddingTimeoutMs,
      apiKey: env.ollamaApiKey,
    });
    resources = { db, embedder };
  }
  return resources;
}
