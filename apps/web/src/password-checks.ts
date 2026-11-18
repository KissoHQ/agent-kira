// Each password check runs Argon2id: 19 MiB of memory and a few tens of milliseconds on the thread
// pool that Node.js shares with file reads. A flood of sign-in attempts must not use all of it, so
// a few checks run at a time, a bounded number wait, and the next ones are refused at once.
export const maxRunningChecks = 2;
export const maxWaitingChecks = 50;

export type CheckOutcome<T> = { ran: true; value: T } | { ran: false };

export function createCheckQueue(maxRunning = maxRunningChecks, maxWaiting = maxWaitingChecks) {
  let running = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    const next = waiting.shift();
    if (next === undefined) {
      running -= 1;
    } else {
      // The slot passes to the next check without being freed in between.
      next();
    }
  };

  return {
    async run<T>(check: () => Promise<T>): Promise<CheckOutcome<T>> {
      if (running >= maxRunning) {
        if (waiting.length >= maxWaiting) {
          return { ran: false };
        }
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      } else {
        running += 1;
      }
      try {
        return { ran: true, value: await check() };
      } finally {
        release();
      }
    },
  };
}

export type CheckQueue = ReturnType<typeof createCheckQueue>;
