import { z } from "zod";

export interface OllamaOptions {
  // Ollama API endpoint, ending with /api.
  baseUrl: string;
  model: string;
  timeoutMs: number;
  // Sent as a bearer token to an Ollama reached through an authenticating proxy, never needed on
  // this machine.
  apiKey?: string;
  fetch?: typeof fetch;
}

// Headers of a request to Ollama, with the key of the proxy in front of it when there is one.
export function ollamaHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey === undefined
    ? { "content-type": "application/json" }
    : { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
}

// Tokens of text the model reads and writes in one call, sent with every call to the chat model,
// by the classifier and by the agent. Without it, Ollama picks a window from the memory of the
// machine, 4096 tokens on a CPU, which the requests of the agent overflow: the model then stops
// writing in the middle of its answer. Ollama loads the model again when the window changes, so
// every call must send the same one. docs/agent.md tells how it is measured.
export const modelContextTokens = 8192;

export type Logprobs = { token: string; logprob: number }[];

const responseSchema = z.object({
  message: z.object({ content: z.string() }),
  logprobs: z.array(z.object({ token: z.string(), logprob: z.number() })).default([]),
});

// Asks the model for an answer that follows a JSON schema, with the probabilities of its tokens.
// The Mastra provider for Ollama does not return them, so the documented API is called directly.
export async function askOllama(
  options: OllamaOptions,
  request: { system: string; user: string; format: unknown },
): Promise<{ content: string; logprobs: Logprobs }> {
  const send = options.fetch ?? fetch;
  const response = await send(`${options.baseUrl}/chat`, {
    method: "POST",
    headers: ollamaHeaders(options.apiKey),
    signal: AbortSignal.timeout(options.timeoutMs),
    body: JSON.stringify({
      model: options.model,
      stream: false,
      think: false,
      format: request.format,
      logprobs: true,
      options: { temperature: 0, num_ctx: modelContextTokens },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama answered ${response.status}`);
  }
  const body = responseSchema.parse(await response.json());
  return { content: body.message.content, logprobs: body.logprobs };
}

// Probability of the tokens that spell a string value of the answer, at its first occurrence
// after its key. The value must be written between quotes, so a value that only starts another
// one does not match.
export function valueProbability(
  logprobs: Logprobs,
  key: string,
  value: string,
): number | undefined {
  let text = "";
  const spans = logprobs.map(({ token, logprob }) => {
    const start = text.length;
    text += token;
    return { start, end: text.length, logprob };
  });
  const keyAt = text.indexOf(`"${key}"`);
  const begin = keyAt === -1 ? -1 : text.indexOf(`"${value}"`, keyAt + key.length + 2);
  if (begin === -1) {
    return undefined;
  }
  const first = begin + 1;
  const last = first + value.length;
  const total = spans
    .filter((span) => span.start < last && span.end > first)
    .reduce((sum, span) => sum + span.logprob, 0);
  return Math.exp(total);
}
