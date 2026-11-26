import { classified } from "@request-agent/core/testing";
import { describe, expect, it } from "vitest";

import { turnCaller, turnOf } from "./turn.ts";

const turn = classified({
  actor: { kind: "contact", contactId: "contact-1", projectIds: ["project-1"] },
  messageId: "message-1",
  project: { status: "identified", projectId: "project-1", source: "CONTACT" },
});

describe("the turn of a session", () => {
  it("comes back from the caller that the route of the server set", () => {
    const caller = turnCaller({ turn, information: "Information." });

    expect(caller.principalId).toBe("contact-1");
    expect(turnOf(caller)).toEqual({ turn, information: "Information." });
  });

  it("is missing for a caller that the route of the server did not set", () => {
    const caller = turnCaller({ turn, information: "Information." });

    expect(turnOf(null)).toBeUndefined();
    expect(turnOf({ ...caller, authenticator: "local-dev" })).toBeUndefined();
  });

  it("is refused when it is not a turn of the server", () => {
    const caller = turnCaller({ turn, information: "Information." });
    const forged = {
      ...caller,
      attributes: { ...caller.attributes, turn: JSON.stringify({ ...turn, actor: "admin" }) },
    };

    expect(() => turnOf(forged)).toThrow(/actor/);
  });
});
