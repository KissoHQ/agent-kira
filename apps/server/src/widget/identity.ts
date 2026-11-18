import { createHmac, timingSafeEqual } from "node:crypto";

// Longest validity of a signed identity, so a copied one soon stops working.
export const maxIdentityLifetimeSeconds = 24 * 60 * 60;

export interface SignedIdentity {
  email: string;
  // Key of the project of the application that signed, such as PORTAL.
  project: string;
  // Unix time, in seconds, after which the signature is refused.
  expires: number;
  signature: string;
}

// The secret of each project's application, by project key. Each application only knows its own,
// so it cannot sign for the people of another client.
export type IdentitySecrets = ReadonlyMap<string, string>;

function sign(secret: string, email: string, project: string, expires: number): string {
  return createHmac("sha256", secret).update(`${email}\n${project}\n${expires}`).digest("hex");
}

// Computed by the server of the application that embeds the widget, for the person signed in:
// the widget then tells the agent who writes, and the person cannot change it.
export function signIdentity(
  secret: string,
  email: string,
  project: string,
  now: Date,
): SignedIdentity {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedProject = project.trim().toUpperCase();
  const expires = Math.floor(now.getTime() / 1000) + maxIdentityLifetimeSeconds;
  return {
    email: normalizedEmail,
    project: normalizedProject,
    expires,
    signature: sign(secret, normalizedEmail, normalizedProject, expires),
  };
}

// True for a signature of this email and project, made with the secret of that project, and still
// valid.
export function verifyIdentity(
  secrets: IdentitySecrets,
  identity: SignedIdentity,
  now: Date,
): boolean {
  const secret = secrets.get(identity.project);
  const seconds = Math.floor(now.getTime() / 1000);
  if (
    secret === undefined ||
    identity.expires <= seconds ||
    identity.expires > seconds + maxIdentityLifetimeSeconds
  ) {
    return false;
  }
  const expected = Buffer.from(
    sign(secret, identity.email, identity.project, identity.expires),
    "hex",
  );
  const given = Buffer.from(identity.signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
