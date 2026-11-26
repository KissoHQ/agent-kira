import {
  type AgentLimit,
  type AgentTurnResult,
  isToolOutcome,
  type ToolOutcome,
} from "@request-agent/core";
import { type CallObservation, calls, runs, type SessionView } from "eve/events";

// The output of a completed call of a tool that records what it did: the tools of the agent return
// their whole outcome, and the model only reads its explanation.
function outcomeOf(call: CallObservation): ToolOutcome | undefined {
  const { output } = call;
  return call.state === "completed" && isToolOutcome(output) && output.tool === call.name
    ? output
    : undefined;
}

export interface TurnEnd {
  // The answer of the turn, when the model wrote one.
  reply: string | undefined;
  // True when the turn was cancelled: by the step limit, or by the route at the time limit.
  cancelled: boolean;
  timedOut: boolean;
}

// What the server needs to know about the message once a turn ended, read from the session.
export function turnResult(view: SessionView, end: TurnEnd): AgentTurnResult {
  // Runs of the turns that called the model: a run the step limit stopped before its call was
  // interrupted without an answer, and a run that summarizes the conversation belongs to no turn.
  const modelRuns = runs(view).filter(
    (run) => run.turnId !== undefined && run.status === "settled" && run.outcome !== "interrupted",
  );
  let cutBy: AgentLimit | null = null;
  if (end.timedOut) {
    cutBy = "time-limit";
  } else if (modelRuns.some((run) => run.finishReason === "length")) {
    cutBy = "context-window";
  } else if (end.cancelled) {
    cutBy = "step-limit";
  }
  return {
    answer: end.cancelled ? "" : (end.reply ?? ""),
    modelCalls: modelRuns.map((run) => ({
      inputTokens: run.usage?.inputTokens ?? 0,
      outputTokens: run.usage?.outputTokens ?? 0,
      durationMs:
        run.startedAt === undefined || run.endedAt === undefined
          ? 0
          : Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)),
    })),
    cutBy,
    outcomes: calls(view, { kind: "tool" })
      .map(outcomeOf)
      .filter((outcome) => outcome !== undefined),
  };
}
