import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { useAppTestDatabase, useTestDatabase } from "../../test/database.ts";
import { bruno, storeMessage } from "../../test/fixtures.ts";
import { attachments } from "../db/schema.ts";
import { seedDatabase } from "../db/seed.ts";
import {
  deleteStoredFiles,
  findOrphanFiles,
  forgetOldFiles,
  forgetStoredFile,
  listStoredFiles,
} from "./files.ts";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

let folder: string;

beforeEach(async () => {
  await seedDatabase(getDatabase());
  folder = await mkdtemp(join(tmpdir(), "files-"));
});

// A file the widget stored, on disk and in the database, received at the given time.
async function storedFile(createdAt: Date): Promise<{ id: string; storageRef: string }> {
  const messageId = await storeMessage(getDatabase(), { sender: bruno, bodyText: "Capture" });
  const storageRef = randomUUID();
  await writeFile(join(folder, storageRef), "image");
  const [row] = await getDatabase()
    .insert(attachments)
    .values({
      messageId,
      filename: "capture.png",
      contentType: "image/png",
      sizeBytes: 5,
      storageRef,
      createdAt,
    })
    .returning({ id: attachments.id });
  if (row === undefined) {
    throw new Error("The file was not stored");
  }
  return { id: row.id, storageRef };
}

describe("stored files", () => {
  it("lists the stored files with the space they take, newest first", async () => {
    await storedFile(new Date("2026-11-01T10:00:00Z"));
    const newest = await storedFile(new Date("2026-11-10T10:00:00Z"));

    const listed = await listStoredFiles(getAppDatabase(), 1);

    expect(listed).toMatchObject({ total: 2, totalBytes: 10, page: 1 });
    expect(listed.rows[0]).toMatchObject({
      id: newest.id,
      filename: "capture.png",
      reference: null,
    });
  });

  it("forgets a file once, and keeps its name, type and size", async () => {
    const file = await storedFile(new Date());

    const first = await forgetStoredFile(getAppDatabase(), file.id);
    const again = await forgetStoredFile(getAppDatabase(), file.id);

    expect(first).toEqual({ ok: true, value: file.storageRef });
    expect(again).toEqual({ ok: false, error: "NOT_FOUND" });
    const [row] = await getDatabase().select().from(attachments).where(eq(attachments.id, file.id));
    expect(row).toMatchObject({ filename: "capture.png", sizeBytes: 5, storageRef: null });
    expect((await listStoredFiles(getAppDatabase(), 1)).total).toBe(0);
  });

  it("forgets the files older than the retention, and only those", async () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const old = await storedFile(new Date("2026-10-01T12:00:00Z"));
    const recent = await storedFile(new Date("2026-11-15T12:00:00Z"));

    const forgotten = await forgetOldFiles(getDatabase(), { retentionDays: 40, now });

    expect(forgotten).toEqual([old.storageRef]);
    expect((await listStoredFiles(getAppDatabase(), 1)).rows.map((row) => row.id)).toEqual([
      recent.id,
    ]);
  });

  it("deletes the files from the folder, and never a name that is not one of its files", async () => {
    const file = await storedFile(new Date());
    await writeFile(join(folder, "notes.txt"), "keep");

    const result = await deleteStoredFiles(folder, [file.storageRef, "../notes.txt", randomUUID()]);

    expect(result).toEqual({ deleted: 2, failed: [] });
    expect(await readdir(folder)).toEqual(["notes.txt"]);
  });

  it("finds the files no message refers to, once they are an hour old", async () => {
    const now = new Date();
    const kept = await storedFile(now);
    const orphan = randomUUID();
    const beingReceived = randomUUID();
    await writeFile(join(folder, orphan), "lost");
    await writeFile(join(folder, beingReceived), "new");
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    await utimes(join(folder, orphan), twoHoursAgo, twoHoursAgo);
    await utimes(join(folder, kept.storageRef), twoHoursAgo, twoHoursAgo);

    expect(await findOrphanFiles(getAppDatabase(), folder, now)).toEqual([orphan]);
    expect(await findOrphanFiles(getAppDatabase(), join(folder, "missing"), now)).toEqual([]);
  });
});
