// Slows down password guessing (OWASP Authentication Cheat Sheet): after a few attempts for one
// key, an email or a network address, sign-in is refused for a while, whatever the password. Kept
// in memory: a restart clears it, which is acceptable for one server process.

export interface LimiterSettings {
  // Attempts allowed within the window; the next ones are refused until the lock ends.
  maxAttempts: number;
  // How long a key stays locked, and how long a quiet key keeps its count.
  lockDurationMs: number;
  // Bounds the memory used when someone tries many invented keys.
  maxTrackedKeys: number;
}

const fifteenMinutes = 15 * 60 * 1000;

// Five tries for one account, as the cheat sheet suggests.
export const emailLimits: LimiterSettings = {
  maxAttempts: 5,
  lockDurationMs: fifteenMinutes,
  maxTrackedKeys: 10_000,
};

// More for one network address, which a whole office can share, but enough to stop one machine
// from trying a few passwords on every account.
export const addressLimits: LimiterSettings = {
  maxAttempts: 30,
  lockDurationMs: fifteenMinutes,
  maxTrackedKeys: 10_000,
};

interface Attempts {
  count: number;
  lastAttemptAt: number;
  lockedUntil: number;
}

export type Admission = { allowed: true } | { allowed: false; retryAfterMs: number };

const normalize = (key: string) => key.trim().toLowerCase();

export function createAttemptLimiter(settings: LimiterSettings, now: () => number = Date.now) {
  // In the order of their last attempt, oldest first: a Map keeps the order of insertion.
  const attempts = new Map<string, Attempts>();

  const isLocked = (entry: Attempts, time: number) => entry.lockedUntil > time;

  // Makes room for a new key by dropping the oldest key that is not locked. Locked keys are never
  // dropped, so flooding the limiter with invented keys cannot unlock a real one.
  function makeRoom(time: number): boolean {
    if (attempts.size < settings.maxTrackedKeys) {
      return true;
    }
    for (const [key, entry] of attempts) {
      if (!isLocked(entry, time)) {
        attempts.delete(key);
        return true;
      }
    }
    return false;
  }

  return {
    // Counts an attempt before the password is checked, so attempts sent at the same time cannot
    // all pass before the first failure is known. A success gives it back.
    begin(rawKey: string): Admission {
      const key = normalize(rawKey);
      const time = now();
      let entry = attempts.get(key);
      if (entry !== undefined && isLocked(entry, time)) {
        return { allowed: false, retryAfterMs: entry.lockedUntil - time };
      }
      // A key quiet for the whole window starts again, so rare typos never add up to a lock.
      if (entry === undefined || time - entry.lastAttemptAt >= settings.lockDurationMs) {
        if (entry === undefined && !makeRoom(time)) {
          return { allowed: false, retryAfterMs: settings.lockDurationMs };
        }
        entry = { count: 0, lastAttemptAt: time, lockedUntil: 0 };
      }
      entry.count += 1;
      entry.lastAttemptAt = time;
      if (entry.count >= settings.maxAttempts) {
        entry.lockedUntil = time + settings.lockDurationMs;
      }
      attempts.delete(key);
      attempts.set(key, entry);
      return { allowed: true };
    },
    // A successful sign-in does not count: the attempt it took is given back.
    giveBack(rawKey: string): void {
      const key = normalize(rawKey);
      const entry = attempts.get(key);
      if (entry === undefined) {
        return;
      }
      entry.count -= 1;
      if (entry.count < settings.maxAttempts) {
        entry.lockedUntil = 0;
      }
      if (entry.count <= 0) {
        attempts.delete(key);
      }
    },
    // Forgets every attempt of the key, as after a successful sign-in to that account.
    clear(rawKey: string): void {
      attempts.delete(normalize(rawKey));
    },
  };
}

export type AttemptLimiter = ReturnType<typeof createAttemptLimiter>;
