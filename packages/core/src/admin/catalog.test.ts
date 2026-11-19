import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { contacts, projects } from "../db/schema.ts";
import { seedDatabase } from "../db/seed.ts";
import {
  addChannelLink,
  channelLinkInput,
  listChannelLinks,
  listOrganizations,
  listProjectRows,
  organizationInput,
  projectInput,
  removeChannelLink,
  saveOrganization,
  saveProject,
  setOrganizationArchived,
  setProjectArchived,
} from "./catalog.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

beforeEach(async () => {
  await seedDatabase(getDatabase());
});

async function organizationId(name: string): Promise<string> {
  const found = (await listOrganizations(getAppDatabase())).find((row) => row.name === name);
  if (found === undefined) {
    throw new Error(`No organization ${name}`);
  }
  return found.id;
}

describe("organizations", () => {
  it("lists the clients with their number of projects and contacts", async () => {
    const rows = await listOrganizations(getAppDatabase());

    expect(rows.find((row) => row.name === "Acme")).toMatchObject({
      emailDomain: "acme.example",
      archived: false,
      projects: 2,
    });
  });

  it("creates and changes a client, and refuses a domain already used", async () => {
    const created = await saveOrganization(
      getAppDatabase(),
      organizationInput.parse({ name: " Umbrella ", emailDomain: "Umbrella.Example" }),
    );
    expect(created.ok).toBe(true);
    const id = await organizationId("Umbrella");

    expect(
      await saveOrganization(
        getAppDatabase(),
        organizationInput.parse({ name: "Umbrella Corp", emailDomain: "" }),
        id,
      ),
    ).toEqual({ ok: true, value: id });
    expect(
      await saveOrganization(
        getAppDatabase(),
        organizationInput.parse({ name: "Copie", emailDomain: "acme.example" }),
      ),
    ).toEqual({ ok: false, error: "DOMAIN_TAKEN" });
  });

  it("refuses a domain that is not one", () => {
    expect(organizationInput.safeParse({ name: "X", emailDomain: "not a domain" }).success).toBe(
      false,
    );
  });

  it("archives a client with its projects, and disables its contacts", async () => {
    const acme = await organizationId("Acme");

    expect(await setOrganizationArchived(getAppDatabase(), acme, true)).toEqual({
      ok: true,
      value: null,
    });

    const archived = await getDatabase()
      .select({ key: projects.key, archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.organizationId, acme));
    expect(archived.every((row) => row.archivedAt !== null)).toBe(true);
    const people = await getDatabase()
      .select({ disabledAt: contacts.disabledAt })
      .from(contacts)
      .where(eq(contacts.organizationId, acme));
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((row) => row.disabledAt !== null)).toBe(true);
    expect(
      (await listOrganizations(getAppDatabase())).find((row) => row.id === acme),
    ).toMatchObject({
      archived: true,
    });
  });
});

describe("projects", () => {
  it("creates a project for a client, changes it and archives it", async () => {
    const acme = await organizationId("Acme");
    const created = await saveProject(
      getAppDatabase(),
      projectInput.parse({ key: "erp", name: "ERP", description: "", organizationId: acme }),
    );
    if (!created.ok) {
      throw new Error(created.error);
    }

    expect(
      await saveProject(
        getAppDatabase(),
        projectInput.parse({ key: "ERP", name: "ERP Acme", organizationId: "" }),
        created.value,
      ),
    ).toEqual({ ok: true, value: created.value });
    await setProjectArchived(getAppDatabase(), created.value, true);

    expect((await listProjectRows(getAppDatabase())).find((row) => row.key === "ERP")).toEqual({
      id: created.value,
      key: "ERP",
      name: "ERP Acme",
      description: null,
      organizationId: null,
      organization: null,
      archived: true,
    });
  });

  it("refuses a key already used or not a short code", async () => {
    expect(
      await saveProject(getAppDatabase(), projectInput.parse({ key: "shop", name: "Autre" })),
    ).toEqual({ ok: false, error: "KEY_TAKEN" });
    expect(projectInput.safeParse({ key: "S", name: "Trop court" }).success).toBe(false);
  });
});

describe("channel links", () => {
  it("links a channel to a project, lists it, refuses it twice, and removes it", async () => {
    const [shop] = await getDatabase().select().from(projects).where(eq(projects.key, "SHOP"));
    const input = channelLinkInput.parse({
      projectId: shop?.id,
      channel: "EMAIL",
      externalId: " Shop-Support@Acme.example ",
    });

    const added = await addChannelLink(getAppDatabase(), input);
    if (!added.ok) {
      throw new Error(added.error);
    }

    expect(
      (await listChannelLinks(getAppDatabase())).find((row) => row.id === added.value),
    ).toEqual({
      id: added.value,
      projectKey: "SHOP",
      channel: "EMAIL",
      externalId: "shop-support@acme.example",
    });
    expect(await addChannelLink(getAppDatabase(), input)).toEqual({
      ok: false,
      error: "ALREADY_LINKED",
    });
    expect(await removeChannelLink(getAppDatabase(), added.value)).toEqual({
      ok: true,
      value: null,
    });
    expect(await removeChannelLink(getAppDatabase(), added.value)).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });

  it("refuses an email channel without an email address", () => {
    expect(
      channelLinkInput.safeParse({
        projectId: "00000000-0000-4000-8000-000000000000",
        channel: "EMAIL",
        externalId: "support",
      }).success,
    ).toBe(false);
  });
});
