import { modelContextTokens } from "@request-agent/core";
import { defineAgent } from "eve";
import { createOllama } from "ollama-ai-provider-v2";

// The settings are read as they are here: eve also loads this file while it builds, without the
// settings of the server. The channel of the agent checks them when the first request comes.
const apiKey = process.env.OLLAMA_API_KEY;
const ollama = createOllama({
  baseURL: process.env.OLLAMA_BASE_URL,
  headers:
    apiKey === undefined || apiKey === "" ? undefined : { authorization: `Bearer ${apiKey}` },
});

export default defineAgent({
  model: ollama(process.env.OLLAMA_MODEL ?? "ornith:9b"),
  // The window of the classifier too, so Ollama keeps one model loaded between them. eve summarizes
  // the conversation when it fills 90% of it.
  modelContextWindowTokens: modelContextTokens,
  modelOptions: {
    providerOptions: {
      // Thinking more than triples the answer time on a CPU (decision 001), so it is turned off.
      ollama: { think: false, options: { num_ctx: modelContextTokens } },
    },
  },
  // No tool of eve: the agent can neither run code, read files nor reach the web. Its only tools
  // are the ones of the requests, in tools/.
  defaultTools: false,
  experimental: {
    // eve deletes what it stored about a session when the session ends, once the message is
    // handled: the database of KIRA stays the only copy of the messages.
    workflow: { retention: 0 },
  },
});
