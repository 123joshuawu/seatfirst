import { describe, expect, it } from "vitest";

import type { NavigationAttempt, NavigationScope } from "@seatfirst/browser-runtime";
import type { CatalogueCrawlStateRow, UpsertTheatreInput } from "@seatfirst/durability";
import type { Theatre, TheatreId } from "@seatfirst/core";
import { ProviderError } from "@seatfirst/providers";
import { runCatalogueCrawlTick } from "../src/catalogue-crawl/duties.js";
import type { CatalogueCrawlDeps, CatalogueCursor } from "../src/catalogue-crawl/duties.js";

/**
 * Fake-dependency harness (S26.6's DI seam): every wrapper is a recording stub, so the
 * orchestration is asserted on the exact calls made — no durability, no Redis, no browser.
 */
interface Harness {
  deps: CatalogueCrawlDeps;
  began: number;
  advanced: CatalogueCursor[];
  completed: number;
  upserts: UpsertTheatreInput[];
  navigated: Array<{ url: string; scope: NavigationScope }>;
  released: Array<{ holderId: string; generation: number }>;
  setState(rows: CatalogueCrawlStateRow[]): void;
  setControl(state: "OPEN" | "PAUSED" | "HALTED"): void;
  setSemaphoreHeld(held: boolean): void;
  setNavigationAttempt(attempt: NavigationAttempt): void;
  setSlugs(slugs: readonly string[]): void;
  setTheatres(theatres: Theatre[]): void;
  setTheatresError(error: Error): void;
}

const NOW = new Date("2026-08-15T00:00:00Z");

function makeHarness(): Harness {
  const h = {
    state: [] as CatalogueCrawlStateRow[],
    control: "OPEN" as "OPEN" | "PAUSED" | "HALTED",
    semaphoreHeld: false,
    attempt: successAttempt("<html></html>"),
    slugs: [] as readonly string[],
    theatres: [] as Theatre[],
    theatresError: null as Error | null,
    began: 0,
    advanced: [] as CatalogueCursor[],
    completed: 0,
    upserts: [] as UpsertTheatreInput[],
    navigated: [] as Array<{ url: string; scope: NavigationScope }>,
    released: [] as Array<{ holderId: string; generation: number }>,
  };

  const deps: CatalogueCrawlDeps = {
    providerId: "amc",
    egressIdentityLabel: "test-egress",
    readState: () => Promise.resolve(h.state),
    beginPass: () => {
      h.began += 1;
      return Promise.resolve(h.state);
    },
    advanceCursor: (_pid, cursor) => {
      h.advanced.push(cursor);
      return Promise.resolve(h.state);
    },
    completePass: () => {
      h.completed += 1;
      return Promise.resolve(h.state);
    },
    upsertTheatre: (input) => {
      h.upserts.push(input);
      return Promise.resolve();
    },
    readControlState: () => Promise.resolve(h.control),
    acquireSemaphore: () => Promise.resolve(h.semaphoreHeld ? false : 1),
    releaseSemaphore: (holderId, generation) => {
      h.released.push({ holderId, generation });
      return Promise.resolve();
    },
    navigate: (url, scope) => {
      h.navigated.push({ url, scope });
      return Promise.resolve(h.attempt);
    },
    parseMarketSlugs: () => h.slugs,
    parseTheatres: () => {
      if (h.theatresError !== null) {
        throw h.theatresError;
      }
      return h.theatres;
    },
    buildDirectoryUrl: () => "https://www.amctheatres.com/movie-theatres",
    buildMarketUrl: (slug) => `https://www.amctheatres.com/movie-theatres/${slug}`,
    mintId: () => "raw-id",
    now: () => NOW,
  };

  return {
    deps,
    get began() {
      return h.began;
    },
    get advanced() {
      return h.advanced;
    },
    get completed() {
      return h.completed;
    },
    get upserts() {
      return h.upserts;
    },
    get navigated() {
      return h.navigated;
    },
    get released() {
      return h.released;
    },
    setState: (rows) => {
      h.state = rows;
    },
    setControl: (state) => {
      h.control = state;
    },
    setSemaphoreHeld: (held) => {
      h.semaphoreHeld = held;
    },
    setNavigationAttempt: (attempt) => {
      h.attempt = attempt;
    },
    setSlugs: (slugs) => {
      h.slugs = slugs;
    },
    setTheatres: (theatres) => {
      h.theatres = theatres;
    },
    setTheatresError: (error) => {
      h.theatresError = error;
    },
  };
}

function row(overrides: Partial<CatalogueCrawlStateRow> = {}): CatalogueCrawlStateRow {
  return {
    provider_id: "amc",
    last_pass_started_at: null,
    last_pass_completed_at: null,
    cursor: null,
    updated_at: NOW,
    ...overrides,
  };
}

function cursor(slugs: readonly string[], nextIndex: number): unknown {
  return { slugs, nextIndex };
}

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

const failedAttempt: NavigationAttempt = {
  outcome: { kind: "NAVIGATION_FAILED", error: "timeout" },
  cleanupCompleted: Promise.resolve(),
};

function theatre(id: string, marketSlug = "atlanta"): Theatre {
  return {
    id: `amc:theatre:${id}` as TheatreId,
    providerId: "amc",
    name: `Theatre ${id}`,
    location: { lat: 33.7, lng: -84.4 },
    timezone: "America/New_York",
    city: "Atlanta",
    address: "123 Main St, Atlanta, GA 30303",
    slugs: { [marketSlug]: id },
    amenities: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  };
}

describe("runCatalogueCrawlTick — S26.8/S26.9 orchestration", () => {
  it("begins a pass on first run: directory navigation then cursor advance", async () => {
    const h = makeHarness();
    h.setSlugs(["albany-ga", "atlanta", "wichita"]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({
      kind: "PAGE_PROCESSED",
      page: "DIRECTORY",
      slugCount: 3,
      theatreCount: 0,
    });
    expect(h.began).toBe(1);
    expect(h.navigated).toHaveLength(1);
    expect(h.navigated[0]?.url).toBe("https://www.amctheatres.com/movie-theatres");
    expect(h.navigated[0]?.scope).toEqual({
      providerId: "amc",
      observationId: "amc:theatre:raw-id",
      fetchRunId: "amc:theatre:raw-id",
      routeClass: "",
      egressIdentityLabel: "test-egress",
    });
    expect(h.advanced).toEqual([{ slugs: ["albany-ga", "atlanta", "wichita"], nextIndex: 0 }]);
    expect(h.upserts).toEqual([]);
    expect(h.completed).toBe(0);
    // The semaphore was acquired and released exactly once.
    expect(h.released).toHaveLength(1);
  });

  it("skips without any navigation when not yet due", async () => {
    const h = makeHarness();
    h.setState([row({ last_pass_completed_at: new Date("2026-07-16T00:00:00Z") })]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_NOT_DUE" });
    expect(h.began).toBe(0);
    expect(h.navigated).toEqual([]);
    expect(h.advanced).toEqual([]);
  });

  it("begins a pass when the last completion is more than one calendar month ago", async () => {
    const h = makeHarness();
    h.setState([row({ last_pass_completed_at: new Date("2026-07-14T00:00:00Z") })]);
    h.setSlugs(["atlanta"]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick.kind).toBe("PAGE_PROCESSED");
    expect(h.began).toBe(1);
    expect(h.navigated).toHaveLength(1);
  });

  it("skips without disturbing the holder when the semaphore is already held", async () => {
    const h = makeHarness();
    h.setSemaphoreHeld(true);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_SEMAPHORE" });
    expect(h.began).toBe(0);
    expect(h.navigated).toEqual([]);
    expect(h.advanced).toEqual([]);
    // A failed acquire never enters the try/finally that releases.
    expect(h.released).toEqual([]);
  });

  it("fails closed on a halted provider without navigating", async () => {
    const h = makeHarness();
    h.setControl("HALTED");

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "SKIPPED_CONTROL", state: "HALTED" });
    expect(h.navigated).toEqual([]);
    expect(h.began).toBe(0);
    expect(h.released).toEqual([]);
  });

  it("maps each parsed theatre to an upsert tagged with the page's market slug", async () => {
    const h = makeHarness();
    h.setState([row({ cursor: cursor(["atlanta"], 0) })]);
    h.setTheatres([theatre("a", "atlanta"), theatre("b", "atlanta")]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({
      kind: "PAGE_PROCESSED",
      page: "MARKET",
      slugCount: 1,
      theatreCount: 2,
    });
    expect(h.navigated).toHaveLength(1);
    expect(h.navigated[0]?.url).toBe("https://www.amctheatres.com/movie-theatres/atlanta");
    expect(h.upserts).toEqual([
      expect.objectContaining({ theatreId: "amc:theatre:a", marketSlug: "atlanta" }),
      expect.objectContaining({ theatreId: "amc:theatre:b", marketSlug: "atlanta" }),
    ]);
    expect(h.advanced).toEqual([{ slugs: ["atlanta"], nextIndex: 1 }]);
  });

  it("forwards parsed theatre amenities into the upsert input (S62)", async () => {
    const h = makeHarness();
    h.setState([row({ cursor: cursor(["atlanta"], 0) })]);
    h.setTheatres([
      { ...theatre("a", "atlanta"), amenities: [{ code: "imax", name: "IMAX" }] },
    ]);

    await runCatalogueCrawlTick(h.deps);

    expect(h.upserts).toEqual([
      expect.objectContaining({
        theatreId: "amc:theatre:a",
        amenities: [{ code: "imax", name: "IMAX" }],
      }),
    ]);
  });

  it("skips just the current market page and advances the cursor when the parser reports UPSTREAM_CHANGED", async () => {
    const h = makeHarness();
    h.setState([row({ cursor: cursor(["albany-ga", "atlanta"], 0) })]);
    h.setTheatresError(
      new ProviderError("UPSTREAM_CHANGED", 'Postal code "31420" is not in the timezone table'),
    );

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({
      kind: "PAGE_SKIPPED_PARSER_INCOMPATIBLE",
      slug: "albany-ga",
      parserErrorCode: "UPSTREAM_CHANGED",
      parserErrorMessage: 'Postal code "31420" is not in the timezone table',
    });
    // The pass keeps making progress: the cursor still advances past the bad page...
    expect(h.advanced).toEqual([{ slugs: ["albany-ga", "atlanta"], nextIndex: 1 }]);
    // ...and nothing from the failed page's (partial, untrustworthy) parse is upserted.
    expect(h.upserts).toEqual([]);
    // The semaphore is still released, same as every other branch.
    expect(h.released).toHaveLength(1);
  });

  it("still fails the whole tick on a parser error that is not UPSTREAM_CHANGED", async () => {
    const h = makeHarness();
    h.setState([row({ cursor: cursor(["atlanta"], 0) })]);
    h.setTheatresError(new ProviderError("UPSTREAM_BLOCKED", "Cloudflare challenge"));

    await expect(runCatalogueCrawlTick(h.deps)).rejects.toThrow("Cloudflare challenge");
    // An unhandled failure must not silently skip the page: no cursor advance.
    expect(h.advanced).toEqual([]);
  });

  it("resumes at the cursor index, not the directory, after a restart", async () => {
    const h = makeHarness();
    h.setState([row({ cursor: cursor(["a", "b", "c"], 2) })]);
    h.setTheatres([theatre("x", "c")]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick.kind).toBe("PAGE_PROCESSED");
    expect(h.navigated).toHaveLength(1);
    expect(h.navigated[0]?.url).toBe("https://www.amctheatres.com/movie-theatres/c");
    expect(h.advanced).toEqual([{ slugs: ["a", "b", "c"], nextIndex: 3 }]);
  });

  it("completes the pass exactly once at the cursor end, without navigation", async () => {
    const h = makeHarness();
    h.setState([row({ cursor: cursor(["a", "b"], 2) })]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "PASS_COMPLETED" });
    expect(h.completed).toBe(1);
    expect(h.navigated).toEqual([]);
    // COMPLETE_PASS needs no semaphore: nothing acquired, nothing released.
    expect(h.released).toEqual([]);
  });

  it("always releases the semaphore, even when navigation fails", async () => {
    const h = makeHarness();
    h.setNavigationAttempt(failedAttempt);
    h.setSlugs(["atlanta"]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "NAVIGATION_UNSUCCESSFUL", outcome: "NAVIGATION_FAILED" });
    expect(h.released).toEqual([{ holderId: "raw-id", generation: 1 }]);
    // Nothing was begun, advanced, or upserted on failure.
    expect(h.began).toBe(0);
    expect(h.advanced).toEqual([]);
    expect(h.upserts).toEqual([]);
  });

  it("does not call beginPass if directory navigation fails on pass start", async () => {
    const h = makeHarness();
    h.setNavigationAttempt(failedAttempt);
    h.setSlugs(["atlanta"]);

    const tick = await runCatalogueCrawlTick(h.deps);

    expect(tick).toEqual({ kind: "NAVIGATION_UNSUCCESSFUL", outcome: "NAVIGATION_FAILED" });
    expect(h.began).toBe(0);
    expect(h.advanced).toEqual([]);
  });
});
