import {
  type Database,
  fileUnhandledMessage,
  markHandled,
  markReplySent,
  maxHandlingAttempts,
  prepareTurn,
  recordFailedAttempt,
  type TurnInput,
  unclassifiedTurn,
} from "@request-agent/core";

import type { HandledMessage } from "./mastra/agents/handle-message";
import { filedForReviewReply } from "./mastra/agents/reply";

// Waits before handling a failed message again: the model may be restarting or busy.
export const defaultRetryDelaysMs = [60_000, 300_000];

export type HandlingOutcome =
  { kind: "handled"; reply: string | null } | { kind: "retry"; delayMs: number; error: unknown };

// Handles a stored message, and makes sure it ends up somewhere: handled by the agent, retried
// later, or, after the last attempt, filed for a person without classification. The message is
// marked as handled only then, so a restart in between handles it again.
export async function handleReliably(
  db: Database,
  handle: (input: TurnInput) => Promise<HandledMessage>,
  input: TurnInput,
  retryDelaysMs: number[] = defaultRetryDelaysMs,
): Promise<HandlingOutcome> {
  try {
    const handled = await handle(input);
    // A message closed meanwhile, such as by an erasure, gets no answer.
    const marked = await markHandled(db, input.messageId, handled.reply);
    return { kind: "handled", reply: marked ? handled.reply : null };
  } catch (error) {
    const attempts = await recordFailedAttempt(db, input.messageId);
    if (attempts < maxHandlingAttempts) {
      const delayMs = retryDelaysMs[attempts - 1] ?? retryDelaysMs.at(-1) ?? 0;
      return { kind: "retry", delayMs, error };
    }
    const turn = await unclassifiedTurn(db, await prepareTurn(db, input));
    const filed = await fileUnhandledMessage(db, turn);
    const reply = filed === undefined ? null : filedForReviewReply(filed.reference);
    const marked = await markHandled(db, input.messageId, reply);
    return { kind: "handled", reply: marked ? reply : null };
  }
}

// Runs tasks one at a time, including the retries scheduled later, and tells when all are done. A
// task that fails is reported, and the next ones still run.
export function createSerialQueue(onError: (error: unknown) => void) {
  let chain = Promise.resolve();
  const pending = new Set<Promise<void>>();
  const push = (task: () => Promise<void>) => {
    chain = chain.then(task).catch(onError);
  };
  return {
    push,
    later: (delayMs: number, task: () => Promise<void>) => {
      const waiting = new Promise<void>((resolve) => {
        setTimeout(() => {
          push(task);
          resolve();
        }, delayMs);
      });
      pending.add(waiting);
      void waiting.then(() => pending.delete(waiting));
    },
    idle: async () => {
      // Retries can be scheduled while waiting, so wait until none is left.
      do {
        // oxlint-disable-next-line no-await-in-loop
        await Promise.all(pending);
        // oxlint-disable-next-line no-await-in-loop
        await chain;
      } while (pending.size > 0);
    },
  };
}

export type SerialQueue = ReturnType<typeof createSerialQueue>;

// Waits before sending an answer again: the mail server or Slack may be down for a while. After
// the last delay, the answer is tried again at that pace until it goes out.
export const defaultSendRetryDelaysMs = [60_000, 300_000, 900_000];

export interface Delivery<Sent> {
  // The inbound message the answer is for, which keeps the answer until it is sent.
  messageId: string;
  // Sends the answer through the channel. Undefined when the channel decides not to send it.
  send: () => Promise<Sent | undefined>;
  // Keeps the answer that went out in the conversation. A failure here is only logged: the answer
  // is out, and sending it again would send it twice.
  record: (sent: Sent) => Promise<void>;
}

export interface DeliveryLogger {
  error(message: string, error: unknown): void;
}

// Sends the answer of a handled message until it goes out. The answer was kept with the message
// when it was handled, so a channel that is down, or a restart, does not lose it.
export function createReplyDelivery(
  db: Database,
  queue: SerialQueue,
  logger: DeliveryLogger,
  retryDelaysMs: number[] = defaultSendRetryDelaysMs,
) {
  async function deliver<Sent>(delivery: Delivery<Sent>, attempt = 0): Promise<void> {
    let sent: Sent | undefined;
    try {
      sent = await delivery.send();
    } catch (error) {
      const delayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? 0;
      logger.error(`The answer to message ${delivery.messageId} will be sent again`, error);
      queue.later(delayMs, () => deliver(delivery, attempt + 1));
      return;
    }
    if (sent !== undefined) {
      await delivery.record(sent).catch((error: unknown) => {
        logger.error(`The answer to message ${delivery.messageId} was sent but not stored`, error);
      });
    }
    await markReplySent(db, delivery.messageId).catch((error: unknown) => {
      logger.error(`The answer to message ${delivery.messageId} could not be marked sent`, error);
    });
  }
  return deliver;
}
