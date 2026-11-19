import { describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { isUniqueViolation } from "./errors.ts";
import { organizations } from "./schema.ts";

useTestDatabase();
const getAppDatabase = useAppTestDatabase();

describe("isUniqueViolation", () => {
  it("recognizes a value already taken, and nothing else", async () => {
    await getAppDatabase().insert(organizations).values({ name: "A", emailDomain: "a.example" });

    const taken = await getAppDatabase()
      .insert(organizations)
      .values({ name: "B", emailDomain: "a.example" })
      .catch((error: unknown) => error);

    expect(isUniqueViolation(taken)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
    expect(isUniqueViolation("text")).toBe(false);
  });
});
