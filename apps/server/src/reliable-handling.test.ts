import {
  listPendingReplies,
  markHandled,
  messages,
  storeInboundMessage,
} from "@request-agent/core";
import { useServerTestDatabase, useTestDatabase } from "@request-agent/core/testing";
import { describe, expect, it } from "vitest";

import {
  createReplyDelivery,
  createSerialQueue,
  handleReliably,
  maxSendAttempts,
} from "./reliable-handling";

const getDatabase = useTestDatabase();
const getAppDatabase = useServerTestDatabase();

async function handledWithReply(reply: string): Promise<string> {
  const stored = await storeInboundMessage(getAppDatabase(), {
    channel: "SLACK",
    conversationExternalId: "C1:1",
    externalId: "C1:1",
    sender: "U1",
    bodyText: "Bonjour",
    raw: {},
    sentAt: new Date(),
  });
  await markHandled(getAppDatabase(), stored.messageId, reply);
  return stored.messageId;
}

function recordingLogger() {
  const errors: string[] = [];
  return { errors, logger: { error: (message: string) => errors.push(message) } };
}

describe("handleReliably", () => {
  it("sends no answer for a message closed while the agent handled it, such as by an erasure", async () => {
    const stored = await storeInboundMessage(getAppDatabase(), {
      channel: "SLACK",
      conversationExternalId: "C1:2",
      externalId: "C1:2",
      sender: "U1",
      bodyText: "Bonjour",
      raw: {},
      sentAt: new Date(),
    });

    const outcome = await handleReliably(
      getAppDatabase(),
      async () => {
        // Closed meanwhile, as an erasure does.
        await markHandled(getDatabase(), stored.messageId);
        return { reply: "Votre demande est REQ-0001.", filedBySystem: false };
      },
      { messageId: stored.messageId, trust: "VERIFIED", channelAddress: null },
    );

    expect(outcome).toEqual({ kind: "handled", reply: null });
    expect(await listPendingReplies(getAppDatabase(), "SLACK")).toEqual([]);
  });
});

describe("createSerialQueue", () => {
  it("runs the next tasks after one that fails, and reports the failure", async () => {
    const failures: unknown[] = [];
    const queue = createSerialQueue((error) => failures.push(error));
    const ran: string[] = [];

    queue.push(() => Promise.reject(new Error("broken")));
    queue.push(() => {
      ran.push("next");
      return Promise.resolve();
    });
    await queue.idle();

    expect(ran).toEqual(["next"]);
    expect(failures).toEqual([new Error("broken")]);
  });
});

describe("createReplyDelivery", () => {
  it("sends the answer again until the channel takes it, then no longer keeps it", async () => {
    const messageId = await handledWithReply("Votre demande est REQ-0001.");
    const { logger, errors } = recordingLogger();
    const queue = createSerialQueue(() => undefined);
    const deliver = createReplyDelivery(getAppDatabase(), queue, logger, [1, 1]);
    let attempts = 0;
    const recorded: string[] = [];

    queue.push(() =>
      deliver({
        messageId,
        send: () => {
          attempts += 1;
          return attempts < 3 ? Promise.reject(new Error("Slack is down")) : Promise.resolve("ts");
        },
        record: (sent) => {
          recorded.push(sent);
          return Promise.resolve();
        },
      }),
    );
    await queue.idle();

    expect(attempts).toBe(3);
    expect(recorded).toEqual(["ts"]);
    expect(errors).toHaveLength(2);
    expect(await listPendingReplies(getAppDatabase(), "SLACK")).toEqual([]);
  });

  it("gives up at once an answer refused for good, and keeps the request for the team", async () => {
    const messageId = await handledWithReply("Votre demande est REQ-0001.");
    const { logger, errors } = recordingLogger();
    const queue = createSerialQueue(() => undefined);
    const deliver = createReplyDelivery(getAppDatabase(), queue, logger, [1]);
    let attempts = 0;

    queue.push(() =>
      deliver({
        messageId,
        send: () => {
          attempts += 1;
          return Promise.reject(new Error("is_archived"));
        },
        record: () => Promise.resolve(),
        isPermanent: (error) => error instanceof Error && error.message === "is_archived",
      }),
    );
    await queue.idle();

    expect(attempts).toBe(1);
    expect(errors).toEqual([
      `The answer to message ${messageId} was given up after 1 attempts: the request stays in the web interface`,
    ]);
    expect(await listPendingReplies(getAppDatabase(), "SLACK")).toEqual([]);
  });

  it("gives up an answer that keeps failing, after the last attempt", async () => {
    const messageId = await handledWithReply("Votre demande est REQ-0001.");
    const { logger, errors } = recordingLogger();
    const queue = createSerialQueue(() => undefined);
    const deliver = createReplyDelivery(getAppDatabase(), queue, logger, [0]);
    let attempts = 0;

    queue.push(() =>
      deliver({
        messageId,
        send: () => {
          attempts += 1;
          return Promise.reject(new Error("Slack is down"));
        },
        record: () => Promise.resolve(),
      }),
    );
    await queue.idle();

    expect(attempts).toBe(maxSendAttempts);
    expect(errors.at(-1)).toContain(`was given up after ${maxSendAttempts} attempts`);
    expect(await listPendingReplies(getAppDatabase(), "SLACK")).toEqual([]);
  });

  it("does not send again an answer that went out but could not be stored", async () => {
    const messageId = await handledWithReply("Votre demande est REQ-0001.");
    const { logger, errors } = recordingLogger();
    const queue = createSerialQueue(() => undefined);
    const deliver = createReplyDelivery(getAppDatabase(), queue, logger, [1]);
    let sent = 0;

    await deliver({
      messageId,
      send: () => {
        sent += 1;
        return Promise.resolve("ts");
      },
      record: () => Promise.reject(new Error("database down")),
    });
    await queue.idle();

    expect(sent).toBe(1);
    expect(errors).toEqual([`The answer to message ${messageId} was sent but not stored`]);
    expect(await listPendingReplies(getAppDatabase(), "SLACK")).toEqual([]);
  });

  it("forgets an answer the channel decided not to send", async () => {
    const messageId = await handledWithReply("Votre demande est REQ-0001.");
    const deliver = createReplyDelivery(
      getAppDatabase(),
      createSerialQueue(() => undefined),
      recordingLogger().logger,
    );

    await deliver({
      messageId,
      send: () => Promise.resolve(undefined),
      record: () => Promise.resolve(),
    });

    const [row] = await getDatabase().select({ reply: messages.pendingReply }).from(messages);
    expect(row?.reply).toBeNull();
  });
});
