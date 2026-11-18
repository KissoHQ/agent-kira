import { describe, expect, it } from "vitest";

import { maxIdentityLifetimeSeconds, signIdentity, verifyIdentity } from "./identity";

const portalSecret = "a-secret-shared-with-the-portal-application";
const shopSecret = "a-secret-shared-with-the-shop-application";
const secrets = new Map([
  ["PORTAL", portalSecret],
  ["SHOP", shopSecret],
]);
const now = new Date("2026-10-31T09:00:00Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const bruno = "bruno.leroy@globex.example";

describe("signed identities", () => {
  it("verifies an identity signed for a project, in normal case, until it expires", () => {
    const identity = signIdentity(portalSecret, " Bruno.Leroy@Globex.example ", " portal ", now);

    expect(identity).toMatchObject({ email: bruno, project: "PORTAL" });
    expect(verifyIdentity(secrets, identity, now)).toBe(true);
    expect(verifyIdentity(secrets, identity, later(maxIdentityLifetimeSeconds - 1))).toBe(true);
    expect(verifyIdentity(secrets, identity, later(maxIdentityLifetimeSeconds))).toBe(false);
  });

  it("refuses another email, another project, a changed expiry or an unknown project", () => {
    const identity = signIdentity(portalSecret, bruno, "PORTAL", now);

    const changed = [
      { ...identity, email: "alice.martin@acme.example" },
      { ...identity, project: "SHOP" },
      { ...identity, expires: identity.expires - 60 },
    ];
    expect(changed.map((attempt) => verifyIdentity(secrets, attempt, now))).toEqual([
      false,
      false,
      false,
    ]);
    expect(verifyIdentity(new Map([["SHOP", shopSecret]]), identity, now)).toBe(false);
  });

  it("refuses an identity signed for a project with the secret of another project", () => {
    // The shop application knows only its own secret: it cannot vouch for people of the portal.
    const forged = signIdentity(shopSecret, bruno, "PORTAL", now);

    expect(verifyIdentity(secrets, forged, now)).toBe(false);
  });

  it("refuses a signature that expires too far in the future", () => {
    const identity = signIdentity(portalSecret, bruno, "PORTAL", later(3600));

    expect(verifyIdentity(secrets, identity, now)).toBe(false);
  });

  it("refuses a signature that is not hexadecimal of the right length", () => {
    const identity = signIdentity(portalSecret, bruno, "PORTAL", now);

    expect(verifyIdentity(secrets, { ...identity, signature: "abc" }, now)).toBe(false);
  });
});
