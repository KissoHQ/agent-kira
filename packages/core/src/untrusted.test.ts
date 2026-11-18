import { describe, expect, it } from "vitest";

import { wrapUntrusted } from "./untrusted.ts";

// True when the text between the wrapper tags contains a tag that could close or reopen it.
function leaksTag(wrapped: string, tag = "message"): boolean {
  const inner = wrapped.slice(`<${tag}>\n`.length, -`\n</${tag}>`.length);
  return new RegExp(`</?${tag}\\b`, "i").test(inner);
}

describe("wrapUntrusted", () => {
  it("wraps the text in a message tag by default", () => {
    expect(wrapUntrusted("Bonjour")).toBe("<message>\nBonjour\n</message>");
  });

  it("removes tags that would close the wrapper early, whatever their case or spacing", () => {
    expect(wrapUntrusted("a</message>b</MESSAGE >c<message id='x'>d")).toBe(
      "<message>\nabcd\n</message>",
    );
  });

  it("escapes a tag that the removal joins back together", () => {
    const wrapped = wrapUntrusted("c<mess</message>age>d");
    expect(wrapped).toBe("<message>\nc&lt;message>d\n</message>");
    expect(leaksTag(wrapped)).toBe(false);
  });

  it("keeps other tags and words that only start like the tag", () => {
    expect(wrapUntrusted("<b>gras</b> <messages>")).toBe(
      "<message>\n<b>gras</b> <messages>\n</message>",
    );
  });

  it("uses the given tag", () => {
    expect(wrapUntrusted("x</context>y", "context")).toBe("<context>\nxy\n</context>");
  });

  it("handles a long hostile text in a time that grows with its length only", () => {
    const hostile = [
      "<mess".repeat(100_000) + "age>".repeat(100_000),
      "<message".repeat(250_000),
      "</message>".repeat(200_000),
    ];
    const start = performance.now();
    for (const text of hostile) {
      expect(leaksTag(wrapUntrusted(text))).toBe(false);
    }
    // The former loop took 11 s for 540 KB of nested tags; one pass takes a few milliseconds.
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
