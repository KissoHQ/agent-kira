// Waits before trying again to reach a service that is down, such as Slack or the mail server
// after a restart of the machine, then tries every 5 minutes until it answers.
export const connectRetryDelaysMs = [10_000, 30_000, 60_000, 120_000, 300_000];

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Runs the task until it succeeds, waiting longer after each failure. Undefined when it is stopped
// before succeeding, such as when the server shuts down.
export async function retryUntilDone<T>(
  task: () => Promise<T>,
  options: {
    onFailure: (error: unknown, attempt: number) => void;
    delaysMs?: number[];
    stopped?: () => boolean;
  },
): Promise<T | undefined> {
  const delays = options.delaysMs ?? connectRetryDelaysMs;
  for (let attempt = 1; options.stopped?.() !== true; attempt += 1) {
    try {
      // Each attempt waits for the previous one: they cannot run in parallel.
      // oxlint-disable-next-line no-await-in-loop
      return await task();
    } catch (error) {
      options.onFailure(error, attempt);
      // oxlint-disable-next-line no-await-in-loop
      await wait(delays[Math.min(attempt - 1, delays.length - 1)] ?? 0);
    }
  }
  return undefined;
}
