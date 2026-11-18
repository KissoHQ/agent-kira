import { describe, expect, it } from "vitest";

import { createCheckQueue } from "./password-checks.ts";

describe("createCheckQueue", () => {
  it("runs a few checks at a time and the waiting ones in their order", async () => {
    const queue = createCheckQueue(2, 10);
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      queue.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[0]?.resolve();
    await runs[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1, 2]);
    gates[1]?.resolve();
    gates[2]?.resolve();

    expect(await Promise.all(runs)).toEqual([
      { ran: true, value: 0 },
      { ran: true, value: 1 },
      { ran: true, value: 2 },
    ]);
  });

  it("refuses at once when too many checks already wait", async () => {
    const queue = createCheckQueue(1, 1);
    const gate = Promise.withResolvers<void>();
    const first = queue.run(() => gate.promise);
    const second = queue.run(() => Promise.resolve());

    expect(await queue.run(() => Promise.resolve())).toEqual({ ran: false });
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([
      { ran: true, value: undefined },
      { ran: true, value: undefined },
    ]);
  });

  it("frees the slot of a check that fails", async () => {
    const queue = createCheckQueue(1, 0);

    await expect(queue.run(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await queue.run(() => Promise.resolve("ok"))).toEqual({ ran: true, value: "ok" });
  });
});
