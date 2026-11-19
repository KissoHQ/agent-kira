import { describe, expect, it } from "vitest";

import { createOllamaEmbedder } from "../knowledge/embedder.ts";
import { askOllama, ollamaHeaders } from "./ollama.ts";

// Records the headers each call to Ollama sends.
function recordingFetch(body: unknown) {
  const sent: Headers[] = [];
  const send: typeof fetch = (_url, init) => {
    sent.push(new Headers(init?.headers));
    return Promise.resolve(Response.json(body));
  };
  return { sent, send };
}

describe("ollamaHeaders", () => {
  it("sends the key of a proxy as a bearer token, and nothing more without one", () => {
    expect(ollamaHeaders(undefined)).toEqual({ "content-type": "application/json" });
    expect(ollamaHeaders("secret")).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
  });

  it("is used by the chat and embedding calls", async () => {
    const chat = recordingFetch({ message: { content: "{}" }, logprobs: [] });
    const embed = recordingFetch({ embeddings: [[0.1]] });

    await askOllama(
      { baseUrl: "http://ollama/api", model: "m", timeoutMs: 1000, apiKey: "k", fetch: chat.send },
      { system: "s", user: "u", format: {} },
    );
    await createOllamaEmbedder({
      baseUrl: "http://ollama/api",
      model: "m",
      timeoutMs: 1000,
      apiKey: "k",
      fetch: embed.send,
    })
      .embed(["texte"], "document")
      .catch(() => undefined);

    expect(chat.sent[0]?.get("authorization")).toBe("Bearer k");
    expect(embed.sent[0]?.get("authorization")).toBe("Bearer k");
  });
});
