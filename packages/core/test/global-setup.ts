import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import { loadAppDatabaseEnv, loadServerDatabaseEnv, loadTestDatabaseEnv } from "../src/env.ts";
import {
  asRole,
  createDatabaseIfMissing,
  disposableDatabaseName,
  prepareDatabase,
} from "./disposable-database.ts";

const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));

export default async function setup(project: TestProject): Promise<void> {
  if (existsSync(rootEnvFile)) {
    process.loadEnvFile(rootEnvFile);
  }
  const { TEST_DATABASE_URL } = loadTestDatabaseEnv();
  const { APP_DATABASE_URL } = loadAppDatabaseEnv();
  const { SERVER_DATABASE_URL } = loadServerDatabaseEnv();
  // The tests empty every table, so they only run on a database whose name marks it as disposable.
  try {
    disposableDatabaseName(TEST_DATABASE_URL);
  } catch (error) {
    throw new Error("TEST_DATABASE_URL must point to a database whose name ends with _test", {
      cause: error,
    });
  }

  try {
    await createDatabaseIfMissing(TEST_DATABASE_URL);
  } catch (error) {
    throw new Error("Cannot reach the test database. Start it with `pnpm db:up`.", {
      cause: error,
    });
  }

  await prepareDatabase(TEST_DATABASE_URL, APP_DATABASE_URL, SERVER_DATABASE_URL);
  project.provide("testDatabaseUrl", TEST_DATABASE_URL);
  project.provide("testAppDatabaseUrl", asRole(TEST_DATABASE_URL, APP_DATABASE_URL));
  project.provide("testServerDatabaseUrl", asRole(TEST_DATABASE_URL, SERVER_DATABASE_URL));
}
