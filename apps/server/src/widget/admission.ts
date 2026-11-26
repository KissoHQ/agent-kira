import type { RateLimit } from "@request-agent/core";

// The widget is public: these limits keep one client from using the slow model, the memory or
// the disk of the server for everyone else.

// A person writes a few messages, each one handled in minutes by the model.
export const messageRate: RateLimit = { max: 10, windowMs: 10 * 60 * 1000, maxKeys: 10_000 };
// An open conversation asks for its answer every 5 seconds; a few open at once stay below this.
export const readRate: RateLimit = { max: 300, windowMs: 5 * 60 * 1000, maxKeys: 10_000 };

// Messages waiting for the agent beyond which the widget asks people to come back later: the
// model handles one message at a time, in minutes on a CPU.
export const maxWaitingMessages = 20;
// So that one client cannot fill the whole queue.
export const maxWaitingPerAddress = 3;

export type WaitingRefusal = "QUEUE_FULL" | "TOO_MANY_FOR_ADDRESS";

// Counts the messages waiting for the agent, in total and for each address. Taking a place and
// checking the limit happen together, without waiting in between, so requests that arrive at the
// same time cannot all pass a limit that only one of them should.
export function createWaitingCounter(initial = 0) {
  let total = initial;
  const byAddress = new Map<string, number>();

  return {
    take(address: string): WaitingRefusal | undefined {
      if (total >= maxWaitingMessages) {
        return "QUEUE_FULL";
      }
      const mine = byAddress.get(address) ?? 0;
      if (mine >= maxWaitingPerAddress) {
        return "TOO_MANY_FOR_ADDRESS";
      }
      total += 1;
      byAddress.set(address, mine + 1);
      return undefined;
    },
    // Called once the message is handled or given up, or when it was not stored after all.
    release(address: string | null): void {
      total = Math.max(total - 1, 0);
      if (address === null) {
        return;
      }
      const mine = (byAddress.get(address) ?? 1) - 1;
      if (mine <= 0) {
        byAddress.delete(address);
      } else {
        byAddress.set(address, mine);
      }
    },
  };
}

// Requests that carry files are read whole into memory: only a few at a time, the next ones wait
// their turn, and beyond a bounded number of waiting ones they are refused.
export const maxConcurrentUploads = 4;
export const maxWaitingUploads = 50;

// Runs tasks a few at a time, in their order of arrival. Undefined when too many already wait.
export function createSlots(maxRunning: number, maxWaiting: number) {
  let running = 0;
  const waiting: (() => void)[] = [];

  return {
    async run<T>(task: () => Promise<T>): Promise<{ value: T } | undefined> {
      if (running >= maxRunning) {
        if (waiting.length >= maxWaiting) {
          return undefined;
        }
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      } else {
        running += 1;
      }
      try {
        return { value: await task() };
      } finally {
        const next = waiting.shift();
        if (next === undefined) {
          running -= 1;
        } else {
          // The slot passes to the next task without being freed in between.
          next();
        }
      }
    },
  };
}
