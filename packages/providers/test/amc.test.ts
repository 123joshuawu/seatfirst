/// <reference lib="dom" />
declare const process: { env: Record<string, string | undefined> };
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { classifyResponse } from "../src/amc/classify.js";
import { AmcFetcher } from "../src/amc/fetcher.js";
import {
  buildTheatresUrl,
  buildMoviesUrl,
  buildShowtimesUrl,
  buildSeatsUrl,
  buildTheatresDirectoryUrl,
  buildMarketTheatresUrl,
  isAllowedUrl,
} from "../src/amc/routes.js";
import { validateIdentity } from "../src/amc/identity.js";
import type { AmcFetchOptions } from "../src/amc/fetcher.js";

describe("AMC Layer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("P4.7 CI Environment Guard", () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = typeof process !== "undefined" ? process.env.SEATFIRST_ENV : undefined;
    });

    afterEach(() => {
      if (typeof process !== "undefined") {
        process.env.SEATFIRST_ENV = originalEnv;
      }
    });

    it("refuses to construct with global fetch when SEATFIRST_ENV is ci", () => {
      if (typeof process !== "undefined") process.env.SEATFIRST_ENV = "ci";

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: globalThis.fetch, isLive: true },
      };

      expect(() => new AmcFetcher(options)).toThrow(/Refusing to use live global fetch/);
    });

    it("allows construction with global fetch when SEATFIRST_ENV is not ci", () => {
      if (typeof process !== "undefined") process.env.SEATFIRST_ENV = "development";

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 500,
        socketTimeoutMs: 5000,
        transport: { request: globalThis.fetch, isLive: true },
      };

      expect(() => new AmcFetcher(options)).not.toThrow();
    });

    it("allows construction in ci when fetchImpl is a stub", () => {
      if (typeof process !== "undefined") process.env.SEATFIRST_ENV = "ci";

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(), isLive: false },
      };

      expect(() => new AmcFetcher(options)).not.toThrow();
    });
  });

  describe("P4.6 Cookie Jar", () => {
    it("accumulates cookies and sends them on subsequent requests without logging them", async () => {
      let callCount = 0;
      let observedCookieHeader: string | undefined;

      const stubFetch = (_url: URL | string | Request, init?: RequestInit) => {
        callCount++;
        const reqHeaders = init?.headers as Record<string, string> | undefined;
        if (callCount === 2) {
          observedCookieHeader = reqHeaders?.["Cookie"];
        }

        const resHeaders = new Headers();
        if (callCount === 1) {
          // Node 18+ Headers implements getSetCookie, but we'll use a mocked method just to be safe
          const headersAny = resHeaders as unknown as { getSetCookie: () => string[] };
          headersAny.getSetCookie = () => [
            "session_id=abc123; Path=/; HttpOnly",
            "tracker=456; Path=/",
          ];
        }

        return Promise.resolve({
          status: 200,
          headers: resHeaders,
          text: () => Promise.resolve("ok"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);

      const p1 = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      const res1 = await p1;

      const p2 = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      const res2 = await p2;

      expect(observedCookieHeader).toBe("session_id=abc123; tracker=456");

      // Verify logs don't contain cookies
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      if (res1.ok && res2.ok) {
        expect(JSON.stringify(res1.value.log)).not.toMatch(/abc123|session_id/);
        expect(JSON.stringify(res2.value.log)).not.toMatch(/abc123|session_id/);
      }
    });
  });

  describe("P4.5 Classifier Ordering", () => {
    it("classifies challenge-under-200 as CHALLENGE_REQUIRED, not ok", () => {
      const result = classifyResponse(
        200,
        { "cf-mitigated": "challenge" },
        { finalHost: "www.amctheatres.com", bodyPrefix: "<html>plausible body</html>" },
      );
      expect(result).toEqual({ ok: false, code: "CHALLENGE_REQUIRED" });
    });

    it("classifies branded 404 under 200 as NOT_FOUND via the Flight notFound digest (Checklist Item 9)", () => {
      const result = classifyResponse(
        200,
        {},
        {
          finalHost: "www.amctheatres.com",
          bodyPrefix: 'E{\\"digest\\":\\"NEXT_NOT_FOUND\\"}\\n',
        },
      );
      expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("P4.3 One in-flight max", () => {
    it("enforces max 1 in-flight request per origin", async () => {
      let inFlight = 0;
      let maxObserved = 0;

      const stubFetch = async () => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);

        await new Promise((r) => setTimeout(r, 50));

        inFlight--;
        return {
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve("ok"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response;
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);

      const p1 = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      const p2 = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));

      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);

      expect(maxObserved).toBe(1);
    });
  });

  describe("P4.3 Retry-After and Backoff", () => {
    it("honors Retry-After on 429", async () => {
      let attempts = 0;
      const stubFetch = () => {
        attempts++;
        if (attempts === 1) {
          return Promise.resolve({
            status: 429,
            headers: new Headers({ "retry-after": "10" }),
            text: () => Promise.resolve("rate limited"),
            url: "https://www.amctheatres.com/movies",
          } as unknown as Response);
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve("ok"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 2,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));

      // Wait just short of the 10s delay (10000ms)
      await vi.advanceTimersByTimeAsync(9900);
      expect(attempts).toBe(1); // Second call must not have started yet

      await vi.advanceTimersByTimeAsync(200); // Cross the threshold
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(attempts).toBe(2);
    });
    it("uses injected backoff on 429 without Retry-After", async () => {
      let attempts = 0;
      const stubFetch = () => {
        attempts++;
        if (attempts === 1) {
          return Promise.resolve({
            status: 429,
            headers: new Headers(),
            text: () => Promise.resolve("rate limited"),
            url: "https://www.amctheatres.com/movies",
          } as unknown as Response);
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve("ok"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 2,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));

      // Attempt 1 backoff is baseMs * 2^(1-1) = 100ms
      await vi.advanceTimersByTimeAsync(90);
      expect(attempts).toBe(1); // Second call must not have started yet

      await vi.advanceTimersByTimeAsync(20); // Cross the threshold
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(attempts).toBe(2);
    });
  });

  describe("P4.4 Halt is a halt", () => {
    it("records exactly one request on CHALLENGE_REQUIRED (no retry)", async () => {
      let attempts = 0;
      const stubFetch = () => {
        attempts++;
        return Promise.resolve({
          status: 200,
          headers: new Headers({ "cf-mitigated": "challenge" }),
          text: () => Promise.resolve("challenge"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe("CHALLENGE_REQUIRED");
      expect(attempts).toBe(1);
    });

    it("positive control: retries a transient 5xx", async () => {
      let attempts = 0;
      const stubFetch = () => {
        attempts++;
        if (attempts < 3) {
          return Promise.resolve({
            status: 502,
            headers: new Headers(),
            text: () => Promise.resolve("error"),
            url: "https://www.amctheatres.com/movies",
          } as unknown as Response);
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve("ok"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  describe("P4.2 Identification", () => {
    it("fails immediately if userAgent is unset (zero transport calls)", () => {
      expect(() => {
        validateIdentity({ userAgent: "" });
      }).toThrow(/userAgent is required/);
    });

    it("observes exact configured string when UA is set", async () => {
      let observedUa: string | undefined = "";
      const stubFetch = (_url: URL | string | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        observedUa = headers["User-Agent"];
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          text: () => Promise.resolve("ok"),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "my-honest-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      await promise;
      expect(observedUa).toBe("my-honest-agent (https://example.com)");
    });

    it("rejects a product name that is punctuation-only after removing the contact (no real product name)", () => {
      expect(() => {
        validateIdentity({ userAgent: "- (https://example.com)" });
      }).toThrow(/must contain a product name/);
    });

    it("rejects a contact that is a bare scheme with no real host", () => {
      expect(() => {
        validateIdentity({ userAgent: "MyProduct (https://)" });
      }).toThrow(/must contain a product name/);
    });

    it("rejects a bare mailto: with no address", () => {
      expect(() => {
        validateIdentity({ userAgent: "MyProduct (mailto:)" });
      }).toThrow(/must contain a product name/);
    });

    it("accepts a real product name plus a real contact host", () => {
      expect(() => {
        validateIdentity({ userAgent: "SeatFinder-FixtureCapture (https://example.com/contact)" });
      }).not.toThrow();
      expect(() => {
        validateIdentity({ userAgent: "SeatFinder-FixtureCapture (mailto:ops@example.com)" });
      }).not.toThrow();
    });
  });

  describe("P4 Redirect handling (regression)", () => {
    it("blocks a redirect to a disallowed same-origin path as UPSTREAM_BLOCKED, never a silent success", async () => {
      const stubFetch = () => {
        const headers = new Headers();
        headers.set("location", "https://www.amctheatres.com/account");
        return Promise.resolve({
          status: 302,
          headers,
          text: () => Promise.resolve(""),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("UPSTREAM_BLOCKED");
      }
    });

    it("classifies a redirect to a Queue-it host as UPSTREAM_QUEUED, not UPSTREAM_BLOCKED", async () => {
      const stubFetch = () => {
        const headers = new Headers();
        headers.set("location", "https://amctheatres.queue-it.net/?c=amc&e=globalsafetynetweb");
        return Promise.resolve({
          status: 302,
          headers,
          text: () => Promise.resolve(""),
          url: "https://www.amctheatres.com/movies",
        } as unknown as Response);
      };

      const options: AmcFetchOptions = {
        userAgent: "test-agent (https://example.com)",
        maxAttempts: 1,
        backoffBaseMs: 100,
        backoffCeilingMs: 1000,
        jitterWindowMs: 0,
        socketTimeoutMs: 5000,
        transport: { request: vi.fn(stubFetch), isLive: false },
      };

      const fetcher = new AmcFetcher(options);
      const promise = fetcher.fetch(new URL("https://www.amctheatres.com/movies"));
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("UPSTREAM_QUEUED");
      }
    });
  });

  describe("P4.1 Allowlist", () => {
    it("rejects disallow prefixes", () => {
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/amc-stubs-wifi/login"))).toBe(false);
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/associate-resources"))).toBe(false);
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/search?q=batman"))).toBe(false);
      expect(isAllowedUrl(new URL("https://graph.amctheatres.com/graphql"))).toBe(false);
    });
    it("rejects arbitrary paths outside the six allowed shapes", () => {
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/account"))).toBe(false);
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/checkout"))).toBe(false);
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/"))).toBe(false);
    });

    it("ADR 0021: rejects near-misses of the two new movie-theatres shapes", () => {
      // Bare directory index with a stray param is neither the index nor the `?q=` search page.
      expect(isAllowedUrl(new URL("https://www.amctheatres.com/movie-theatres?extra=1"))).toBe(
        false,
      );
      // Market-slug page with any query param.
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/movie-theatres/boston?extra=1")),
      ).toBe(false);
      // Two bare segments without the `/showtimes` suffix is neither shape.
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/movie-theatres/boston/amc-boston")),
      ).toBe(false);
    });

    it("positive control: allows all six inventory routes", () => {
      expect(isAllowedUrl(buildTheatresUrl("boston"))).toBe(true);
      expect(isAllowedUrl(buildMoviesUrl())).toBe(true);
      expect(isAllowedUrl(buildShowtimesUrl("boston", "amc-boston", "2026-10-10"))).toBe(true);
      expect(isAllowedUrl(buildSeatsUrl(12345))).toBe(true);
      expect(isAllowedUrl(buildTheatresDirectoryUrl())).toBe(true);
      expect(isAllowedUrl(buildMarketTheatresUrl("boston"))).toBe(true);
    });

    it("produces correctly shaped URLs", () => {
      expect(buildTheatresUrl("boston").toString()).toBe(
        "https://www.amctheatres.com/movie-theatres?q=boston",
      );
      expect(buildMoviesUrl().toString()).toBe("https://www.amctheatres.com/movies");
      expect(buildShowtimesUrl("bos", "amc", "2026-10-10").toString()).toBe(
        "https://www.amctheatres.com/movie-theatres/bos/amc/showtimes?date=2026-10-10",
      );
      expect(buildSeatsUrl(123).toString()).toBe("https://www.amctheatres.com/showtimes/123/seats");
      expect(buildTheatresDirectoryUrl().toString()).toBe(
        "https://www.amctheatres.com/movie-theatres",
      );
      expect(buildMarketTheatresUrl("boston").toString()).toBe(
        "https://www.amctheatres.com/movie-theatres/boston",
      );
    });
    it("P9.1: buildSeatsUrl carries single and multiple seat names, clean path otherwise", () => {
      expect(buildSeatsUrl(146027740, ["J10"]).toString()).toBe(
        "https://www.amctheatres.com/showtimes/146027740/seats?seats=J10",
      );
      expect(buildSeatsUrl(146027740, ["J10", "J9", "J8", "J7"]).toString()).toBe(
        "https://www.amctheatres.com/showtimes/146027740/seats?seats=J10%2CJ9%2CJ8%2CJ7",
      );
      expect(buildSeatsUrl(123).toString()).toBe("https://www.amctheatres.com/showtimes/123/seats");
      expect(buildSeatsUrl(123, []).toString()).toBe(
        "https://www.amctheatres.com/showtimes/123/seats",
      );
    });

    it("P9.2: isAllowedUrl accepts the baseline seats map and valid ?seats= params", () => {
      expect(isAllowedUrl(buildSeatsUrl(12345))).toBe(true);
      expect(isAllowedUrl(buildSeatsUrl(12345, ["A1", "A2"]))).toBe(true);
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=A1,A2")),
      ).toBe(true);
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=G8")),
      ).toBe(true);
    });

    it("P9.2: isAllowedUrl fails closed on unauthorized keys, malformed values, duplicates", () => {
      // Unauthorized key.
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?foo=bar")),
      ).toBe(false);
      // Malformed characters: encoded space, semicolon, and empty value.
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=A1%20A2")),
      ).toBe(false);
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=A1%3BA2")),
      ).toBe(false);
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=")),
      ).toBe(false);
      // Duplicate `seats` keys.
      expect(
        isAllowedUrl(
          new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=A1&seats=A2"),
        ),
      ).toBe(false);
      // Valid key mixed with an unauthorized key.
      expect(
        isAllowedUrl(new URL("https://www.amctheatres.com/showtimes/12345/seats?seats=A1&foo=bar")),
      ).toBe(false);
    });
  });
});
