import { describe, expect, it } from "vitest";

import { createLogger, errorMessage, type LogLevel } from "./logger.ts";

function capture(minimum: LogLevel) {
  const lines: { level: LogLevel; line: string }[] = [];
  const logger = createLogger("KIRA", minimum, (level, line) => lines.push({ level, line }));
  return { logger, lines };
}

describe("createLogger", () => {
  it("writes the level, the name, the message and its values as JSON", () => {
    const { logger, lines } = capture("debug");

    logger.warn("The agent was stopped by a limit", { limit: "step-limit" });

    expect(lines).toEqual([
      {
        level: "warn",
        line: expect.stringMatching(
          /^\d{4}-\d\d-\d\dT[\d:.]+Z WARN \(KIRA\): The agent was stopped by a limit \{"limit":"step-limit"\}$/,
        ),
      },
    ]);
  });

  it("leaves out the levels below the one asked for", () => {
    const { logger, lines } = capture("warn");

    logger.debug("debug");
    logger.info("info");
    logger.warn("warn");
    logger.error("error");

    expect(lines.map(({ level }) => level)).toEqual(["warn", "error"]);
  });
});

describe("errorMessage", () => {
  it("gives the message of an error, or the value itself", () => {
    expect(errorMessage(new Error("down"))).toBe("down");
    expect(errorMessage("refused")).toBe("refused");
  });
});
