import { describe, expect, it } from "vitest";

import { isPermanentSmtpError } from "./errors";

// An error as nodemailer reports a reply of the mail server.
const smtpError = (responseCode: number, command: string) =>
  Object.assign(new Error("Message failed"), { responseCode, command });

describe("isPermanentSmtpError", () => {
  it("gives up when the recipient or the message is refused for good", () => {
    expect(isPermanentSmtpError(smtpError(550, "RCPT TO"))).toBe(true);
    expect(isPermanentSmtpError(smtpError(554, "DATA"))).toBe(true);
  });

  it("keeps trying on a temporary refusal, a wrong order or a sign-in refused", () => {
    expect(isPermanentSmtpError(smtpError(451, "RCPT TO"))).toBe(false);
    expect(isPermanentSmtpError(smtpError(503, "DATA"))).toBe(false);
    expect(isPermanentSmtpError(smtpError(535, "AUTH PLAIN"))).toBe(false);
    expect(isPermanentSmtpError(new Error("connect ECONNREFUSED"))).toBe(false);
  });
});
