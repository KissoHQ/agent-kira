import { describe, expect, it } from "vitest";

import { cachedCheck } from "./cached-check.ts";

describe("cachedCheck", () => {
  it("runs the check once per period, whatever the number of callers", async () => {
    let time = 0;
    let runs = 0;
    const check = cachedCheck(
      () => {
        runs += 1;
        return Promise.resolve(runs);
      },
      5000,
      () => time,
    );

    const together = await Promise.all(Array.from({ length: 100 }, () => check()));
    time = 4999;
    const sameAgain = await check();
    time = 5000;
    const next = await check();

    expect(new Set(together)).toEqual(new Set([1]));
    expect(sameAgain).toBe(1);
    expect(next).toBe(2);
    expect(runs).toBe(2);
  });
});
