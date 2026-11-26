import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgent, startAgent } from "./agent-process.ts";
import { writeScript } from "./script.ts";

// The agent of the tests: the real one with a scripted model, in its own process as in
// production. The tests talk to it through its route, with its password.

const root = fileURLToPath(new URL("scripted/", import.meta.url));

export const scriptedAgentPassword = "password-of-the-agent-of-the-tests";

export interface ScriptedAgent {
  url: string;
  password: string;
  // The file the tests write the script of each message into.
  scriptFile: string;
  stop: () => Promise<void>;
}

export async function startScriptedAgent(databaseUrl: string): Promise<ScriptedAgent> {
  await buildAgent(root);
  // The sessions of an earlier run of the tests are not resumed: eve keeps them in this folder.
  rmSync(join(root, ".eve", ".workflow-data"), { recursive: true, force: true });
  const scriptDirectory = mkdtempSync(join(tmpdir(), "kira-agent-"));
  const scriptFile = join(scriptDirectory, "script.json");
  writeScript(scriptFile, { steps: [], articles: [], calls: [], searches: [] });
  const agent = await startAgent(root, {
    SERVER_DATABASE_URL: databaseUrl,
    AGENT_PASSWORD: scriptedAgentPassword,
    // Never called: the model and the search of the help articles are scripted.
    OLLAMA_BASE_URL: "http://127.0.0.1:9/api",
    KIRA_SCRIPT_FILE: scriptFile,
  });
  return {
    url: agent.url,
    password: scriptedAgentPassword,
    scriptFile,
    stop: async () => {
      await agent.stop();
      rmSync(scriptDirectory, { recursive: true, force: true });
    },
  };
}
