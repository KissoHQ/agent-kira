import { and, asc, count, eq, isNull, notExists } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client.ts";
import { isForeignKeyViolation, isUniqueViolation } from "../db/errors.ts";
import {
  channel,
  contacts,
  organizations,
  projectChannels,
  projects,
  staffAccounts,
} from "../db/schema.ts";
import { fail, type Result, succeed } from "../requests/views.ts";

// What an administrator manages: the clients, their projects, and the channels that lead to a
// project. Nothing is deleted: a client or a project that ends is archived, so its requests and
// their history stay.

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional(),
  );

// A domain such as acme.example: labels of letters, digits and hyphens, separated by dots.
const domain = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const organizationInput = z.object({
  name: z.string().trim().min(1).max(120),
  emailDomain: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().toLowerCase().regex(domain).optional(),
  ),
});
export type OrganizationInput = z.infer<typeof organizationInput>;

export const projectInput = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/),
  name: z.string().trim().min(1).max(120),
  description: optionalText(1000),
  organizationId: z.preprocess((value) => (value === "" ? undefined : value), z.uuid().optional()),
});
export type ProjectInput = z.infer<typeof projectInput>;

export const channelLinkInput = z
  .object({
    projectId: z.uuid(),
    channel: z.enum(channel.enumValues),
    // Slack channel ID, email address, or project key for the widget.
    externalId: z.string().trim().min(1).max(254),
  })
  .transform((link) => ({
    ...link,
    externalId: link.channel === "EMAIL" ? link.externalId.toLowerCase() : link.externalId,
  }))
  .refine((link) => link.channel !== "EMAIL" || z.email().safeParse(link.externalId).success, {
    message: "An email channel needs an email address",
    path: ["externalId"],
  });
export type ChannelLinkInput = z.output<typeof channelLinkInput>;

export interface OrganizationRow {
  id: string;
  name: string;
  emailDomain: string | null;
  archived: boolean;
  projects: number;
  contacts: number;
}

const countOf = (counts: { id: string | null; value: number }[], id: string) =>
  counts.find((row) => row.id === id)?.value ?? 0;

export async function listOrganizations(db: Database): Promise<OrganizationRow[]> {
  const [rows, projectCounts, contactCounts] = await Promise.all([
    db.select().from(organizations).orderBy(asc(organizations.name)),
    db
      .select({ id: projects.organizationId, value: count() })
      .from(projects)
      .groupBy(projects.organizationId),
    db
      .select({ id: contacts.organizationId, value: count() })
      .from(contacts)
      .groupBy(contacts.organizationId),
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    emailDomain: row.emailDomain,
    archived: row.archivedAt !== null,
    projects: countOf(projectCounts, row.id),
    contacts: countOf(contactCounts, row.id),
  }));
}

// Creates a client, or changes the one with this id.
export async function saveOrganization(
  db: Database,
  input: OrganizationInput,
  id?: string,
): Promise<Result<string, "DOMAIN_TAKEN" | "NOT_FOUND">> {
  const values = { name: input.name, emailDomain: input.emailDomain ?? null };
  try {
    const [row] =
      id === undefined
        ? await db.insert(organizations).values(values).returning({ id: organizations.id })
        : await db
            .update(organizations)
            .set(values)
            .where(eq(organizations.id, id))
            .returning({ id: organizations.id });
    return row === undefined ? fail("NOT_FOUND") : succeed(row.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail("DOMAIN_TAKEN");
    }
    throw error;
  }
}

// A client that left: it is archived with its projects, and its contacts are disabled, so their
// messages are treated as those of unknown senders. An account of the team is never disabled here:
// only the page of the team does that. Restoring the client restores only itself: its
// projects and contacts are restored one by one, as each may have ended on its own.
export async function setOrganizationArchived(
  db: Database,
  id: string,
  archived: boolean,
): Promise<Result<null, "NOT_FOUND">> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(organizations)
      .set({ archivedAt: archived ? now : null })
      .where(eq(organizations.id, id))
      .returning({ id: organizations.id });
    if (row === undefined) {
      return fail("NOT_FOUND");
    }
    if (archived) {
      await tx
        .update(projects)
        .set({ archivedAt: now })
        .where(and(eq(projects.organizationId, id), isNull(projects.archivedAt)));
      await tx
        .update(contacts)
        .set({ disabledAt: now })
        .where(
          and(
            eq(contacts.organizationId, id),
            isNull(contacts.disabledAt),
            notExists(
              tx
                .select({ contactId: staffAccounts.contactId })
                .from(staffAccounts)
                .where(eq(staffAccounts.contactId, contacts.id)),
            ),
          ),
        );
    }
    return succeed(null);
  });
}

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  organizationId: string | null;
  organization: string | null;
  archived: boolean;
}

export async function listProjectRows(db: Database): Promise<ProjectRow[]> {
  const rows = await db
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      description: projects.description,
      organizationId: projects.organizationId,
      organization: organizations.name,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .leftJoin(organizations, eq(organizations.id, projects.organizationId))
    .orderBy(asc(projects.key));
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    organizationId: row.organizationId,
    organization: row.organization,
    archived: row.archivedAt !== null,
  }));
}

// Creates a project, or changes the one with this id. The key of a project never changes: the
// applications that embed the widget sign with the secret of that key, and the channels and the
// commands name it, so a new key would silently cut them off, and a key used again would let the
// application of the old project vouch for the people of the new one.
export async function saveProject(
  db: Database,
  input: ProjectInput,
  id?: string,
): Promise<Result<string, "KEY_TAKEN" | "KEY_LOCKED" | "NOT_FOUND" | "UNKNOWN_ORGANIZATION">> {
  const values = {
    name: input.name,
    description: input.description ?? null,
    organizationId: input.organizationId ?? null,
  };
  try {
    if (id === undefined) {
      const [created] = await db
        .insert(projects)
        .values({ ...values, key: input.key })
        .returning({ id: projects.id });
      return created === undefined ? fail("NOT_FOUND") : succeed(created.id);
    }
    // The key is part of the condition: a form with another key changes nothing.
    const [row] = await db
      .update(projects)
      .set(values)
      .where(and(eq(projects.id, id), eq(projects.key, input.key)))
      .returning({ id: projects.id });
    if (row !== undefined) {
      return succeed(row.id);
    }
    const [existing] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id));
    return fail(existing === undefined ? "NOT_FOUND" : "KEY_LOCKED");
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail("KEY_TAKEN");
    }
    if (isForeignKeyViolation(error)) {
      return fail("UNKNOWN_ORGANIZATION");
    }
    throw error;
  }
}

// A finished project: no new message is filed under it, and its requests stay for the team.
export async function setProjectArchived(
  db: Database,
  id: string,
  archived: boolean,
): Promise<Result<null, "NOT_FOUND">> {
  const [row] = await db
    .update(projects)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  return row === undefined ? fail("NOT_FOUND") : succeed(null);
}

export interface ChannelLinkRow {
  id: string;
  projectKey: string;
  channel: ChannelLinkInput["channel"];
  externalId: string;
}

export async function listChannelLinks(db: Database): Promise<ChannelLinkRow[]> {
  return db
    .select({
      id: projectChannels.id,
      projectKey: projects.key,
      channel: projectChannels.channel,
      externalId: projectChannels.externalId,
    })
    .from(projectChannels)
    .innerJoin(projects, eq(projects.id, projectChannels.projectId))
    .orderBy(asc(projects.key), asc(projectChannels.channel), asc(projectChannels.externalId));
}

// A Slack channel, an email address or a widget that leads to one project.
export async function addChannelLink(
  db: Database,
  input: ChannelLinkInput,
): Promise<Result<string, "ALREADY_LINKED" | "NOT_FOUND">> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, input.projectId));
  if (project === undefined) {
    return fail("NOT_FOUND");
  }
  try {
    const [row] = await db
      .insert(projectChannels)
      .values(input)
      .returning({ id: projectChannels.id });
    return row === undefined ? fail("NOT_FOUND") : succeed(row.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail("ALREADY_LINKED");
    }
    throw error;
  }
}

export async function removeChannelLink(
  db: Database,
  id: string,
): Promise<Result<null, "NOT_FOUND">> {
  const [row] = await db
    .delete(projectChannels)
    .where(eq(projectChannels.id, id))
    .returning({ id: projectChannels.id });
  return row === undefined ? fail("NOT_FOUND") : succeed(null);
}
