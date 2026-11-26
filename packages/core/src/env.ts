import { z } from "zod";

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

// Database role of the web interface and the commands of the team, created by the migrations with
// restricted rights.
export const appRole = "request_agent_app";
// Database role of the agent server, which reads messages from outside: it has fewer rights still,
// and none on the accounts of the team.
export const serverRole = "request_agent_server";

const roleUrl = (role: string) =>
  postgresUrl.refine(
    (value) => {
      const url = new URL(value);
      return url.username === role && url.password !== "";
    },
    { message: `Must connect as the ${role} role, with a password` },
  );

const databaseEnvSchema = z.object({ DATABASE_URL: postgresUrl });
const appDatabaseEnvSchema = z.object({ APP_DATABASE_URL: roleUrl(appRole) });
const serverDatabaseEnvSchema = z.object({ SERVER_DATABASE_URL: roleUrl(serverRole) });
const testDatabaseEnvSchema = z.object({ TEST_DATABASE_URL: postgresUrl });

// Below this confidence, a classified request waits for a human review. 0.8 was measured on the
// evaluation messages: see docs/agent.md.
const defaultReviewThreshold = 0.8;

// The documented API of Ollama is under /api: a base URL without it answers 404 to every call.
export const ollamaBaseUrl = z.url().refine((value) => /\/api\/?$/.test(value), {
  message: "Must end with /api, such as http://127.0.0.1:11434/api",
});
// Optional bearer token, for an Ollama reached through an authenticating proxy.
export const ollamaApiKey = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const classifierEnvSchema = z.object({
  OLLAMA_BASE_URL: ollamaBaseUrl,
  OLLAMA_API_KEY: ollamaApiKey,
  OLLAMA_MODEL: z.string().min(1),
  // An empty value in .env means not set: read as a number, it would be 0 and send nothing to
  // review.
  CLASSIFICATION_REVIEW_THRESHOLD: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().min(0).max(1).default(defaultReviewThreshold),
  ),
});

// Model that turns help articles and questions into vectors, chosen in decision 010.
const defaultEmbeddingModel = "qwen3-embedding:0.6b";

const knowledgeEnvSchema = z.object({
  OLLAMA_BASE_URL: ollamaBaseUrl,
  OLLAMA_API_KEY: ollamaApiKey,
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default(defaultEmbeddingModel),
});

export type ClassifierEnv = z.infer<typeof classifierEnvSchema>;
export type KnowledgeEnv = z.infer<typeof knowledgeEnvSchema>;
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type AppDatabaseEnv = z.infer<typeof appDatabaseEnvSchema>;
export type ServerDatabaseEnv = z.infer<typeof serverDatabaseEnvSchema>;
export type TestDatabaseEnv = z.infer<typeof testDatabaseEnvSchema>;

function parseEnv<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadDatabaseEnv(source: NodeJS.ProcessEnv = process.env): DatabaseEnv {
  return parseEnv(databaseEnvSchema, source);
}

export function loadAppDatabaseEnv(source: NodeJS.ProcessEnv = process.env): AppDatabaseEnv {
  return parseEnv(appDatabaseEnvSchema, source);
}

export function loadServerDatabaseEnv(source: NodeJS.ProcessEnv = process.env): ServerDatabaseEnv {
  return parseEnv(serverDatabaseEnvSchema, source);
}

export function loadTestDatabaseEnv(source: NodeJS.ProcessEnv = process.env): TestDatabaseEnv {
  return parseEnv(testDatabaseEnvSchema, source);
}

export function loadClassifierEnv(source: NodeJS.ProcessEnv = process.env): ClassifierEnv {
  return parseEnv(classifierEnvSchema, source);
}

export function loadKnowledgeEnv(source: NodeJS.ProcessEnv = process.env): KnowledgeEnv {
  return parseEnv(knowledgeEnvSchema, source);
}
