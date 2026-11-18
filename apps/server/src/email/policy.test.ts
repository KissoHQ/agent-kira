import { describe, expect, it } from "vitest";

import { rawEmail } from "../../test/emails";
import { parseEmail } from "./parse";
import { checkSender, isAutomatic } from "./policy";

const trusted = { trustedAuthservId: "mx.requests.example", trustAllSenders: false };

async function emailWith(headers: Record<string, string>, from = "alice.martin@acme.example") {
  return parseEmail(await rawEmail({ from, headers }));
}

describe("checkSender", () => {
  it("verifies a sender that passed DMARC at our receiving server", async () => {
    const email = await emailWith({
      "Authentication-Results":
        "mx.requests.example; dkim=pass header.i=@acme.example; dmarc=pass (p=REJECT) header.from=acme.example",
    });

    expect(checkSender(email, trusted).trust).toBe("VERIFIED");
  });

  it("reads the header that Gmail writes, with its comments and its other methods", async () => {
    // As received on 2026-10-30 by the Gmail account of the agent, with the addresses replaced.
    const email = await emailWith({
      "Authentication-Results":
        "mx.google.com;\r\n       dkim=pass header.i=@acme.example header.s=20260707 header.b=jf1ehd1E;\r\n       spf=pass (google.com: domain of bounce@mail.acme.example designates 209.85.220.69 as permitted sender) smtp.mailfrom=bounce@mail.acme.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.example;\r\n       dara=pass header.i=@gmail.com",
    });

    expect(
      checkSender(email, { trustedAuthservId: "mx.google.com", trustAllSenders: false }).trust,
    ).toBe("VERIFIED");
  });

  it("ignores a result written by another server, as a sender can forge one", async () => {
    const email = await emailWith({
      "Authentication-Results": "mx.evil.example; dmarc=pass header.from=acme.example",
    });

    expect(checkSender(email, trusted).trust).toBe("UNVERIFIED");
  });

  it("does not verify a sender that failed DMARC, or another domain than the From address", async () => {
    const failed = await emailWith({
      "Authentication-Results": "mx.requests.example; dmarc=fail header.from=acme.example",
    });
    const otherDomain = await emailWith({
      "Authentication-Results": "mx.requests.example; dmarc=pass header.from=evil.example",
    });

    expect(checkSender(failed, trusted).trust).toBe("UNVERIFIED");
    expect(checkSender(otherDomain, trusted).trust).toBe("UNVERIFIED");
  });

  it("marks as forged an address whose domain failed DMARC at our receiving server only", async () => {
    const failed = await emailWith({
      "Authentication-Results": "mx.requests.example; dmarc=fail header.from=acme.example",
    });
    const failedElsewhere = await emailWith({
      "Authentication-Results": "mx.evil.example; dmarc=fail header.from=acme.example",
    });
    const unknown = await emailWith({});

    expect(checkSender(failed, trusted)).toEqual({ trust: "UNVERIFIED", forged: true });
    expect(checkSender(failedElsewhere, trusted).forged).toBe(false);
    expect(checkSender(unknown, trusted).forged).toBe(false);
  });

  it("verifies nobody when no receiving server is trusted", async () => {
    const email = await emailWith({
      "Authentication-Results": "mx.requests.example; dmarc=pass header.from=acme.example",
    });

    expect(checkSender(email, { trustedAuthservId: undefined, trustAllSenders: false }).trust).toBe(
      "UNVERIFIED",
    );
    expect(checkSender(await emailWith({}), trusted).trust).toBe("UNVERIFIED");
  });

  it("trusts every sender only when told to, for local tests", async () => {
    expect(
      checkSender(await emailWith({}), { trustedAuthservId: undefined, trustAllSenders: true }),
    ).toEqual({ trust: "VERIFIED", forged: false });
  });
});

describe("isAutomatic", () => {
  const own = "agent@requests.example";

  it("lets a message written by a person through", async () => {
    expect(isAutomatic(await emailWith({}), own)).toBe(false);
    expect(isAutomatic(await emailWith({ "Auto-Submitted": "no" }), own)).toBe(false);
  });

  it("recognizes automatic replies, mailing lists and bulk mail", async () => {
    expect(isAutomatic(await emailWith({ "Auto-Submitted": "auto-replied" }), own)).toBe(true);
    expect(isAutomatic(await emailWith({ Precedence: "bulk" }), own)).toBe(true);
    expect(isAutomatic(await emailWith({ "List-Id": "<team.acme.example>" }), own)).toBe(true);
  });

  it("recognizes robot senders and the agent itself", async () => {
    expect(isAutomatic(await emailWith({}, "MAILER-DAEMON@acme.example"), own)).toBe(true);
    expect(isAutomatic(await emailWith({}, "no-reply@acme.example"), own)).toBe(true);
    expect(isAutomatic(await emailWith({}, own), own)).toBe(true);
  });

  it("recognizes a no-reply address with a prefix or a tag", async () => {
    expect(isAutomatic(await emailWith({}, "billing-noreply@acme.example"), own)).toBe(true);
    expect(isAutomatic(await emailWith({}, "billing.do-not-reply@acme.example"), own)).toBe(true);
    expect(isAutomatic(await emailWith({}, "no-reply+alerts@acme.example"), own)).toBe(true);
  });

  it("lets through people whose address only contains a robot word", async () => {
    expect(isAutomatic(await emailWith({}, "noreen.ply@acme.example"), own)).toBe(false);
    expect(isAutomatic(await emailWith({}, "jean.postmaster@acme.example"), own)).toBe(false);
    expect(isAutomatic(await emailWith({}, "replynow@acme.example"), own)).toBe(false);
  });
});
