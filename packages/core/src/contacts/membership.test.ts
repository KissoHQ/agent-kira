import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { alice, bruno } from "../../test/fixtures.ts";
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

  it("is false for a contact of another project, an unknown person or an unknown project", async () => {
    const answers = await Promise.all([
      worksOnProjectByEmail(getAppDatabase(), alice, "PORTAL"),
      worksOnProjectByEmail(getAppDatabase(), "nobody@globex.example", "PORTAL"),
      worksOnProjectByEmail(getAppDatabase(), bruno, "NOPE"),
    ]);

    expect(answers).toEqual([false, false, false]);
  });
});
