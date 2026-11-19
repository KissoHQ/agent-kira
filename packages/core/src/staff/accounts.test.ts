import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { contacts, staffAccounts } from "../db/schema.ts";
import {
  authenticateStaff,
  changeOwnPassword,
  listStaff,
  saveStaffAccount,
  setStaffDisabled,
  setStaffPassword,
  setStaffRole,
  staffAccountInput,
} from "./accounts.ts";
import { findSession, openSession } from "./sessions.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

const password = "a long staff password";
const account = { email: "Dana.Support@Team.Example", name: "Dana Support", password };

let contactId: string;

beforeEach(async () => {
  contactId = await saveStaffAccount(getAppDatabase(), staffAccountInput.parse(account));
});

describe("staffAccountInput", () => {
  it("refuses a password shorter than 15 characters", () => {
    expect(staffAccountInput.safeParse({ ...account, password: "fourteen chars" }).success).toBe(
      false,
    );
  });
});

describe("saveStaffAccount", () => {
  it("creates the contact with a lowercase email and stores only a hash", async () => {
    const [stored] = await getDatabase()
      .select({ email: contacts.email, hash: staffAccounts.passwordHash })
      .from(staffAccounts)
      .innerJoin(contacts, eq(contacts.id, staffAccounts.contactId));

    expect(stored?.email).toBe("dana.support@team.example");
    expect(stored?.hash).toMatch(/^\$argon2id\$/);
  });

  it("sets a new password on the same contact, and ends its open sessions", async () => {
    const { token } = await openSession(getAppDatabase(), contactId);

    const again = await saveStaffAccount(
      getAppDatabase(),
      staffAccountInput.parse({ ...account, password: "another long password" }),
    );

    expect(again).toBe(contactId);
    await expect(
      authenticateStaff(getAppDatabase(), account.email, "another long password"),
    ).resolves.toMatchObject({ contactId, role: "MEMBER" });
    await expect(authenticateStaff(getAppDatabase(), account.email, password)).resolves.toBe(
      undefined,
    );
    await expect(findSession(getAppDatabase(), token)).resolves.toBeUndefined();
  });

  it("keeps a disabled account disabled, and keeps the role when none is given", async () => {
    await saveStaffAccount(
      getAppDatabase(),
      staffAccountInput.parse({ ...account, role: "ADMIN" }),
    );
    await getDatabase().update(staffAccounts).set({ disabledAt: new Date() });

    await saveStaffAccount(
      getAppDatabase(),
      staffAccountInput.parse({ ...account, password: "another long password" }),
    );

    await expect(
      authenticateStaff(getAppDatabase(), account.email, "another long password"),
    ).resolves.toBeUndefined();
    expect(await listStaff(getAppDatabase())).toMatchObject([{ role: "ADMIN", disabled: true }]);
  });
});

describe("authenticateStaff", () => {
  it("returns the team member for the right email and password", async () => {
    await expect(
      authenticateStaff(getAppDatabase(), " dana.support@team.example ", password),
    ).resolves.toEqual({
      contactId,
      name: "Dana Support",
      email: "dana.support@team.example",
      role: "MEMBER",
    });
  });

  it("refuses a wrong password, an unknown email and a disabled account", async () => {
    await expect(authenticateStaff(getAppDatabase(), account.email, "wrong")).resolves.toBe(
      undefined,
    );
    await expect(
      authenticateStaff(getAppDatabase(), "nobody@team.example", password),
    ).resolves.toBe(undefined);

    await getDatabase().update(staffAccounts).set({ disabledAt: new Date() });

    await expect(authenticateStaff(getAppDatabase(), account.email, password)).resolves.toBe(
      undefined,
    );
  });

  it("does not give an account to a contact who only writes to the agent", async () => {
    await getDatabase().insert(contacts).values({ email: "client@acme.example" });

    await expect(authenticateStaff(getAppDatabase(), "client@acme.example", "")).resolves.toBe(
      undefined,
    );
  });
});

async function admin(email: string): Promise<string> {
  return saveStaffAccount(
    getAppDatabase(),
    staffAccountInput.parse({ email, name: "Admin", password, role: "ADMIN" }),
  );
}

describe("administration of the accounts", () => {
  it("lists the accounts with their role and state", async () => {
    await admin("eve.admin@team.example");

    expect(await listStaff(getAppDatabase())).toEqual([
      {
        contactId,
        email: "dana.support@team.example",
        name: "Dana Support",
        role: "MEMBER",
        disabled: false,
      },
      expect.objectContaining({ email: "eve.admin@team.example", role: "ADMIN" }),
    ]);
  });

  it("never removes the last administrator, by role or by disabling", async () => {
    const eve = await admin("eve.admin@team.example");

    expect(await setStaffRole(getAppDatabase(), eve, "MEMBER")).toEqual({
      ok: false,
      error: "LAST_ADMIN",
    });
    expect(await setStaffDisabled(getAppDatabase(), eve, true)).toEqual({
      ok: false,
      error: "LAST_ADMIN",
    });
    expect(await setStaffRole(getAppDatabase(), contactId, "ADMIN")).toEqual({
      ok: true,
      value: null,
    });
    expect(await setStaffRole(getAppDatabase(), eve, "MEMBER")).toEqual({ ok: true, value: null });
  });

  it("ends the sessions of an account that is disabled, and enables it again", async () => {
    const { token } = await openSession(getAppDatabase(), contactId);

    await setStaffDisabled(getAppDatabase(), contactId, true);
    await expect(findSession(getAppDatabase(), token)).resolves.toBeUndefined();
    await expect(
      authenticateStaff(getAppDatabase(), account.email, password),
    ).resolves.toBeUndefined();

    await setStaffDisabled(getAppDatabase(), contactId, false);
    await expect(
      authenticateStaff(getAppDatabase(), account.email, password),
    ).resolves.toBeDefined();
  });

  it("gives a new password, which ends every session", async () => {
    const { token } = await openSession(getAppDatabase(), contactId);

    await setStaffPassword(getAppDatabase(), contactId, "a password given by the admin");

    await expect(findSession(getAppDatabase(), token)).resolves.toBeUndefined();
    await expect(
      authenticateStaff(getAppDatabase(), account.email, "a password given by the admin"),
    ).resolves.toBeDefined();
  });

  it("lets a person change their own password, keeping only the session they use", async () => {
    const used = await openSession(getAppDatabase(), contactId);
    const other = await openSession(getAppDatabase(), contactId);
    const member = { contactId, email: "dana.support@team.example" };

    expect(
      await changeOwnPassword(
        getAppDatabase(),
        member,
        "wrong password!!",
        "a new long password",
        used.token,
      ),
    ).toEqual({ ok: false, error: "WRONG_PASSWORD" });
    expect(
      await changeOwnPassword(
        getAppDatabase(),
        member,
        password,
        "a new long password",
        used.token,
      ),
    ).toEqual({ ok: true, value: null });

    await expect(findSession(getAppDatabase(), used.token)).resolves.toBeDefined();
    await expect(findSession(getAppDatabase(), other.token)).resolves.toBeUndefined();
    await expect(
      authenticateStaff(getAppDatabase(), member.email, "a new long password"),
    ).resolves.toBeDefined();
  });
});
