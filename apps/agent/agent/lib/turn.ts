import { type ClassifiedTurn, classifiedTurnSchema } from "@request-agent/core";
import type { SessionAuthContext } from "eve/context";

// The message being handled travels with the caller of the turn: eve gives it to the tools and to
// the instructions from the session, out of reach of the model. Only the server sets it, on the
// route protected by the password of the agent.

const authenticator = "kira-server";

export interface TurnContext {
  turn: ClassifiedTurn;
  // The information computed by the server before the model runs.
  information: string;
}

export function turnCaller({ turn, information }: TurnContext): SessionAuthContext {
  return {
    authenticator,
    principalId: turn.actor.kind === "contact" ? turn.actor.contactId : "anonymous",
    principalType: "user",
    attributes: { turn: JSON.stringify(turn), information },
  };
}

// The message of the turn, or undefined when the turn was not started by the server.
export function turnOf(caller: SessionAuthContext | null | undefined): TurnContext | undefined {
  if (caller?.authenticator !== authenticator) {
    return undefined;
  }
  const { turn, information } = caller.attributes;
  if (typeof turn !== "string" || typeof information !== "string") {
    return undefined;
  }
  return { turn: classifiedTurnSchema.parse(JSON.parse(turn)), information };
}
