import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import { escapeLiteral } from "pg";

import type { Database } from "./client.ts";

// The SCRAM-SHA-256 verifier of a password, as PostgreSQL stores it (RFC 5802 and RFC 7677). The
// database receives it instead of the password, so the password never appears in a statement that
// its logs could keep.
const scramIterations = 4096;

export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, scramIterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const keys = `${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
  return `SCRAM-SHA-256$${scramIterations}:${salt.toString("base64")}$${keys}`;
}

// PostgreSQL prepares a non-ASCII password with SASLprep before computing its verifier: a password
// of printable ASCII characters is the same before and after, so the verifier computed here matches.
const printableAscii = /^[\x20-\x7e]+$/;

// Lets a role created by the migrations log in with the password of its URL. The migrations create
// the roles without a password, because a secret must never be stored in a migration.
export async function configureRole(
  db: Database,
  role: string,
  databaseUrl: string,
): Promise<void> {
  const password = decodeURIComponent(new URL(databaseUrl).password);
  if (password === "") {
    throw new Error(`The ${role} role needs a password`);
  }
  if (!printableAscii.test(password)) {
    throw new Error(`The password of the ${role} role must use printable ASCII characters only`);
  }
  // ALTER ROLE does not accept query parameters, so the verifier is escaped as a literal.
  await db.execute(
    sql.raw(`alter role "${role}" with login password ${escapeLiteral(scramVerifier(password))}`),
  );
}
