import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserSupervisor,
  CorridorNavigationOptions,
  NavigationAttempt,
  NavigationScope,
} from "@seatfirst/browser-runtime";
import type { PoolOptions } from "@seatfirst/durability";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

import { createCatalogueCrawler } from "../src/catalogue-crawl/entrypoint.js";
import type {
  CatalogueCrawlService,
  CreateCatalogueCrawlerOptions,
} from "../src/catalogue-crawl/entrypoint.js";
import type { CatalogueCrawlDeps } from "../src/catalogue-crawl/duties.js";

/**
 * Composition-level wiring proof for `createCatalogueCrawler`'s dev-only `fetchHop`
 * option (`ProviderFetchNavigationSeams.fetchHop`, ADR 0022 §6 "no separate lane"): a
 * caller-supplied offline navigation seam MUST reach the corridor transport for crawler
 * navigations — never be silently dropped back onto the live network.
 *
 * Following `crash-handler-wiring.test.ts`'s harness idiom: every boundary that would
 * touch an external service is mocked with a recording spy (transport, tick-loop
 * construction, crash handlers, OTel bootstrap, ioredis), while the real composition
 * code under test runs end-to-end. pg pools are lazy (no connection until queried), so
 * durability stays real. The assertions prove the wiring itself: the exact seam
 * reference flows `options.fetchHop` → `deps.navigate` → `runCorridorNavigation`, and
 * omission keeps production byte-identical (no `fetchHop` key at all).
 */

const state = vi.hoisted(() => {
  return {
    supervisorStarts: [] as unknown[][],
    transportCalls: [] as Array<{ supervisor: unknown; options: CorridorNavigationOptions }>,
    crawlRegistrations: [] as Array<{ deps: CatalogueCrawlDeps; stopped: number }>,
    redisConstructors: [] as unknown[],
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
      throw new Error("BrowserSupervisor.start must not run when a supervisor is injected");
    });
  },
  runCorridorNavigation: vi.fn(
    (supervisor: unknown, options: CorridorNavigationOptions): Promise<NavigationAttempt> => {
      state.transportCalls.push({ supervisor, options });
      return Promise.resolve(successAttempt("<html></html>"));
    },
  ),
}));

vi.mock("../src/catalogue-crawl/crawl.js", () => ({
  runCatalogueCrawler: vi.fn((deps: CatalogueCrawlDeps) => {
    const registration = { deps, stopped: 0 };
    state.crawlRegistrations.push(registration);
    return {
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
          pathname: "/movie-theatres",
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

const DIRECTORY_URL = "https://www.amctheatres.com/movie-theatres";

function baseOptions(): CreateCatalogueCrawlerOptions {
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
    chromeExecutablePath: "/usr/bin/chrome",
    cleanupGracePeriodMs: 100,
    readinessTimeoutMs: 1000,
    readinessTargetUrl: "http://127.0.0.1:8787/readyz",
    logger: {} as unknown as SeatfirstLogger,
    env: {},
  };
}

function fakeSupervisor(): BrowserSupervisor {
  return {
    egressIdentityLabel: "test-egress",
    shutdown: () => Promise.resolve(),
  } as unknown as BrowserSupervisor;
}

function crawlScope(): NavigationScope {
  return {
    providerId: "amc",
    observationId: "amc:theatre:obs",
    fetchRunId: "amc:theatre:run",
    routeClass: "",
    egressIdentityLabel: "test-egress",
  };
}

function lastDeps(): CatalogueCrawlDeps {
  expect(state.crawlRegistrations.length).toBeGreaterThan(0);
  return state.crawlRegistrations[state.crawlRegistrations.length - 1]!.deps;
}

function lastTransportCall(): { supervisor: unknown; options: CorridorNavigationOptions } {
  expect(state.transportCalls.length).toBeGreaterThan(0);
  return state.transportCalls[state.transportCalls.length - 1]!;
}

describe("createCatalogueCrawler — fetchHop seam wiring", () => {
  beforeEach(() => {
    state.supervisorStarts = [];
    state.transportCalls = [];
    state.crawlRegistrations = [];
    state.redisConstructors = [];
    state.crashHandlerInstalls = 0;
    state.otelShutdowns = 0;
  });

  it("forwards an injected fetchHop by reference into runCorridorNavigation", async () => {
    const fetchHop = vi.fn(() =>
      Promise.resolve({ status: 200, headers: {}, body: "<html></html>" }),
    );
    const injectedSupervisor = fakeSupervisor();
    let service: CatalogueCrawlService | undefined;
    try {
      service = await createCatalogueCrawler({
        ...baseOptions(),
        supervisor: injectedSupervisor,
        fetchHop,
      });

      // No self-started Chrome: the caller-owned supervisor is used (D3/S31.6).
      expect(state.supervisorStarts).toHaveLength(0);

      const targetUrl = await lastDeps().navigate(DIRECTORY_URL, crawlScope());
      expect(targetUrl.outcome.kind).toBe("SUCCESS");

      expect(state.transportCalls).toHaveLength(1);
      const { supervisor, options } = lastTransportCall();
      // The seam reaches the transport layer verbatim — same function object, not a copy.
      expect(options.fetchHop).toBe(fetchHop);
      // The rest of the corridor request is unchanged by the seam's presence.
      expect(supervisor).toBe(injectedSupervisor);
      expect(options.targetUrl).toBe(DIRECTORY_URL);
      expect(options.scope).toEqual(crawlScope());
      expect(options.userAgent).toBe("test-agent");
      expect(options.limits).toEqual({ navigationTimeoutMs: 5000 });
    } finally {
      await service?.close();
    }
  });

  it("omits fetchHop entirely when no seam is supplied (production parity)", async () => {
    let service: CatalogueCrawlService | undefined;
    try {
      service = await createCatalogueCrawler({
        ...baseOptions(),
        supervisor: fakeSupervisor(),
      });

      await lastDeps().navigate(DIRECTORY_URL, crawlScope());

      expect(state.transportCalls).toHaveLength(1);
      const { options } = lastTransportCall();
      // Gate 14 / no-undefined-key style: absent means the key is ABSENT, so the
      // transport takes its default (real network) exactly as before this option existed.
      expect("fetchHop" in options).toBe(false);
    } finally {
      await service?.close();
    }
  });

  it("keeps the lifecycle intact with a seam supplied: stop, teardown, caller-owned Chrome", async () => {
    const fetchHop = vi.fn(() =>
      Promise.resolve({ status: 200, headers: {}, body: "<html></html>" }),
    );
    const service = await createCatalogueCrawler({
      ...baseOptions(),
      supervisor: fakeSupervisor(),
      fetchHop,
    });

    service.stop();
    expect(state.crawlRegistrations[0]?.stopped).toBe(1);

    await service.close();
    // Caller-owned supervisor is NOT shut down by the crawler (ownership stays with the
    // caller); everything the crawler opened is torn down.
    expect(state.otelShutdowns).toBe(1);
    expect(state.crashHandlerInstalls).toBe(1);
  });
});
