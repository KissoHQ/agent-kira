import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { count, desc, eq, isNotNull, sql, sum } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client.ts";
import { attachments, messages, requests } from "../db/schema.ts";
import { formatReference } from "../requests/reference.ts";
import { fail, type Result, succeed } from "../requests/views.ts";

// The files people attach through the widget take space on the server, under a quota: once it is
// full, new files are refused. They are kept 40 days by default, then deleted by the daily purge,
// and an administrator deletes any of them earlier from the web interface. A deleted file leaves
// its name, type, size and date with its message: only its content is gone.

export const defaultAttachmentRetentionDays = 40;
export const filesPageSize = 50;

// Files are written by the widget under random UUIDs: any other name in the folder is never
// touched.
const storageRef = z.uuid();

export interface StoredFileRow {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  // The request of the message the file came with, if it was filed.
  reference: string | null;
}

export interface StoredFiles {
  rows: StoredFileRow[];
  // Every stored file, on all pages, and the space they take.
  total: number;
  totalBytes: number;
  page: number;
}

// The files kept on the server, newest first, one page at a time.
export async function listStoredFiles(db: Database, page: number): Promise<StoredFiles> {
  const stored = isNotNull(attachments.storageRef);
  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        contentType: attachments.contentType,
        sizeBytes: attachments.sizeBytes,
        createdAt: attachments.createdAt,
        number: requests.number,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .leftJoin(requests, eq(requests.id, messages.requestId))
      .where(stored)
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      .limit(filesPageSize)
      .offset((page - 1) * filesPageSize),
    db
      .select({ total: count(), totalBytes: sum(attachments.sizeBytes).mapWith(Number) })
      .from(attachments)
      .where(stored),
  ]);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      reference: row.number === null ? null : formatReference(row.number),
    })),
    total: totals?.total ?? 0,
    totalBytes: totals?.totalBytes ?? 0,
    page,
  };
}

// Forgets where a file is stored, so it is no longer served, and returns where it was, for the
// caller to delete it from the folder. The old location is read in the same statement, so two
// administrators deleting the same file at once delete it once.
export async function forgetStoredFile(
  db: Database,
  id: string,
): Promise<Result<string, "NOT_FOUND">> {
  const result = await db.execute<{ storage_ref: string }>(sql`
    with old as (
      select ${attachments.id} as id, ${attachments.storageRef} as storage_ref
      from ${attachments}
      where ${attachments.id} = ${id} and ${attachments.storageRef} is not null
      for update
    )
    update ${attachments} set storage_ref = null from old
    where ${attachments.id} = old.id
    returning old.storage_ref
  `);
  const [row] = result.rows;
  return row === undefined ? fail("NOT_FOUND") : succeed(row.storage_ref);
}

// Forgets the files kept longer than the retention, and returns where they were.
export async function forgetOldFiles(
  db: Database,
  options: { retentionDays: number; now?: Date },
): Promise<string[]> {
  const now = options.now ?? new Date();
  const limit = new Date(now.getTime() - options.retentionDays * 24 * 60 * 60 * 1000);
  const result = await db.execute<{ storage_ref: string }>(sql`
    with old as (
      select ${attachments.id} as id, ${attachments.storageRef} as storage_ref
      from ${attachments}
      where ${attachments.storageRef} is not null and ${attachments.createdAt} < ${limit}
      for update
    )
    update ${attachments} set storage_ref = null from old
    where ${attachments.id} = old.id
    returning old.storage_ref
  `);
  return result.rows.map((row) => row.storage_ref);
}

// Deletes stored files from the folder. Every file is tried; those that cannot be deleted are
// returned with the reason, to be reported. A file already gone is not an error.
export async function deleteStoredFiles(
  folder: string,
  storageRefs: string[],
): Promise<{ deleted: number; failed: string[] }> {
  const refs = storageRefs.filter((ref) => storageRef.safeParse(ref).success);
  const removals = await Promise.allSettled(
    refs.map((ref) => rm(join(folder, ref), { force: true })),
  );
  const failed = refs.flatMap((ref, index) => {
    const removal = removals[index];
    return removal?.status === "rejected"
      ? [`${join(folder, ref)}: ${String(removal.reason)}`]
      : [];
  });
  return { deleted: refs.length - failed.length, failed };
}

// Files in the folder that no message refers to, such as one whose deletion failed once. Only
// files older than an hour are listed: a file being received is written before its message is
// stored.
export async function findOrphanFiles(
  db: Database,
  folder: string,
  now: Date = new Date(),
): Promise<string[]> {
  const names = await readdir(folder).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const candidates = names.filter((name) => storageRef.safeParse(name).success);
  if (candidates.length === 0) {
    return [];
  }
  const known = new Set(
    (
      await db
        .select({ storageRef: attachments.storageRef })
        .from(attachments)
        .where(isNotNull(attachments.storageRef))
    ).map((row) => row.storageRef),
  );
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  const unknown = candidates.filter((name) => !known.has(name));
  const ages = await Promise.all(
    unknown.map(async (name) => ({ name, modified: (await stat(join(folder, name))).mtimeMs })),
  );
  return ages.filter((file) => file.modified < hourAgo).map((file) => file.name);
}
