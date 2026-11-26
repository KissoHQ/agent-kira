import {
  agentPassword,
  loadServerDatabaseEnv,
  ollamaApiKey,
  ollamaBaseUrl,
  timeoutSeconds,
} from "@request-agent/core";
import { z } from "zod";

// Model that turns help articles and questions into vectors, chosen in decision 010.
const defaultEmbeddingModel = "qwen3-embedding:0.6b";

const agentEnvSchema = z.object({
  OLLAMA_BASE_URL: ollamaBaseUrl,
  OLLAMA_API_KEY: ollamaApiKey,
  // An empty value, as compose.production.yaml passes for a setting left out of .env, means the
  // default.
  OLLAMA_EMBEDDING_MODEL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).default(defaultEmbeddingModel),
  ),
  // One call that turns a question into a vector, to search the help articles.
  EMBEDDING_TIMEOUT_SECONDS: timeoutSeconds(60),
  AGENT_PASSWORD: agentPassword,
});

export interface AgentEnv {
  ollamaBaseUrl: string;
  ollamaApiKey: string | undefined;
  embeddingModel: string;
  embeddingTimeoutMs: number;
  password: string;
  databaseUrl: string;
}

export function parseAgentEnv(source: NodeJS.ProcessEnv): AgentEnv {
  const result = agentEnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const env = result.data;
  return {
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaApiKey: env.OLLAMA_API_KEY,
    embeddingModel: env.OLLAMA_EMBEDDING_MODEL,
    embeddingTimeoutMs: env.EMBEDDING_TIMEOUT_SECONDS * 1000,
    password: env.AGENT_PASSWORD,
    databaseUrl: loadServerDatabaseEnv(source).SERVER_DATABASE_URL,
  };
}

let cached: AgentEnv | undefined;

// eve runs the top-level code of the agent files while it builds them too, without the settings
// of the server: they are read when the first request needs them.
export function agentEnv(): AgentEnv {
  cached ??= parseAgentEnv(process.env);
  return cached;
}
