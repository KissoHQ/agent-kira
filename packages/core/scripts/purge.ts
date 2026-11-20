// Deletes the data the system no longer needs: sessions of the web interface that ended more than
// a month ago, the original payload of messages handled more than a set number of days ago, 365 by
// default, and the files attached through the widget more than ATTACHMENT_RETENTION_DAYS ago, 40
// by default. The texts
// of the messages, and the name, type and size of each file, stay. Files left in the folder that
// no message refers to are deleted too. Meant to run once a day, such as from cron.
// It connects as the owner of the database (DATABASE_URL), and deletes the files from
// ATTACHMENTS_DIR.
// Usage: pnpm db:purge [--source-retention-days 365]
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  attachmentRetentionDays,
  deleteStoredFiles,
  findOrphanFiles,
  forgetOldFiles,
} from "../src/admin/files.ts";
import { connectDatabase } from "../src/db/client.ts";
import { loadDatabaseEnv } from "../src/env.ts";
import { purgeOldData } from "../src/privacy/erase.ts";

const { values } = parseArgs({
  options: { "source-retention-days": { type: "string", default: "365" } },
});
const sourceDays = z.coerce.number().int().min(1).safeParse(values["source-retention-days"]);
if (!sourceDays.success) {
  console.error("--source-retention-days must be a whole number of days, at least 1");
  process.exit(1);
}
const attachmentDays = attachmentRetentionDays.safeParse(process.env.ATTACHMENT_RETENTION_DAYS);
if (!attachmentDays.success) {
  console.error("ATTACHMENT_RETENTION_DAYS must be a whole number of days, at least 1");
  process.exit(1);
}
const attachmentsDir = process.env.ATTACHMENTS_DIR;
if (attachmentsDir !== undefined && attachmentsDir !== "" && !isAbsolute(attachmentsDir)) {
  console.error("ATTACHMENTS_DIR must be an absolute path");
  process.exit(1);
}

const { DATABASE_URL } = loadDatabaseEnv();
const { db, close } = connectDatabase(DATABASE_URL, { statementTimeoutMs: 0 });
try {
  const purged = await purgeOldData(db, { sourceRetentionDays: sourceDays.data });
  console.info(`Sessions deleted: ${purged.sessions}. Message sources emptied: ${purged.sources}.`);
  if (attachmentsDir === undefined || attachmentsDir === "") {
    console.info("ATTACHMENTS_DIR is not set: no file is kept, none to delete.");
  } else {
    // The orphans are listed before the old files are forgotten, so a file whose deletion fails
    // below is found again by the next purge.
    const orphans = await findOrphanFiles(db, attachmentsDir);
    const old = await forgetOldFiles(db, { retentionDays: attachmentDays.data });
    const files = await deleteStoredFiles(attachmentsDir, [...old, ...orphans]);
    console.info(`Files deleted: ${files.deleted} (${old.length} old, ${orphans.length} orphan).`);
    if (files.failed.length > 0) {
      console.error("These files could not be deleted; the next purge tries them again:");
      console.error(files.failed.join("\n"));
      process.exitCode = 1;
    }
  }
} finally {
  await close();
}
