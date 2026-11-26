import { type ScriptedAgentHandle, useScriptedAgent } from "@request-agent/agent/testing";

import { type AgentClient, createAgentClient } from "../src/agent/client.ts";

// The agent of the tests, started by the global setup in its own process: the real agent with a
// scripted model. The server reaches it through its client, as in production.
export function useAgent(): { scripted: ScriptedAgentHandle; client: AgentClient } {
  const scripted = useScriptedAgent();
  return {
    scripted,
    client: createAgentClient({ url: scripted.url, password: scripted.password }),
  };
}
