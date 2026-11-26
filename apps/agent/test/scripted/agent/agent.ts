import { setTimeout as sleep } from "node:timers/promises";

import { modelContextTokens } from "@request-agent/core";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { readScript, writeScript } from "../../script.ts";

// The agent of KIRA with a model that plays the script of the test: the tools, the instructions,
// the hook and the channel are the ones of the agent, re-exported by the other files.

function scriptFile(): string {
  const file = process.env.KIRA_SCRIPT_FILE;
  if (file === undefined || file === "") {
    throw new Error("KIRA_SCRIPT_FILE must name the script of the test");
  }
  return file;
}

// Set while a step that the context window cuts is played.
let cutByWindow = false;

const scripted = mockModel({
  modelId: "scripted",
  provider: "kira-tests",
  respond: async (request) => {
    const file = scriptFile();
    const script = readScript(file);
    const step = script.steps[Math.min(script.calls.length, script.steps.length - 1)];
    if (step === undefined) {
      throw new Error("The script of the test has no step");
    }
    script.calls.push({
      tools: request.tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b)),
      system: request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.text)
        .join("\n"),
      messages: request.messages.filter((message) => message.role !== "system"),
      toolResults: request.toolResults.map(({ name, output }) => ({ name, output })),
    });
    writeScript(file, script);
    if (step.delayMs !== undefined) {
      await sleep(step.delayMs);
    }
    cutByWindow = "finishReason" in step && step.finishReason === "length";
    if (!("toolCalls" in step)) {
      return step.text;
    }
    return {
      text: step.text,
      toolCalls: step.toolCalls.map((call) => ({ name: call.tool, input: call.input })),
    };
  },
});

type StreamPart = { type: string; finishReason?: unknown };

function isStreamResult(value: unknown): value is { stream: ReadableStream<StreamPart> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "stream" in value &&
    value.stream instanceof ReadableStream
  );
}

// Ends the answer as a model whose context window filled: the reason of its end is "length".
function endedByLength(stream: ReadableStream<StreamPart>): ReadableStream<StreamPart> {
  return stream.pipeThrough(
    new TransformStream<StreamPart, StreamPart>({
      transform(part, controller) {
        controller.enqueue(
          part.type === "finish"
            ? { ...part, finishReason: { raw: "length", unified: "length" } }
            : part,
        );
      },
    }),
  );
}

const model = new Proxy(scripted, {
  get(target, property, receiver) {
    if (property === "doStream") {
      return async (options: unknown) => {
        const result: unknown = await Reflect.apply(
          Reflect.get(target, property, receiver),
          target,
          [options],
        );
        if (!isStreamResult(result)) {
          throw new Error("The scripted model gave no stream");
        }
        return cutByWindow ? { ...result, stream: endedByLength(result.stream) } : result;
      };
    }
    return Reflect.get(target, property, receiver) as unknown;
  },
});

export default defineAgent({
  model,
  modelContextWindowTokens: modelContextTokens,
  defaultTools: false,
  experimental: { workflow: { retention: 0 } },
});
