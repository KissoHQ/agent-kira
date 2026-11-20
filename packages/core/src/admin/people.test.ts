import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { alice, storeMessage } from "../../test/fixtures.ts";
import { projects } from "../db/schema.ts";
import { seedDatabase } from "../db/seed.ts";
import { prepareTurn } from "../requests/turn.ts";
import { saveStaffAccount, staffAccountInput } from "../staff/accounts.ts";
import {
  contactAdminInput,
  listContactRows,
  saveContactRow,
  setContactDisabled,
} from "./people.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

beforeEach(async () => {
  await seedDatabase(getDatabase());
});

async function projectId(key: string): Promise<string> {
  const [row] = await getDatabase().select().from(projects).where(eq(projects.key, key));
  if (row === undefined) {
    throw new Error(`No project ${key}`);
  }
  return row.id;
}

async function aliceRow() {
  const row = (await listContactRows(getAppDatabase())).find((contact) => contact.email === alice);
  if (row === undefined) {
    throw new Error("No Alice");
  }
  return row;
}

describe("contacts", () => {
  it("lists the contacts with their client and projects", async () => {
    expect(await aliceRow()).toMatchObject({
      name: "Alice Martin",
      organization: "Acme",
      projectKeys: ["CRM", "SHOP"],
      disabled: false,
    });
  });

  it("creates a Slack contact, then sets exactly the projects given", async () => {
    const created = await saveContactRow(
      getAppDatabase(),
      contactAdminInput.parse({
        name: "Emma Petit",
        slackUserId: "u0emma",
        projectIds: [await projectId("SHOP"), await projectId("CRM")],
      }),
    );
    if (!created.ok) {
      throw new Error(created.error);
    }

    await saveContactRow(
      getAppDatabase(),
      contactAdminInput.parse({
        name: "Emma Petit",
        slackUserId: "U0EMMA",
        projectIds: [await projectId("SHOP")],
      }),
      created.value,
    );

    const emma = (await listContactRows(getAppDatabase())).find((row) => row.id === created.value);
    expect(emma).toMatchObject({ slackUserId: "U0EMMA", email: null, projectKeys: ["SHOP"] });
  });

  it("removes a project from a contact, who then no longer works on it", async () => {
    const before = await aliceRow();

    await saveContactRow(
      getAppDatabase(),
      contactAdminInput.parse({
        email: alice,
        name: "Alice Martin",
        organizationId: before.organizationId,
        projectIds: [await projectId("SHOP")],
      }),
      before.id,
    );

    const messageId = await storeMessage(getDatabase(), { sender: alice, bodyText: "Bonjour" });
    const turn = await prepareTurn(getAppDatabase(), {
      messageId,
      trust: "VERIFIED",
      channelAddress: null,
    });
    expect(turn.actor).toEqual({
      kind: "contact",
      contactId: before.id,
      projectIds: [await projectId("SHOP")],
    });
  });

  it("refuses a contact without identity, an identity already used or an unknown project", async () => {
    expect(contactAdminInput.safeParse({ name: "Personne" }).success).toBe(false);
    expect(
      await saveContactRow(getAppDatabase(), contactAdminInput.parse({ email: alice })),
    ).toEqual({ ok: false, error: "IDENTITY_TAKEN" });
    expect(
      await saveContactRow(
        getAppDatabase(),
        contactAdminInput.parse({
          email: "new@acme.example",
          projectIds: ["00000000-0000-4000-8000-000000000000"],
        }),
      ),
    ).toEqual({ ok: false, error: "UNKNOWN_PROJECT" });
  });

  it("leaves the accounts of the team to the page of the team", async () => {
    const { id } = await aliceRow();
    await saveStaffAccount(
      getDatabase(),
      staffAccountInput.parse({ email: alice, name: "Alice Martin", password: "a long password!" }),
    );

    expect((await listContactRows(getAppDatabase())).map((row) => row.email)).not.toContain(alice);
    expect(
      await saveContactRow(
        getAppDatabase(),
        contactAdminInput.parse({ slackUserId: "U0ALICE" }),
        id,
      ),
    ).toEqual({ ok: false, error: "STAFF_ACCOUNT" });
    expect(await setContactDisabled(getAppDatabase(), id, true)).toEqual({
      ok: false,
      error: "STAFF_ACCOUNT",
    });
  });

  it("refuses a client that does not exist, without failing", async () => {
    expect(
      await saveContactRow(
        getAppDatabase(),
        contactAdminInput.parse({
          email: "new@acme.example",
          organizationId: "00000000-0000-4000-8000-000000000000",
        }),
      ),
    ).toEqual({ ok: false, error: "UNKNOWN_ORGANIZATION" });
  });

  it("disables and enables a contact", async () => {
    const { id } = await aliceRow();

    await setContactDisabled(getAppDatabase(), id, true);
    expect((await aliceRow()).disabled).toBe(true);
    await setContactDisabled(getAppDatabase(), id, false);
    expect((await aliceRow()).disabled).toBe(false);
    expect(
      await setContactDisabled(getAppDatabase(), "00000000-0000-4000-8000-000000000000", true),
    ).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });
});
