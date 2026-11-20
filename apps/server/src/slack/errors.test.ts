import { ErrorCode } from "@slack/web-api";
import { describe, expect, it } from "vitest";

import { isPermanentSlackError } from "./errors";

// An error as @slack/web-api throws it when Slack answers with ok: false.
const platformError = (error: string) =>
  Object.assign(new Error(`An API error occurred: ${error}`), {
    code: ErrorCode.PlatformError,
    data: { ok: false, error },
  });

describe("isPermanentSlackError", () => {
  it("gives up when the channel is gone, archived or closed to the bot", () => {
    for (const error of ["channel_not_found", "not_in_channel", "is_archived"]) {
      expect(isPermanentSlackError(platformError(error))).toBe(true);
    }
  });

  it("keeps trying on an error of the token, a limit or the network", () => {
    expect(isPermanentSlackError(platformError("invalid_auth"))).toBe(false);
    expect(isPermanentSlackError(platformError("ratelimited"))).toBe(false);
    expect(isPermanentSlackError(new Error("fetch failed"))).toBe(false);
    expect(isPermanentSlackError(undefined)).toBe(false);
  });
});
