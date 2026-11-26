import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limiter.ts";

describe("createRateLimiter", () => {
  const limit = { max: 3, windowMs: 1000, maxKeys: 2 };

  function limiterAt(start: number) {
    let time = start;
    const limiter = createRateLimiter(limit, () => time);
    return { limiter, advance: (ms: number) => (time += ms) };
  }

  it("allows the maximum in a window for each key, then says when to come back", () => {
    const { limiter, advance } = limiterAt(0);
    expect([1, 2, 3].map(() => limiter.take("a").allowed)).toEqual([true, true, true]);
    advance(400);

    expect(limiter.take("a")).toEqual({ allowed: false, retryAfterMs: 600 });
    expect(limiter.take("b").allowed).toBe(true);
    advance(600);
    expect(limiter.take("a").allowed).toBe(true);
  });

  it("never drops a limited key to make room for another", () => {
    const { limiter, advance } = limiterAt(0);
    [1, 2, 3].forEach(() => limiter.take("a"));
    limiter.take("b");

    expect(limiter.take("c")).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.take("a").allowed).toBe(false);
    advance(1000);
    expect(limiter.take("c").allowed).toBe(true);
  });
});
