import { afterEach, describe, expect, it, vi } from "vitest";

import { scriptedModel } from "../test/scripted-model";
import { createChannelHandler } from "./channel-handler";
import { createRequestAgent } from "./mastra/agents/request-agent";

const ignore = () => undefined;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createChannelHandler", () => {
  it("refuses a time limit that is not a whole number of seconds, naming it", () => {
    vi.stubEnv("AGENT_TIMEOUT_SECONDS", "0");
    const agent = createRequestAgent(scriptedModel([{ text: "ok" }]));

    expect(() => createChannelHandler(agent, ignore, ignore)).toThrow(/AGENT_TIMEOUT_SECONDS/);
  });
});
