import { describe, expect, it, vi } from "vitest";

import type { BrowserSupervisor } from "@seatfirst/browser-runtime";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import { startFetchWorker } from "../src/fetch-worker/entrypoint.js";
import type { ProviderFetchNavigationSeams } from "../src/dispatch/handlers/provider-fetch-actor.js";
import type { CreateCatalogueCrawlerOptions } from "../src/catalogue-crawl/entrypoint.js";

/**
 * Wiring proof for the confirmed dev-mode leak this repo fixed: `startFetchWorker`
 * forwards `options.navigationSeams.fetchHop` into BOTH consumers of the one shared
 * warm Chrome (ADR 0022 §6) — the RUN actor's `actorDeps.navigationSeams` AND
 * `createCatalogueCrawler`'s `fetchHop`. Before that forwarding existed, a fresh
 * `--profile full` stack's catalogue-crawl tick issued a real, unintercepted Playwright
 * navigation to the live AMC directory even though the dev entrypoint supplied a seam.
 *
 * Every external boundary is mocked (supervisor launch, dispatch consumers, env-sourced
 * pools, OTel, crash handlers); the real composition code under test runs end-to-end.
 * The assertion is on the exact options object handed to `createCatalogueCrawler`: same
 * seam reference as injected, and — when no seams are supplied — no `fetchHop` key at
 * all (gate 14 / no-undefined-key style; production stays byte-identical).
 */

const state = vi.hoisted(() => {
  return {
    crawlerOptions: [] as unknown[],
    supervisorStarts: 0,
    dispatchStarts: 0,
    stopped: [] as string[],
  };
});

vi.mock("../src/crash-handlers.js", () => ({
  installCrashHandlers: vi.fn(),
}));

vi.mock("@seatfirst/config/otel-bootstrap", () => ({
  buildOtelFromEnv: vi.fn(() => ({
    shutdown: () => Promise.resolve(),
    metrics: {},
  })),
}));

vi.mock("@seatfirst/durability", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    verifySchemaVersion: vi.fn(() => Promise.resolve()),
    SchemaVersionError: class extends Error {},
  };
});

vi.mock("@seatfirst/browser-runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BrowserSupervisor: class {
    static start = vi.fn(() => {
      state.supervisorStarts += 1;
      return {
        egressIdentityLabel: "test-egress",
        shutdown: () => Promise.resolve(),
        isReady: () => true,
        addReadinessListener: () => () => {},
      } as unknown as BrowserSupervisor;
    });
  },
}));

vi.mock("../src/catalogue-crawl/entrypoint.js", () => ({
  catalogueCrawlConfigFromEnv: vi.fn(() => ({
    postgres: {
      connectionString: "postgres://test:test@127.0.0.1:5999/test",
      max: 2,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1000,
    },
    redis: { host: "127.0.0.1", port: 6399 },
    egressIdentityLabel: "test-egress",
    userAgent: "test-agent",
    navigationTimeoutMs: 5000,
    semaphoreTtlMs: 60_000,
    chromeExecutablePath: "/usr/bin/chrome",
    cleanupGracePeriodMs: 100,
    readinessTimeoutMs: 1000,
    readinessTargetUrl: "http://127.0.0.1:8787/readyz",
  })),
  createCatalogueCrawler: vi.fn((options: CreateCatalogueCrawlerOptions) => {
    state.crawlerOptions.push(options);
    state.stopped.push("crawler");
    return {
      stop(): void {},
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
  }),
}));

vi.mock("../src/amc-movies-crawl/entrypoint.js", () => ({
  amcMoviesCrawlConfigFromEnv: vi.fn(() => ({
    postgres: {
      connectionString: "postgres://test:test@127.0.0.1:5999/test",
      max: 2,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1000,
    },
    redis: { host: "127.0.0.1", port: 6399 },
    egressIdentityLabel: "test-egress",
    userAgent: "test-agent",
    navigationTimeoutMs: 5000,
    semaphoreTtlMs: 60_000,
  })),
  createAmcMoviesCrawler: vi.fn(() => {
    state.stopped.push("amcMoviesCrawler");
    return Promise.resolve({
      pause(): void {},
      resume(): void {},
      close(): Promise<void> {
        return Promise.resolve();
      },
    });
  }),
}));

vi.mock("../src/dispatch/entry.js", () => ({
  dispatchConfigFromEnv: vi.fn(() => ({})),
  startDispatchWorker: vi.fn(() => {
    state.dispatchStarts += 1;
    state.stopped.push("dispatch");
    return {
      close(): Promise<void> {
        return Promise.resolve();
      },
    };
  }),
}));

vi.mock("../src/fetch-worker/aggregate-config.js", () => ({
  answerAssemblerDepsFromEnv: vi.fn(() => ({
    pool: { end: () => Promise.resolve() },
    providerHostAllowlists: { amc: ["example.invalid"] },
  })),
}));

vi.mock("../src/fetch-worker/provider-fetch-actor-config.js", () => ({
  providerFetchActorDepsFromEnv: vi.fn(() => ({
    pool: { end: () => Promise.resolve() },
    redis: {},
    redisClient: { quit: () => Promise.resolve("OK") },
    controlSource: () => Promise.resolve("OPEN"),
    userAgent: "test-agent",
    navigationLimits: { navigationTimeoutMs: 5000 },
    semaphoreTtlMs: 60_000,
    heartbeatIntervalMs: 1000,
    runLeaseTtl: "30 seconds",
    maxAttempts: 3,
    chargeSubscriberFetch: () => Promise.resolve(),
  })),
}));

const DEV_ENV = { EGRESS_IDENTITY_LABEL: "test-egress" };

function lastCrawlerOptions(): CreateCatalogueCrawlerOptions {
  expect(state.crawlerOptions.length).toBeGreaterThan(0);
  return state.crawlerOptions[state.crawlerOptions.length - 1] as CreateCatalogueCrawlerOptions;
}

describe("startFetchWorker — navigationSeams forwarding to the catalogue crawler", () => {
  it("forwards navigationSeams.fetchHop into createCatalogueCrawler by reference", async () => {
    const fetchHop = vi.fn(() =>
      Promise.resolve({ status: 200, headers: {}, body: "<html></html>" }),
    );
    const navigationSeams: ProviderFetchNavigationSeams = { fetchHop };
    const worker = await startFetchWorker(DEV_ENV, {
      navigationSeams,
      logger: {} as unknown as SeatfirstLogger,
      env: DEV_ENV,
    });
    await worker.close();

    // Exactly one shared warm Chrome (ADR 0022 §6), one crawl loop, one dispatch set.
    expect(state.supervisorStarts).toBe(1);
    expect(state.dispatchStarts).toBe(1);
    expect(state.crawlerOptions).toHaveLength(1);

    // THE regression pin: the SAME seam instance reaches the crawler, so crawler
    // navigations are fixture-intercepted/refused exactly like the RUN actor's.
    const options = lastCrawlerOptions();
    expect(options.fetchHop).toBe(fetchHop);
    expect(options.supervisor).toBeDefined();
  });

  it("adds no fetchHop key when no navigationSeams are supplied (production parity)", async () => {
    const worker = await startFetchWorker(DEV_ENV, {
      logger: {} as unknown as SeatfirstLogger,
      env: DEV_ENV,
    });
    await worker.close();

    const options = lastCrawlerOptions();
    // Gate 14 / no-undefined-key style: absent means absent — production's single call
    // site (`infra/docker/fetch-worker/entrypoint.mjs`) passes no second argument, so
    // behavior there is byte-for-byte unchanged by the seam parameter existing.
    expect("fetchHop" in options).toBe(false);
    expect(state.crawlerOptions).toHaveLength(2);
  });
});
