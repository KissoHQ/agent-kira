import {
  conversationOfMessage,
  conversationSenderDomains,
  createRateLimiter,
  listUnhandledMessages,
  markHandled,
  type Database,
  storeInboundMessage,
  storeOutboundMessage,
  type RateLimit,
  type TurnInput,
} from "@request-agent/core";

import { z } from "zod";

import type { HandledMessage } from "../mastra/agents/handle-message";
import { createSerialQueue, defaultRetryDelaysMs, handleReliably } from "../reliable-handling";
import { type ParsedEmail, parseEmail } from "./parse";
import { checkSender, isAutomatic, type SenderCheck, type TrustSettings } from "./policy";

// The parts of the mail clients the adapter uses, so tests can replace them.
export interface Mailbox {
  // Calls the listener for every unread email, then for each new one as it arrives.
  watch(listener: (mail: { uid: number; source: Uint8Array }) => Promise<void>): Promise<void>;
  markSeen(uid: number): Promise<void>;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string[];
}

export interface MailSender {
  send(email: OutgoingEmail): Promise<{ messageId: string }>;
}

export interface EmailAdapterLogger {
  info(message: string): void;
  error(message: string, error: unknown): void;
}

export interface EmailAdapterOptions {
  mailbox: Mailbox;
  sender: MailSender;
  db: Database;
  // Runs the agent on a stored message: handleMessage, bound to the agent and the classifier.
  handle: (input: TurnInput) => Promise<HandledMessage>;
  // Address the agent receives and answers from.
  address: string;
  trust: TrustSettings;
  logger: EmailAdapterLogger;
  // Waits before handling a failed email again, after the first and second failures.
  retryDelaysMs?: number[];
}

// Sent when an email could not even be filed for a person, for example when the database is down.
// The email stays unhandled and is handled again when the server restarts.
export const unavailableReply =
  "Le service est momentanément indisponible et votre message n'a pas pu être traité. Merci de le renvoyer un peu plus tard.";

const storedSource = z.object({ source: z.string() });

// The From address of an email that is not verified can be forged, to make the agent write to
// someone else from the domain of the company. Such a sender never gets a text written from their
// message: only this fixed notice, with the reference of the request when there is one.
export function acknowledgementOf(reply: string): string {
  const reference = /REQ-\d{1,9}/.exec(reply)?.[0];
  const notice =
    "Bonjour,\n\nNous avons bien reçu votre message. L'équipe va l'examiner et reviendra vers vous si nécessaire.";
  return reference === undefined ? notice : `${notice}\n\nRéférence : ${reference}`;
}

// Answers sent to one address. A verified sender may write often; a sender who is not verified,
// whose address may be someone else's, gets at most one notice a day, so the agent cannot be used to
// send many emails to a victim. These counts also stop a loop with another automatic system.
export const verifiedReplyRate: RateLimit = {
  max: 30,
  windowMs: 60 * 60 * 1000,
  maxKeys: 10_000,
};
export const unverifiedReplyRate: RateLimit = {
  max: 1,
  windowMs: 24 * 60 * 60 * 1000,
  maxKeys: 100_000,
};

// The thread an email belongs to, named after its first message. A reply that lost its References
// header is still attached through the message it answers. The sender chooses these headers: an
// email that names a known thread where nobody of its domain wrote starts its own thread instead.
async function threadOf(db: Database, email: ParsedEmail): Promise<string> {
  const [root] = email.references;
  let named: string | undefined = root;
  if (named === undefined && email.inReplyTo !== null) {
    named = (await conversationOfMessage(db, "EMAIL", email.inReplyTo)) ?? email.inReplyTo;
  }
  if (named === undefined) {
    return email.messageId;
  }
  const domains = await conversationSenderDomains(db, "EMAIL", named);
  const domain = email.from.slice(email.from.lastIndexOf("@") + 1);
  return domains === undefined || domains.includes(domain) ? named : email.messageId;
}

// Keeps one "Re:" and adds the request reference, so people and mail clients follow the thread.
function replySubject(subject: string | null, reply: string): string {
  const base = (subject ?? "").replace(/^(\s*(re|tr|fw|fwd)\s*:\s*)+/i, "").trim();
  const reference = /REQ-\d{1,9}/.exec(reply)?.[0];
  const tagged =
    reference === undefined || base.includes(reference) ? base : `${base} [${reference}]`;
  return `Re: ${tagged}`.trim();
}

// Connects a mailbox to the agent. Each email is stored before it is marked as read, so a read
// email is never lost, then handled one at a time, since the model runs on a CPU.
export async function startEmailAdapter(options: EmailAdapterOptions): Promise<{
  idle: () => Promise<void>;
}> {
  const { db, logger } = options;
  const queue = createSerialQueue();
  const verifiedReplies = createRateLimiter(verifiedReplyRate);
  const unverifiedReplies = createRateLimiter(unverifiedReplyRate);

  async function reply(email: ParsedEmail, thread: string, text: string): Promise<void> {
    const sent = await options.sender.send({
      to: email.from,
      subject: replySubject(email.subject, text),
      text,
      inReplyTo: email.messageId,
      references: [...email.references, email.messageId],
    });
    await storeOutboundMessage(db, {
      channel: "EMAIL",
      conversationExternalId: thread,
      externalId: sent.messageId,
      sender: options.address,
      subject: replySubject(email.subject, text),
      bodyText: text,
      raw: { to: email.from },
      sentAt: new Date(),
      inReplyTo: email.messageId,
    });
  }

  // Sends an answer within the rules for the sender: nothing to an address whose domain failed
  // DMARC, the fixed notice to a sender who is not verified, and a bounded number of emails to one
  // address. A fixed text of the system, such as the unavailability notice, is sent as it is.
  async function answer(
    email: ParsedEmail,
    thread: string,
    sender: SenderCheck,
    text: { kind: "agent" | "system"; value: string },
  ): Promise<void> {
    if (sender.forged) {
      logger.info(`No answer to ${email.messageId}: DMARC failed for the domain of its sender`);
      return;
    }
    const verified = sender.trust === "VERIFIED";
    if (!(verified ? verifiedReplies : unverifiedReplies).take(email.from).allowed) {
      logger.info(`No answer to ${email.messageId}: its sender reached the limit of answers`);
      return;
    }
    await reply(
      email,
      thread,
      verified || text.kind === "system" ? text.value : acknowledgementOf(text.value),
    );
  }

  async function process(email: ParsedEmail, thread: string, messageId: string): Promise<void> {
    const ownAddress = options.address.toLowerCase();
    const sender = checkSender(email, options.trust);
    try {
      const outcome = await handleReliably(
        db,
        options.handle,
        {
          messageId,
          trust: sender.trust,
          // An address dedicated to a project, such as one forwarded to the agent's mailbox.
          channelAddress: email.recipients.find((address) => address !== ownAddress) ?? ownAddress,
        },
        options.retryDelaysMs ?? defaultRetryDelaysMs,
      );
      if (outcome.kind === "retry") {
        logger.error(`Email ${email.messageId} will be handled again`, outcome.error);
        queue.later(outcome.delayMs, () => process(email, thread, messageId));
        return;
      }
      if (outcome.reply !== null) {
        await answer(email, thread, sender, { kind: "agent", value: outcome.reply });
      }
    } catch (error) {
      logger.error(`Email ${email.messageId} could not be handled`, error);
      await answer(email, thread, sender, { kind: "system", value: unavailableReply }).catch(
        (replyError: unknown) => {
          logger.error("The unavailability reply could not be sent", replyError);
        },
      );
    }
  }

  async function receive(mail: { uid: number; source: Uint8Array }): Promise<void> {
    const email = await parseEmail(mail.source);
    const thread = await threadOf(db, email);
    const stored = await storeInboundMessage(db, {
      channel: "EMAIL",
      conversationExternalId: thread,
      externalId: email.messageId,
      sender: email.from,
      subject: email.subject,
      bodyText: email.text,
      // The original email, so the request can always go back to the source.
      raw: {
        source: Buffer.from(mail.source).toString("base64"),
        headers: email.headers,
        recipients: email.recipients,
        attachments: email.attachments,
      },
      sentAt: email.sentAt,
      inReplyTo: email.inReplyTo,
      attachments: email.attachments,
    });
    if (stored.isNew) {
      // Automatic replies and mailing lists are kept, but neither handled nor answered.
      if (isAutomatic(email, options.address)) {
        await markHandled(db, stored.messageId);
      } else {
        queue.push(() => process(email, thread, stored.messageId));
      }
    }
    await options.mailbox.markSeen(mail.uid);
  }

  // Emails stored before a restart but never handled are handled first, from their original source.
  async function recoverUnhandled(): Promise<void> {
    const unhandled = await listUnhandledMessages(db, "EMAIL");
    const prepared = await Promise.all(
      unhandled.map(async (stored) => {
        const source = storedSource.safeParse(stored.raw);
        if (!source.success) {
          // Stored by an earlier version, without its source: it cannot be read again.
          await markHandled(db, stored.messageId);
          return undefined;
        }
        const email = await parseEmail(Buffer.from(source.data.source, "base64"));
        return { email, thread: await threadOf(db, email), messageId: stored.messageId };
      }),
    );
    // Queued in their order, oldest first.
    for (const item of prepared) {
      if (item !== undefined) {
        queue.push(() => process(item.email, item.thread, item.messageId));
      }
    }
  }

  // A database that is down at startup does not stop the channel: the messages stay unhandled and
  // are handled again at the next start.
  await recoverUnhandled().catch((error: unknown) => {
    logger.error("Unhandled messages could not be resumed", error);
  });

  return options.mailbox
    .watch(async (mail) => {
      try {
        await receive(mail);
      } catch (error) {
        // Left unread, so it is read again at the next start and not lost.
        logger.error(`Email ${mail.uid} could not be stored`, error);
      }
    })
    .then(() => {
      logger.info("Email adapter listening");
      return { idle: queue.idle };
    });
}
