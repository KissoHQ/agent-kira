import { describe, expect, it } from "vitest";

import {
  createRateLimiter,
  createSlots,
  createWaitingCounter,
  maxWaitingMessages,
  maxWaitingPerAddress,
} from "./admission";

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

describe("createWaitingCounter", () => {
  it("limits the waiting messages of one address, and gives the place back", () => {
    const waiting = createWaitingCounter();
    for (let index = 0; index < maxWaitingPerAddress; index += 1) {
      expect(waiting.take("a")).toBeUndefined();
    }

    expect(waiting.take("a")).toBe("TOO_MANY_FOR_ADDRESS");
    expect(waiting.take("b")).toBeUndefined();
    waiting.release("a");
    expect(waiting.take("a")).toBeUndefined();
  });

  it("limits the waiting messages in total, counting those left by a restart", () => {
    const waiting = createWaitingCounter(maxWaitingMessages - 1);

    expect(waiting.take("a")).toBeUndefined();
    expect(waiting.take("b")).toBe("QUEUE_FULL");
    waiting.release(null);
    expect(waiting.take("b")).toBeUndefined();
  });
});

describe("createSlots", () => {
  it("runs a few tasks at a time, the others in their order, and refuses beyond the waiting limit", async () => {
    const slots = createSlots(1, 1);
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = slots.run(async () => {
      await gate.promise;
      order.push("first");
    });
    const second = slots.run(() => {
      order.push("second");
      return Promise.resolve();
    });

    expect(await slots.run(() => Promise.resolve())).toBeUndefined();
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("frees the slot of a task that fails", async () => {
    const slots = createSlots(1, 0);

    await expect(slots.run(() => Promise.reject(new Error("disk full")))).rejects.toThrow();
    expect(await slots.run(() => Promise.resolve("ok"))).toEqual({ value: "ok" });
  });
});
