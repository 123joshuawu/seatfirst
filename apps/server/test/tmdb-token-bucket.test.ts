import { describe, expect, it } from "vitest";

import {
  createTokenBucket,
  TMDB_TOKEN_BUCKET_CAPACITY,
  TMDB_TOKEN_BUCKET_REFILL_PER_SECOND,
} from "../src/tmdb/token-bucket.js";

/**
 * S25.5 token bucket (ADR 0019 amendment decision 3): capacity 30, refill 30/s. The fake
 * clock + recording sleep let the refill arithmetic be asserted without real timers.
 */
describe("createTokenBucket (S25.5)", () => {
  it("serves exactly capacity requests without waiting, then blocks the next", async () => {
    const clock = { ms: 0 };
    const sleeps: number[] = [];
    const bucket = createTokenBucket({
      now: () => clock.ms,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.ms += ms;
        return Promise.resolve();
      },
    });

    for (let i = 0; i < TMDB_TOKEN_BUCKET_CAPACITY; i++) {
      await bucket.acquire();
    }
    expect(sleeps).toEqual([]);

    await bucket.acquire(); // the 31st — must wait for a refilled token
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("refills at the pinned rate so a full second restores the whole capacity", async () => {
    const clock = { ms: 0 };
    const sleeps: number[] = [];
    const bucket = createTokenBucket({
      now: () => clock.ms,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.ms += ms;
        return Promise.resolve();
      },
    });

    for (let i = 0; i < TMDB_TOKEN_BUCKET_CAPACITY; i++) {
      await bucket.acquire();
    }
    // One second later, exactly `refillPerSecond` tokens have returned.
    clock.ms += 1000;
    for (let i = 0; i < TMDB_TOKEN_BUCKET_REFILL_PER_SECOND; i++) {
      await bucket.acquire();
    }
    // None of the refilled-token acquisitions needed to wait.
    expect(sleeps).toEqual([]);
  });

  it("never exceeds capacity no matter how long it idles", async () => {
    const clock = { ms: 0 };
    const sleeps: number[] = [];
    const bucket = createTokenBucket({
      now: () => clock.ms,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.ms += ms;
        return Promise.resolve();
      },
    });

    clock.ms += 60_000; // a minute of idle must not mint more than capacity tokens
    for (let i = 0; i < TMDB_TOKEN_BUCKET_CAPACITY; i++) {
      await bucket.acquire();
    }
    expect(sleeps).toEqual([]);

    // The 31st must wait: the bucket was capped at capacity, not 60_000/33.3 ≈ 1800.
    await bucket.acquire();
    expect(sleeps.length).toBeGreaterThan(0);
  });
});
