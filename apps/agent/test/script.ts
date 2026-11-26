import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

// What the scripted agent plays and what it saw, shared through a file between the tests and the
// agent, which runs in its own process. The tests write the script before each message, then read
// what the model was given.

const toolCallSchema = z.object({ tool: z.string(), input: z.unknown() });

// A step calls tools, possibly writing some text next to them as models do, or only writes text.
// A text step ends with "length" when the context window filled before the model ended it. A step
// can also make the model wait, as a model that takes too long.
const stepSchema = z.union([
  z.object({
    toolCalls: z.array(toolCallSchema),
    text: z.string().optional(),
    delayMs: z.number().optional(),
  }),
  z.object({
    text: z.string(),
    finishReason: z.enum(["stop", "length"]).optional(),
    delayMs: z.number().optional(),
  }),
]);

export type ScriptedStep = z.infer<typeof stepSchema>;

// One call of the model, as it received it.
const modelCallSchema = z.object({
  tools: z.array(z.string()),
  system: z.string(),
  // The messages after the system prompt, as text.
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
  toolResults: z.array(z.object({ name: z.string(), output: z.unknown() })),
});

export type ModelCall = z.infer<typeof modelCallSchema>;

const scriptSchema = z.object({
  steps: z.array(stepSchema),
  // The help articles that the search of the agent finds.
  articles: z.array(
    z.object({ project: z.string(), title: z.string(), body: z.string(), relevance: z.number() }),
  ),
  calls: z.array(modelCallSchema),
  searches: z.array(z.object({ actor: z.string(), question: z.string() })),
});

export type Script = z.infer<typeof scriptSchema>;

export function readScript(file: string): Script {
  return scriptSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function writeScript(file: string, script: Script): void {
  writeFileSync(file, JSON.stringify(script));
}
