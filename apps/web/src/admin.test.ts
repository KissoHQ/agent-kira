import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachments,
  listChannelLinks,
  listContactRows,
  listOrganizations,
  listProjectRows,
  listStaff,
  listStoredFiles,
  saveStaffAccount,
} from "@request-agent/core";
import {
  bruno,
  seedDatabase,
  storeMessage,
  useAppTestDatabase,
  useTestDatabase,
} from "@request-agent/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { createWebApp } from "./app.ts";
import { emailLimits } from "./sign-in-limiter.ts";

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

  it("keeps the key of a project, and refuses a client that does not exist", async () => {
    const cookie = await signIn(admin);
    const shop = (await listProjectRows(getAppDatabase())).find((row) => row.key === "SHOP");

    const renamed = await post(
      `/admin/projects/${shop?.id}`,
      { key: "SHOP2", name: "Boutique" },
      cookie,
    );
    const unknownClient = await post(
      "/admin/projects",
      { key: "NEW", name: "Nouveau", organizationId: "00000000-0000-4000-8000-000000000000" },
      cookie,
    );

    expect(renamed.status).toBe(409);
    expect(await renamed.text()).toContain("Le code d&#39;un projet ne change pas");
    expect((await listProjectRows(getAppDatabase())).map((row) => row.key)).toContain("SHOP");
    expect(unknownClient.status).toBe(409);
    expect(await unknownClient.text()).toContain("Ce client n&#39;existe plus.");
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

  it("neither lists nor changes the accounts of the team, which their own page manages", async () => {
    const cookie = await signIn(admin);
    const dana = (await listStaff(getAppDatabase())).find((row) => row.email === member);

    const page = await (await get("/admin/contacts", cookie)).text();
    const edited = await post(
      `/admin/contacts/${dana?.contactId}`,
      { email: "", slackUserId: "U0DANA", name: "Dana" },
      cookie,
    );
    const disabled = await post(
      `/admin/contacts/${dana?.contactId}/disable`,
      { disabled: "true" },
      cookie,
    );

    expect(page).not.toContain(member);
    expect(edited.status).toBe(409);
    expect(await edited.text()).toContain("compte de l&#39;équipe");
    expect(disabled.status).toBe(409);
    expect((await post("/login", { email: member, password })).status).toBe(303);
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
      { email: "fred@team.example", name: "Fred", role: "MEMBER", password, confirm: password },
      cookie,
    );
    const fred = (await listStaff(getAppDatabase())).find(
      (row) => row.email === "fred@team.example",
    );
    await post(
      `/admin/staff/${fred?.contactId}/role`,
      { role: "ADMIN", confirm: password },
      cookie,
    );
    await post(
      `/admin/staff/${fred?.contactId}/disable`,
      { disabled: "true", confirm: password },
      cookie,
    );

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

    const response = await post(
      `/admin/staff/${eve?.contactId}/role`,
      { role: "MEMBER", confirm: password },
      cookie,
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Il doit rester au moins un administrateur actif.");
  });

  it("gives a new password that ends the sessions of the person", async () => {
    const adminCookie = await signIn(admin);
    const memberCookie = await signIn(member);
    const dana = (await listStaff(getAppDatabase())).find((row) => row.email === member);

    await post(
      `/admin/staff/${dana?.contactId}/password`,
      { password: "a password from the admin", confirm: password },
      adminCookie,
    );

    expect((await get("/", memberCookie)).status).toBe(303);
  });

  it("asks the own password of the administrator before any change, and limits wrong ones", async () => {
    const cookie = await signIn(admin);
    const dana = (await listStaff(getAppDatabase())).find((row) => row.email === member);
    const promote = (confirm: string) =>
      post(`/admin/staff/${dana?.contactId}/role`, { role: "ADMIN", confirm }, cookie);

    const without = await post(`/admin/staff/${dana?.contactId}/role`, { role: "ADMIN" }, cookie);
    const statuses = [];
    // The form without password was the first wrong attempt.
    for (let attempt = 1; attempt < emailLimits.maxAttempts; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      statuses.push((await promote("not my password")).status);
    }
    const blocked = await promote(password);

    expect(without.status).toBe(400);
    expect(await without.text()).toContain("Mot de passe actuel incorrect.");
    expect(statuses.every((status) => status === 400)).toBe(true);
    expect(blocked.status).toBe(429);
    expect((await listStaff(getAppDatabase())).find((row) => row.email === member)?.role).toBe(
      "MEMBER",
    );
  });

  it("changes the sign-in email of a member, which ends their sessions", async () => {
    const adminCookie = await signIn(admin);
    const memberCookie = await signIn(member);
    const dana = (await listStaff(getAppDatabase())).find((row) => row.email === member);

    const changed = await post(
      `/admin/staff/${dana?.contactId}`,
      { email: "dana@team.example", name: "Dana", confirm: password },
      adminCookie,
    );

    expect(changed.status).toBe(303);
    expect((await get("/", memberCookie)).status).toBe(303);
    expect((await post("/login", { email: "dana@team.example", password })).status).toBe(303);
  });

  it("refuses an account on the email of a person of a client", async () => {
    const cookie = await signIn(admin);

    const refused = await post(
      "/admin/staff",
      {
        email: "alice.martin@acme.example",
        name: "Alice",
        role: "ADMIN",
        password,
        confirm: password,
      },
      cookie,
    );

    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("contact d&#39;un client");
    expect((await listStaff(getAppDatabase())).map((row) => row.email)).not.toContain(
      "alice.martin@acme.example",
    );
  });

  it("logs who did what, without any password", async () => {
    const events: string[] = [];
    app = createWebApp({
      db: getAppDatabase(),
      timeZone: "Europe/Paris",
      onAudit: (event) => events.push(event),
    });
    const cookie = await signIn(admin);
    const dana = (await listStaff(getAppDatabase())).find((row) => row.email === member);

    await post(
      `/admin/staff/${dana?.contactId}/role`,
      { role: "ADMIN", confirm: password },
      cookie,
    );
    await post("/admin/organizations", { name: "Umbrella" }, cookie);

    expect(events).toContain(`Administration by "${admin}": set the role of "${member}" to ADMIN`);
    expect(events).toContain(`Administration by "${admin}": added the client "Umbrella"`);
    expect(events.join("\n")).not.toContain(password);
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

describe("files", () => {
  it("lets an administrator delete a file to free its space, and keeps its name", async () => {
    const folder = await mkdtemp(join(tmpdir(), "admin-files-"));
    const storageRef = randomUUID();
    await writeFile(join(folder, storageRef), "image");
    const messageId = await storeMessage(getDatabase(), { sender: bruno, bodyText: "Capture" });
    const [file] = await getDatabase()
      .insert(attachments)
      .values({
        messageId,
        filename: "capture.png",
        contentType: "image/png",
        sizeBytes: 5,
        storageRef,
      })
      .returning({ id: attachments.id });
    app = createWebApp({
      db: getAppDatabase(),
      timeZone: "Europe/Paris",
      attachmentsDir: folder,
      attachmentRetentionDays: 30,
    });
    const cookie = await signIn(admin);

    const listed = await (await get("/admin/files", cookie)).text();
    const deleted = await post(`/admin/files/${file?.id}/delete`, {}, cookie);
    const again = await post(`/admin/files/${file?.id}/delete`, {}, cookie);

    expect(listed).toContain("capture.png");
    expect(listed).toContain("1 fichiers joints gardés sur le serveur");
    // The page says the retention the purge uses, as set in ATTACHMENT_RETENTION_DAYS.
    expect(listed).toContain("supprimés automatiquement 30 jours");
    expect(deleted.headers.get("location")).toBe("/admin/files?done=deleted");
    expect(again.status).toBe(404);
    expect(await readdir(folder)).toEqual([]);
    expect((await listStoredFiles(getAppDatabase(), 1)).total).toBe(0);
    expect((await get(`/attachments/${file?.id}`, cookie)).status).toBe(404);
  });

  it("is refused to a member", async () => {
    const cookie = await signIn(member);

    expect((await get("/admin/files", cookie)).status).toBe(403);
  });
});
