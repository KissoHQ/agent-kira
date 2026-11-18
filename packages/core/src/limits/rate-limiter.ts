// Counts the requests of each key, such as a network address or an email address, in fixed
// windows of time, so one client cannot use the server for everyone else.

export interface RateLimit {
  // Requests allowed in each window, for one key.
  max: number;
  windowMs: number;
  // Bounds the memory used when someone sends from many addresses.
  maxKeys: number;
}

export type Admission = { allowed: true } | { allowed: false; retryAfterMs: number };

interface Window {
  start: number;
  count: number;
}

export function createRateLimiter(limit: RateLimit, now: () => number = Date.now) {
  // In the order of their last request, oldest first: a Map keeps the order of insertion.
  const windows = new Map<string, Window>();

  // Makes room for a new key by dropping the oldest one whose window is over. A key still limited
  // is never dropped, so sending from many addresses cannot reset one of them.
  function makeRoom(time: number): boolean {
    if (windows.size < limit.maxKeys) {
      return true;
    }
    for (const [key, window] of windows) {
      if (time - window.start >= limit.windowMs) {
        windows.delete(key);
        return true;
      }
    }
    return false;
  }

  return {
    take(key: string): Admission {
      const time = now();
      let window = windows.get(key);
      if (window === undefined || time - window.start >= limit.windowMs) {
        if (window === undefined && !makeRoom(time)) {
          return { allowed: false, retryAfterMs: limit.windowMs };
        }
        window = { start: time, count: 0 };
      }
      if (window.count >= limit.max) {
        return { allowed: false, retryAfterMs: window.start + limit.windowMs - time };
      }
      window.count += 1;
      windows.delete(key);
      windows.set(key, window);
      return { allowed: true };
    },
  };
}
