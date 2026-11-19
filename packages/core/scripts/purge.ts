// Deletes the data the system no longer needs: sessions of the web interface that ended more than
// a month ago, and the original payload of messages handled more than a set number of days ago,
// 365 by default. The texts of the messages stay. Meant to run once a day, such as from cron.
// It connects as the owner of the database (DATABASE_URL).
// Usage: pnpm db:purge [--source-retention-days 365]
import { parseArgs } from "node:util";

import { z } from "zod";

import { connectDatabase } from "../src/db/client.ts";
import { loadDatabaseEnv } from "../src/env.ts";
import { purgeOldData } from "../src/privacy/erase.ts";

const { values } = parseArgs({
  options: { "source-retention-days": { type: "string", default: "365" } },
});
const days = z.coerce.number().int().min(1).safeParse(values["source-retention-days"]);
if (!days.success) {
  console.error("--source-retention-days must be a whole number of days, at least 1");
  process.exit(1);
}

const { DATABASE_URL } = loadDatabaseEnv();
const { db, close } = connectDatabase(DATABASE_URL, { statementTimeoutMs: 0 });
try {
  const purged = await purgeOldData(db, { sourceRetentionDays: days.data });
  console.info(`Sessions deleted: ${purged.sessions}. Message sources emptied: ${purged.sources}.`);
} finally {
  await close();
}
