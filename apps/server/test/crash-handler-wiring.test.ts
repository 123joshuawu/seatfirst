import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfiguredOtel } from "@seatfirst/config/otel";
import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";

import type { CrashHandlerDeps } from "../src/crash-handlers.js";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import {
  TEST_COOKIE_POLICY,
  TEST_PROVIDER_HOST_ALLOWLISTS,
  TEST_RATE_LIMIT_CONFIG,
} from "./support/app.js";

/**
 * O10.5 / verification item 1's parameterized behavioral wiring harness, shared by all
 * seven startup functions (`startApp` + the six worker roles). For each role the harness
 * mocks `installCrashHandlers` itself with a recording spy that throws a sentinel AFTER
 * capturing its deps — so each startup is driven through its real composition code until
 * exactly the install call, then stops safely without touching any real external service
 * (no pool connection, no BullMQ/Redis dial-out, no Chrome). The assertions prove the
 * spec's actual requirement: exactly ONE installation per startup, receiving that role's
 * OWN logger handle (the injected one where the role accepts DI; for `startApp`, the one
 * instance its single `createLogger` call produced) and the SAME `ConfiguredOtel` handle
 * the role's O5/O6 bootstrap created.
 *
 * The isolated event-level tests (fatal→flush→exit ordering, flush failure, idempotence)
 * live in `crash-handlers.test.ts` against the un-mocked helper.
 */

const state = vi.hoisted(() => {
  const sentinel = new Error("crash-handler wiring sentinel");
  return {
    sentinel,
    installed: [] as CrashHandlerDeps[],
    fakeOtel: undefined as unknown as ConfiguredOtel,
    fakeLogger: undefined as unknown as SeatfirstLogger,
  };
});

vi.mock("../src/crash-handlers.js", () => ({
  installCrashHandlers: vi.fn((deps: CrashHandlerDeps) => {
    state.installed.push(deps);
    throw state.sentinel;
  }),
}));

vi.mock("@seatfirst/config/otel-bootstrap", () => ({
  buildOtelFromEnv: vi.fn(() => state.fakeOtel),
}));

vi.mock("@seatfirst/config/logger", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    createLogger: vi.fn(() => state.fakeLogger),
  };
});

function makeFakeOtel(): ConfiguredOtel {
  return {
    forceFlush: () => Promise.resolve(undefined),
    shutdown: () => Promise.resolve(undefined),
    tracer: { startSpan: vi.fn() },
    meter: {},
    logger: { emit: vi.fn() },
    metrics: {},
    globalRegistration: {
      tracer: false,
      metrics: false,
      logs: false,
    },
  } as unknown as ConfiguredOtel;
}

function makeSpyLogger(): SeatfirstLogger {
  const noop = vi.fn();
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: vi.fn(() => makeSpyLogger()),
  };
}

/** Drives one startup and asserts it aborted at exactly one install with wired handles. */
async function expectWired(start: () => unknown, expectedLogger: SeatfirstLogger): Promise<void> {
  try {
    await start();
    expect.unreachable("startup did not stop at installCrashHandlers");
  } catch (error) {
    expect(error).toBe(state.sentinel);
  }
  expect(state.installed).toHaveLength(1);
  const deps = state.installed[0];
  expect(deps?.logger).toBe(expectedLogger);
  expect(deps?.otel).toBe(state.fakeOtel);
  expect(typeof deps?.exit).toBe("function");
}

describe("O10.5 — installCrashHandlers wired at all seven startups", () => {
  let asnDir: string;
  let asnCsvPath: string;

  beforeEach(() => {
    state.installed = [];
    state.fakeOtel = makeFakeOtel();
    state.fakeLogger = makeSpyLogger();
    asnDir = mkdtempSync(join(tmpdir(), "o10-asn-"));
    asnCsvPath = join(asnDir, "asn.csv");
    // Minimal GeoLite-ASN-shaped row: network,asn — enough for loadAsnLookup to resolve.
    writeFileSync(asnCsvPath, "1.0.0.0,13335,\n", "utf8");
  });

  afterEach(() => {
    rmSync(asnDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("1/7 startApp wires its own single createLogger instance and config.otel", async () => {
    const { appConfigFromEnv, startApp } = await import("../src/app-config.js");
    const env = {
      DATABASE_URL: "postgresql://crashtest.invalid/db",
      REDIS_URL: "redis://127.0.0.1:6399",
      API_PORT: "8080",
      APP_PG_POOL_MAX: "2",
      APP_PG_POOL_IDLE_TIMEOUT_MS: "1000",
      APP_PG_CONNECT_TIMEOUT_MS: "1000",
      FRESHNESS_MS: "60000",
      RETRY_AFTER_SECONDS: "30",
      STREAM_BLOCK_TIMEOUT_MS: "250",
      RECHECK_DEADLINE_MS: "30000",
      RECHECK_RECOVERY_ROW_WEIGHT: "1",
      COOKIE_SECRET: "o10-cookie-secret-not-a-production-value",
      NONCE_SECRET: "o10-nonce-secret-not-a-production-value",
      RELAY_PEER_CIDR: "10.99.0.0/16",
      ASN_DATABASE_PATH: asnCsvPath,
      MAPBOX_ACCESS_TOKEN: "test-mapbox-token",
      LOG_LEVEL: "info",
      CORS_ALLOWED_ORIGINS: "http://localhost:8081",
      SEARCH_LIMITS_JSON: JSON.stringify(DEFAULT_SEARCH_LIMITS),
      RATE_LIMIT_CONFIG_JSON: JSON.stringify(TEST_RATE_LIMIT_CONFIG),
      SESSION_COOKIE_POLICY_JSON: JSON.stringify(TEST_COOKIE_POLICY),
      PROVIDER_HOST_ALLOWLISTS_JSON: JSON.stringify(TEST_PROVIDER_HOST_ALLOWLISTS),
    };
    const config = appConfigFromEnv(env);
    await expectWired(() => startApp(config), state.fakeLogger);
    // The OTel handle passed to the installer is the one O5.4's bootstrap put on the
    // config — the same object this process would flush on crash.
    expect(config.otel).toBe(state.fakeOtel);
  });
  it("1b/7 startApp wires successfully when ASN_DATABASE_PATH is omitted (ADR 0095)", async () => {
    const { appConfigFromEnv, startApp } = await import("../src/app-config.js");
    const env = {
      DATABASE_URL: "postgresql://crashtest.invalid/db",
      REDIS_URL: "redis://127.0.0.1:6399",
      API_PORT: "8080",
      APP_PG_POOL_MAX: "2",
      APP_PG_POOL_IDLE_TIMEOUT_MS: "1000",
      APP_PG_CONNECT_TIMEOUT_MS: "1000",
      FRESHNESS_MS: "60000",
      RETRY_AFTER_SECONDS: "30",
      STREAM_BLOCK_TIMEOUT_MS: "250",
      RECHECK_DEADLINE_MS: "30000",
      RECHECK_RECOVERY_ROW_WEIGHT: "1",
      COOKIE_SECRET: "o10-cookie-secret-not-a-production-value",
      NONCE_SECRET: "o10-nonce-secret-not-a-production-value",
      RELAY_PEER_CIDR: "10.99.0.0/16",
      MAPBOX_ACCESS_TOKEN: "test-mapbox-token",
      LOG_LEVEL: "info",
      CORS_ALLOWED_ORIGINS: "http://localhost:8081",
      SEARCH_LIMITS_JSON: JSON.stringify(DEFAULT_SEARCH_LIMITS),
      RATE_LIMIT_CONFIG_JSON: JSON.stringify(TEST_RATE_LIMIT_CONFIG),
      SESSION_COOKIE_POLICY_JSON: JSON.stringify(TEST_COOKIE_POLICY),
      PROVIDER_HOST_ALLOWLISTS_JSON: JSON.stringify(TEST_PROVIDER_HOST_ALLOWLISTS),
    };
    const config = appConfigFromEnv(env);
    expect(config.asnDatabasePath).toBeUndefined();
    await expectWired(() => startApp(config), state.fakeLogger);
    expect(config.otel).toBe(state.fakeOtel);
  });

  it("2/7 startRelayDaemon wires the injected logger and its own otel handle", async () => {
    const { relayConfigFromEnv, startRelayDaemon } = await import("../src/relay/entrypoint.js");
    const logger = makeSpyLogger();
    await expectWired(
      () =>
        startRelayDaemon({
          config: relayConfigFromEnv({
            DATABASE_URL: "postgresql://crashtest.invalid/db",
            RELAY_POLL_INTERVAL_MS: "10",
            RELAY_BATCH_SIZE: "1",
            RELAY_RETRY_BACKOFF: "1 second",
            RELAY_ALARM_THRESHOLD_MS: "1000",
            RELAY_HEALTH_PORT: "8081",
            LOG_LEVEL: "info",
          }),
          env: {},
          logger,
        }),
      logger,
    );
  });

  it("3/7 createSweeper wires the injected logger and its own otel handle", async () => {
    const { createSweeper } = await import("../src/sweeper/entry.js");
    const logger = makeSpyLogger();
    await expectWired(
      () =>
        createSweeper({
          postgres: {
            connectionString: "postgresql://crashtest.invalid/db",
            max: 1,
            idleTimeoutMillis: 1000,
            connectionTimeoutMillis: 1000,
          },
          connection: { lazyConnect: true },
          tickIntervalMs: 60_000,
          outboxBatch: 1,
          rearmAge: "1 minute",
          maxAttempts: 3,
          snapshotAge: "1 minute",
          logLevel: "info",
          env: {},
          logger,
        }),
      logger,
    );
  });

  it("4/7 startDispatchWorker wires the injected logger and its own otel handle", async () => {
    const { startDispatchWorker } = await import("../src/dispatch/entry.js");
    const logger = makeSpyLogger();
    await expectWired(
      () =>
        startDispatchWorker({
          postgres: {
            connectionString: "postgresql://crashtest.invalid/db",
            max: 1,
            idleTimeoutMillis: 1000,
            connectionTimeoutMillis: 1000,
          },
          leaseTtl: "5 minutes",
          connection: { lazyConnect: true },
          logLevel: "info",
          env: {},
          logger,
        }),
      logger,
    );
  });

  it("5/7 startTmdbWorker wires the injected logger and its own otel handle", async () => {
    const { startTmdbWorker } = await import("../src/tmdb/entrypoint.js");
    const logger = makeSpyLogger();
    await expectWired(
      () =>
        startTmdbWorker({
          apiKey: "o10-test-api-key",
          databaseUrl: "postgresql://crashtest.invalid/db",
          connection: { lazyConnect: true },
          logLevel: "info",
          env: {},
          logger,
        }),
      logger,
    );
  });

  it("6/7 startFetchWorker wires the injected logger and its own otel handle", async () => {
    const { startFetchWorker } = await import("../src/fetch-worker/entrypoint.js");
    const logger = makeSpyLogger();
    await expectWired(
      () => startFetchWorker({ LOG_LEVEL: "info" }, { logger, env: { LOG_LEVEL: "info" } }),
      logger,
    );
  });

  it("7/7 createCatalogueCrawler wires the injected logger and its own otel handle", async () => {
    const { createCatalogueCrawler } = await import("../src/catalogue-crawl/entrypoint.js");
    const logger = makeSpyLogger();
    await expectWired(
      () =>
        createCatalogueCrawler({
          postgres: {
            connectionString: "postgresql://crashtest.invalid/db",
            max: 1,
            idleTimeoutMillis: 1000,
            connectionTimeoutMillis: 1000,
          },
          redis: { lazyConnect: true },
          egressIdentityLabel: "o10-test",
          userAgent: "o10-test-agent",
          navigationTimeoutMs: 1000,
          semaphoreTtlMs: 1000,
          chromeExecutablePath: "/usr/bin/false",
          cleanupGracePeriodMs: 1,
          readinessTimeoutMs: 1,
          readinessTargetUrl: "http://127.0.0.1:1",
          logLevel: "info",
          env: {},
          logger,
        }),
      logger,
    );
  });
});
