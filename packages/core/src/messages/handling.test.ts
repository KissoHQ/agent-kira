import { describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { type ChannelMessage, storeInboundMessage, storeOutboundMessage } from "./inbox.ts";
import {
  listPendingReplies,
  listUnhandledMessages,
  markHandled,
  markReplySent,
  recordFailedAttempt,
} from "./handling.ts";

useTestDatabase();
const getAppDatabase = useAppTestDatabase();

const message = (externalId: string): ChannelMessage => ({
  channel: "EMAIL",
  conversationExternalId: "<thread@acme.example>",
  externalId,
  sender: "alice.martin@acme.example",
  bodyText: "Le panier se vide.",
  raw: { id: externalId },
  sentAt: new Date("2026-10-29T09:00:00Z"),
});

describe("message handling", () => {
  it("lists the inbound messages not handled yet, oldest first", async () => {
    const first = await storeInboundMessage(getAppDatabase(), message("<1@acme.example>"));
    const second = await storeInboundMessage(getAppDatabase(), message("<2@acme.example>"));
    await storeOutboundMessage(getAppDatabase(), message("<reply@requests.example>"));

    const unhandled = await listUnhandledMessages(getAppDatabase(), "EMAIL");

    expect(unhandled.map((m) => m.messageId)).toEqual([first.messageId, second.messageId]);
    expect(unhandled[0]).toMatchObject({
      externalId: "<1@acme.example>",
      conversationExternalId: "<thread@acme.example>",
      raw: { id: "<1@acme.example>" },
    });
    expect(await listUnhandledMessages(getAppDatabase(), "SLACK")).toEqual([]);
  });

  it("no longer lists a handled message", async () => {
    const stored = await storeInboundMessage(getAppDatabase(), message("<1@acme.example>"));

    await markHandled(getAppDatabase(), stored.messageId);

    expect(await listUnhandledMessages(getAppDatabase(), "EMAIL")).toEqual([]);
  });

  it("counts the failed attempts", async () => {
    const stored = await storeInboundMessage(getAppDatabase(), message("<1@acme.example>"));

    expect(await recordFailedAttempt(getAppDatabase(), stored.messageId)).toBe(1);
    expect(await recordFailedAttempt(getAppDatabase(), stored.messageId)).toBe(2);
    const [unhandled] = await listUnhandledMessages(getAppDatabase(), "EMAIL");
    expect(unhandled?.handlingAttempts).toBe(2);
  });

  it("keeps the answer of a handled message until the channel has sent it", async () => {
    const answered = await storeInboundMessage(getAppDatabase(), message("<1@acme.example>"));
    const silent = await storeInboundMessage(getAppDatabase(), message("<2@acme.example>"));

    await markHandled(getAppDatabase(), answered.messageId, "Votre demande est REQ-0001.");
    await markHandled(getAppDatabase(), silent.messageId);

    expect(await listPendingReplies(getAppDatabase(), "EMAIL")).toEqual([
      {
        messageId: answered.messageId,
        externalId: "<1@acme.example>",
        conversationExternalId: "<thread@acme.example>",
        raw: { id: "<1@acme.example>" },
        reply: "Votre demande est REQ-0001.",
      },
    ]);
    expect(await listPendingReplies(getAppDatabase(), "SLACK")).toEqual([]);

    await markReplySent(getAppDatabase(), answered.messageId);

    expect(await listPendingReplies(getAppDatabase(), "EMAIL")).toEqual([]);
  });

  it("never replaces the answer of a message already handled", async () => {
    const stored = await storeInboundMessage(getAppDatabase(), message("<1@acme.example>"));

    await markHandled(getAppDatabase(), stored.messageId, "Première réponse");
    await markHandled(getAppDatabase(), stored.messageId, "Seconde réponse");

    const [pending] = await listPendingReplies(getAppDatabase(), "EMAIL");
    expect(pending?.reply).toBe("Première réponse");
  });
});
