import type { KnowledgeHit } from "@request-agent/core";
import { inject } from "vitest";

import { type ModelCall, readScript, type ScriptedStep, writeScript } from "./script.ts";

// Values given by the global setup to every test file that uses the agent of the tests.
declare module "vitest" {
  export interface ProvidedContext {
    agentUrl: string;
    agentPassword: string;
    agentScriptFile: string;
  }
}

export { buildAgent, productionAgentRoot, startAgent } from "./agent-process.ts";
export type { ModelCall, ScriptedStep } from "./script.ts";

export interface ScriptedAgentHandle {
  url: string;
  password: string;
  // Sets what the model plays for the next message, and the help articles the search finds.
  play: (steps: ScriptedStep[], articles?: KnowledgeHit[]) => void;
  // Each call of the model since the last play, as the model received it.
  calls: () => ModelCall[];
  // Each search of the help articles since the last play.
  searches: () => { actor: string; question: string }[];
}

// The agent of the tests, started by the global setup.
export function useScriptedAgent(): ScriptedAgentHandle {
  const file = inject("agentScriptFile");
  return {
    url: inject("agentUrl"),
    password: inject("agentPassword"),
    play: (steps, articles = []) => {
      writeScript(file, { steps, articles, calls: [], searches: [] });
    },
    calls: () => readScript(file).calls,
    searches: () => readScript(file).searches,
  };
}
