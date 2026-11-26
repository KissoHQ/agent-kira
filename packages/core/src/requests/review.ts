import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database, Transaction } from "../db/client.ts";
import { events, projects, requests } from "../db/schema.ts";
import { parseReference } from "./reference.ts";
import {
  fail,
  type RequestView,
  type Result,
  selectRequestViews,
  succeed,
  toRequestView,
} from "./views.ts";

// The person who reviews, as recorded in the history. These operations are for the team, not for
// senders: the caller, such as the web interface, decides who may use them.
export interface Reviewer {
  contactId: string | null;
}

type RequestRow = typeof requests.$inferSelect;

const reference = z.string().regex(/^REQ-\d{1,9}$/i);

export const reviewRequestInput = z.object({
  reference,
  changes: z
    .object({
      type: z.enum(requests.type.enumValues).optional(),
      priority: z.enum(requests.priority.enumValues).nullable().optional(),
      projectKey: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/)
        .nullable()
        .optional(),
      status: z.enum(requests.status.enumValues).optional(),
    })
    .default({}),
  // The time of the last change the person saw. When the request changed since, such as a message
  // the agent added, the review is refused, so the person never overwrites what they did not see.
  version: z.iso.datetime().optional(),
});

export const markDuplicateInput = z.object({
  reference,
  duplicateOf: reference,
  // As for a review: a request that changed since the page was opened is not closed.
  version: z.iso.datetime().optional(),
});

export type ReviewRequestInput = z.infer<typeof reviewRequestInput>;
export type MarkDuplicateInput = z.infer<typeof markDuplicateInput>;

export interface ReviewItem {
  request: RequestView;
  // Why the request waits for a person, as recorded when it was classified.
  reasons: string[];
}

async function lockRequest(tx: Transaction, value: string): Promise<RequestRow | undefined> {
  const requestNumber = parseReference(value);
  if (requestNumber === undefined) {
    return undefined;
  }
  const [row] = await tx
    .select()
    .from(requests)
    .where(eq(requests.number, requestNumber))
    .for("update");
  return row;
}

async function view(tx: Database | Transaction, requestId: string): Promise<RequestView> {
  const [row] = await selectRequestViews(tx, eq(requests.id, requestId));
  if (row === undefined) {
    throw new Error(`Request ${requestId} disappeared`);
  }
  return toRequestView(row);
}

// Requests shown on one page of the review queue.
export const reviewPageSize = 50;

export interface ReviewQueuePage {
  items: ReviewItem[];
  // Every request waiting for a person, on all pages.
  total: number;
  page: number;
}

// Requests waiting for a person, oldest first, a page at a time, with the reasons of the review.
export async function listReviewQueue(db: Database, page = 1): Promise<ReviewQueuePage> {
  const waiting = eq(requests.needsReview, true);
  const [rows, [counted]] = await Promise.all([
    selectRequestViews(db, waiting)
      .orderBy(asc(requests.createdAt), asc(requests.number))
      .limit(reviewPageSize)
      .offset((page - 1) * reviewPageSize),
    db.select({ value: count() }).from(requests).where(waiting),
  ]);
  const reasons = await reviewReasonsFor(
    db,
    rows.map((row) => row.id),
  );
  return {
    items: rows.map((row) => ({ request: toRequestView(row), reasons: reasons.get(row.id) ?? [] })),
    total: counted?.value ?? 0,
    page,
  };
}

const classifiedData = z
  .object({ reviewReasons: z.array(z.string()).default([]) })
  .catch({ reviewReasons: [] });

// Why each request was sent to a person: the reasons recorded by its latest classification, and a
// question the agent passed to the team since the last review. Two queries for all the requests.
async function reviewReasonsFor(
  db: Database,
  requestIds: string[],
): Promise<Map<string, string[]>> {
  if (requestIds.length === 0) {
    return new Map();
  }
  const [classified, latest] = await Promise.all([
    db
      .selectDistinctOn([events.requestId], { requestId: events.requestId, data: events.data })
      .from(events)
      .where(and(inArray(events.requestId, requestIds), eq(events.type, "CLASSIFIED")))
      .orderBy(events.requestId, desc(events.createdAt), desc(events.id)),
    db
      .selectDistinctOn([events.requestId], { requestId: events.requestId, type: events.type })
      .from(events)
      .where(
        and(
          inArray(events.requestId, requestIds),
          inArray(events.type, ["REVIEW_REQUESTED", "REVIEWED"]),
        ),
      )
      .orderBy(events.requestId, desc(events.createdAt), desc(events.id)),
  ]);
  return new Map(
    requestIds.map((id) => {
      const reasons = classifiedData.parse(
        classified.find((row) => row.requestId === id)?.data ?? {},
      ).reviewReasons;
      const forwarded = latest.find((row) => row.requestId === id)?.type === "REVIEW_REQUESTED";
      return [
        id,
        forwarded && !reasons.includes("QUESTION_FOR_TEAM")
          ? [...reasons, "QUESTION_FOR_TEAM"]
          : reasons,
      ];
    }),
  );
}

export async function reviewReasonsOf(db: Database, requestId: string): Promise<string[]> {
  return (await reviewReasonsFor(db, [requestId])).get(requestId) ?? [];
}

// A person checked the request: it leaves the queue, with the corrections they made, recorded in
// its history.
export function reviewRequest(
  db: Database,
  reviewer: Reviewer,
  input: ReviewRequestInput,
): Promise<Result<RequestView, "NOT_FOUND" | "PROJECT_NOT_FOUND" | "CHANGED">> {
  return db.transaction(async (tx) => {
    const request = await lockRequest(tx, input.reference);
    if (request === undefined) {
      return fail("NOT_FOUND");
    }
    if (input.version !== undefined && request.updatedAt.getTime() !== Date.parse(input.version)) {
      return fail("CHANGED");
    }
    const values: Partial<RequestRow> = { needsReview: false };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const { type, priority, projectKey, status } = input.changes;
    if (type !== undefined && type !== request.type) {
      values.type = type;
      changes.type = { from: request.type, to: type };
    }
    if (priority !== undefined && priority !== request.priority) {
      values.priority = priority;
      changes.priority = { from: request.priority, to: priority };
    }
    if (projectKey !== undefined) {
      const [project] =
        projectKey === null
          ? [{ id: null }]
          : await tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.key, projectKey.toUpperCase()));
      if (project === undefined) {
        return fail("PROJECT_NOT_FOUND");
      }
      if (project.id !== request.projectId) {
        values.projectId = project.id;
        changes.projectKey = { from: (await view(tx, request.id)).projectKey, to: projectKey };
      }
    }
    if (status !== undefined && status !== request.status) {
      values.status = status;
    }
    await tx.update(requests).set(values).where(eq(requests.id, request.id));
    const actor = {
      requestId: request.id,
      actorType: "HUMAN" as const,
      actorContactId: reviewer.contactId,
    };
    if (values.status !== undefined) {
      await tx.insert(events).values({
        ...actor,
        type: "STATUS_CHANGED",
        data: { from: request.status, to: values.status },
      });
    }
    await tx.insert(events).values({ ...actor, type: "REVIEWED", data: { changes } });
    return succeed(await view(tx, request.id));
  });
}

// Locks two requests in one statement, in the order of their numbers, so two people marking them
// against each other at the same time wait for one another instead of blocking each other.
async function lockPair(
  tx: Transaction,
  first: string,
  second: string,
): Promise<[RequestRow | undefined, RequestRow | undefined]> {
  const firstNumber = parseReference(first);
  const secondNumber = parseReference(second);
  const numbers = [firstNumber, secondNumber].filter((value) => value !== undefined);
  if (numbers.length === 0) {
    return [undefined, undefined];
  }
  const rows = await tx
    .select()
    .from(requests)
    .where(inArray(requests.number, numbers))
    .orderBy(asc(requests.number))
    .for("update");
  const find = (value: number | undefined) => rows.find((row) => row.number === value);
  return [find(firstNumber), find(secondNumber)];
}

// A person found that the request repeats another one: it is closed and points to the original.
// Every duplicate points straight to an original that is not itself a duplicate: the requests that
// pointed to this one now point to its original, so no chain and no loop can form.
export function markDuplicate(
  db: Database,
  reviewer: Reviewer,
  input: MarkDuplicateInput,
): Promise<
  Result<RequestView, "NOT_FOUND" | "SAME_REQUEST" | "ORIGINAL_IS_DUPLICATE" | "CHANGED">
> {
  return db.transaction(async (tx) => {
    const [request, original] = await lockPair(tx, input.reference, input.duplicateOf);
    if (request === undefined || original === undefined) {
      return fail("NOT_FOUND");
    }
    if (request.id === original.id) {
      return fail("SAME_REQUEST");
    }
    if (input.version !== undefined && request.updatedAt.getTime() !== Date.parse(input.version)) {
      return fail("CHANGED");
    }
    if (original.duplicateOfRequestId !== null) {
      return fail("ORIGINAL_IS_DUPLICATE");
    }
    await tx
      .update(requests)
      .set({ duplicateOfRequestId: original.id, status: "CLOSED", needsReview: false })
      .where(eq(requests.id, request.id));
    const repointed = await tx
      .update(requests)
      .set({ duplicateOfRequestId: original.id })
      .where(eq(requests.duplicateOfRequestId, request.id))
      .returning({ id: requests.id });
    const originalReference = (await view(tx, original.id)).reference;
    const byReviewer = { actorType: "HUMAN" as const, actorContactId: reviewer.contactId };
    await tx.insert(events).values([
      {
        ...byReviewer,
        requestId: request.id,
        type: "MARKED_DUPLICATE",
        data: { duplicateOf: originalReference },
      },
      {
        ...byReviewer,
        requestId: request.id,
        type: "STATUS_CHANGED",
        data: { from: request.status, to: "CLOSED" },
      },
      ...repointed.map((row) => ({
        actorType: byReviewer.actorType,
        actorContactId: byReviewer.actorContactId,
        requestId: row.id,
        type: "MARKED_DUPLICATE" as const,
        data: { duplicateOf: originalReference },
      })),
    ]);
    return succeed(await view(tx, request.id));
  });
}
