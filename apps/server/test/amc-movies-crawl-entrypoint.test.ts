import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserSupervisor,
  CorridorNavigationOptions,
  NavigationAttempt,
  NavigationScope,
} from "@seatfirst/browser-runtime";
import type { PoolOptions } from "@seatfirst/durability";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import {
  amcMoviesCrawlConfigFromEnv,
  createAmcMoviesCrawler,
} from "../src/amc-movies-crawl/entrypoint.js";
import type {
  AmcMoviesCrawlService,
  CreateAmcMoviesCrawlerOptions,
} from "../src/amc-movies-crawl/entrypoint.js";
import type { AmcMoviesCrawlDeps } from "../src/amc-movies-crawl/duties.js";

/**
 * Composition-level wiring proof for `createAmcMoviesCrawler` (ADR 0102 decision 8).
 * Mirrors `catalogue-crawl-entrypoint.test.ts`'s harness idiom: every boundary that
 * would touch an external service is mocked with a recording spy (transport, tick-loop
 * construction, crash handlers, OTel bootstrap, ioredis), while the real composition
 * code under test runs end-to-end. pg pools are lazy (no connection until queried), so
 * durability stays real. The assertions prove the wiring itself: the caller-supplied
 * supervisor is used (never a self-started Chrome), the dev-only `fetchHop` seam
 * reaches the corridor transport verbatim, and the semaphore rides the shared `sem:amc`
 * key — never a new lane.
 */

const state = vi.hoisted(() => {
  return {
    supervisorStarts: [] as unknown[][],
    supervisorShutdowns: 0,
    transportCalls: [] as Array<{ supervisor: unknown; options: CorridorNavigationOptions }>,
    crawlRegistrations: [] as Array<{ deps: AmcMoviesCrawlDeps; stopped: number }>,
    redisConstructors: [] as unknown[],
    redisEvals: [] as Array<{ text: unknown; numKeys: unknown; rest: unknown[] }>,
    crashHandlerInstalls: 0,
    otelShutdowns: 0,
  };
});

vi.mock("../src/crash-handlers.js", () => ({
  installCrashHandlers: vi.fn(() => {
    state.crashHandlerInstalls += 1;
  }),
}));

vi.mock("@seatfirst/config/otel-bootstrap", () => ({
  buildOtelFromEnv: vi.fn(() => ({
    shutdown: () => {
      state.otelShutdowns += 1;
      return Promise.resolve();
    },
    metrics: {},
  })),
}));

vi.mock("ioredis", () => ({
  default: {
    Redis: class {
      constructor(connection: unknown) {
        state.redisConstructors.push(connection);
      }
      eval(text: unknown, numKeys: unknown, ...rest: unknown[]): Promise<number> {
        state.redisEvals.push({ text, numKeys, rest });
        return Promise.resolve(7);
      }
      quit(): Promise<"OK"> {
        return Promise.resolve("OK");
      }
    },
  },
}));

vi.mock("@seatfirst/browser-runtime", () => ({
  BrowserSupervisor: class {
    static start = vi.fn((...args: unknown[]) => {
      state.supervisorStarts.push(args);
      throw new Error("BrowserSupervisor.start must not run: the supervisor is injected");
    });
  },
  runCorridorNavigation: vi.fn(
    (supervisor: unknown, options: CorridorNavigationOptions): Promise<NavigationAttempt> => {
      state.transportCalls.push({ supervisor, options });
      return Promise.resolve(successAttempt("<html></html>"));
    },
  ),
}));

vi.mock("../src/amc-movies-crawl/crawl.js", () => ({
  runAmcMoviesCrawler: vi.fn((deps: AmcMoviesCrawlDeps) => {
    const registration = { deps, stopped: 0 };
    state.crawlRegistrations.push(registration);
    return {
      pause(): void {},
      resume(): void {},
      stop(): void {
        registration.stopped += 1;
      },
    };
  }),
}));

function successAttempt(documentHtml: string): NavigationAttempt {
  return {
    outcome: {
      kind: "SUCCESS",
      classification: "AMC_INITIAL",
      hops: [],
      payload: {
        finalUrl: {
          origin: "https://www.amctheatres.com",
          pathname: "/movies",
          queryKeys: [],
        },
        finalStatus: 200,
        headers: {},
        documentHtml,
      },
      subresourceAborts: 0,
    },
    cleanupCompleted: Promise.resolve(),
  };
}

const MOVIES_URL = "https://www.amctheatres.com/movies";

function baseOptions(): CreateAmcMoviesCrawlerOptions {
  const postgres: PoolOptions = {
    connectionString: "postgres://test:test@127.0.0.1:5999/test",
    max: 2,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 1000,
  };
  return {
    postgres,
    redis: { host: "127.0.0.1", port: 6399 },
    egressIdentityLabel: "test-egress",
    userAgent: "test-agent",
    navigationTimeoutMs: 5000,
    semaphoreTtlMs: 60_000,
    logger: {} as unknown as SeatfirstLogger,
    env: {},
    supervisor: fakeSupervisor(),
  };
}

function fakeSupervisor(): BrowserSupervisor {
  return {
    egressIdentityLabel: "test-egress",
    shutdown: () => {
      state.supervisorShutdowns += 1;
      return Promise.resolve();
    },
  } as unknown as BrowserSupervisor;
}

function crawlScope(): NavigationScope {
  return {
    providerId: "amc",
    observationId: "amc:movie:obs",
    fetchRunId: "amc:movie:run",
    routeClass: "",
    egressIdentityLabel: "test-egress",
  };
}

function lastDeps(): AmcMoviesCrawlDeps {
  expect(state.crawlRegistrations.length).toBeGreaterThan(0);
  return state.crawlRegistrations[state.crawlRegistrations.length - 1]!.deps;
}

function lastTransportCall(): { supervisor: unknown; options: CorridorNavigationOptions } {
  expect(state.transportCalls.length).toBeGreaterThan(0);
  return state.transportCalls[state.transportCalls.length - 1]!;
}

function testEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://test:test@127.0.0.1:5999/test",
    PG_POOL_MAX: "2",
    PG_POOL_IDLE_TIMEOUT_MS: "1000",
    PG_POOL_CONNECTION_TIMEOUT_MS: "1000",
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "6399",
    AMC_EGRESS_IDENTITY_LABEL: "test-egress",
    AMC_USER_AGENT: "test-agent",
    AMC_NAVIGATION_TIMEOUT_MS: "5000",
    AMC_SEMAPHORE_TTL_MS: "60000",
  };
}

describe("amcMoviesCrawlConfigFromEnv — ADR 0102 transport config", () => {
  it("reads the shared AMC transport vars with no Chrome config", () => {
    const config = amcMoviesCrawlConfigFromEnv(testEnv());

    expect(config.postgres).toEqual({
      connectionString: "postgres://test:test@127.0.0.1:5999/test",
      max: 2,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1000,
    });
    expect(config.redis).toEqual({ host: "127.0.0.1", port: 6399 });
    expect(config.egressIdentityLabel).toBe("test-egress");
    expect(config.userAgent).toBe("test-agent");
    expect(config.navigationTimeoutMs).toBe(5000);
    expect(config.semaphoreTtlMs).toBe(60_000);
    // No supervisor ownership here: the config carries no Chrome/readiness keys.
    expect("chromeExecutablePath" in config).toBe(false);
  });

  it("throws with no default when a required var is missing", () => {
    const env = testEnv();
    delete env["DATABASE_URL"];

    expect(() => amcMoviesCrawlConfigFromEnv(env)).toThrow(
      "DATABASE_URL is required and has no default",
    );
  });
});

describe("createAmcMoviesCrawler — ADR 0102 decision 8 composition", () => {
  beforeEach(() => {
    state.supervisorStarts = [];
    state.supervisorShutdowns = 0;
    state.transportCalls = [];
    state.crawlRegistrations = [];
    state.redisConstructors = [];
    state.redisEvals = [];
    state.crashHandlerInstalls = 0;
    state.otelShutdowns = 0;
  });

  it("uses the injected supervisor and builds the bare /movies URL", async () => {
    let service: AmcMoviesCrawlService | undefined;
    try {
      service = await createAmcMoviesCrawler(baseOptions());

      // No self-started Chrome: the caller-owned supervisor is used.
      expect(state.supervisorStarts).toHaveLength(0);
      expect(lastDeps().buildMoviesUrl()).toBe(MOVIES_URL);
    } finally {
      await service?.close();
    }
  });

  it("forwards an injected fetchHop by reference into runCorridorNavigation", async () => {
    const fetchHop = vi.fn(() =>
      Promise.resolve({ status: 200, headers: {}, body: "<html></html>" }),
    );
    const injectedSupervisor = fakeSupervisor();
    let service: AmcMoviesCrawlService | undefined;
    try {
      service = await createAmcMoviesCrawler({
        ...baseOptions(),
        supervisor: injectedSupervisor,
        fetchHop,
      });

      expect(state.supervisorStarts).toHaveLength(0);

      const targetUrl = await lastDeps().navigate(MOVIES_URL, crawlScope());
      expect(targetUrl.outcome.kind).toBe("SUCCESS");

      expect(state.transportCalls).toHaveLength(1);
      const { supervisor, options } = lastTransportCall();
      // The seam reaches the transport layer verbatim — same function object, not a copy.
      expect(options.fetchHop).toBe(fetchHop);
      // The rest of the corridor request is unchanged by the seam's presence.
      expect(supervisor).toBe(injectedSupervisor);
      expect(options.targetUrl).toBe(MOVIES_URL);
      expect(options.scope).toEqual(crawlScope());
      expect(options.userAgent).toBe("test-agent");
      expect(options.limits).toEqual({ navigationTimeoutMs: 5000 });
    } finally {
      await service?.close();
    }
  });

  it("omits fetchHop entirely when no seam is supplied (production parity)", async () => {
    let service: AmcMoviesCrawlService | undefined;
    try {
      service = await createAmcMoviesCrawler(baseOptions());

      await lastDeps().navigate(MOVIES_URL, crawlScope());

      expect(state.transportCalls).toHaveLength(1);
      const { options } = lastTransportCall();
      // Gate 14 / no-undefined-key style: absent means the key is ABSENT, so the
      // transport takes its default (real network) exactly as before this option existed.
      expect("fetchHop" in options).toBe(false);
    } finally {
      await service?.close();
    }
  });

  it("rides the shared sem:amc semaphore key, never a new lane", async () => {
    let service: AmcMoviesCrawlService | undefined;
    try {
      service = await createAmcMoviesCrawler(baseOptions());

      const generation = await lastDeps().acquireSemaphore("holder-1");

      expect(generation).toBe(7);
      expect(state.redisEvals).toHaveLength(1);
      const call = state.redisEvals[0]!;
      expect(call.numKeys).toBe(2);
      // KEYS[1..2]: the same holder hash + generation counter the theatre-catalogue
      // crawl and provider-fetch share (ADR 0102 decision 2).
      expect(call.rest.slice(0, 2)).toEqual(["sem:amc", "sem:amc:gen"]);
      // ARGV[1..2]: holder id + lease TTL.
      expect(call.rest.slice(2)).toEqual(["holder-1", 60_000]);

      await lastDeps().releaseSemaphore("holder-1", 7);
      expect(state.redisEvals).toHaveLength(2);
      expect(state.redisEvals[1]!.rest).toEqual(["sem:amc", "holder-1", 7]);
    } finally {
      await service?.close();
    }
  });

  it("keeps the lifecycle intact: stop, teardown, caller-owned Chrome survives close", async () => {
    const service = await createAmcMoviesCrawler(baseOptions());

    service.stop();
    expect(state.crawlRegistrations[0]?.stopped).toBe(1);

    await service.close();
    // Caller-owned supervisor is NOT shut down by the crawler (ADR 0102 decision 8);
    // everything the crawler opened is torn down.
    expect(state.supervisorShutdowns).toBe(0);
    expect(state.otelShutdowns).toBe(1);
    expect(state.crashHandlerInstalls).toBe(1);
  });
});
