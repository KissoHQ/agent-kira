import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { useAppTestDatabase, useServerTestDatabase, useTestDatabase } from "../../test/database.ts";
import { scramVerifier } from "./app-role.ts";
import {
  contacts,
  conversations,
  events,
  messages,
  organizations,
  projectChannels,
  projectContacts,
  requests,
  staffAccounts,
  staffSessions,
} from "./schema.ts";

useTestDatabase();
const getAppDatabase = useAppTestDatabase();
const getServerDatabase = useServerTestDatabase();

const permissionDenied = { cause: { code: "42501" } };

async function insertRequestWithEvent() {
  const db = getAppDatabase();
  const [request] = await db
    .insert(requests)
    .values({ type: "BUG", title: "Paiement en échec", sourceChannel: "EMAIL" })
    .returning();
  if (request === undefined) {
    throw new Error("The request was not inserted");
  }
  await db.insert(events).values({ requestId: request.id, type: "CREATED", actorType: "AGENT" });
  return request;
}

describe("application role", () => {
  it("reads, adds and updates rows", async () => {
    const db = getAppDatabase();
    const request = await insertRequestWithEvent();

    const [updated] = await db
      .update(requests)
      .set({ priority: "HIGH" })
      .where(eq(requests.id, request.id))
      .returning();

    expect(request.number).toBe(1);
    expect(updated?.priority).toBe("HIGH");
    expect(await db.select().from(events)).toHaveLength(1);
  });

  it("cannot delete rows", async () => {
    await insertRequestWithEvent();

    await expect(getAppDatabase().delete(requests)).rejects.toMatchObject(permissionDenied);
    await expect(getAppDatabase().delete(organizations)).rejects.toMatchObject(permissionDenied);
  });

  it("can remove who works on a project and which channel leads to it, which are settings", async () => {
    await expect(getAppDatabase().delete(projectContacts)).resolves.toBeDefined();
    await expect(getAppDatabase().delete(projectChannels)).resolves.toBeDefined();
  });

  it("cannot rewrite the history", async () => {
    await insertRequestWithEvent();

    await expect(getAppDatabase().update(events).set({ data: {} })).rejects.toMatchObject(
      permissionDenied,
    );
  });

  it("cannot change the schema or empty a table", async () => {
    const db = getAppDatabase();

    await expect(db.execute(sql`truncate requests cascade`)).rejects.toMatchObject(
      permissionDenied,
    );
    await expect(db.execute(sql`create table intruder (id int)`)).rejects.toMatchObject(
      permissionDenied,
    );
    await expect(
      db.execute(sql`alter table requests add column intruder int`),
    ).rejects.toMatchObject(permissionDenied);
  });
});

describe("role of the agent server", () => {
  it("stores a message and files a request, as the agent does", async () => {
    const db = getServerDatabase();
    const [conversation] = await db
      .insert(conversations)
      .values({ channel: "EMAIL", externalId: "<thread@acme.example>" })
      .returning();
    const [message] = await db
      .insert(messages)
      .values({
        conversationId: conversation?.id ?? "",
        channel: "EMAIL",
        externalId: "<1@acme.example>",
        direction: "INBOUND",
        sender: "alice@acme.example",
        bodyText: "Le panier se vide.",
        raw: {},
        sentAt: new Date(),
      })
      .returning();
    const [request] = await db
      .insert(requests)
      .values({ type: "BUG", title: "Panier vide", sourceChannel: "EMAIL" })
      .returning();

    await db
      .update(messages)
      .set({ requestId: request?.id, handledAt: new Date() })
      .where(eq(messages.id, message?.id ?? ""));
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it("can neither read nor write the accounts and sessions of the team", async () => {
    const db = getServerDatabase();

    await expect(db.select().from(staffAccounts)).rejects.toMatchObject(permissionDenied);
    await expect(db.select().from(staffSessions)).rejects.toMatchObject(permissionDenied);
    await expect(
      db.insert(contacts).values({ email: "intruder@evil.example" }),
    ).rejects.toMatchObject(permissionDenied);
  });

  it("cannot change what a message said, nor delete anything", async () => {
    const db = getServerDatabase();

    await expect(db.update(messages).set({ bodyText: "réécrit" })).rejects.toMatchObject(
      permissionDenied,
    );
    await expect(db.update(messages).set({ raw: {} })).rejects.toMatchObject(permissionDenied);
    await expect(db.delete(messages)).rejects.toMatchObject(permissionDenied);
    await expect(db.delete(projectContacts)).rejects.toMatchObject(permissionDenied);
    await expect(db.update(organizations).set({ name: "x" })).rejects.toMatchObject(
      permissionDenied,
    );
  });
});

describe("scramVerifier", () => {
  it("gives the verifier of RFC 7677, which never contains the password", () => {
    const verifier = scramVerifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));

    // The example exchange of RFC 7677, section 3: the stored and server keys of "pencil".
    expect(verifier).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
    expect(scramVerifier("pencil")).not.toContain("pencil");
  });
});
