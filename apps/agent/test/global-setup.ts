import type { TestProject } from "vitest/node";

import { startScriptedAgent } from "./scripted-agent.ts";

// Runs after the global setup of the business core, which prepares the test database: the agent
// of the tests uses it with the role of the server.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const agent = await startScriptedAgent(project.getProvidedContext().testServerDatabaseUrl);
  project.provide("agentUrl", agent.url);
  project.provide("agentPassword", agent.password);
  project.provide("agentScriptFile", agent.scriptFile);
  return agent.stop;
}
