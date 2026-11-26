import { maxAgentSteps, maxModelCallsPerMessage } from "@request-agent/core";
import { defineState } from "eve/context";
import { defineHook } from "eve/hooks";

// Calls of the model for the message of the session, and for its current turn. Kept by eve with
// the session, so a restart does not reset them.
const modelCalls = defineState("kira.model-calls", () => ({ message: 0, turnId: "", turn: 0 }));

// eve has no limit of steps: it calls the model until the model writes an answer without calling a
// tool. This hook stops a turn before the call of the model that goes past the limit, so an
// injected instruction cannot make the agent loop over the tools. The session holds one message:
// the limit of the message counts its rewrites too.
export default defineHook({
  events: {
    "model.requested"(event, ctx) {
      // A call that summarizes the conversation belongs to no turn, and is not a step.
      if (!("turnId" in event.data.owner)) {
        return;
      }
      const { turnId } = event.data.owner;
      modelCalls.update((counted) => ({
        message: counted.message + 1,
        turnId,
        turn: counted.turnId === turnId ? counted.turn + 1 : 1,
      }));
      const counted = modelCalls.get();
      if (counted.turn > maxAgentSteps || counted.message > maxModelCallsPerMessage) {
        ctx.cancel("The step limit of the message is reached.");
      }
    },
  },
});
