import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";

import type { Database, Transaction } from "../db/client.ts";
import { contacts, staffAccounts, staffSessions } from "../db/schema.ts";
import type { StaffMember } from "./accounts.ts";

// A session ends after a working day, even if it is still used: OWASP Session Management Cheat
// Sheet, absolute timeout.
export const sessionDurationMs = 8 * 60 * 60 * 1000;
// A session left alone ends sooner, so a computer left open does not stay signed in all day: OWASP
// Session Management Cheat Sheet, idle timeout.
export const sessionIdleMs = 60 * 60 * 1000;
// The last use of a session is written at most this often, not on every request.
const lastSeenPrecisionMs = 60 * 1000;
// 256 random bits, far more than the 64 bits OWASP asks for.
const tokenBytes = 32;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Opens a session and returns the token for the cookie. Only its hash is stored.
export async function openSession(
  db: Database,
  contactId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(tokenBytes).toString("base64url");
  const expiresAt = new Date(now.getTime() + sessionDurationMs);
  await db
    .insert(staffSessions)
    .values({ contactId, tokenHash: hashToken(token), expiresAt, lastSeenAt: now });
  return { token, expiresAt };
}

// The team member of a session still open and recently used, with an enabled account. Using the
// session keeps it from ending for inactivity.
export async function findSession(
  db: Database,
  token: string,
  now = new Date(),
): Promise<StaffMember | undefined> {
  const tokenHash = hashToken(token);
  const [session] = await db
    .select({
      contactId: contacts.id,
      name: contacts.name,
      email: contacts.email,
      role: staffAccounts.role,
      lastSeenAt: staffSessions.lastSeenAt,
    })
    .from(staffSessions)
    .innerJoin(staffAccounts, eq(staffAccounts.contactId, staffSessions.contactId))
    .innerJoin(contacts, eq(contacts.id, staffSessions.contactId))
    .where(
      and(
        eq(staffSessions.tokenHash, tokenHash),
        isNull(staffSessions.revokedAt),
        gt(staffSessions.expiresAt, now),
        gt(staffSessions.lastSeenAt, new Date(now.getTime() - sessionIdleMs)),
        isNull(staffAccounts.disabledAt),
      ),
    );
  if (session === undefined) {
    return undefined;
  }
  if (now.getTime() - session.lastSeenAt.getTime() >= lastSeenPrecisionMs) {
    await db
      .update(staffSessions)
      .set({ lastSeenAt: now })
      .where(and(eq(staffSessions.tokenHash, tokenHash), lt(staffSessions.lastSeenAt, now)));
  }
  return {
    contactId: session.contactId,
    name: session.name,
    email: session.email,
    role: session.role,
  };
}

export async function closeSession(db: Database, token: string): Promise<void> {
  await db
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(staffSessions.tokenHash, hashToken(token)), isNull(staffSessions.revokedAt)));
}

// Ends every session of a team member, such as after a new password or when the account is
// disabled, except the one given, which the person is using to make the change.
export async function closeSessionsOf(
  db: Database | Transaction,
  contactId: string,
  keptToken?: string,
): Promise<void> {
  const open = and(eq(staffSessions.contactId, contactId), isNull(staffSessions.revokedAt));
  await db
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(
      keptToken === undefined ? open : and(open, ne(staffSessions.tokenHash, hashToken(keptToken))),
    );
}
