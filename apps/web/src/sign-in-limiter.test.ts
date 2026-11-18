import { describe, expect, it } from "vitest";

import { createAttemptLimiter, emailLimits, type LimiterSettings } from "./sign-in-limiter.ts";

const settings: LimiterSettings = { maxAttempts: 5, lockDurationMs: 1000, maxTrackedKeys: 100 };

function limiterAt(start: number, limits = settings) {
  let time = start;
  const limiter = createAttemptLimiter(limits, () => time);
  return { limiter, advance: (ms: number) => (time += ms) };
}

function attempt(limiter: ReturnType<typeof createAttemptLimiter>, key: string, times: number) {
  return Array.from({ length: times }, () => limiter.begin(key).allowed);
}

describe("createAttemptLimiter", () => {
  it("allows the maximum number of attempts for a key, whatever its case, then locks it", () => {
    const { limiter } = limiterAt(0);

    expect(attempt(limiter, "dana@team.example", 4)).toEqual([true, true, true, true]);
    expect(limiter.begin(" Dana@Team.example ").allowed).toBe(true);

    expect(limiter.begin("dana@team.example")).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.begin("other@team.example").allowed).toBe(true);
  });

  it("counts attempts before their result, so a burst of attempts cannot pass the limit", () => {
    const { limiter } = limiterAt(0);

    const burst = attempt(limiter, "dana@team.example", 200);

    expect(burst.filter(Boolean)).toHaveLength(settings.maxAttempts);
  });

  it("unlocks after the lock duration, with a new count", () => {
    const { limiter, advance } = limiterAt(0);
    attempt(limiter, "dana@team.example", settings.maxAttempts);

    advance(settings.lockDurationMs - 1);
    expect(limiter.begin("dana@team.example")).toEqual({ allowed: false, retryAfterMs: 1 });
    advance(1);
    expect(attempt(limiter, "dana@team.example", settings.maxAttempts).every(Boolean)).toBe(true);
  });

  it("forgets the attempts of a key that stays quiet for a whole window", () => {
    const { limiter, advance } = limiterAt(0);
    attempt(limiter, "dana@team.example", settings.maxAttempts - 1);

    advance(settings.lockDurationMs);

    expect(attempt(limiter, "dana@team.example", settings.maxAttempts - 1).every(Boolean)).toBe(
      true,
    );
    expect(limiter.begin("dana@team.example").allowed).toBe(true);
  });

  it("gives back the attempt of a success, and clears every attempt on demand", () => {
    const { limiter } = limiterAt(0);
    attempt(limiter, "office", settings.maxAttempts);

    limiter.giveBack("office");
    expect(limiter.begin("office").allowed).toBe(true);

    limiter.clear("office");
    expect(attempt(limiter, "office", settings.maxAttempts).every(Boolean)).toBe(true);
  });

  it("never drops a locked key to make room, even when flooded with invented keys", () => {
    const { limiter } = limiterAt(0);
    attempt(limiter, "dana@team.example", settings.maxAttempts);

    for (let index = 0; index < settings.maxTrackedKeys * 3; index += 1) {
      limiter.begin(`invented-${index}@team.example`);
    }

    expect(limiter.begin("dana@team.example").allowed).toBe(false);
  });

  it("refuses a new key when every tracked key is locked", () => {
    const { limiter } = limiterAt(0, { ...settings, maxTrackedKeys: 2 });
    attempt(limiter, "a", settings.maxAttempts);
    attempt(limiter, "b", settings.maxAttempts);

    expect(limiter.begin("c")).toEqual({ allowed: false, retryAfterMs: settings.lockDurationMs });
  });

  it("follows the cheat sheet for one account: five attempts every fifteen minutes", () => {
    expect(emailLimits).toMatchObject({ maxAttempts: 5, lockDurationMs: 15 * 60 * 1000 });
  });
});
