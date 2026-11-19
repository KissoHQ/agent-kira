import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client.ts";
import { isUniqueViolation } from "../db/errors.ts";
import { contacts, organizations, projectContacts, projects } from "../db/schema.ts";
import { fail, type Result, succeed } from "../requests/views.ts";

// The people of the clients who write to the agent, as an administrator manages them.

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const contactAdminInput = z
  .object({
    email: z.preprocess(
      blankToUndefined,
      z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
    ),
    name: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
    // A Slack member ID, such as U012AB3CD, shown in the profile of the person in Slack.
    slackUserId: z.preprocess(
      blankToUndefined,
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[UW][A-Z0-9]{2,20}$/)
        .optional(),
    ),
    organizationId: z.preprocess(blankToUndefined, z.uuid().optional()),
    projectIds: z.array(z.uuid()).max(100).default([]),
  })
  .refine((input) => input.email !== undefined || input.slackUserId !== undefined, {
    message: "A contact needs an email address or a Slack member ID",
    path: ["email"],
  });
export type ContactAdminInput = z.output<typeof contactAdminInput>;

export interface ContactRow {
  id: string;
  email: string | null;
  name: string | null;
  slackUserId: string | null;
  organizationId: string | null;
  organization: string | null;
  projectIds: string[];
  projectKeys: string[];
  disabled: boolean;
}

export async function listContactRows(db: Database): Promise<ContactRow[]> {
  const [rows, links] = await Promise.all([
    db
      .select({
        id: contacts.id,
        email: contacts.email,
        name: contacts.name,
        slackUserId: contacts.slackUserId,
        organizationId: contacts.organizationId,
        organization: organizations.name,
        disabledAt: contacts.disabledAt,
      })
      .from(contacts)
      .leftJoin(organizations, eq(organizations.id, contacts.organizationId))
      .orderBy(asc(contacts.email), asc(contacts.slackUserId)),
    db
      .select({ contactId: projectContacts.contactId, id: projects.id, key: projects.key })
      .from(projectContacts)
      .innerJoin(projects, eq(projects.id, projectContacts.projectId))
      .orderBy(asc(projects.key)),
  ]);
  return rows.map((row) => {
    const own = links.filter((link) => link.contactId === row.id);
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      slackUserId: row.slackUserId,
      organizationId: row.organizationId,
      organization: row.organization,
      projectIds: own.map((link) => link.id),
      projectKeys: own.map((link) => link.key),
      disabled: row.disabledAt !== null,
    };
  });
}

// Creates a contact, or changes the one with this id, with exactly the projects given: a person
// who no longer works on a project loses access to its requests at once.
export async function saveContactRow(
  db: Database,
  input: ContactAdminInput,
  id?: string,
): Promise<Result<string, "IDENTITY_TAKEN" | "NOT_FOUND" | "UNKNOWN_PROJECT">> {
  try {
    return await db.transaction(async (tx) => {
      if (input.projectIds.length > 0) {
        const found = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, input.projectIds));
        if (found.length !== new Set(input.projectIds).size) {
          return fail("UNKNOWN_PROJECT");
        }
      }
      const values = {
        email: input.email ?? null,
        name: input.name ?? null,
        slackUserId: input.slackUserId ?? null,
        organizationId: input.organizationId ?? null,
      };
      const [row] =
        id === undefined
          ? await tx.insert(contacts).values(values).returning({ id: contacts.id })
          : await tx
              .update(contacts)
              .set(values)
              .where(eq(contacts.id, id))
              .returning({ id: contacts.id });
      if (row === undefined) {
        return fail("NOT_FOUND");
      }
      await tx.delete(projectContacts).where(eq(projectContacts.contactId, row.id));
      if (input.projectIds.length > 0) {
        await tx
          .insert(projectContacts)
          .values(
            [...new Set(input.projectIds)].map((projectId) => ({ projectId, contactId: row.id })),
          );
      }
      return succeed(row.id);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail("IDENTITY_TAKEN");
    }
    throw error;
  }
}

// A disabled contact, such as a person who left the client, is treated as an unknown sender: their
// messages are filed for a review and they reach no request.
export async function setContactDisabled(
  db: Database,
  id: string,
  disabled: boolean,
): Promise<Result<null, "NOT_FOUND">> {
  const [row] = await db
    .update(contacts)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(eq(contacts.id, id))
    .returning({ id: contacts.id });
  return row === undefined ? fail("NOT_FOUND") : succeed(null);
}
