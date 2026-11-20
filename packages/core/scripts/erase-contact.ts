// Erases the personal data of a person who asks for it (GDPR, article 17): what they wrote, the
// answers they got, the texts of their requests, their files, and who they are. The requests keep
// their type, status, project and dates. Without --confirm, it only shows what it would erase.
// It connects as the owner of the database (DATABASE_URL), the only one allowed to change history.
// Usage: pnpm contact:erase --email bruno.leroy@globex.example [--confirm]
//        pnpm contact:erase --slack U012AB3CD [--confirm]
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { deleteStoredFiles } from "../src/admin/files.ts";
import { connectDatabase } from "../src/db/client.ts";
import { loadDatabaseEnv } from "../src/env.ts";
import { erasePerson, personInput } from "../src/privacy/erase.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    slack: { type: "string" },
    confirm: { type: "boolean", default: false },
  },
});
const person = personInput.safeParse({ email: values.email, slackUserId: values.slack });
if (!person.success) {
  console.error(`Invalid person:\n${z.prettifyError(person.error)}`);
  process.exit(1);
}

const attachmentsDir = process.env.ATTACHMENTS_DIR;

const { DATABASE_URL } = loadDatabaseEnv();
const { db, close } = connectDatabase(DATABASE_URL, { statementTimeoutMs: 0 });
try {
  const result = await erasePerson(db, person.data, values.confirm);
  if (!result.ok) {
    console.error("This person has an account of the team: disable it in the web interface.");
    process.exitCode = 1;
  } else {
    const erasure = result.value;
    console.info(
      [
        `Contact: ${erasure.contact ? "found" : "none, only messages from this address"}`,
        `Messages written: ${erasure.messages}`,
        `Answers received: ${erasure.answers}`,
        `Requests: ${erasure.requests}`,
        `History events: ${erasure.events}`,
        `Files: ${erasure.attachments}`,
      ].join("\n"),
    );
    if (!values.confirm) {
      console.info("Nothing was erased. Run again with --confirm to erase it.");
    } else if (
      erasure.storageRefs.length > 0 &&
      (attachmentsDir === undefined || !isAbsolute(attachmentsDir))
    ) {
      console.error("Set ATTACHMENTS_DIR to delete the files themselves:");
      console.error(erasure.storageRefs.join("\n"));
      process.exitCode = 1;
    } else {
      // Every file is tried: one that cannot be deleted, such as on a read-only folder, is listed,
      // and the daily purge deletes it once no message refers to it.
      const { failed: left } = await deleteStoredFiles(attachmentsDir ?? "", erasure.storageRefs);
      if (left.length > 0) {
        console.error(
          "The database is erased, but these files could not be deleted; the daily purge tries them again:",
        );
        console.error(left.join("\n"));
        process.exitCode = 1;
      } else {
        console.info("Erased.");
      }
    }
  }
} finally {
  await close();
}
