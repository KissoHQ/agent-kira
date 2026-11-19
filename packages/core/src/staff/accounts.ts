import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, Transaction } from "../db/client.ts";
import { contacts, staffAccounts, staffRole } from "../db/schema.ts";
import { fail, type Result, succeed } from "../requests/views.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { closeSessionsOf } from "./sessions.ts";

// NIST SP 800-63B asks for at least 15 characters when the password is the only factor. The
// maximum keeps a sign-in attempt from costing too much.
export const minPasswordLength = 15;
const maxPasswordLength = 128;

export type StaffRole = (typeof staffRole.enumValues)[number];

const password = z.string().min(minPasswordLength).max(maxPasswordLength);

export const staffAccountInput = z.object({
  email: z.email().max(254).toLowerCase(),
  name: z.string().trim().min(1).max(120),
  password,
  // Kept as it is for an existing account when not given.
  role: z.enum(staffRole.enumValues).optional(),
});

export type StaffAccountInput = z.infer<typeof staffAccountInput>;

export const passwordInput = password;

export interface StaffMember {
  contactId: string;
  name: string | null;
  email: string | null;
  role: StaffRole;
}

// Hash compared when the email is unknown, so an answer takes as long for an unknown email as for
// a wrong password and does not tell which addresses have an account.
let unknownAccountHash: Promise<string> | undefined;

// Creates the account of a team member, a member unless told otherwise, or sets a new password.
// The contact is found by email, or created. A new password ends every open session; a disabled
// account stays disabled, as only an administrator enables it again.
export async function saveStaffAccount(db: Database, input: StaffAccountInput): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contacts)
      .values({ email: input.email, name: input.name })
      .onConflictDoUpdate({ target: contacts.email, set: { name: sql`excluded.name` } })
      .returning({ id: contacts.id });
    if (contact === undefined) {
      throw new Error("The contact of the account was not stored");
    }
    await tx
      .insert(staffAccounts)
      .values({ contactId: contact.id, passwordHash, role: input.role ?? "MEMBER" })
      .onConflictDoUpdate({
        target: staffAccounts.contactId,
        set: input.role === undefined ? { passwordHash } : { passwordHash, role: input.role },
      });
    await closeSessionsOf(tx, contact.id);
    return contact.id;
  });
}

// The team member with this email and password, if their account is enabled.
export async function authenticateStaff(
  db: Database,
  email: string,
  given: string,
): Promise<StaffMember | undefined> {
  const [account] = await db
    .select({
      contactId: contacts.id,
      name: contacts.name,
      email: contacts.email,
      role: staffAccounts.role,
      passwordHash: staffAccounts.passwordHash,
    })
    .from(staffAccounts)
    .innerJoin(contacts, eq(contacts.id, staffAccounts.contactId))
    .where(and(eq(contacts.email, email.trim().toLowerCase()), isNull(staffAccounts.disabledAt)));
  if (account === undefined || given.length > maxPasswordLength) {
    unknownAccountHash ??= hashPassword("unknown account");
    await verifyPassword(given.slice(0, maxPasswordLength), await unknownAccountHash);
    return undefined;
  }
  if (!(await verifyPassword(given, account.passwordHash))) {
    return undefined;
  }
  return {
    contactId: account.contactId,
    name: account.name,
    email: account.email,
    role: account.role,
  };
}

export interface StaffRow {
  contactId: string;
  email: string | null;
  name: string | null;
  role: StaffRole;
  disabled: boolean;
}

export async function listStaff(db: Database): Promise<StaffRow[]> {
  const rows = await db
    .select({
      contactId: staffAccounts.contactId,
      email: contacts.email,
      name: contacts.name,
      role: staffAccounts.role,
      disabledAt: staffAccounts.disabledAt,
    })
    .from(staffAccounts)
    .innerJoin(contacts, eq(contacts.id, staffAccounts.contactId))
    .orderBy(asc(contacts.email));
  return rows.map((row) => ({
    contactId: row.contactId,
    email: row.email,
    name: row.name,
    role: row.role,
    disabled: row.disabledAt !== null,
  }));
}

// Locks the enabled administrators, so two of them cannot remove each other at the same time and
// leave nobody to manage the accounts.
async function lockedAdministrators(tx: Transaction): Promise<string[]> {
  const rows = await tx
    .select({ contactId: staffAccounts.contactId })
    .from(staffAccounts)
    .where(and(eq(staffAccounts.role, "ADMIN"), isNull(staffAccounts.disabledAt)))
    .for("update");
  return rows.map((row) => row.contactId);
}

const isLastAdministrator = (administrators: string[], contactId: string) =>
  administrators.length === 1 && administrators[0] === contactId;

export async function setStaffRole(
  db: Database,
  contactId: string,
  role: StaffRole,
): Promise<Result<null, "NOT_FOUND" | "LAST_ADMIN">> {
  return db.transaction(async (tx) => {
    if (role !== "ADMIN" && isLastAdministrator(await lockedAdministrators(tx), contactId)) {
      return fail("LAST_ADMIN");
    }
    const [row] = await tx
      .update(staffAccounts)
      .set({ role })
      .where(eq(staffAccounts.contactId, contactId))
      .returning({ contactId: staffAccounts.contactId });
    return row === undefined ? fail("NOT_FOUND") : succeed(null);
  });
}

// A disabled account can no longer sign in, and its open sessions end at once.
export async function setStaffDisabled(
  db: Database,
  contactId: string,
  disabled: boolean,
): Promise<Result<null, "NOT_FOUND" | "LAST_ADMIN">> {
  return db.transaction(async (tx) => {
    if (disabled && isLastAdministrator(await lockedAdministrators(tx), contactId)) {
      return fail("LAST_ADMIN");
    }
    const [row] = await tx
      .update(staffAccounts)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(eq(staffAccounts.contactId, contactId))
      .returning({ contactId: staffAccounts.contactId });
    if (row === undefined) {
      return fail("NOT_FOUND");
    }
    if (disabled) {
      await closeSessionsOf(tx, contactId);
    }
    return succeed(null);
  });
}

// A new password given by an administrator: every session of the person ends.
export async function setStaffPassword(
  db: Database,
  contactId: string,
  newPassword: string,
): Promise<Result<null, "NOT_FOUND">> {
  const passwordHash = await hashPassword(newPassword);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(staffAccounts)
      .set({ passwordHash })
      .where(eq(staffAccounts.contactId, contactId))
      .returning({ contactId: staffAccounts.contactId });
    if (row === undefined) {
      return fail("NOT_FOUND");
    }
    await closeSessionsOf(tx, contactId);
    return succeed(null);
  });
}

// A team member changes their own password, giving the current one: their other sessions end, and
// the one they use stays open.
export async function changeOwnPassword(
  db: Database,
  member: { contactId: string; email: string | null },
  current: string,
  next: string,
  sessionToken: string,
): Promise<Result<null, "WRONG_PASSWORD">> {
  const checked =
    member.email === null ? undefined : await authenticateStaff(db, member.email, current);
  if (checked?.contactId !== member.contactId) {
    return fail("WRONG_PASSWORD");
  }
  const passwordHash = await hashPassword(next);
  await db.transaction(async (tx) => {
    await tx
      .update(staffAccounts)
      .set({ passwordHash })
      .where(eq(staffAccounts.contactId, member.contactId));
    await closeSessionsOf(tx, member.contactId, sessionToken);
  });
  return succeed(null);
}
