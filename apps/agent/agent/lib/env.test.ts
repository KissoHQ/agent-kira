import { describe, expect, it } from "vitest";

import { parseAgentEnv } from "./env.ts";

const valid = {
  OLLAMA_BASE_URL: "http://127.0.0.1:11434/api",
  AGENT_PASSWORD: "a-password-of-at-least-32-characters",
  SERVER_DATABASE_URL: "postgresql://request_agent_server:secret@127.0.0.1:5433/request_agent",
};

describe("parseAgentEnv", () => {
  it("reads the settings of the agent, with the defaults of the search of the articles", () => {
    expect(parseAgentEnv(valid)).toEqual({
      ollamaBaseUrl: valid.OLLAMA_BASE_URL,
      ollamaApiKey: undefined,
      embeddingModel: "qwen3-embedding:0.6b",
      embeddingTimeoutMs: 60_000,
      password: valid.AGENT_PASSWORD,
      databaseUrl: valid.SERVER_DATABASE_URL,
    });
  });

  it("takes empty values as the defaults", () => {
    expect(
      parseAgentEnv({ ...valid, OLLAMA_EMBEDDING_MODEL: "", EMBEDDING_TIMEOUT_SECONDS: "" }),
    ).toMatchObject({ embeddingModel: "qwen3-embedding:0.6b", embeddingTimeoutMs: 60_000 });
  });

  it("refuses a short password, and a database role other than the one of the server", () => {
    expect(() => parseAgentEnv({ ...valid, AGENT_PASSWORD: "short" })).toThrow(/AGENT_PASSWORD/);
    expect(() =>
      parseAgentEnv({
        ...valid,
        SERVER_DATABASE_URL: "postgresql://request_agent:secret@127.0.0.1:5433/request_agent",
      }),
    ).toThrow(/request_agent_server/);
  });
});
