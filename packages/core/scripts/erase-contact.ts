// Erases the personal data of a person who asks for it (GDPR, article 17): what they wrote, the
// answers they got, the texts of their requests, their files, and who they are. The requests keep
// their type, status, project and dates. Without --confirm, it only shows what it would erase.
// It connects as the owner of the database (DATABASE_URL), the only one allowed to change history.
// Usage: pnpm contact:erase --email bruno.leroy@globex.example [--confirm]
//        pnpm contact:erase --slack U012AB3CD [--confirm]
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

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

// Files written by the widget are named by a UUID: anything else is never deleted.
const storageRef = z.uuid();
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
      const folder = attachmentsDir ?? "";
      await Promise.all(
        erasure.storageRefs
          .filter((ref) => storageRef.safeParse(ref).success)
          .map((ref) => rm(join(folder, ref), { force: true })),
      );
      console.info("Erased.");
    }
  }
} finally {
  await close();
}
