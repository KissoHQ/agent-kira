// A check that costs a call to another service, such as the database, run at most once per period:
// callers within the period, even many at the same time, share its result. A public route that
// runs it, such as /ready, then costs the same whatever the number of requests.
export function cachedCheck<T>(
  check: () => Promise<T>,
  periodMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let last: { at: number; result: Promise<T> } | undefined;
  return () => {
    const time = now();
    if (last === undefined || time - last.at >= periodMs) {
      last = { at: time, result: check() };
    }
    return last.result;
  };
}

// The period of the checks of /ready: an orchestrator asks every few seconds at most.
export const readinessCheckPeriodMs = 5000;
