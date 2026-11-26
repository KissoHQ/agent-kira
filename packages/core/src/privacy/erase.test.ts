import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { alice, bruno, classified, storeMessage } from "../../test/fixtures.ts";
import { attachments, contacts, events, messages, requests, staffSessions } from "../db/schema.ts";
import { seedDatabase } from "../db/seed.ts";
import { storeOutboundMessage } from "../messages/inbox.ts";
import { createRequest, requestClarification } from "../requests/commands.ts";
import { prepareTurn } from "../requests/turn.ts";
import { saveStaffAccount } from "../staff/accounts.ts";
import { openSession } from "../staff/sessions.ts";
import { erasedText, erasePerson, personInput, purgeOldData } from "./erase.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

beforeEach(async () => {
  await seedDatabase(getDatabase());
});

// A request of the person, with a file, a question asked to them and the answer of the agent.
async function requestOf(sender: string, text: string, thread: string) {
  const messageId = await storeMessage(getDatabase(), { sender, bodyText: text, thread });
  const turn = classified(
    await prepareTurn(getAppDatabase(), { messageId, trust: "VERIFIED", channelAddress: null }),
    { title: `Titre de ${sender}`, summary: `Résumé de ${sender}` },
    text,
  );
  const created = await createRequest(getAppDatabase(), turn, { projectKey: "PORTAL" });
  if (!created.ok) {
    throw new Error(created.error);
  }
  return { messageId, turn, reference: created.value.request.reference };
}

describe("erasePerson", () => {
  it("shows what it will erase without writing anything, then erases only that person", async () => {
    const own = await requestOf(bruno, "Mon numéro est le 06 12 34 56 78.", "t-bruno");
    const [stored] = await getDatabase()
      .select({ externalId: messages.externalId })
      .from(messages)
      .where(eq(messages.id, own.messageId));
    await storeOutboundMessage(getAppDatabase(), {
      channel: "EMAIL",
      conversationExternalId: "t-bruno",
      externalId: "<answer@requests.example>",
      sender: "agent@requests.example",
      bodyText: "Bonjour Bruno, votre demande est enregistrée.",
      raw: { to: bruno },
      sentAt: new Date(),
      inReplyTo: stored?.externalId,
    });
    await getDatabase().insert(attachments).values({
      messageId: own.messageId,
      filename: "facture.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      storageRef: "0b4c1f9e-5c43-4c1d-9d8e-2f3a4b5c6d7e",
    });
    const other = await requestOf("chloe.durand@initech.example", "Le CRM est lent.", "t-chloe");
    const person = personInput.parse({ email: " Bruno.Leroy@Globex.example " });

    const preview = await erasePerson(getDatabase(), person, false);
    expect(preview).toEqual({
      ok: true,
      value: {
        contact: true,
        messages: 1,
        answers: 1,
        requests: 1,
        events: 2,
        attachments: 1,
        storageRefs: ["0b4c1f9e-5c43-4c1d-9d8e-2f3a4b5c6d7e"],
      },
    });
    const [untouched] = await getDatabase()
      .select({ text: messages.bodyText })
      .from(messages)
      .where(eq(messages.id, own.messageId));
    expect(untouched?.text).toBe("Mon numéro est le 06 12 34 56 78.");

    await erasePerson(getDatabase(), person, true);

    const texts = await getDatabase()
      .select({
        id: messages.id,
        text: messages.bodyText,
        sender: messages.sender,
        raw: messages.raw,
      })
      .from(messages);
    expect(texts.find((row) => row.id === own.messageId)).toEqual({
      id: own.messageId,
      text: erasedText,
      sender: "erased",
      raw: {},
    });
    expect(texts.filter((row) => row.text === erasedText)).toHaveLength(2);
    expect(texts.find((row) => row.id === other.messageId)?.text).toBe("Le CRM est lent.");
    const [erasedRequest, otherRequest] = await getDatabase()
      .select()
      .from(requests)
      .orderBy(requests.number);
    expect(erasedRequest).toMatchObject({
      title: "Demande effacée à la demande de la personne",
      summary: null,
      description: null,
      status: "NEW",
      type: "BUG",
    });
    expect(otherRequest?.title).toBe("Titre de chloe.durand@initech.example");
    const [created] = await getDatabase()
      .select({ data: events.data })
      .from(events)
      .where(eq(events.requestId, erasedRequest?.id ?? ""));
    expect(created?.data).toEqual({ status: "NEW" });
    expect(await getDatabase().select().from(attachments)).toEqual([]);
    const [contact] = await getDatabase()
      .select()
      .from(contacts)
      .where(eq(contacts.id, erasedRequest?.requesterContactId ?? ""));
    expect(contact).toMatchObject({ name: null, slackUserId: null });
    expect(contact?.email).toMatch(/^erased-.+@erased\.invalid$/);
    expect(contact?.disabledAt).not.toBeNull();
  });

  it("removes a question asked to the person from the history", async () => {
    const messageId = await storeMessage(getDatabase(), { sender: alice, bodyText: "Ça bloque." });
    const turn = classified(
      await prepareTurn(getAppDatabase(), { messageId, trust: "VERIFIED", channelAddress: null }),
    );
    await requestClarification(getAppDatabase(), turn, {
      question: "Alice, quel est votre login ?",
    });

    await erasePerson(getDatabase(), personInput.parse({ email: alice }), true);

    const asked = await getDatabase()
      .select({ data: events.data })
      .from(events)
      .where(eq(events.type, "CLARIFICATION_REQUESTED"));
    expect(asked).toEqual([{ data: {} }]);
  });

  it("erases the messages of a sender who is no contact, by their address", async () => {
    const messageId = await storeMessage(getDatabase(), {
      sender: "someone@unknown.example",
      bodyText: "Je m'appelle Jean Dupont.",
    });

    const erased = await erasePerson(
      getDatabase(),
      personInput.parse({ email: "someone@unknown.example" }),
      true,
    );

    expect(erased).toMatchObject({ ok: true, value: { contact: false, messages: 1 } });
    const [row] = await getDatabase()
      .select({ text: messages.bodyText })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(row?.text).toBe(erasedText);
  });

  it("closes a message being handled, so the agent cannot file its text after the erasure", async () => {
    const messageId = await storeMessage(getDatabase(), {
      sender: bruno,
      bodyText: "Mon numéro est le 06 12 34 56 78.",
    });
    // The agent read the message before the erasure, and files it after.
    const turn = classified(
      await prepareTurn(getAppDatabase(), { messageId, trust: "VERIFIED", channelAddress: null }),
      { title: "Numéro de Bruno" },
    );

    await erasePerson(getDatabase(), personInput.parse({ email: bruno }), true);

    await expect(createRequest(getAppDatabase(), turn, { projectKey: "PORTAL" })).rejects.toThrow(
      /closed while the agent handled it/,
    );
    expect(await getDatabase().select().from(requests)).toEqual([]);
    const [row] = await getDatabase()
      .select({ handledAt: messages.handledAt })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(row?.handledAt).not.toBeNull();
  });

  it("empties the original payloads of the conversations of the person, and keeps the others' text", async () => {
    const own = await storeMessage(getDatabase(), {
      sender: bruno,
      bodyText: "Bonjour",
      thread: "t-shared",
    });
    const colleague = await storeMessage(getDatabase(), {
      sender: "claire@globex.example",
      bodyText: "Je confirme ce que dit Bruno.",
      thread: "t-shared",
    });
    await getDatabase()
      .update(messages)
      .set({ raw: { source: "Bruno a écrit : 06 12 34 56 78" }, handledAt: new Date() })
      .where(eq(messages.id, colleague));

    await erasePerson(getDatabase(), personInput.parse({ email: bruno }), true);

    const rows = await getDatabase()
      .select({ id: messages.id, raw: messages.raw, text: messages.bodyText })
      .from(messages);
    expect(rows.find((row) => row.id === colleague)).toEqual({
      id: colleague,
      raw: {},
      text: "Je confirme ce que dit Bruno.",
    });
    expect(rows.find((row) => row.id === own)?.text).toBe(erasedText);
  });

  it("refuses to erase the contact of an account of the team", async () => {
    await saveStaffAccount(getAppDatabase(), {
      email: "dana.support@team.example",
      name: "Dana",
      password: "a long staff password",
    });

    expect(
      await erasePerson(
        getDatabase(),
        personInput.parse({ email: "dana.support@team.example" }),
        true,
      ),
    ).toEqual({ ok: false, error: "STAFF_ACCOUNT" });
  });

  it("keeps the history append-only outside an erasure, even for the owner", async () => {
    await requestOf(bruno, "Le portail plante.", "t-1");

    await expect(getDatabase().execute(sql`update events set data = '{}'`)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
    await expect(getDatabase().execute(sql`delete from events`)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only") },
    });
  });

  it("needs exactly one way to name the person", () => {
    expect(personInput.safeParse({}).success).toBe(false);
    expect(personInput.safeParse({ email: bruno, slackUserId: "U0BRUNO" }).success).toBe(false);
  });
});

describe("purgeOldData", () => {
  it("deletes old sessions and old sources, and keeps the recent ones and the texts", async () => {
    const contactId = await saveStaffAccount(getAppDatabase(), {
      email: "dana.support@team.example",
      name: "Dana",
      password: "a long staff password",
    });
    const now = new Date("2026-11-19T12:00:00Z");
    await openSession(getAppDatabase(), contactId, new Date("2026-08-01T08:00:00Z"));
    await openSession(getAppDatabase(), contactId, now);
    const oldMessage = await storeMessage(getDatabase(), { sender: bruno, bodyText: "Ancien" });
    const recentMessage = await storeMessage(getDatabase(), { sender: bruno, bodyText: "Récent" });
    await getDatabase()
      .update(messages)
      .set({ raw: { source: "…" }, handledAt: now, receivedAt: new Date("2025-01-01T00:00:00Z") })
      .where(eq(messages.id, oldMessage));
    await getDatabase()
      .update(messages)
      .set({ raw: { source: "…" }, handledAt: now })
      .where(eq(messages.id, recentMessage));

    const purged = await purgeOldData(getDatabase(), { sourceRetentionDays: 365, now });

    expect(purged).toEqual({ sessions: 1, sources: 1 });
    expect(await getDatabase().select().from(staffSessions)).toHaveLength(1);
    const rows = await getDatabase()
      .select({ id: messages.id, raw: messages.raw, text: messages.bodyText })
      .from(messages);
    expect(rows.find((row) => row.id === oldMessage)).toMatchObject({ raw: {}, text: "Ancien" });
    expect(rows.find((row) => row.id === recentMessage)?.raw).toEqual({ source: "…" });
  });

  it("empties the payload of old answers, which name their recipient", async () => {
    const now = new Date("2026-11-19T12:00:00Z");
    await storeMessage(getDatabase(), { sender: bruno, bodyText: "Question", thread: "t-old" });
    await storeOutboundMessage(getAppDatabase(), {
      channel: "EMAIL",
      conversationExternalId: "t-old",
      externalId: "<old-answer@requests.example>",
      sender: "agent@requests.example",
      bodyText: "Réponse",
      raw: { to: bruno },
      sentAt: new Date("2025-01-01T00:00:00Z"),
    });
    await getDatabase()
      .update(messages)
      .set({ receivedAt: new Date("2025-01-01T00:00:00Z") })
      .where(eq(messages.direction, "OUTBOUND"));

    await purgeOldData(getDatabase(), { sourceRetentionDays: 365, now });

    const [answer] = await getDatabase()
      .select({ raw: messages.raw, text: messages.bodyText })
      .from(messages)
      .where(eq(messages.direction, "OUTBOUND"));
    expect(answer).toEqual({ raw: {}, text: "Réponse" });
  });
});
