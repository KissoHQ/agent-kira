import {
  addChannelLink,
  authenticateStaff,
  changeOwnPassword,
  channelLinkInput,
  contactAdminInput,
  createStaffAccount,
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
  setContactDisabled,
  setOrganizationArchived,
  setProjectArchived,
  setStaffDisabled,
  setStaffIdentity,
  setStaffPassword,
  setStaffRole,
  staffAccountInput,
  staffIdentityInput,
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
import type { CheckQueue } from "./password-checks.ts";
import type { AttemptLimiter } from "./sign-in-limiter.ts";

type Status = 200 | 400 | 403 | 404 | 409 | 429 | 503;

export interface AdminDependencies {
  db: Database;
  view: (c: Context<AdminEnv>) => ViewContext;
  render: (
    c: Context<AdminEnv>,
    fragment: Fragment,
    status: Status,
  ) => Response | Promise<Response>;
  // Records who did what, for the logs of the server. Never with a password.
  audit: (event: string) => void;
  // The queue of password checks and hashes shared with sign-in, so pages of accounts cannot use
  // the thread pool of the server either.
  passwordChecks: CheckQueue;
  // The attempts of each account, shared with sign-in: a wrong password here counts as there.
  emailLimiter: AttemptLimiter;
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
  KEY_LOCKED: "Le code d'un projet ne change pas : le widget et les canaux le désignent.",
  UNKNOWN_ORGANIZATION: "Ce client n'existe plus.",
  STAFF_ACCOUNT: "Ce contact est un compte de l'équipe : modifiez-le depuis la page Équipe.",
  CLIENT_CONTACT:
    "Cet e-mail est celui d'un contact d'un client : un compte de l'équipe ne peut pas le reprendre.",
  IDENTITY_TAKEN: "Cet e-mail ou cet identifiant Slack est déjà celui d'un autre contact.",
  UNKNOWN_PROJECT: "Un des projets n'existe plus.",
  ALREADY_LINKED: "Ce canal mène déjà à un projet.",
  LAST_ADMIN: "Il doit rester au moins un administrateur actif.",
  NOT_FOUND: "Élément introuvable.",
  WRONG_PASSWORD: "Mot de passe actuel incorrect.",
  TOO_MANY: "Trop de mots de passe incorrects. Réessayez dans quelques minutes.",
  BUSY: "Trop de vérifications en cours. Réessayez dans quelques secondes.",
  INVALID: "Valeurs invalides : vérifiez le formulaire.",
} as const;

// The status of a refusal: a wrong password is a bad form, too many of them or a full queue are
// limits.
const statusOf = (code: "WRONG_PASSWORD" | "TOO_MANY" | "BUSY"): Status =>
  code === "TOO_MANY" ? 429 : code === "BUSY" ? 503 : 400;
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
const back = (c: Context<AdminEnv>, path: string, notice: Notice) =>
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

// Who acts, as the logs name them. Values typed by people are quoted, so a line break in them cannot
// write a false line in the logs.
const actor = (c: Context<AdminEnv>) => JSON.stringify(c.get("staff").email);

export function registerAdministration(app: Hono<AdminEnv>, deps: AdminDependencies): void {
  const { db, passwordChecks, emailLimiter } = deps;
  const record = (c: Context<AdminEnv>, action: string) => {
    deps.audit(`Administration by ${actor(c)}: ${action}`);
  };
  // Records an action that succeeded, then goes back to the list.
  const done = (c: Context<AdminEnv>, path: string, notice: Notice, action?: string) => {
    if (action !== undefined) {
      record(c, action);
    }
    return back(c, path, notice);
  };

  // Checks the own password of the person who acts, counted as a sign-in attempt of their account
  // and run in the queue of password checks. Undefined when it is right.
  async function checkOwnPassword(
    c: Context<AdminEnv>,
    given: string | string[] | undefined,
  ): Promise<"WRONG_PASSWORD" | "TOO_MANY" | "BUSY" | undefined> {
    const email = c.get("staff").email ?? "";
    const attempt = emailLimiter.begin(email);
    if (!attempt.allowed) {
      return "TOO_MANY";
    }
    const password = typeof given === "string" ? given : "";
    const check = await passwordChecks.run(() => authenticateStaff(db, email, password));
    if (!check.ran) {
      emailLimiter.giveBack(email);
      return "BUSY";
    }
    if (check.value?.contactId !== c.get("staff").contactId) {
      deps.audit(`Wrong password of ${actor(c)} to confirm an action on accounts`);
      return "WRONG_PASSWORD";
    }
    emailLimiter.giveBack(email);
    return undefined;
  }

  // Runs the hash of a new password in the queue. Undefined when the queue is full.
  async function hashed<T>(work: () => Promise<T>): Promise<T | undefined> {
    const outcome = await passwordChecks.run(work);
    return outcome.ran ? outcome.value : undefined;
  }

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
      ? done(
          c,
          "/admin/organizations",
          "added",
          `added the client ${JSON.stringify(input.data.name)}`,
        )
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
      ? done(c, "/admin/organizations", "saved", `changed the client ${target.data}`)
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
      ? done(
          c,
          "/admin/organizations",
          "archived",
          `${archived.data ? "archived" : "restored"} the client ${target.data}`,
        )
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
      ? done(c, "/admin/projects", "added", `added the project ${input.data.key}`)
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
      ? done(c, "/admin/projects", "saved", `changed the project ${input.data.key}`)
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
      ? done(
          c,
          "/admin/projects",
          "archived",
          `${archived.data ? "archived" : "restored"} the project ${target.data}`,
        )
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
      ? done(c, "/admin/contacts", "added", `added the contact ${saved.value}`)
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
      ? done(c, "/admin/contacts", "saved", `changed the contact ${target.data}`)
      : // An account of the team has no page among the contacts: the list says why.
        saved.error === "STAFF_ACCOUNT"
        ? showContacts(c, failure(saved.error), 409)
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
      ? done(
          c,
          "/admin/contacts",
          "disabled",
          `${disabled.data ? "disabled" : "enabled"} the contact ${target.data}`,
        )
      : showContacts(c, failure(result.error), result.error === "NOT_FOUND" ? 404 : 409);
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
      ? done(
          c,
          "/admin/channels",
          "added",
          `linked ${input.data.channel} ${JSON.stringify(input.data.externalId)} to the project ${input.data.projectId}`,
        )
      : showChannels(c, failure(added.error), 409);
  });
  app.post("/admin/channels/:id/remove", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    if (!target.success) {
      return showChannels(c, failure("INVALID"), 400);
    }
    const removed = await removeChannelLink(db, target.data);
    return removed.ok
      ? done(c, "/admin/channels", "removed", `removed the channel link ${target.data}`)
      : showChannels(c, failure(removed.error), 404);
  });

  // Accounts of the team. Each change asks the own password of the administrator again.
  const showStaff = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) =>
    deps.render(c, staffPage(deps.view(c), await listStaff(db), feedback), status);
  app.get("/admin/staff", (c) => showStaff(c, feedbackOf(c), 200));
  app.post("/admin/staff", async (c) => {
    const form = await formOf(c);
    const input = staffAccountInput.safeParse(form);
    if (!input.success) {
      return showStaff(c, failure("INVALID"), 400);
    }
    const refused = await checkOwnPassword(c, form.confirm);
    if (refused !== undefined) {
      return showStaff(c, failure(refused), statusOf(refused));
    }
    const created = await hashed(() => createStaffAccount(db, input.data));
    if (created === undefined) {
      return showStaff(c, failure("BUSY"), 503);
    }
    if (!created.ok) {
      return showStaff(c, failure(created.error), 409);
    }
    record(
      c,
      `created the account ${JSON.stringify(input.data.email)} as ${input.data.role ?? "MEMBER"}`,
    );
    return done(c, "/admin/staff", "added");
  });
  const showMember = async (c: Context<AdminEnv>, feedback: Feedback, status: Status) => {
    const row = (await listStaff(db)).find((member) => member.contactId === c.req.param("id"));
    return row === undefined
      ? showStaff(c, failure("NOT_FOUND"), 404)
      : deps.render(c, staffMemberPage(deps.view(c), row, feedback), status);
  };
  // The account an action targets, as the logs name it.
  const memberName = async (contactId: string) =>
    JSON.stringify(
      (await listStaff(db)).find((row) => row.contactId === contactId)?.email ?? contactId,
    );
  app.get("/admin/staff/:id", (c) => showMember(c, {}, 200));
  app.post("/admin/staff/:id", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const form = await formOf(c);
    const input = staffIdentityInput.safeParse(form);
    if (!target.success || !input.success) {
      return showMember(c, failure("INVALID"), 400);
    }
    const refused = await checkOwnPassword(c, form.confirm);
    if (refused !== undefined) {
      return showMember(c, failure(refused), statusOf(refused));
    }
    const before = await memberName(target.data);
    const result = await setStaffIdentity(db, target.data, input.data);
    if (!result.ok) {
      return showMember(c, failure(result.error), result.error === "NOT_FOUND" ? 404 : 409);
    }
    record(c, `set the email of ${before} to ${JSON.stringify(input.data.email)}`);
    return done(c, "/admin/staff", "saved");
  });
  app.post("/admin/staff/:id/role", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const form = await formOf(c);
    const role = z.enum(["ADMIN", "MEMBER"]).safeParse(form.role);
    if (!target.success || !role.success) {
      return showMember(c, failure("INVALID"), 400);
    }
    const refused = await checkOwnPassword(c, form.confirm);
    if (refused !== undefined) {
      return showMember(c, failure(refused), statusOf(refused));
    }
    const result = await setStaffRole(db, target.data, role.data);
    if (!result.ok) {
      return showMember(c, failure(result.error), 409);
    }
    record(c, `set the role of ${await memberName(target.data)} to ${role.data}`);
    return done(c, "/admin/staff", "saved");
  });
  app.post("/admin/staff/:id/disable", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const form = await formOf(c);
    const disabled = flag.safeParse(form.disabled);
    if (!target.success || !disabled.success) {
      return showStaff(c, failure("INVALID"), 400);
    }
    const refused = await checkOwnPassword(c, form.confirm);
    if (refused !== undefined) {
      return showMember(c, failure(refused), statusOf(refused));
    }
    const result = await setStaffDisabled(db, target.data, disabled.data);
    if (!result.ok) {
      return showMember(c, failure(result.error), 409);
    }
    record(
      c,
      `${disabled.data ? "disabled" : "enabled"} the account ${await memberName(target.data)}`,
    );
    return done(c, "/admin/staff", "disabled");
  });
  app.post("/admin/staff/:id/password", async (c) => {
    const target = id.safeParse(c.req.param("id"));
    const form = await formOf(c);
    const password = passwordInput.safeParse(form.password);
    if (!target.success || !password.success) {
      return showMember(c, failure("INVALID"), 400);
    }
    const refused = await checkOwnPassword(c, form.confirm);
    if (refused !== undefined) {
      return showMember(c, failure(refused), statusOf(refused));
    }
    const result = await hashed(() => setStaffPassword(db, target.data, password.data));
    if (result === undefined) {
      return showMember(c, failure("BUSY"), 503);
    }
    if (!result.ok) {
      return showMember(c, failure(result.error), 404);
    }
    record(c, `gave a new password to ${await memberName(target.data)}`);
    return done(c, "/admin/staff", "password");
  });

  // The own account of each person, administrator or not. The current password is checked like a
  // sign-in: in the queue of checks, and counted among the attempts of the account.
  app.get("/account", (c) => deps.render(c, accountPage(deps.view(c), feedbackOf(c)), 200));
  app.post("/account/password", async (c) => {
    const form = await formOf(c);
    const next = passwordInput.safeParse(form.password);
    const current = typeof form.current === "string" ? form.current : "";
    if (!next.success) {
      return deps.render(c, accountPage(deps.view(c), failure("INVALID")), 400);
    }
    const staff = c.get("staff");
    const email = staff.email ?? "";
    const attempt = emailLimiter.begin(email);
    if (!attempt.allowed) {
      return deps.render(c, accountPage(deps.view(c), failure("TOO_MANY")), 429);
    }
    const outcome = await passwordChecks.run(() =>
      changeOwnPassword(db, staff, current, next.data, c.get("sessionToken")),
    );
    if (!outcome.ran) {
      emailLimiter.giveBack(email);
      return deps.render(c, accountPage(deps.view(c), failure("BUSY")), 503);
    }
    if (!outcome.value.ok) {
      deps.audit(`Wrong current password of ${actor(c)} to change it`);
      return deps.render(c, accountPage(deps.view(c), failure(outcome.value.error)), 400);
    }
    emailLimiter.giveBack(email);
    deps.audit(`Password changed by ${actor(c)}`);
    return done(c, "/account", "password");
  });
}
