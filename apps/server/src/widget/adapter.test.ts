import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachments,
  events,
  messages,
  requests,
  storeInboundMessage,
  type TurnInput,
} from "@request-agent/core";
import {
  bruno,
  seedDatabase,
  useServerTestDatabase,
  useTestDatabase,
} from "@request-agent/core/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { HandledMessage } from "../mastra/agents/handle-message";
import { conversationLifetimeMs, createWidgetApp } from "./adapter";
import { maxWaitingMessages, maxWaitingPerAddress, messageRate } from "./admission";
import { signIdentity } from "./identity";

const getDatabase = useTestDatabase();
const getAppDatabase = useServerTestDatabase();

const secret = "a-secret-shared-with-the-portal-application";
const portal = "https://portal.example.com";
const answer = "Votre demande est enregistrée sous la référence REQ-0001.";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

beforeEach(async () => {
  await seedDatabase(getDatabase());
});

async function widgetFor(
  handle?: (input: TurnInput) => Promise<HandledMessage>,
  attachmentsQuotaBytes = 1024 * 1024 * 1024,
) {
  const inputs: TurnInput[] = [];
  const folder = await mkdtemp(join(tmpdir(), "widget-"));
  const widget = await createWidgetApp({
    db: getAppDatabase(),
    handle:
      handle ??
      ((input) => {
        inputs.push(input);
        return Promise.resolve({ reply: answer, filedBySystem: false });
      }),
    allowedOrigins: [portal],
    identitySecrets: new Map([["PORTAL", secret]]),
    attachmentsDir: folder,
    attachmentsQuotaBytes,
    logger: { info: () => undefined, error: () => undefined },
    retryDelaysMs: [0, 0],
  });
  return { ...widget, inputs, folder };
}

function newMessage(fields: Record<string, string>, files: File[] = []) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  for (const file of files) {
    form.append("files", file);
  }
  return { method: "POST", body: form, headers: { origin: portal } };
}

// Where a request comes from, as the Node.js server gives it to the app.
const fromAddress = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

// What the portal application gives the widget for the person signed in.
function signed(email = bruno) {
  const identity = signIdentity(secret, email, "PORTAL", new Date());
  return {
    email: identity.email,
    project: identity.project,
    expires: String(identity.expires),
    signature: identity.signature,
  };
}

async function conversationOf(response: Response): Promise<string> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("conversation" in body)) {
    throw new Error("No conversation");
  }
  return String(body.conversation);
}

describe("the widget channel", () => {
  it("serves the script that applications embed", async () => {
    const { app } = await widgetFor();

    const response = await app.request("/widget/widget.js");

    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(await response.text()).toContain("attachShadow");
  });

  it("stores a message of a signed-in person with its file, and hands it to the agent as verified", async () => {
    const widget = await widgetFor();

    const response = await widget.app.request(
      "/widget/messages",
      newMessage(
        { kind: "BUG", text: "Le bouton Valider ne répond plus.", ...signed(), project: "portal" },
        [new File([png], "capture.png", { type: "image/png" })],
      ),
    );
    await widget.idle();

    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe(portal);
    expect(widget.inputs).toEqual([
      { messageId: expect.any(String), trust: "VERIFIED", channelAddress: "PORTAL" },
    ]);
    const [message] = await getDatabase().select().from(messages).orderBy(messages.receivedAt);
    expect(message).toMatchObject({
      channel: "WIDGET",
      sender: bruno,
      subject: "Signalement d'un bug",
      bodyText: "Le bouton Valider ne répond plus.",
    });
    const [file] = await getDatabase().select().from(attachments);
    expect(file).toMatchObject({
      filename: "capture.png",
      contentType: "image/png",
      sizeBytes: 11,
    });
    expect(await readdir(widget.folder)).toEqual([file?.storageRef]);
    expect(new Uint8Array(await readFile(join(widget.folder, file?.storageRef ?? "")))).toEqual(
      png,
    );
  });

  it("shows the conversation with the answer of the agent to the browser that holds it", async () => {
    const widget = await widgetFor();
    const token = await conversationOf(
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "QUESTION", text: "Où en est ma demande ?", ...signed() }),
      ),
    );
    await widget.idle();

    const thread: unknown = await (
      await widget.app.request(`/widget/conversations/${token}`)
    ).json();

    expect(thread).toEqual({
      messages: [
        {
          fromAgent: false,
          text: "Où en est ma demande ?",
          sentAt: expect.any(String),
          attachments: [],
        },
        { fromAgent: true, text: answer, sentAt: expect.any(String), attachments: [] },
      ],
      requests: [],
      waiting: false,
    });
    expect((await widget.app.request("/widget/conversations/unknown")).status).toBe(404);
  });

  it("gives the status of a request created by the conversation as a label and a code", async () => {
    // The agent files the message as a request in progress, as it would through its tools.
    const widget = await widgetFor(async (input) => {
      const [request] = await getDatabase()
        .insert(requests)
        .values({
          type: "BUG",
          status: "IN_PROGRESS",
          title: "Bouton Valider inactif",
          sourceChannel: "WIDGET",
        })
        .returning({ id: requests.id });
      await getDatabase()
        .insert(events)
        .values({
          requestId: request?.id ?? "",
          type: "CREATED",
          actorType: "AGENT",
          messageId: input.messageId,
        });
      return { reply: answer, filedBySystem: false };
    });
    const token = await conversationOf(
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "BUG", text: "Le bouton Valider ne répond plus.", ...signed() }),
      ),
    );
    await widget.idle();

    const thread: unknown = await (
      await widget.app.request(`/widget/conversations/${token}`)
    ).json();

    expect(thread).toMatchObject({
      requests: [
        {
          reference: expect.stringMatching(/^REQ-\d{4}$/),
          title: "Bouton Valider inactif",
          status: "en cours de traitement",
          statusCode: "IN_PROGRESS",
        },
      ],
    });
  });

  it("treats a person as unverified without a valid signature of the application", async () => {
    const widget = await widgetFor();

    for (const identity of [
      { email: bruno },
      { ...signed(), email: "alice.martin@acme.example" },
      { ...signed(), signature: "0".repeat(64) },
      // Signed by the portal, but Alice does not work on the portal.
      signed("alice.martin@acme.example"),
      // A signature for the portal sent to another project.
      { ...signed(), project: "SHOP" },
    ]) {
      // One after the other, so the agent receives them in this order.
      // oxlint-disable-next-line no-await-in-loop
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "QUESTION", text: "Bonjour", ...identity }),
      );
    }
    await widget.idle();

    expect(widget.inputs.map((input) => input.trust)).toEqual([
      "UNVERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
    ]);
  });

  it("keeps the person and the trust of the conversation for a reply", async () => {
    const widget = await widgetFor();
    const token = await conversationOf(
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "BUG", text: "Panne", ...signed() }),
      ),
    );
    await widget.idle();

    const response = await widget.app.request(
      `/widget/conversations/${token}/messages`,
      newMessage({ text: "Toujours en panne", ...signed(), email: "someone@else.example" }),
    );
    await widget.idle();

    expect(response.status).toBe(202);
    expect(widget.inputs.at(-1)).toMatchObject({ trust: "VERIFIED", channelAddress: "PORTAL" });
    const replies = await getDatabase().select({ sender: messages.sender }).from(messages);
    expect(replies.filter((row) => row.sender === bruno)).toHaveLength(2);
  });

  it("closes a conversation to its token once it has had no message for too long", async () => {
    let time = new Date();
    const widget = await createWidgetApp({
      db: getAppDatabase(),
      handle: () => Promise.resolve({ reply: answer, filedBySystem: false }),
      allowedOrigins: [portal],
      identitySecrets: new Map([["PORTAL", secret]]),
      attachmentsDir: await mkdtemp(join(tmpdir(), "widget-")),
      attachmentsQuotaBytes: 1024,
      logger: { info: () => undefined, error: () => undefined },
      now: () => time,
    });
    const token = await conversationOf(
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "BUG", text: "Panne", ...signed() }),
      ),
    );
    await widget.idle();

    time = new Date(time.getTime() + conversationLifetimeMs - 60_000);
    expect((await widget.app.request(`/widget/conversations/${token}`)).status).toBe(200);
    time = new Date(time.getTime() + 60_000);

    expect((await widget.app.request(`/widget/conversations/${token}`)).status).toBe(404);
    const reply = await widget.app.request(
      `/widget/conversations/${token}/messages`,
      newMessage({ text: "Toujours en panne", ...signed() }),
    );
    expect(reply.status).toBe(404);
  });

  it("treats a reply without the signature of the person as unverified", async () => {
    const widget = await widgetFor();
    const token = await conversationOf(
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "BUG", text: "Panne", ...signed() }),
      ),
    );
    await widget.idle();

    // Someone else on the same computer, who found the conversation in the browser.
    await widget.app.request(
      `/widget/conversations/${token}/messages`,
      newMessage({ text: "Annulez tout" }),
    );
    await widget.idle();

    expect(widget.inputs.map((input) => input.trust)).toEqual(["VERIFIED", "UNVERIFIED"]);
  });

  it("refuses an incomplete message or a file of another type, and stores nothing", async () => {
    const widget = await widgetFor();

    const empty = await widget.app.request(
      "/widget/messages",
      newMessage({ kind: "BUG", text: " ", ...signed() }),
    );
    const zip = await widget.app.request(
      "/widget/messages",
      newMessage({ kind: "BUG", text: "Voici l'archive", ...signed() }, [
        // The start of a real ZIP header, with its null bytes.
        new File([new Uint8Array([0x50, 0x4b, 3, 4, 0x14, 0, 0, 0])], "logs.zip"),
      ]),
    );
    const unknown = await widget.app.request(
      "/widget/conversations/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/messages",
      newMessage({ text: "Bonjour" }),
    );

    expect([empty.status, zip.status, unknown.status]).toEqual([400, 400, 404]);
    expect(await getDatabase().select().from(messages)).toHaveLength(0);
  });

  it("answers preflight requests of the allowed applications only", async () => {
    const { app } = await widgetFor();
    const preflight = (origin: string) =>
      app.request("/widget/messages", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      });

    expect((await preflight(portal)).headers.get("access-control-allow-origin")).toBe(portal);
    expect(
      (await preflight("https://evil.example")).headers.get("access-control-allow-origin"),
    ).toBe(null);
  });

  it("lets exactly the allowed number of messages wait, even when they arrive together", async () => {
    const widget = await widgetFor(() => new Promise(() => undefined));

    const responses = await Promise.all(
      Array.from({ length: maxWaitingMessages + 10 }, async (_, index) =>
        widget.app.request(
          "/widget/messages",
          newMessage({ kind: "QUESTION", text: "Bonjour", ...signed() }),
          fromAddress(`198.51.100.${index}`),
        ),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 202)).toHaveLength(maxWaitingMessages);
    expect(statuses.filter((status) => status === 503)).toHaveLength(10);
    expect(await getDatabase().select().from(messages)).toHaveLength(maxWaitingMessages);
  });

  it("keeps one address from filling the queue of the agent", async () => {
    const widget = await widgetFor(() => new Promise(() => undefined));
    const send = (address: string) =>
      widget.app.request(
        "/widget/messages",
        newMessage({ kind: "QUESTION", text: "Bonjour", ...signed() }),
        fromAddress(address),
      );
    for (let sent = 0; sent < maxWaitingPerAddress; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop
      expect((await send("203.0.113.7")).status).toBe(202);
    }

    const again = await send("203.0.113.7");
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({
      error: "Vos messages précédents sont en cours de traitement. Merci d'attendre leur réponse.",
    });
    expect((await send("198.51.100.4")).status).toBe(202);
  });

  it("limits the messages of one address over time, and says when to come back", async () => {
    const widget = await widgetFor();
    for (let sent = 0; sent < messageRate.max; sent += 1) {
      // Each one is handled before the next, so the queue never fills.
      // oxlint-disable-next-line no-await-in-loop
      await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "QUESTION", text: "Bonjour", ...signed() }),
        fromAddress("203.0.113.7"),
      );
      // oxlint-disable-next-line no-await-in-loop
      await widget.idle();
    }

    const refused = await widget.app.request(
      "/widget/messages",
      newMessage({ kind: "QUESTION", text: "Bonjour", ...signed() }),
      fromAddress("203.0.113.7"),
    );

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await getDatabase().select().from(messages)).toHaveLength(messageRate.max * 2);
  });

  it("refuses files beyond the quota of the folder, and still takes messages without files", async () => {
    const widget = await widgetFor(undefined, png.length * 2);
    const withFile = () =>
      widget.app.request(
        "/widget/messages",
        newMessage({ kind: "BUG", text: "Capture", ...signed() }, [new File([png], "a.png")]),
        fromAddress("203.0.113.7"),
      );

    expect((await withFile()).status).toBe(202);
    await widget.idle();
    expect((await withFile()).status).toBe(202);
    await widget.idle();
    const full = await withFile();
    const withoutFile = await widget.app.request(
      "/widget/messages",
      newMessage({ kind: "BUG", text: "Sans capture", ...signed() }),
      fromAddress("203.0.113.7"),
    );

    expect(full.status).toBe(503);
    expect(withoutFile.status).toBe(202);
    expect(await readdir(widget.folder)).toHaveLength(2);
  });

  it("counts the files already in the folder at start", async () => {
    const first = await widgetFor(undefined, png.length);
    await first.app.request(
      "/widget/messages",
      newMessage({ kind: "BUG", text: "Capture", ...signed() }, [new File([png], "a.png")]),
    );
    await first.idle();

    const restarted = await createWidgetApp({
      db: getAppDatabase(),
      handle: () => Promise.resolve({ reply: answer, filedBySystem: false }),
      allowedOrigins: [portal],
      identitySecrets: new Map(),
      attachmentsDir: first.folder,
      attachmentsQuotaBytes: png.length,
      logger: { info: () => undefined, error: () => undefined },
    });
    const refused = await restarted.app.request(
      "/widget/messages",
      newMessage({ kind: "BUG", text: "Capture", email: bruno }, [new File([png], "b.png")]),
    );

    expect(refused.status).toBe(503);
  });

  it("gives the place back when a message is refused, so the sender can correct it", async () => {
    const widget = await widgetFor(() => new Promise(() => undefined));
    for (let sent = 0; sent < maxWaitingPerAddress + 2; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await widget.app.request(
        "/widget/messages",
        newMessage({ kind: "BUG", text: " ", ...signed() }),
        fromAddress("203.0.113.7"),
      );
      expect(refused.status).toBe(400);
    }

    const accepted = await widget.app.request(
      "/widget/messages",
      newMessage({ kind: "BUG", text: "Panne", ...signed() }),
      fromAddress("203.0.113.7"),
    );
    expect(accepted.status).toBe(202);
  });

  it("handles at start the messages left unhandled by a restart", async () => {
    await storeInboundMessage(getAppDatabase(), {
      channel: "WIDGET",
      conversationExternalId: "a-conversation",
      externalId: "a-message",
      sender: bruno,
      bodyText: "Bonjour",
      raw: { verified: true, project: "PORTAL" },
      sentAt: new Date(),
    });

    const widget = await widgetFor();
    await widget.idle();

    expect(widget.inputs).toEqual([
      { messageId: expect.any(String), trust: "VERIFIED", channelAddress: "PORTAL" },
    ]);
    const stored = await getDatabase()
      .select({ direction: messages.direction })
      .from(messages)
      .orderBy(messages.receivedAt);
    expect(stored.map((row) => row.direction)).toEqual(["INBOUND", "OUTBOUND"]);
  });
});
