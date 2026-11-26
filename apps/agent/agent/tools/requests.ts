import { searchKnowledge } from "@request-agent/core";
import { defineDynamic } from "eve/tools";

import { createRequestTools } from "../lib/request-tools.ts";
import { agentResources } from "../lib/resources.ts";
import { turnOf } from "../lib/turn.ts";

// The tools of the message being handled, bound to its sender. eve builds them again before each
// call of the model, from the turn that the server sent with the message: a turn that the server
// did not start gets no tool.
export default defineDynamic((ctx) => {
  const current = turnOf(ctx.session.auth.current);
  if (current === undefined) {
    return null;
  }
  const { db, embedder } = agentResources();
  const { turn } = current;
  return createRequestTools(db, turn, (question) =>
    searchKnowledge(db, embedder, turn.actor, question),
  );
});
