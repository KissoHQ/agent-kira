import { describe, expect, it } from "vitest";

import { escapeForSlack } from "./connect.ts";

describe("escapeForSlack", () => {
  it("keeps a text written by the model from notifying a channel or hiding a link", () => {
    expect(escapeForSlack("Prévenez <!channel> & lisez <https://evil.example|la doc>")).toBe(
      "Prévenez &lt;!channel&gt; &amp; lisez &lt;https://evil.example|la doc&gt;",
    );
  });
});
