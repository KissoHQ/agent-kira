import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { alice, bruno } from "../../test/fixtures.ts";
import { contacts, projects } from "../db/schema.ts";
import { seedDatabase } from "../db/seed.ts";
import { worksOnProjectByEmail } from "./membership.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

beforeEach(async () => {
  await seedDatabase(getDatabase());
});

describe("worksOnProjectByEmail", () => {
  it("is true for a contact of the project, whatever the case of the email and key", async () => {
    expect(await worksOnProjectByEmail(getAppDatabase(), bruno.toUpperCase(), "portal")).toBe(true);
  });

  it("is false for a disabled contact or an archived project", async () => {
    await getDatabase()
      .update(contacts)
      .set({ disabledAt: new Date() })
      .where(eq(contacts.email, bruno));
    expect(await worksOnProjectByEmail(getAppDatabase(), bruno, "PORTAL")).toBe(false);

    await getDatabase().update(contacts).set({ disabledAt: null });
    await getDatabase()
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.key, "PORTAL"));
    expect(await worksOnProjectByEmail(getAppDatabase(), bruno, "PORTAL")).toBe(false);
  });

  it("is false for a contact of another project, an unknown person or an unknown project", async () => {
    const answers = await Promise.all([
      worksOnProjectByEmail(getAppDatabase(), alice, "PORTAL"),
      worksOnProjectByEmail(getAppDatabase(), "nobody@globex.example", "PORTAL"),
      worksOnProjectByEmail(getAppDatabase(), bruno, "NOPE"),
    ]);

    expect(answers).toEqual([false, false, false]);
  });
});
