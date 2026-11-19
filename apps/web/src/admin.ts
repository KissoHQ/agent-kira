import {
  addChannelLink,
  changeOwnPassword,
  channelLinkInput,
  contactAdminInput,
  type Database,
  listChannelLinks,
  listContactRows,
  listOrganizations,
  listProjectRows,
  listStaff,
  organizationInput,
  passwordInput,
  projectInput,
  removeChannelLink,
  saveContactRow,
  saveOrganization,
  saveProject,
  saveStaffAccount,
  setContactDisabled,
  setOrganizationArchived,
  setProjectArchived,
  setStaffDisabled,
  setStaffPassword,
  setStaffRole,
  staffAccountInput,
} from "@request-agent/core";
import type { Context, Hono } from "hono";
import { z } from "zod";

import {
  accountPage,
  channelsPage,
  contactPage,
  contactsPage,
  type Feedback,
  forbiddenPage,
  organizationPage,
  organizationsPage,
  projectPage,
  projectsPage,
  staffMemberPage,
  staffPage,
} from "./views/admin.ts";
import type { Fragment, ViewContext } from "./views/layout.ts";

import type { WebEnv as AdminEnv } from "./app.ts";

type Status = 200 | 400 | 403 | 404 | 409;

export interface AdminDependencies {
  db: Database;
  view: (c: Context<AdminEnv>) => ViewContext;
  render: (
    c: Context<AdminEnv>,
    fragment: Fragment,
    status: Status,
  ) => Response | Promise<Response>;
}

const notices = {
  saved: "Modification enregistrée.",
  archived: "Archivage mis à jour.",
  disabled: "État du compte mis à jour.",
  added: "Ajout enregistré.",
  removed: "Canal retiré.",
  password: "Mot de passe changé.",
} as const;
type Notice = keyof typeof notices;
const isNotice = (value: string): value is Notice => Object.hasOwn(notices, value);

const errors = {
  DOMAIN_TAKEN: "Ce domaine est déjà celui d'un autre client.",
  KEY_TAKEN: "Ce code est déjà celui d'un autre projet.",
  IDENTITY_TAKEN: "Cet e-mail ou cet identifiant Slack est déjà celui d'un autre contact.",
  UNKNOWN_PROJECT: "Un des projets n'existe plus.",
  ALREADY_LINKED: "Ce canal mène déjà à un projet.",
  LAST_ADMIN: "Il doit rester au moins un administrateur actif.",
  NOT_FOUND: "Élément introuvable.",
  WRONG_PASSWORD: "Mot de passe actuel incorrect.",
  INVALID: "Valeurs invalides : vérifiez le formulaire.",
} as const;
type ErrorCode = keyof typeof errors;

const id = z.uuid();
const flag = z.enum(["true", "false"]).transform((value) => value === "true");

// The fields of a form, a repeated field such as checkboxes kept as a list.
async function formOf(c: Context<AdminEnv>): Promise<Record<string, string | string[]>> {
  const body = await c.req.parseBody({ all: true });
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === "string") {
      fields[name] = value;
    } else if (Array.isArray(value)) {
      fields[name] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return fields;
}

const listOf = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

// After an action, the browser goes back to the list, so reloading does not repeat it.
const done = (c: Context<AdminEnv>, path: string, notice: Notice) =>
  c.redirect(`${path}?done=${notice}`, 303);

const feedbackOf = (c: Context<AdminEnv>): Feedback => {
  const notice = c.req.query("done");
  return notice !== undefined && isNotice(notice) ? { notice: notices[notice] } : {};
};

const failure = (code: ErrorCode): Feedback => ({ error: errors[code] });

const contactFields = (form: Record<string, string | string[]>) => ({
  ...form,
  projectIds: listOf(form.projectIds),
});

export function registerAdministration(app: Hono<AdminEnv>, deps: AdminDependencies): void {
  const { db } = deps;

  // Only administrators reach these pages.
  app.use("/admin/*", async (c, next) => {
    if (c.get("staff").role !== "ADMIN") {
      return deps.render(c, forbiddenPage(deps.view(c)), 403);
    }
    return next();
  });

  // Clients.
  const showOrganizations = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) =>
    deps.render(c, organizationsPage(deps.view(c), await listOrganizations(db), feedback), status);
  app.get("/admin/organizations", (c) => showOrganizations(c, feedbackOf(c), 200));
  app.post("/admin/organizations", async (c) => {
    const input = organizationInput.safeParse(await formOf(c));
    if (!input.success) {
      return showOrganizations(c, failure("INVALID"), 400);
    }
    const saved = await saveOrganization(db, input.data);
    return saved.ok
      ? done(c, "/admin/organizations", "added")
      : showOrganizations(c, failure(saved.error), 409);
  });
  const showOrganization = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const row = (await listOrganizations(db)).find((org) => org.id === c.req.param("id"));
    return row === undefined
      ? showOrganizations(c, failure("NOT_FOUND"), 404)
      : deps.render(c, organizationPage(deps.view(c), row, feedback), status);
  };
  app.get("/admin/organizations/:id", (c) => showOrganization(c, {}, 200));
  app.post("/admin/organizations/:id", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const input = organizationInput.safeParse(await formOf(c));
    if (!target.success || !input.success) {
      return showOrganization(c, failure("INVALID"), 400);
    }
    const saved = await saveOrganization(db, input.data, target.data);
    return saved.ok
      ? done(c, "/admin/organizations", "saved")
      : showOrganization(c, failure(saved.error), 409);
  });
  app.post("/admin/organizations/:id/archive", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const archived = flag.safeParse((await formOf(c)).archived);
    if (!target.success || !archived.success) {
      return showOrganizations(c, failure("INVALID"), 400);
    }
    const result = await setOrganizationArchived(db, target.data, archived.data);
    return result.ok
      ? done(c, "/admin/organizations", "archived")
      : showOrganizations(c, failure(result.error), 404);
  });

  // Projects.
  const showProjects = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const [rows, organizations] = await Promise.all([listProjectRows(db), listOrganizations(db)]);
    return deps.render(c, projectsPage(deps.view(c), rows, organizations, feedback), status);
  };
  app.get("/admin/projects", (c) => showProjects(c, feedbackOf(c), 200));
  app.post("/admin/projects", async (c) => {
    const input = projectInput.safeParse(await formOf(c));
    if (!input.success) {
      return showProjects(c, failure("INVALID"), 400);
    }
    const saved = await saveProject(db, input.data);
    return saved.ok
      ? done(c, "/admin/projects", "added")
      : showProjects(c, failure(saved.error), 409);
  });
  const showProject = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const [rows, organizations] = await Promise.all([listProjectRows(db), listOrganizations(db)]);
    const row = rows.find((project) => project.id === c.req.param("id"));
    return row === undefined
      ? showProjects(c, failure("NOT_FOUND"), 404)
      : deps.render(c, projectPage(deps.view(c), row, organizations, feedback), status);
  };
  app.get("/admin/projects/:id", (c) => showProject(c, {}, 200));
  app.post("/admin/projects/:id", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const input = projectInput.safeParse(await formOf(c));
    if (!target.success || !input.success) {
      return showProject(c, failure("INVALID"), 400);
    }
    const saved = await saveProject(db, input.data, target.data);
    return saved.ok
      ? done(c, "/admin/projects", "saved")
      : showProject(c, failure(saved.error), 409);
  });
  app.post("/admin/projects/:id/archive", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const archived = flag.safeParse((await formOf(c)).archived);
    if (!target.success || !archived.success) {
      return showProjects(c, failure("INVALID"), 400);
    }
    const result = await setProjectArchived(db, target.data, archived.data);
    return result.ok
      ? done(c, "/admin/projects", "archived")
      : showProjects(c, failure(result.error), 404);
  });

  // Contacts.
  const showContacts = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const [rows, organizations, projects] = await Promise.all([
      listContactRows(db),
      listOrganizations(db),
      listProjectRows(db),
    ]);
    return deps.render(
      c,
      contactsPage(deps.view(c), rows, organizations, projects, feedback),
      status,
    );
  };
  app.get("/admin/contacts", (c) => showContacts(c, feedbackOf(c), 200));
  app.post("/admin/contacts", async (c) => {
    const input = contactAdminInput.safeParse(contactFields(await formOf(c)));
    if (!input.success) {
      return showContacts(c, failure("INVALID"), 400);
    }
    const saved = await saveContactRow(db, input.data);
    return saved.ok
      ? done(c, "/admin/contacts", "added")
      : showContacts(c, failure(saved.error), 409);
  });
  const showContact = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const [rows, organizations, projects] = await Promise.all([
      listContactRows(db),
      listOrganizations(db),
      listProjectRows(db),
    ]);
    const row = rows.find((contact) => contact.id === c.req.param("id"));
    return row === undefined
      ? showContacts(c, failure("NOT_FOUND"), 404)
      : deps.render(c, contactPage(deps.view(c), row, organizations, projects, feedback), status);
  };
  app.get("/admin/contacts/:id", (c) => showContact(c, {}, 200));
  app.post("/admin/contacts/:id", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const input = contactAdminInput.safeParse(contactFields(await formOf(c)));
    if (!target.success || !input.success) {
      return showContact(c, failure("INVALID"), 400);
    }
    const saved = await saveContactRow(db, input.data, target.data);
    return saved.ok
      ? done(c, "/admin/contacts", "saved")
      : showContact(c, failure(saved.error), 409);
  });
  app.post("/admin/contacts/:id/disable", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const disabled = flag.safeParse((await formOf(c)).disabled);
    if (!target.success || !disabled.success) {
      return showContacts(c, failure("INVALID"), 400);
    }
    const result = await setContactDisabled(db, target.data, disabled.data);
    return result.ok
      ? done(c, "/admin/contacts", "disabled")
      : showContacts(c, failure(result.error), 404);
  });

  // Channels.
  const showChannels = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const [rows, projects] = await Promise.all([listChannelLinks(db), listProjectRows(db)]);
    return deps.render(c, channelsPage(deps.view(c), rows, projects, feedback), status);
  };
  app.get("/admin/channels", (c) => showChannels(c, feedbackOf(c), 200));
  app.post("/admin/channels", async (c) => {
    const input = channelLinkInput.safeParse(await formOf(c));
    if (!input.success) {
      return showChannels(c, failure("INVALID"), 400);
    }
    const added = await addChannelLink(db, input.data);
    return added.ok
      ? done(c, "/admin/channels", "added")
      : showChannels(c, failure(added.error), 409);
  });
  app.post("/admin/channels/:id/remove", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    if (!target.success) {
      return showChannels(c, failure("INVALID"), 400);
    }
    const removed = await removeChannelLink(db, target.data);
    return removed.ok
      ? done(c, "/admin/channels", "removed")
      : showChannels(c, failure(removed.error), 404);
  });

  // Accounts of the team.
  const showStaff = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) =>
    deps.render(c, staffPage(deps.view(c), await listStaff(db), feedback), status);
  app.get("/admin/staff", (c) => showStaff(c, feedbackOf(c), 200));
  app.post("/admin/staff", async (c) => {
    const input = staffAccountInput.safeParse(await formOf(c));
    if (!input.success) {
      return showStaff(c, failure("INVALID"), 400);
    }
    const existing = (await listStaff(db)).some((row) => row.email === input.data.email);
    if (existing) {
      return showStaff(c, failure("IDENTITY_TAKEN"), 409);
    }
    await saveStaffAccount(db, input.data);
    return done(c, "/admin/staff", "added");
  });
  const showMember = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const row = (await listStaff(db)).find((member) => member.contactId === c.req.param("id"));
    return row === undefined
      ? showStaff(c, failure("NOT_FOUND"), 404)
      : deps.render(c, staffMemberPage(deps.view(c), row, feedback), status);
  };
  app.get("/admin/staff/:id", (c) => showMember(c, {}, 200));
  app.post("/admin/staff/:id/role", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const role = z.enum(["ADMIN", "MEMBER"]).safeParse((await formOf(c)).role);
    if (!target.success || !role.success) {
      return showMember(c, failure("INVALID"), 400);
    }
    const result = await setStaffRole(db, target.data, role.data);
    return result.ok ? done(c, "/admin/staff", "saved") : showMember(c, failure(result.error), 409);
  });
  app.post("/admin/staff/:id/disable", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const disabled = flag.safeParse((await formOf(c)).disabled);
    if (!target.success || !disabled.success) {
      return showStaff(c, failure("INVALID"), 400);
    }
    const result = await setStaffDisabled(db, target.data, disabled.data);
    return result.ok
      ? done(c, "/admin/staff", "disabled")
      : showStaff(c, failure(result.error), 409);
  });
  app.post("/admin/staff/:id/password", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const password = passwordInput.safeParse((await formOf(c)).password);
    if (!target.success || !password.success) {
      return showMember(c, failure("INVALID"), 400);
    }
    const result = await setStaffPassword(db, target.data, password.data);
    return result.ok
      ? done(c, "/admin/staff", "password")
      : showMember(c, failure(result.error), 404);
  });

  // The own account of each person, administrator or not.
  app.get("/account", (c) => deps.render(c, accountPage(deps.view(c), feedbackOf(c)), 200));
  app.post("/account/password", async (c) => {
    const form = await formOf(c);
    const next = passwordInput.safeParse(form.password);
    const current = typeof form.current === "string" ? form.current : "";
    if (!next.success) {
      return deps.render(c, accountPage(deps.view(c), failure("INVALID")), 400);
    }
    const result = await changeOwnPassword(
      db,
      c.get("staff"),
      current,
      next.data,
      c.get("sessionToken"),
    );
    return result.ok
      ? done(c, "/account", "password")
      : deps.render(c, accountPage(deps.view(c), failure(result.error)), 400);
  });
}
