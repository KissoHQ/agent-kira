import { modelContextTokens } from "@request-agent/core";
import { describe, expect, it } from "vitest";

import agent from "./agent.ts";

describe("the agent", () => {
  it("turns off the thinking mode of the model and asks for the context window of the classifier", () => {
    expect(agent).toMatchObject({
      modelContextWindowTokens: modelContextTokens,
      modelOptions: {
        providerOptions: {
          ollama: { think: false, options: { num_ctx: modelContextTokens } },
        },
      },
    });
  });

  it("has none of the tools of eve, and has eve delete each session when it ends", () => {
    expect(agent).toMatchObject({
      defaultTools: false,
      experimental: { workflow: { retention: 0 } },
    });
  });
});
