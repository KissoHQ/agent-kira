import { describe, expect, it } from "vitest";

import { retryUntilDone } from "./retry";

describe("retryUntilDone", () => {
  it("tries again after each failure until the task succeeds", async () => {
    const failures: number[] = [];
    let calls = 0;

    const result = await retryUntilDone(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error("down")) : Promise.resolve("up");
      },
      { delaysMs: [1], onFailure: (_, attempt) => failures.push(attempt) },
    );

    expect(result).toBe("up");
    expect(failures).toEqual([1, 2]);
  });

  it("gives up when it is stopped", async () => {
    let stopped = false;
    let calls = 0;

    const result = await retryUntilDone(
      () => {
        calls += 1;
        stopped = calls === 2;
        return Promise.reject(new Error("down"));
      },
      { delaysMs: [1], onFailure: () => undefined, stopped: () => stopped },
    );

    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });
});
