import {
  listChannelLinks,
  listContactRows,
  listOrganizations,
  listProjectRows,
  listStaff,
  saveStaffAccount,
} from "@request-agent/core";
import { seedDatabase, useAppTestDatabase, useTestDatabase } from "@request-agent/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { createWebApp } from "./app.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

const password = "a long staff password";
const admin = "eve.admin@team.example";
const member = "dana.support@team.example";
const origin = "http://localhost";

let app: ReturnType<typeof createWebApp>;

beforeEach(async () => {
  await seedDatabase(getDatabase());
  await saveStaffAccount(getAppDatabase(), { email: admin, name: "Eve", password, role: "ADMIN" });
  await saveStaffAccount(getAppDatabase(), { email: member, name: "Dana", password });
  app = createWebApp({ db: getAppDatabase(), timeZone: "Europe/Paris" });
});

async function post(
  path: string,
  fields: Record<string, string | string[]>,
  cookie = "",
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      body.append(name, item);
    }
  }
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body,
  });
}

async function signIn(email: string): Promise<string> {
  const response = await post("/login", { email, password });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) {
    throw new Error("No session cookie");
  }
  return cookie;
}

const get = async (path: string, cookie: string) => app.request(path, { headers: { cookie } });

describe("access to the administration", () => {
  it("is refused to a member, who sees no link to it", async () => {
    const cookie = await signIn(member);

    const page = await (await get("/", cookie)).text();
    const refused = await get("/admin/organizations", cookie);
    const action = await post("/admin/organizations", { name: "Intrus" }, cookie);

    expect(page).not.toContain("Administration");
    expect(refused.status).toBe(403);
    expect(action.status).toBe(403);
    expect((await listOrganizations(getAppDatabase())).map((row) => row.name)).not.toContain(
      "Intrus",
    );
  });

  it("is open to an administrator, with a link in the navigation", async () => {
    const cookie = await signIn(admin);

    expect(await (await get("/", cookie)).text()).toContain('href="/admin/organizations"');
    expect((await get("/admin/organizations", cookie)).status).toBe(200);
  });
});

describe("clients, projects and channels", () => {
  it("creates a client and its project, links a channel, then archives the client", async () => {
    const cookie = await signIn(admin);

    const created = await post(
      "/admin/organizations",
      { name: "Umbrella", emailDomain: "umbrella.example" },
      cookie,
    );
    const umbrella = (await listOrganizations(getAppDatabase())).find(
      (row) => row.name === "Umbrella",
    );
    await post(
      "/admin/projects",
      { key: "lab", name: "Laboratoire", description: "", organizationId: umbrella?.id ?? "" },
      cookie,
    );
    const lab = (await listProjectRows(getAppDatabase())).find((row) => row.key === "LAB");
    await post(
      "/admin/channels",
      { projectId: lab?.id ?? "", channel: "SLACK", externalId: "C0LAB" },
      cookie,
    );
    await post(`/admin/organizations/${umbrella?.id}/archive`, { archived: "true" }, cookie);

    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/admin/organizations?done=added");
    expect(lab).toMatchObject({ name: "Laboratoire", organization: "Umbrella" });
    expect(await listChannelLinks(getAppDatabase())).toContainEqual(
      expect.objectContaining({ projectKey: "LAB", channel: "SLACK", externalId: "C0LAB" }),
    );
    expect(
      (await listProjectRows(getAppDatabase())).find((row) => row.key === "LAB"),
    ).toMatchObject({
      archived: true,
    });
    const page = await (await get("/admin/organizations?done=archived", cookie)).text();
    expect(page).toContain("Archivage mis à jour.");
  });

  it("refuses a project key already taken, and a form that is not valid", async () => {
    const cookie = await signIn(admin);

    const taken = await post("/admin/projects", { key: "SHOP", name: "Autre" }, cookie);
    const invalid = await post("/admin/projects", { key: "x", name: "" }, cookie);

    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain("un autre projet");
    expect(invalid.status).toBe(400);
  });
});

describe("contacts", () => {
  it("changes the projects of a contact and disables them", async () => {
    const cookie = await signIn(admin);
    const alice = (await listContactRows(getAppDatabase())).find(
      (row) => row.email === "alice.martin@acme.example",
    );
    const shop = (await listProjectRows(getAppDatabase())).find((row) => row.key === "SHOP");

    const edited = await post(
      `/admin/contacts/${alice?.id}`,
      {
        email: "alice.martin@acme.example",
        name: "Alice Martin",
        organizationId: alice?.organizationId ?? "",
        projectIds: [shop?.id ?? ""],
      },
      cookie,
    );
    await post(`/admin/contacts/${alice?.id}/disable`, { disabled: "true" }, cookie);

    expect(edited.status).toBe(303);
    expect(
      (await listContactRows(getAppDatabase())).find((row) => row.id === alice?.id),
    ).toMatchObject({ projectKeys: ["SHOP"], disabled: true });
  });

  it("adds a Slack contact with no email", async () => {
    const cookie = await signIn(admin);

    await post("/admin/contacts", { name: "Emma Petit", slackUserId: "U0EMMA", email: "" }, cookie);

    const emma = (await listContactRows(getAppDatabase())).find(
      (row) => row.slackUserId === "U0EMMA",
    );
    expect(emma).toMatchObject({ name: "Emma Petit", email: null });
  });
});

describe("accounts of the team", () => {
  it("creates an account, makes it administrator, then disables it", async () => {
    const cookie = await signIn(admin);

    await post(
      "/admin/staff",
      { email: "fred@team.example", name: "Fred", role: "MEMBER", password },
      cookie,
    );
    const fred = (await listStaff(getAppDatabase())).find(
      (row) => row.email === "fred@team.example",
    );
    await post(`/admin/staff/${fred?.contactId}/role`, { role: "ADMIN" }, cookie);
    await post(`/admin/staff/${fred?.contactId}/disable`, { disabled: "true" }, cookie);

    expect(
      (await listStaff(getAppDatabase())).find((row) => row.email === "fred@team.example"),
    ).toMatchObject({
      role: "ADMIN",
      disabled: true,
    });
  });

  it("keeps the last administrator", async () => {
    const cookie = await signIn(admin);
    const eve = (await listStaff(getAppDatabase())).find((row) => row.email === admin);

    const response = await post(`/admin/staff/${eve?.contactId}/role`, { role: "MEMBER" }, cookie);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Il doit rester au moins un administrateur actif.");
  });

  it("gives a new password that ends the sessions of the person", async () => {
    const adminCookie = await signIn(admin);
    const memberCookie = await signIn(member);
    const dana = (await listStaff(getAppDatabase())).find((row) => row.email === member);

    await post(
      `/admin/staff/${dana?.contactId}/password`,
      { password: "a password from the admin" },
      adminCookie,
    );

    expect((await get("/", memberCookie)).status).toBe(303);
  });
});

describe("own account", () => {
  it("lets a member change their password with the current one", async () => {
    const cookie = await signIn(member);

    const wrong = await post(
      "/account/password",
      { current: "not the password", password: "a brand new password" },
      cookie,
    );
    const changed = await post(
      "/account/password",
      { current: password, password: "a brand new password" },
      cookie,
    );

    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Mot de passe actuel incorrect.");
    expect(changed.headers.get("location")).toBe("/account?done=password");
    expect((await get("/", cookie)).status).toBe(200);
    expect((await post("/login", { email: member, password: "a brand new password" })).status).toBe(
      303,
    );
  });
});
