import {
  attachments,
  connectDatabase,
  conversations,
  messages,
  type TurnInput,
} from "@request-agent/core";
import { useAppTestDatabase, useTestDatabase } from "@request-agent/core/testing";
import type Mail from "nodemailer/lib/mailer";
import { afterAll, describe, expect, it } from "vitest";

import { rawEmail } from "../../test/emails";
import type { HandledMessage } from "../mastra/agents/handle-message";
import {
  acknowledgementOf,
  type OutgoingEmail,
  startEmailAdapter,
  verifiedReplyRate,
} from "./adapter";
import type { TrustSettings } from "./policy";

const getDatabase = useTestDatabase();
const getAppDatabase = useAppTestDatabase();

const address = "agent@requests.example";

// A database nobody listens on, to make storing fail.
const unreachableDatabase = connectDatabase("postgresql://nobody:none@127.0.0.1:1/none");

afterAll(async () => {
  await unreachableDatabase.close();
});

// A mailbox the test fills, and a sender that records what the adapter sends.
// Every sender is verified, as with a receiving server that checked DMARC, unless a test says so.
const everySenderVerified: TrustSettings = { trustedAuthservId: undefined, trustAllSenders: true };
const receivingServer: TrustSettings = {
  trustedAuthservId: "mx.requests.example",
  trustAllSenders: false,
};

async function fakeMail(
  handle: (input: TurnInput) => Promise<HandledMessage>,
  failingStore = false,
  trust = everySenderVerified,
) {
  let deliver: ((mail: { uid: number; source: Uint8Array }) => Promise<void>) | undefined;
  const seen: number[] = [];
  const sent: OutgoingEmail[] = [];
  const handled: TurnInput[] = [];
  let uid = 0;
  const adapter = await startEmailAdapter({
    mailbox: {
      watch: (listener) => {
        deliver = listener;
        return Promise.resolve();
      },
      markSeen: (seenUid) => {
        seen.push(seenUid);
        return Promise.resolve();
      },
    },
    sender: {
      send: (email) => {
        sent.push(email);
        return Promise.resolve({ messageId: `<reply-${sent.length}@requests.example>` });
      },
    },
    db: failingStore ? unreachableDatabase.db : getAppDatabase(),
    handle: (input) => {
      handled.push(input);
      return handle(input);
    },
    address,
    trust,
    logger: { info: () => {}, error: () => {} },
    // Retries come at once, so the tests do not wait.
    retryDelaysMs: [1, 1],
  });

  async function deliverOnly(options: Mail.Options) {
    uid += 1;
    await deliver?.({ uid, source: await rawEmail(options) });
    return uid;
  }
  async function receive(options: Mail.Options) {
    const delivered = await deliverOnly(options);
    await adapter.idle();
    return delivered;
  }
  return { receive, deliverOnly, seen, sent, handled, idle: adapter.idle };
}

const answered = (reply: string | null) => () => Promise.resolve({ reply, filedBySystem: false });

describe("startEmailAdapter", () => {
  it("stores an email, handles it, and answers in its thread", async () => {
    const mail = await fakeMail(
      answered("Votre demande est enregistrée sous la référence REQ-0001."),
    );

    const uid = await mail.receive({
      messageId: "<first@acme.example>",
      attachments: [
        { filename: "capture.png", content: Buffer.alloc(10), contentType: "image/png" },
      ],
    });

    expect(mail.seen).toEqual([uid]);
    expect(mail.handled).toEqual([
      { messageId: expect.any(String), trust: "VERIFIED", channelAddress: address },
    ]);
    expect(mail.sent).toEqual([
      {
        to: "alice.martin@acme.example",
        subject: "Re: Bouton de validation cassé [REQ-0001]",
        text: "Votre demande est enregistrée sous la référence REQ-0001.",
        inReplyTo: "<first@acme.example>",
        references: ["<first@acme.example>"],
      },
    ]);
    const stored = await getDatabase().select().from(messages);
    expect(stored.map((m) => m.direction)).toEqual(["INBOUND", "OUTBOUND"]);
    expect(await getDatabase().select().from(attachments)).toHaveLength(1);
  });

  it("attaches a reply to the conversation of the email it answers", async () => {
    const mail = await fakeMail(answered("ok"));
    await mail.receive({ messageId: "<first@acme.example>" });

    // A reply to the agent's answer, from a mail client that keeps only In-Reply-To.
    await mail.receive({
      messageId: "<second@acme.example>",
      inReplyTo: "<reply-1@requests.example>",
    });

    expect(await getDatabase().select().from(conversations)).toHaveLength(1);
    expect(mail.handled).toHaveLength(2);
  });

  it("keeps a colleague of the same company in the thread, and another company out of it", async () => {
    const mail = await fakeMail(answered("ok"));
    await mail.receive({ messageId: "<first@acme.example>" });

    await mail.receive({
      from: "chloe.dupont@acme.example",
      messageId: "<colleague@acme.example>",
      references: ["<first@acme.example>"],
    });
    await mail.receive({
      from: "someone@evil.example",
      messageId: "<outsider@evil.example>",
      references: ["<first@acme.example>"],
    });

    const threads = await getDatabase()
      .select({ externalId: conversations.externalId })
      .from(conversations);
    expect(threads.map((thread) => thread.externalId).toSorted()).toEqual([
      "<first@acme.example>",
      "<outsider@evil.example>",
    ]);
  });

  it("uses an address dedicated to a project, such as a forwarded one", async () => {
    const mail = await fakeMail(answered("ok"));

    await mail.receive({ to: "Portal-Support@initech.example", cc: address });

    expect(mail.handled[0]?.channelAddress).toBe("portal-support@initech.example");
  });

  it("handles an email delivered twice only once", async () => {
    const mail = await fakeMail(answered("ok"));

    await mail.receive({ messageId: "<same@acme.example>" });
    await mail.receive({ messageId: "<same@acme.example>" });

    expect(mail.handled).toHaveLength(1);
    expect(mail.seen).toHaveLength(2);
  });

  it("keeps automatic emails without handling or answering them", async () => {
    const mail = await fakeMail(answered("ok"));

    await mail.receive({ headers: { "Auto-Submitted": "auto-replied" }, text: "Je suis absente." });
    await mail.receive({ from: "MAILER-DAEMON@acme.example", text: "Delivery failed" });

    expect(mail.handled).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect(await getDatabase().select().from(messages)).toHaveLength(2);
  });

  it("sends nothing when no answer is needed, such as for thanks", async () => {
    const mail = await fakeMail(answered(null));

    await mail.receive({ text: "Merci beaucoup !" });

    expect(mail.sent).toHaveLength(0);
  });

  it("sends only a fixed notice to a sender who is not verified, whatever the agent wrote", async () => {
    const mail = await fakeMail(
      answered("Voici le lien de réinitialisation : https://evil.example — REQ-0004."),
      false,
      receivingServer,
    );

    await mail.receive({ messageId: "<unverified@acme.example>" });

    expect(mail.handled[0]?.trust).toBe("UNVERIFIED");
    expect(mail.sent.map((email) => email.text)).toEqual([acknowledgementOf("REQ-0004")]);
    expect(mail.sent[0]?.text).not.toContain("evil.example");
  });

  it("answers nothing to an address whose domain failed DMARC at our server", async () => {
    const mail = await fakeMail(answered("Votre demande REQ-0001."), false, receivingServer);

    await mail.receive({
      headers: {
        "Authentication-Results": "mx.requests.example; dmarc=fail header.from=acme.example",
      },
    });

    expect(mail.handled).toHaveLength(1);
    expect(mail.sent).toEqual([]);
  });

  it("sends at most one notice a day to a sender who is not verified", async () => {
    const mail = await fakeMail(answered("Votre demande REQ-0001."), false, receivingServer);

    await mail.receive({ messageId: "<one@acme.example>" });
    await mail.receive({ messageId: "<two@acme.example>" });
    await mail.receive({ messageId: "<three@acme.example>", from: "bruno.leroy@globex.example" });

    expect(mail.handled).toHaveLength(3);
    expect(mail.sent.map((email) => email.to)).toEqual([
      "alice.martin@acme.example",
      "bruno.leroy@globex.example",
    ]);
  });

  it("limits the answers to one verified address, which stops a loop with another robot", async () => {
    const mail = await fakeMail(answered("Votre demande REQ-0001."));
    for (let index = 0; index <= verifiedReplyRate.max; index += 1) {
      // One after the other, as the mailbox delivers them.
      // oxlint-disable-next-line no-await-in-loop
      await mail.receive({ messageId: `<loop-${index}@acme.example>` });
    }

    expect(mail.handled).toHaveLength(verifiedReplyRate.max + 1);
    expect(mail.sent).toHaveLength(verifiedReplyRate.max);
  });

  it("retries a failing email, then files it for a person and gives its reference", async () => {
    const mail = await fakeMail(() => Promise.reject(new Error("Ollama is down")));

    await mail.receive({});

    expect(mail.handled).toHaveLength(3);
    expect(mail.sent.map((email) => email.text)).toEqual([
      "Votre message est enregistré sous la référence REQ-0001. Une personne de l'équipe va le traiter.",
    ]);
  });

  it("handles at startup the emails stored before a restart, from their original source", async () => {
    const first = await fakeMail(() => new Promise(() => {}));
    await first.deliverOnly({ messageId: "<pending@acme.example>" });

    const restarted = await fakeMail(answered("ok"));
    await restarted.idle();

    expect(restarted.handled).toHaveLength(1);
    expect(restarted.sent[0]).toMatchObject({ inReplyTo: "<pending@acme.example>" });
  });

  it("leaves an email it could not store unread, so it is read again later", async () => {
    const mail = await fakeMail(answered("ok"), true);

    await mail.receive({});

    expect(mail.seen).toHaveLength(0);
  });
});
