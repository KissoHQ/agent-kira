import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client.ts";
import {
  attachments,
  contacts,
  conversations,
  events,
  messages,
  requests,
  staffAccounts,
} from "../db/schema.ts";
import { fail, type Result, succeed } from "../requests/views.ts";

// Erasing the personal data of a person who asks for it (GDPR, article 17). Nothing is deleted
// that the history needs: what the person wrote and who they are is replaced, so the requests keep
// their type, status, project and dates for the team and its figures.

export const erasedText = "[effacé à la demande de la personne]";
const erasedTitle = "Demande effacée à la demande de la personne";

export const personInput = z
  .object({
    email: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().trim().toLowerCase().pipe(z.email()).optional(),
    ),
    slackUserId: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[UW][A-Z0-9]{2,20}$/)
        .optional(),
    ),
  })
  .refine((person) => (person.email === undefined) !== (person.slackUserId === undefined), {
    message: "Give either an email address or a Slack member ID",
  });
export type PersonInput = z.output<typeof personInput>;

export interface Erasure {
  contact: boolean;
  messages: number;
  answers: number;
  requests: number;
  events: number;
  attachments: number;
  // Files the widget stored for the person, to delete from the attachments folder.
  storageRefs: string[];
}

// What an erasure removes, read and written in one transaction. With apply false, nothing is
// written, so the team sees first what the erasure will touch.
export async function erasePerson(
  ownerDb: Database,
  person: PersonInput,
  apply: boolean,
): Promise<Result<Erasure, "STAFF_ACCOUNT">> {
  return ownerDb.transaction(async (tx) => {
    const identity = person.email ?? person.slackUserId ?? "";
    const [contact] = await tx
      .select({ id: contacts.id, staff: staffAccounts.contactId })
      .from(contacts)
      .leftJoin(staffAccounts, eq(staffAccounts.contactId, contacts.id))
      .where(
        person.email === undefined
          ? eq(contacts.slackUserId, identity)
          : eq(contacts.email, identity),
      );
    // An account of the team is managed in the interface: its owner signs the history of others.
    if (contact?.staff != null) {
      return fail("STAFF_ACCOUNT");
    }

    const written = await tx
      .select({
        id: messages.id,
        externalId: messages.externalId,
        conversationId: messages.conversationId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.direction, "INBOUND"),
          contact === undefined
            ? eq(messages.sender, identity)
            : or(eq(messages.sender, identity), eq(messages.authorContactId, contact.id)),
        ),
      );
    const writtenIds = written.map((row) => row.id);
    const answers =
      written.length === 0
        ? []
        : await tx
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.direction, "OUTBOUND"),
                inArray(
                  messages.inReplyTo,
                  written.map((row) => row.externalId),
                ),
              ),
            );
    const created =
      writtenIds.length === 0
        ? []
        : await tx
            .select({ requestId: events.requestId })
            .from(events)
            .where(and(eq(events.type, "CREATED"), inArray(events.messageId, writtenIds)));
    const madeByContact =
      contact === undefined
        ? []
        : await tx
            .select({ requestId: requests.id })
            .from(requests)
            .where(eq(requests.requesterContactId, contact.id));
    const requestIds = [...new Set([...created, ...madeByContact].map((row) => row.requestId))];
    const files =
      writtenIds.length === 0
        ? []
        : await tx
            .select({ id: attachments.id, storageRef: attachments.storageRef })
            .from(attachments)
            .where(inArray(attachments.messageId, writtenIds));
    const touchedEvents =
      requestIds.length === 0 && writtenIds.length === 0
        ? []
        : await tx
            .select({ id: events.id })
            .from(events)
            .where(
              or(
                requestIds.length === 0 ? sql`false` : inArray(events.requestId, requestIds),
                writtenIds.length === 0 ? sql`false` : inArray(events.messageId, writtenIds),
              ),
            );

    const erasure: Erasure = {
      contact: contact !== undefined,
      messages: written.length,
      answers: answers.length,
      requests: requestIds.length,
      events: touchedEvents.length,
      attachments: files.length,
      storageRefs: files.flatMap((file) => (file.storageRef === null ? [] : [file.storageRef])),
    };
    if (!apply) {
      return succeed(erasure);
    }

    // Lets this transaction, and only it, remove text from the history.
    await tx.execute(sql`set local request_agent.erasing = 'on'`);
    const textMessages = [...writtenIds, ...answers.map((row) => row.id)];
    if (textMessages.length > 0) {
      await tx
        .update(messages)
        .set({ bodyText: erasedText, subject: null, raw: {}, pendingReply: null })
        .where(inArray(messages.id, textMessages));
    }
    if (writtenIds.length > 0) {
      await tx.update(messages).set({ sender: "erased" }).where(inArray(messages.id, writtenIds));
    }
    if (written.length > 0) {
      await tx
        .update(conversations)
        .set({ subject: null })
        .where(inArray(conversations.id, [...new Set(written.map((row) => row.conversationId))]));
    }
    if (files.length > 0) {
      await tx.delete(attachments).where(
        inArray(
          attachments.id,
          files.map((file) => file.id),
        ),
      );
    }
    if (requestIds.length > 0) {
      await tx
        .update(requests)
        .set({ title: erasedTitle, summary: null, description: null })
        .where(inArray(requests.id, requestIds));
    }
    if (touchedEvents.length > 0) {
      // Removes the texts kept in the details: a title, a question, and changed texts.
      await tx
        .update(events)
        .set({
          data: sql`((${events.data} - 'title') - 'question') #- '{changes,title}' #- '{changes,summary}' #- '{changes,description}'`,
        })
        .where(
          inArray(
            events.id,
            touchedEvents.map((row) => row.id),
          ),
        );
    }
    if (contact !== undefined) {
      await tx
        .update(contacts)
        .set({
          email: `erased-${contact.id}@erased.invalid`,
          name: null,
          role: null,
          slackUserId: null,
          disabledAt: sql`coalesce(${contacts.disabledAt}, now())`,
        })
        .where(eq(contacts.id, contact.id));
    }
    return succeed(erasure);
  });
}

export interface Purge {
  sessions: number;
  sources: number;
}

// Keeps no data longer than the system needs it: sessions of the web interface that ended more
// than a month ago, and the original payload of messages handled and answered long ago. Their text
// stays, so the requests keep their messages.
export async function purgeOldData(
  ownerDb: Database,
  options: { sourceRetentionDays: number; now?: Date },
): Promise<Purge> {
  const now = options.now ?? new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sourceLimit = new Date(now.getTime() - options.sourceRetentionDays * 24 * 60 * 60 * 1000);
  return ownerDb.transaction(async (tx) => {
    const sessions = await tx.execute(
      sql`delete from staff_sessions where expires_at < ${monthAgo} or revoked_at < ${monthAgo}`,
    );
    const sources = await tx
      .update(messages)
      .set({ raw: {} })
      .where(
        and(
          isNotNull(messages.handledAt),
          sql`${messages.pendingReply} is null`,
          sql`${messages.receivedAt} < ${sourceLimit}`,
          sql`${messages.raw} <> '{}'::jsonb`,
        ),
      )
      .returning({ id: messages.id });
    return { sessions: sessions.rowCount ?? 0, sources: sources.length };
  });
}
