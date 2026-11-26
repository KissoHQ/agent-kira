import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentClient } from "./agent/client.ts";
import { createChannelHandler } from "./channel-handler.ts";

const ignore = () => undefined;

// Never called: the handler refuses its settings first.
const unusedAgent: AgentClient = {
  handle: () => Promise.reject(new Error("unused")),
  rewrite: () => Promise.reject(new Error("unused")),
  end: () => Promise.resolve(),
  ready: () => Promise.resolve(true),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createChannelHandler", () => {
  it("refuses a time limit that is not a whole number of seconds, naming it", () => {
    vi.stubEnv("AGENT_TIMEOUT_SECONDS", "0");

    expect(() =>
      createChannelHandler(unusedAgent, {
        onDatabaseError: ignore,
        onLimitCut: ignore,
        onSessionNotEnded: ignore,
      }),
    ).toThrow(/AGENT_TIMEOUT_SECONDS/);
  });
});
