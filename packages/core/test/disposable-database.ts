import { Client } from "pg";

import { configureRole } from "../src/db/app-role.ts";
import { connectDatabase } from "../src/db/client.ts";
import { migrateDatabase } from "../src/db/migrate.ts";
import { appRole, serverRole } from "../src/env.ts";

// The tests and the measures empty or drop their database, so they only run on one whose name
// marks it as disposable.
const disposableName = /^[a-z0-9_]+_test$/;

// Name of the database of a URL, checked to be disposable.
export function disposableDatabaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!disposableName.test(name)) {
    throw new Error(`The database name must end with _test, got "${name}"`);
  }
  return name;
}

// Same database, reached with a restricted role of the application.
export function asRole(databaseUrl: string, roleDatabaseUrl: string): string {
  const roleUrl = new URL(roleDatabaseUrl);
  const url = new URL(databaseUrl);
  url.username = roleUrl.username;
  url.password = roleUrl.password;
  return url.href;
}

// Runs statements on the maintenance database of the same server, where databases are created
// and dropped.
async function onServer(databaseUrl: string, task: (client: Client) => Promise<void>) {
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = "/postgres";
  const client = new Client({ connectionString: maintenanceUrl.href });
  await client.connect();
  try {
    await task(client);
  } finally {
    await client.end();
  }
}

export async function createDatabaseIfMissing(databaseUrl: string): Promise<void> {
  const name = disposableDatabaseName(databaseUrl);
  await onServer(databaseUrl, async (client) => {
    const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      // The name cannot be a query parameter; it is safe because it matched disposableName.
      await client.query(`create database "${name}"`);
    }
  });
}

export async function dropDatabaseIfExists(databaseUrl: string): Promise<void> {
  const name = disposableDatabaseName(databaseUrl);
  await onServer(databaseUrl, async (client) => {
    // Same as above: the name matched disposableName.
    await client.query(`drop database if exists "${name}"`);
  });
}

// Applies the migrations and gives the roles of the application their passwords, as
// `pnpm db:migrate` does.
export async function prepareDatabase(
  databaseUrl: string,
  appDatabaseUrl: string,
  serverDatabaseUrl: string,
): Promise<void> {
  const { db, close } = connectDatabase(databaseUrl);
  try {
    await migrateDatabase(db);
    await configureRole(db, appRole, appDatabaseUrl);
    await configureRole(db, serverRole, serverDatabaseUrl);
  } finally {
    await close();
  }
}
