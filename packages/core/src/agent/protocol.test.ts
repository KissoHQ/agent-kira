import { describe, expect, it } from "vitest";

import { classified } from "../../test/fixtures.ts";
import { agentTurnReplySchema, agentTurnRequestSchema, agentTurnResultSchema } from "./protocol.ts";

const turn = classified({
  actor: { kind: "contact", contactId: "contact-1", projectIds: ["project-1"] },
  messageId: "message-1",
  project: { status: "identified", projectId: "project-1", source: "CONTACT" },
});

const request = {
  turn,
  information: "Information computed by the system.",
  text: "<message>\nLe portail ne répond plus.\n</message>",
  timeoutMs: 60_000,
};

describe("agentTurnRequestSchema", () => {
  it("accepts a turn of the server as it is", () => {
    expect(agentTurnRequestSchema.parse(request)).toEqual(request);
  });

  it("refuses a turn whose sender, project or classification is not one of the server", () => {
    const invalid = [
      { ...request, turn: { ...turn, actor: { kind: "staff" } } },
      { ...request, turn: { ...turn, project: { status: "guessed" } } },
      { ...request, turn: { ...turn, classification: { ...turn.classification, type: "SPAM" } } },
      { ...request, turn: { ...turn, messageId: "" } },
    ];

    for (const body of invalid) {
      expect(agentTurnRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("refuses an empty text, a text too long, and a time limit that is not positive", () => {
    expect(agentTurnRequestSchema.safeParse({ ...request, text: "" }).success).toBe(false);
    expect(agentTurnRequestSchema.safeParse({ ...request, text: "a".repeat(20_001) }).success).toBe(
      false,
    );
    expect(agentTurnRequestSchema.safeParse({ ...request, timeoutMs: 0 }).success).toBe(false);
  });
});

describe("agentTurnResultSchema", () => {
  const result = {
    answer: "Votre demande est enregistrée.",
    modelCalls: [{ inputTokens: 1200, outputTokens: 40, durationMs: 50_000 }],
    cutBy: null,
    outcomes: [{ tool: "create_request", result: { ok: false, error: "NOT_A_REQUEST" } }],
  };

  it("accepts what the agent returns", () => {
    expect(agentTurnResultSchema.parse(result)).toEqual(result);
  });

  it("refuses an outcome of a tool the agent does not have, and an unknown limit", () => {
    expect(
      agentTurnResultSchema.safeParse({ ...result, outcomes: [{ tool: "drop_table", result: 1 }] })
        .success,
    ).toBe(false);
    expect(agentTurnResultSchema.safeParse({ ...result, cutBy: "patience" }).success).toBe(false);
  });
});

describe("agentTurnReplySchema", () => {
  it("reads a result or an error, with the spaces the agent sends while the turn runs", () => {
    const result = { answer: "", modelCalls: [], cutBy: "step-limit", outcomes: [] };

    expect(agentTurnReplySchema.parse(JSON.parse(`   ${JSON.stringify({ result })}`))).toEqual({
      result,
    });
    expect(agentTurnReplySchema.parse({ error: "The turn failed" })).toEqual({
      error: "The turn failed",
    });
    expect(agentTurnReplySchema.safeParse({}).success).toBe(false);
  });
});
