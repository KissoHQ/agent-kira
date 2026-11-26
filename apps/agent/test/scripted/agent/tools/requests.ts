import { defineDynamic } from "eve/tools";

import { createRequestTools } from "../../../../agent/lib/request-tools.ts";
import { agentResources } from "../../../../agent/lib/resources.ts";
import { turnOf } from "../../../../agent/lib/turn.ts";
import { readScript, writeScript } from "../../../script.ts";

// The tools of the agent, with a search of the help articles that returns the articles of the
// script and records each question, instead of asking Ollama for vectors.
export default defineDynamic((ctx) => {
  const current = turnOf(ctx.session.auth.current);
  if (current === undefined) {
    return null;
  }
  const file = process.env.KIRA_SCRIPT_FILE ?? "";
  const { turn } = current;
  return createRequestTools(agentResources().db, turn, (question) => {
    const script = readScript(file);
    script.searches.push({ actor: turn.actor.kind, question });
    writeScript(file, script);
    return Promise.resolve(script.articles);
  });
});
