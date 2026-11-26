import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  addressKey,
  type Admission,
  conversationOrigin,
  createRateLimiter,
  type Database,
  listPendingReplies,
  listUnhandledMessages,
  readConversation,
  storeInboundMessage,
  storeOutboundMessage,
  type TurnInput,
  worksOnProjectByEmail,
} from "@request-agent/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";

import type { HandledMessage } from "../agent/handle-message.ts";
import { statusLabels } from "../agent/reply.ts";
import {
  createReplyDelivery,
  createSerialQueue,
  defaultRetryDelaysMs,
  handleReliably,
} from "../reliable-handling.ts";
import {
  createSlots,
  createWaitingCounter,
  maxConcurrentUploads,
  maxWaitingUploads,
  messageRate,
  readRate,
} from "./admission.ts";
import { type AcceptedFile, acceptFiles, maxFileBytes, maxFiles } from "./files.ts";
import { type IdentitySecrets, verifyIdentity } from "./identity.ts";
import { widgetScript } from "./script.ts";

export interface WidgetLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

export interface WidgetOptions {
  db: Database;
  // Runs the agent on a stored message: handleMessage, bound to the agent and the classifier.
  handle: (input: TurnInput) => Promise<HandledMessage>;
  // Origins of the applications allowed to embed the widget, such as https://portal.example.com.
  allowedOrigins: string[];
  // The secret of each project's application, which signs the identity of the person signed in.
  // A project without a secret has only unverified people.
  identitySecrets: IdentitySecrets;
  // Folder where the attached files are written, under random names.
  attachmentsDir: string;
  // Most bytes the files of the folder may take: beyond, new files are refused.
  attachmentsQuotaBytes: number;
  logger: WidgetLogger;
  // Behind a reverse proxy, every request comes from the proxy: the address of the person is the
  // last one the proxy added to X-Forwarded-For. Only set it when such a proxy is in front.
  trustProxy?: boolean;
  // Waits before handling a failed message again, after the first and second failures.
  retryDelaysMs?: number[];
  // Waits before writing an answer again when the database refused it.
  sendRetryDelaysMs?: number[];
  // Waits before handling again a message whose failure could not even be recorded.
  unrecordedRetryDelayMs?: number;
  now?: () => Date;
}

// The files, and the fields of a form, fit in this size.
const maxBodyBytes = maxFiles * maxFileBytes + 64 * 1024;

// Sent as the subject of the message, which the classifier reads with the text.
const subjects = {
  QUESTION: "Question",
  BUG: "Signalement d'un bug",
  EVOLUTION: "Demande d'évolution",
} as const;

const text = z.string().trim().min(1).max(5000);
// The signature of the application, sent with every message of a person signed in.
const signatureFields = {
  expires: z.coerce.number().int().optional(),
  signature: z.string().optional(),
};
const newMessageForm = z.object({
  kind: z.enum(["QUESTION", "BUG", "EVOLUTION"]),
  text,
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  ...signatureFields,
  // Set by the application that embeds the widget: a project with a widget channel.
  project: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/)
    .optional(),
});
const replyForm = z.object({ text, ...signatureFields });

// A conversation is reached only with its token, which only the browser that opened it holds.
const conversationToken = z.string().regex(/^[\w-]{43}$/);
// A conversation without a message for this long is closed to its token, so a token left in a
// browser or copied somewhere stops working. The requests themselves stay, for the team.
export const conversationLifetimeMs = 90 * 24 * 60 * 60 * 1000;
// A message whose handling could not even be recorded, such as while the database is down, is
// tried again after this delay, until the database answers.
export const unrecordedRetryDelayMs = 5 * 60 * 1000;
// Once the files seem to fill the quota, the folder is measured again at most this often, so files
// deleted meanwhile, such as by an erasure, give their room back without a restart.
export const quotaRecountIntervalMs = 60 * 1000;

// Kept with each message, so a reply and a message handled again after a restart keep the trust
// and the project of the conversation.
const rawSchema = z.object({ verified: z.boolean(), project: z.string().nullable() });
type WidgetRaw = z.infer<typeof rawSchema>;

// Only a hash of the token is stored, so a copy of the database does not open the conversations.
const externalIdOf = (token: string) => createHash("sha256").update(token).digest("hex");

const invalidMessage = "Le message est incomplet, ou un fichier n'est pas accepté.";

// What the Node.js server of Hono gives each request: the socket it arrived on.
type Env = { Bindings: { incoming?: { socket: { remoteAddress?: string } } } };

const busy = "Le service reçoit beaucoup de demandes. Merci de réessayer plus tard.";

// Bytes taken by the files already in the folder, or 0 before the first file.
async function folderSize(folder: string): Promise<number> {
  const names = await readdir(folder).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const sizes = await Promise.all(names.map(async (name) => (await stat(join(folder, name))).size));
  return sizes.reduce((total, size) => total + size, 0);
}

function fail(c: Context<Env>, status: 400 | 404 | 413 | 429 | 500 | 503, error: string) {
  return c.json({ error }, status);
}

function tooMany(c: Context<Env>, admission: Admission & { allowed: false }, error: string) {
  c.header("Retry-After", String(Math.ceil(admission.retryAfterMs / 1000)));
  return fail(c, 429, error);
}

// The client a request comes from, as the limits count it: its address, or its IPv6 network.
function clientAddress(c: Context<Env>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded !== undefined && forwarded !== "") {
      return addressKey(forwarded);
    }
  }
  return addressKey(c.env?.incoming?.socket.remoteAddress ?? "unknown");
}

// The values of a form field that may be repeated, such as files.
function all(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// The widget channel: an HTTP API for the script embedded in the applications. A message is stored,
// then handled by the agent one at a time, and the answer is read with the conversation.
export async function createWidgetApp(options: WidgetOptions) {
  const { db, logger } = options;
  const now = options.now ?? (() => new Date());
  const queue = createSerialQueue((error) => {
    logger.error("A widget task failed", error);
  });
  const deliver = createReplyDelivery(db, queue, logger, options.sendRetryDelaysMs);
  const trustProxy = options.trustProxy ?? false;
  const messageLimiter = createRateLimiter(messageRate);
  const readLimiter = createRateLimiter(readRate);
  // Messages left unhandled by a restart wait too: they are counted from the start.
  const unhandledAtStart = await listUnhandledMessages(db, "WIDGET").catch((error: unknown) => {
    logger.error("Unhandled widget messages could not be resumed", error);
    return [];
  });
  const waiting = createWaitingCounter(unhandledAtStart.length);
  const uploads = createSlots(maxConcurrentUploads, maxWaitingUploads);
  const isOver = (lastMessageAt: Date) =>
    now().getTime() - lastMessageAt.getTime() >= conversationLifetimeMs;
  let storedBytes = await folderSize(options.attachmentsDir);
  // Room reserved by files being written, counted until they are stored or removed.
  let reservedBytes = 0;
  let measuredAt = now().getTime();

  // A person is verified only by a valid signature of the application of the project, for someone
  // who works on that project: an email typed in the widget proves nothing, and an application
  // cannot vouch for the people of another client.
  async function isVerified(person: {
    email: string;
    project: string | null;
    expires: number | undefined;
    signature: string | undefined;
  }): Promise<boolean> {
    const { email, project, expires, signature } = person;
    if (project === null || expires === undefined || signature === undefined) {
      return false;
    }
    if (!verifyIdentity(options.identitySecrets, { email, project, expires, signature }, now())) {
      return false;
    }
    return worksOnProjectByEmail(db, email, project);
  }

  // Writes the answer kept with a handled message into its conversation, where the widget reads it,
  // again later if the database refuses it.
  function answer(storedMessageId: string, conversation: string, externalId: string, body: string) {
    return deliver({
      messageId: storedMessageId,
      send: async () => {
        await reply(conversation, externalId, body);
        return undefined;
      },
      record: () => Promise.resolve(),
    });
  }

  async function reply(conversation: string, messageId: string, body: string): Promise<void> {
    await storeOutboundMessage(db, {
      channel: "WIDGET",
      conversationExternalId: conversation,
      externalId: randomUUID(),
      sender: "agent",
      bodyText: body,
      raw: {},
      sentAt: now(),
      inReplyTo: messageId,
    });
  }

  // Handles a message, then gives back its place among the waiting ones, unless it waits again.
  async function process(
    input: TurnInput,
    conversation: string,
    externalId: string,
    address: string | null,
  ) {
    try {
      const outcome = await handleReliably(
        db,
        options.handle,
        input,
        options.retryDelaysMs ?? defaultRetryDelaysMs,
      );
      if (outcome.kind === "retry") {
        logger.error(`Widget message ${externalId} will be handled again`, outcome.error);
        queue.later(outcome.delayMs, () => process(input, conversation, externalId, address));
        return;
      }
      waiting.release(address);
      if (outcome.reply !== null) {
        await answer(input.messageId, conversation, externalId, outcome.reply);
      }
    } catch (error) {
      // Nothing could be recorded, so the message is still unhandled: it keeps its place and is
      // tried again later, instead of waiting for a restart while its sender sees no answer.
      logger.error(`Widget message ${externalId} could not be handled, tried again later`, error);
      queue.later(options.unrecordedRetryDelayMs ?? unrecordedRetryDelayMs, () =>
        process(input, conversation, externalId, address),
      );
    }
  }

  async function saveFiles(files: AcceptedFile[]) {
    if (files.length > 0) {
      await mkdir(options.attachmentsDir, { recursive: true });
    }
    const saved = files.map((file) => ({
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.bytes.length,
      storageRef: randomUUID(),
    }));
    const writes = await Promise.allSettled(
      files.map((file, index) =>
        writeFile(join(options.attachmentsDir, saved[index]?.storageRef ?? ""), file.bytes, {
          flag: "wx",
        }),
      ),
    );
    const failed = writes.find((write) => write.status === "rejected");
    if (failed !== undefined) {
      await removeFiles(saved.map((file) => file.storageRef));
      throw failed.reason;
    }
    return saved;
  }

  // Removes the files of a message that could not be stored, so they take no room.
  async function removeFiles(storageRefs: string[]) {
    const removals = await Promise.allSettled(
      storageRefs.map((ref) => rm(join(options.attachmentsDir, ref), { force: true })),
    );
    for (const removal of removals) {
      if (removal.status === "rejected") {
        logger.error("A file of a message not stored could not be removed", removal.reason);
      }
    }
  }

  // Writes the files, then stores the message with them. The files are removed if the message
  // cannot be stored.
  async function storeWithFiles(
    conversation: string,
    externalId: string,
    message: { text: string; subject: string | null; sender: string; raw: WidgetRaw },
    files: AcceptedFile[],
  ) {
    const attachments = await saveFiles(files);
    try {
      return await storeInboundMessage(db, {
        channel: "WIDGET",
        conversationExternalId: conversation,
        externalId,
        sender: message.sender,
        subject: message.subject,
        bodyText: message.text,
        raw: message.raw,
        sentAt: now(),
        attachments,
      });
    } catch (error) {
      await removeFiles(attachments.map((file) => file.storageRef));
      throw error;
    }
  }

  // Reserves room for the files before they are written, so messages received at the same time
  // cannot together pass the quota. False when there is not enough room left, even once the folder
  // is measured again.
  async function reserveRoom(bytes: number): Promise<boolean> {
    if (bytes === 0) {
      return true;
    }
    const fits = () => storedBytes + reservedBytes + bytes <= options.attachmentsQuotaBytes;
    if (!fits() && now().getTime() - measuredAt >= quotaRecountIntervalMs) {
      measuredAt = now().getTime();
      storedBytes = await folderSize(options.attachmentsDir);
    }
    if (!fits()) {
      return false;
    }
    reservedBytes += bytes;
    return true;
  }

  // A message that will be stored and handled: the place it took among the waiting ones is given
  // back if it ends up not stored.
  interface Ticket {
    address: string;
    queued: boolean;
  }

  // Stores a message of the person and queues it for the agent, which takes minutes on a CPU.
  async function receive(
    c: Context<Env>,
    ticket: Ticket,
    token: string,
    message: { text: string; subject: string | null; sender: string; raw: WidgetRaw },
    files: AcceptedFile[],
  ) {
    const bytes = files.reduce((total, file) => total + file.bytes.length, 0);
    if (!(await reserveRoom(bytes))) {
      logger.error(
        "A file was refused",
        new Error(
          `The attachments folder reached its quota of ${options.attachmentsQuotaBytes} bytes`,
        ),
      );
      return fail(
        c,
        503,
        "Les fichiers ne peuvent pas être reçus pour le moment. Envoyez votre message sans fichier.",
      );
    }
    const conversation = externalIdOf(token);
    const externalId = randomUUID();
    let stored: Awaited<ReturnType<typeof storeInboundMessage>>;
    try {
      stored = await storeWithFiles(conversation, externalId, message, files);
      storedBytes += bytes;
    } finally {
      reservedBytes -= bytes;
    }
    const input: TurnInput = {
      messageId: stored.messageId,
      trust: message.raw.verified ? "VERIFIED" : "UNVERIFIED",
      channelAddress: message.raw.project,
    };
    queue.push(() => process(input, conversation, externalId, ticket.address));
    ticket.queued = true;
    return c.json({ conversation: token }, 202);
  }

  // Lets a new message in when its sender has not written too much, a place is free among the
  // waiting messages, and few files are being received. The body is read only after that.
  async function admit(
    c: Context<Env>,
    receiveMessage: (ticket: Ticket) => Promise<Response>,
  ): Promise<Response> {
    const address = clientAddress(c, trustProxy);
    const rate = messageLimiter.take(address);
    if (!rate.allowed) {
      return tooMany(
        c,
        rate,
        "Vous avez envoyé beaucoup de messages. Merci de réessayer plus tard.",
      );
    }
    const refusal = waiting.take(address);
    if (refusal === "QUEUE_FULL") {
      return fail(c, 503, busy);
    }
    if (refusal === "TOO_MANY_FOR_ADDRESS") {
      return fail(
        c,
        429,
        "Vos messages précédents sont en cours de traitement. Merci d'attendre leur réponse.",
      );
    }
    const ticket: Ticket = { address, queued: false };
    try {
      const received = await uploads.run(() => receiveMessage(ticket));
      return received === undefined ? fail(c, 503, busy) : received.value;
    } finally {
      if (!ticket.queued) {
        waiting.release(address);
      }
    }
  }

  const app = new Hono<Env>();
  // An unexpected failure, such as the database lost, goes to the log of the server, and the person
  // gets a message they can understand, without any detail of the failure.
  app.onError((error, c) => {
    logger.error("A widget request failed", error);
    return fail(c, 500, "Votre message n'a pas pu être reçu. Merci de réessayer plus tard.");
  });
  app.use(
    "/widget/*",
    cors({ origin: options.allowedOrigins, allowMethods: ["GET", "POST"], maxAge: 600 }),
  );
  app.use(
    "/widget/*",
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => fail(c, 413, "Les fichiers sont trop volumineux."),
    }),
  );

  app.get("/widget/widget.js", (c) =>
    c.body(widgetScript, 200, { "Content-Type": "text/javascript; charset=utf-8" }),
  );

  app.post("/widget/messages", (c) => admit(c, (ticket) => receiveNew(c, ticket)));

  async function receiveNew(c: Context<Env>, ticket: Ticket): Promise<Response> {
    const body = await c.req.parseBody({ all: true });
    const form = newMessageForm.safeParse(body);
    const files = await acceptFiles(all(body.files));
    if (!form.success || files === undefined) {
      return fail(c, 400, invalidMessage);
    }
    const { email, expires, signature } = form.data;
    const project = form.data.project ?? null;
    const verified = await isVerified({ email, project, expires, signature });
    return receive(
      c,
      ticket,
      randomBytes(32).toString("base64url"),
      {
        text: form.data.text,
        subject: subjects[form.data.kind],
        sender: email,
        raw: { verified, project },
      },
      files,
    );
  }

  app.post("/widget/conversations/:token/messages", (c) =>
    admit(c, (ticket) => receiveReply(c, ticket)),
  );

  async function receiveReply(c: Context<Env>, ticket: Ticket): Promise<Response> {
    const token = conversationToken.safeParse(c.req.param("token"));
    const origin = token.success
      ? await conversationOrigin(db, "WIDGET", externalIdOf(token.data))
      : undefined;
    const raw = rawSchema.safeParse(origin?.raw);
    if (!token.success || origin === undefined || !raw.success || isOver(origin.lastMessageAt)) {
      return fail(c, 404, "Cette conversation est introuvable.");
    }
    const body = await c.req.parseBody({ all: true });
    const form = replyForm.safeParse(body);
    const files = await acceptFiles(all(body.files));
    if (!form.success || files === undefined) {
      return fail(c, 400, invalidMessage);
    }
    // A reply keeps the person and the project of the first message of the conversation. It is
    // verified only when that message was, and the reply is signed again for the same person: a
    // token found on a shared computer does not let someone else write in their name.
    const verified =
      raw.data.verified &&
      (await isVerified({
        email: origin.sender,
        project: raw.data.project,
        expires: form.data.expires,
        signature: form.data.signature,
      }));
    return receive(
      c,
      ticket,
      token.data,
      {
        text: form.data.text,
        subject: null,
        sender: origin.sender,
        raw: { verified, project: raw.data.project },
      },
      files,
    );
  }

  app.get("/widget/conversations/:token", async (c) => {
    const rate = readLimiter.take(clientAddress(c, trustProxy));
    if (!rate.allowed) {
      return tooMany(c, rate, busy);
    }
    const token = conversationToken.safeParse(c.req.param("token"));
    const thread = token.success
      ? await readConversation(db, "WIDGET", externalIdOf(token.data))
      : undefined;
    const lastMessage = thread?.messages.at(-1);
    if (thread === undefined || lastMessage === undefined || isOver(new Date(lastMessage.sentAt))) {
      return fail(c, 404, "Cette conversation est introuvable.");
    }
    return c.json({
      ...thread,
      requests: thread.requests.map((request) => ({
        reference: request.reference,
        title: request.title,
        status: statusLabels[request.status],
        // The code of the status, from which the widget shows a short label and a color.
        statusCode: request.status,
      })),
    });
  });

  // Answers kept but not written yet are written first, then the messages stored before a restart
  // but never handled are handled, in their order.
  const pending = await listPendingReplies(db, "WIDGET").catch((error: unknown) => {
    logger.error("Pending widget answers could not be resumed", error);
    return [];
  });
  for (const stored of pending) {
    queue.push(() =>
      answer(stored.messageId, stored.conversationExternalId, stored.externalId, stored.reply),
    );
  }
  for (const stored of unhandledAtStart) {
    const raw = rawSchema.safeParse(stored.raw);
    const input: TurnInput = {
      messageId: stored.messageId,
      trust: raw.success && raw.data.verified ? "VERIFIED" : "UNVERIFIED",
      channelAddress: raw.success ? raw.data.project : null,
    };
    queue.push(() => process(input, stored.conversationExternalId, stored.externalId, null));
  }

  return { app, idle: queue.idle };
}
