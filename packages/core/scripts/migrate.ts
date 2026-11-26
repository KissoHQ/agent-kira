import { configureRole } from "../src/db/app-role.ts";
import { connectDatabase } from "../src/db/client.ts";
import { migrateDatabase } from "../src/db/migrate.ts";
import {
  appRole,
  loadAppDatabaseEnv,
  loadDatabaseEnv,
  loadServerDatabaseEnv,
  serverRole,
} from "../src/env.ts";

const { DATABASE_URL } = loadDatabaseEnv();
const { APP_DATABASE_URL } = loadAppDatabaseEnv();
const { SERVER_DATABASE_URL } = loadServerDatabaseEnv();
// A migration may build an index on a large table: it runs without the statement limit of the app.
const { db, close } = connectDatabase(DATABASE_URL, { statementTimeoutMs: 0 });
try {
  await migrateDatabase(db);
  await configureRole(db, appRole, APP_DATABASE_URL);
  await configureRole(db, serverRole, SERVER_DATABASE_URL);
  console.info("Database migrations applied and the roles of the application configured.");
} finally {
  await close();
}
