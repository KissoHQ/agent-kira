import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import type { TestProject } from "vitest/node";

import { configureRole } from "../src/db/app-role.ts";
import { connectDatabase } from "../src/db/client.ts";
import { migrateDatabase } from "../src/db/migrate.ts";
import {
  appRole,
  loadAppDatabaseEnv,
  loadServerDatabaseEnv,
  loadTestDatabaseEnv,
  serverRole,
} from "../src/env.ts";

// The tests empty every table, so they only run on a database whose name marks it as disposable.
const testDatabaseName = /^[a-z0-9_]+_test$/;

const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));

// Same test database, reached with a restricted role of the application.
function asRole(testDatabaseUrl: URL, roleDatabaseUrl: string): string {
  const roleUrl = new URL(roleDatabaseUrl);
  const url = new URL(testDatabaseUrl);
  url.username = roleUrl.username;
  url.password = roleUrl.password;
  return url.href;
}

async function createDatabaseIfMissing(databaseUrl: URL, name: string): Promise<void> {
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  const client = new Client({ connectionString: maintenanceUrl.href });
  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      // The name cannot be a query parameter; it is safe because it matched testDatabaseName.
      await client.query(`create database "${name}"`);
    }
  } finally {
    await client.end();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  if (existsSync(rootEnvFile)) {
    process.loadEnvFile(rootEnvFile);
  }
  const { TEST_DATABASE_URL } = loadTestDatabaseEnv();
  const { APP_DATABASE_URL } = loadAppDatabaseEnv();
  const { SERVER_DATABASE_URL } = loadServerDatabaseEnv();
  const databaseUrl = new URL(TEST_DATABASE_URL);
  const name = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!testDatabaseName.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL must point to a database whose name ends with _test, got "${name}"`,
    );
  }

  try {
    await createDatabaseIfMissing(databaseUrl, name);
  } catch (error) {
    throw new Error("Cannot reach the test database. Start it with `pnpm db:up`.", {
      cause: error,
    });
  }

  const { db, close } = connectDatabase(TEST_DATABASE_URL);
  try {
    await migrateDatabase(db);
    await configureRole(db, appRole, APP_DATABASE_URL);
    await configureRole(db, serverRole, SERVER_DATABASE_URL);
  } finally {
    await close();
  }
  project.provide("testDatabaseUrl", TEST_DATABASE_URL);
  project.provide("testAppDatabaseUrl", asRole(databaseUrl, APP_DATABASE_URL));
  project.provide("testServerDatabaseUrl", asRole(databaseUrl, SERVER_DATABASE_URL));
}
