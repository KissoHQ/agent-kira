import {
  type Database,
  hasWrittenIn,
  listPendingReplies,
  listUnhandledMessages,
  markHandled,
  markReplySent,
  storeInboundMessage,
  storeOutboundMessage,
  type TurnInput,
} from "@request-agent/core";

import type { HandledMessage } from "../mastra/agents/handle-message";
import {
  createReplyDelivery,
  createSerialQueue,
  defaultRetryDelaysMs,
  handleReliably,
} from "../reliable-handling";
import { parseSlackEvent, type SlackMessage } from "./events";

// The parts of the Slack clients the adapter uses, so tests can replace them.
export interface SlackEventSource {
  on(
    type: "app_mention" | "message",
    listener: (args: { event: unknown; ack: () => Promise<void> }) => Promise<void>,
  ): void;
}

export interface SlackWebApi {
  postInThread(message: {
    channel: string;
    threadTs: string;
    text: string;
  }): Promise<{ ts: string }>;
  addReaction(reaction: { channel: string; ts: string; name: string }): Promise<void>;
}

export interface SlackAdapterLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

export interface SlackAdapterOptions {
  events: SlackEventSource;
  web: SlackWebApi;
  db: Database;
  // Runs the agent on a stored message: handleMessage, bound to the agent and the classifier.
  handle: (input: TurnInput) => Promise<HandledMessage>;
  botUserId: string;
  teamId: string;
  logger: SlackAdapterLogger;
  // Waits before handling a failed message again, after the first and second failures.
  retryDelaysMs?: number[];
  // Waits before posting an answer again when Slack refused it.
  sendRetryDelaysMs?: number[];
}

// Sent when a message could not even be filed for a person, for example when the database is down.
// The message stays unhandled and is handled again when the server restarts.
export const unavailableReply =
  "Le service est momentanément indisponible et votre message n'a pas pu être traité. Merci de le renvoyer un peu plus tard.";

// The reaction that tells the sender the message was received and is being handled.
const receivedReaction = "eyes";

const conversationId = (message: SlackMessage) => `${message.channel}:${message.threadTs}`;
const messageId = (channel: string, ts: string) => `${channel}:${ts}`;

// Slack timestamps are seconds since the epoch, with microseconds after the dot.
const sentAt = (ts: string) => new Date(Number(ts) * 1000);

// Connects Slack to the agent. Each message is stored before Slack is acknowledged, so a message
// Slack considers delivered is stored, then handled one at a time, since the model runs on a CPU.
export async function startSlackAdapter(
  options: SlackAdapterOptions,
): Promise<{ idle: () => Promise<void> }> {
  const { db, web, logger } = options;
  const queue = createSerialQueue((error) => {
    logger.error("A Slack task failed", error);
  });
  const deliver = createReplyDelivery(db, queue, logger, options.sendRetryDelaysMs);
  const context = { botUserId: options.botUserId, teamId: options.teamId };

  const post = (message: SlackMessage, text: string) =>
    web.postInThread({ channel: message.channel, threadTs: message.threadTs, text });

  async function record(message: SlackMessage, text: string, posted: { ts: string }) {
    await storeOutboundMessage(db, {
      channel: "SLACK",
      conversationExternalId: conversationId(message),
      externalId: messageId(message.channel, posted.ts),
      sender: options.botUserId,
      bodyText: text,
      raw: { ts: posted.ts },
      sentAt: sentAt(posted.ts),
      // Ties the answer to the message it answers, and so to the request of that message.
      inReplyTo: messageId(message.channel, message.ts),
    });
  }

  // Posts the answer kept with a handled message, again later if Slack refuses it.
  function answer(message: SlackMessage, storedMessageId: string, text: string) {
    return deliver({
      messageId: storedMessageId,
      send: () => post(message, text),
      record: (posted) => record(message, text, posted),
    });
  }

  async function process(message: SlackMessage, storedMessageId: string): Promise<void> {
    try {
      const outcome = await handleReliably(
        db,
        options.handle,
        {
          messageId: storedMessageId,
          trust: message.sameTeam ? "VERIFIED" : "UNVERIFIED",
          channelAddress: message.channel,
        },
        options.retryDelaysMs ?? defaultRetryDelaysMs,
      );
      if (outcome.kind === "retry") {
        logger.error(
          `Slack message ${message.channel}:${message.ts} will be handled again`,
          outcome.error,
        );
        queue.later(outcome.delayMs, () => process(message, storedMessageId));
        return;
      }
      if (outcome.reply !== null) {
        await answer(message, storedMessageId, outcome.reply);
      }
    } catch (error) {
      // Nothing could be kept for this message: the notice is posted once.
      logger.error(`Slack message ${message.channel}:${message.ts} could not be handled`, error);
      await post(message, unavailableReply)
        .then((posted) => record(message, unavailableReply, posted))
        .catch((replyError: unknown) => {
          logger.error("The unavailability reply could not be sent", replyError);
        });
    }
  }

  async function receive(event: unknown, ack: () => Promise<void>): Promise<void> {
    const message = parseSlackEvent(event, context);
    // A plain channel message is only kept when it continues a thread the agent follows, from
    // someone who already wrote to the agent there: the other messages of the channel, and a
    // colleague of the team answering in the thread, are not stored.
    const relevant =
      message !== undefined &&
      (message.addressedToAgent ||
        (await hasWrittenIn(db, "SLACK", conversationId(message), message.user)));
    if (!relevant) {
      await ack();
      return;
    }
    const stored = await storeInboundMessage(db, {
      channel: "SLACK",
      conversationExternalId: conversationId(message),
      externalId: messageId(message.channel, message.ts),
      sender: message.user,
      bodyText: message.text,
      raw: event,
      sentAt: sentAt(message.ts),
    });
    // A mention arrives both as a mention and as a channel message: only the first is handled. It
    // is queued before Slack is acknowledged, so a failed acknowledgement cannot leave it unhandled.
    if (stored.isNew) {
      queue.push(() => process(message, stored.messageId));
    }
    await ack();
    if (stored.isNew) {
      await web
        .addReaction({ channel: message.channel, ts: message.ts, name: receivedReaction })
        .catch((error: unknown) => {
          logger.error("The reception reaction could not be added", error);
        });
    }
  }

  for (const type of ["app_mention", "message"] as const) {
    options.events.on(type, async ({ event, ack }) => {
      try {
        await receive(event, ack);
      } catch (error) {
        // Not acknowledged: Slack delivers the event again, and the stored message is not lost.
        logger.error(`Slack ${type} event could not be stored`, error);
      }
    });
  }
  // Messages stored before a restart but never handled are handled now, in their order, after the
  // answers that were kept but not posted yet.
  async function recoverUnhandled(): Promise<void> {
    const [pending, unhandled] = await Promise.all([
      listPendingReplies(db, "SLACK"),
      listUnhandledMessages(db, "SLACK"),
    ]);
    for (const stored of pending) {
      const message = parseSlackEvent(stored.raw, context);
      queue.push(() =>
        message === undefined
          ? markReplySent(db, stored.messageId)
          : answer(message, stored.messageId, stored.reply),
      );
    }
    const unreadable = [];
    // Queued in their order, oldest first.
    for (const stored of unhandled) {
      const message = parseSlackEvent(stored.raw, context);
      if (message === undefined) {
        unreadable.push(stored.messageId);
      } else {
        queue.push(() => process(message, stored.messageId));
      }
    }
    await Promise.all(unreadable.map((id) => markHandled(db, id)));
  }

  // A database that is down at startup does not stop the channel: the messages stay unhandled and
  // are handled again at the next start.
  await recoverUnhandled().catch((error: unknown) => {
    logger.error("Unhandled messages could not be resumed", error);
  });

  logger.info("Slack adapter listening");
  return { idle: queue.idle };
}
