import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { conversations, messages, requests } from "../db/schema.ts";
import { formatReference } from "../requests/reference.ts";

type Channel = (typeof messages.$inferSelect)["channel"];

// How many times a message is handled before the system stops retrying it.
export const maxHandlingAttempts = 3;

export interface UnhandledMessage {
  messageId: string;
  // The message and its conversation, as named by their channel.
  externalId: string;
  conversationExternalId: string;
  // Original payload stored by the channel adapter, from which the adapter can handle it again.
  raw: unknown;
  handlingAttempts: number;
}

// The system is done with an inbound message, whatever the outcome, so it is not handled again.
// Its answer, if any, is kept with it until the channel has sent it. False when the message was
// already closed meanwhile, such as by an erasure: its answer must then not be sent.
export async function markHandled(
  db: Database,
  messageId: string,
  reply: string | null = null,
): Promise<boolean> {
  const marked = await db
    .update(messages)
    .set({ handledAt: new Date(), pendingReply: reply })
    .where(and(eq(messages.id, messageId), isNull(messages.handledAt)))
    .returning({ id: messages.id });
  return marked.length > 0;
}

// The reference of the request a message is filed under, as recorded by the system, or undefined.
// Unlike a reference in a text, it cannot name a request the sender did not make.
export async function requestReferenceOf(
  db: Database,
  messageId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ number: requests.number })
    .from(messages)
    .innerJoin(requests, eq(requests.id, messages.requestId))
    .where(eq(messages.id, messageId));
  return row === undefined ? undefined : formatReference(row.number);
}

// The channel sent the answer to the message, or decided not to send it: it is no longer pending.
export async function markReplySent(db: Database, messageId: string): Promise<void> {
  await db.update(messages).set({ pendingReply: null }).where(eq(messages.id, messageId));
}

export interface PendingReply {
  messageId: string;
  externalId: string;
  conversationExternalId: string;
  // Original payload of the message, from which the adapter knows where to answer.
  raw: unknown;
  reply: string;
}

// Answers of handled messages that the channel has not sent yet, oldest first: after a restart,
// the adapter of each channel sends them.
export async function listPendingReplies(db: Database, channel: Channel): Promise<PendingReply[]> {
  const rows = await db
    .select({
      messageId: messages.id,
      externalId: messages.externalId,
      conversationExternalId: conversations.externalId,
      raw: messages.raw,
      reply: messages.pendingReply,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.channel, channel), isNotNull(messages.pendingReply)))
    .orderBy(asc(messages.receivedAt));
  return rows.flatMap((row) => (row.reply === null ? [] : [{ ...row, reply: row.reply }]));
}

// Records a failed attempt and returns how many attempts have failed so far.
export async function recordFailedAttempt(db: Database, messageId: string): Promise<number> {
  const [row] = await db
    .update(messages)
    .set({ handlingAttempts: sql`${messages.handlingAttempts} + 1` })
    .where(eq(messages.id, messageId))
    .returning({ attempts: messages.handlingAttempts });
  if (row === undefined) {
    throw new Error(`Message ${messageId} does not exist`);
  }
  return row.attempts;
}

// Inbound messages stored but not handled yet, oldest first: after a restart, the adapter of each
// channel handles them again.
export async function listUnhandledMessages(
  db: Database,
  channel: Channel,
): Promise<UnhandledMessage[]> {
  const rows = await db
    .select({
      messageId: messages.id,
      externalId: messages.externalId,
      conversationExternalId: conversations.externalId,
      raw: messages.raw,
      handlingAttempts: messages.handlingAttempts,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.channel, channel),
        eq(messages.direction, "INBOUND"),
        isNull(messages.handledAt),
      ),
    )
    .orderBy(asc(messages.receivedAt));
  return rows;
}
