import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "../src/dispatch/queries.js";
import {
  findJobContext,
  findRunContext,
  findSearchById,
  readAggregateFailedShowtimeIds,
  readAggregateFetchFailures,
  readAggregateFetchFacts,
  readAggregatePerformances,
  readAggregateScheduleOutcome,
  readAuditoriumLayouts,
  readLatestShowtimeSnapshots,
} from "../src/dispatch/queries.js";

/**
 * S40.2/S40.3 — the dispatch read boundaries against an in-memory `Queryable`. Each
 * mapper gets one fully-populated well-formed row (proving the mapping is unchanged)
 * and at least one malformed row (proving the throw names the offending column). No
 * live Postgres here: real-row coverage lives in `aggregate-answer-assembler.test.ts`
 * (testcontainers). Column values mirror pg's real deliveries — `bigint` columns as
 * decimal strings, `integer` as numbers, `bytea` as Buffers.
 */

function dbReturning(rows: unknown[]): Queryable & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(() => Promise.resolve({ rows })) };
}

/** Serves each scripted response in order, repeating the last one. */
function dbScripted(
  scripts: { rows: unknown[] }[],
): Queryable & { query: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    query: vi.fn(() => Promise.resolve(scripts[Math.min(call++, scripts.length - 1)]!)),
  };
}

const CAPTURED_AT = new Date("2026-08-22T12:00:00.000Z");

/** Fully-populated `findJobContext` row: job + run_key + `search_`-prefixed search. */
function joinedJobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: "job_1",
    search_id: "srch_1",
    job_kind: "SHOWTIME_FETCH",
    run_key_id: "rk_1",
    generation: 3,
    state: "LEASED",
    lease_expires_at: null,
    attempt: 1,
    deadline_at: new Date("2026-08-23T00:00:00.000Z"),
    fail_cause: null,
    created_at: new Date("2026-08-21T09:00:00.000Z"),
    key_kind: "SHOWTIME_FETCH",
    provider_id: "amc",
    route_class: "",
    showtime_id: "amc:showtime:1",
    theatre_id: null,
    local_date: null,
    accepted_revision: "7",
    projected_revision: "5",
    latest_observation_id: "obs_1",
    latest_captured_at: CAPTURED_AT,
    recheck_placement: {},
    session_id: "sess_1",
    idempotency_key: "idem_1",
    spec: { movies: [] },
    spec_hash: "spec-hash-1",
    status: "RUNNING",
    terminal_cause: null,
    capacity_denied_at: null,
    search_deadline_at: new Date("2026-08-23T01:00:00.000Z"),
    projected_through: "42",
    agg_requested_rev: "9",
    agg_processed_rev: "8",
    agg_lease_expires: null,
    agg_generation: 2,
    next_seq: "11",
    search_created_at: new Date("2026-08-20T09:00:00.000Z"),
    terminalized_at: null,
    ...overrides,
  };
}

/** Fully-populated `findRunContext` row: run + run_key + unprefixed subscriber search. */
function joinedRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run_1",
    run_key_id: "rk_1",
    observation_id: "obs_9",
    state: "LEASED",
    generation: 2,
    lease_expires_at: null,
    attempt: 0,
    provider_epoch: "5",
    fail_cause: null,
    created_at: new Date("2026-08-21T10:00:00.000Z"),
    key_kind: "SCHEDULE_RESOLUTION",
    provider_id: "amc",
    route_class: "",
    showtime_id: null,
    theatre_id: "amc:theatre:1",
    local_date: "2026-08-05",
    accepted_revision: "1",
    projected_revision: "0",
    latest_observation_id: "obs_9",
    latest_captured_at: CAPTURED_AT,
    recheck_placement: null,
    search_id: "srch_2",
    session_id: "sess_2",
    idempotency_key: "idem_2",
    spec: {},
    spec_hash: "spec-hash-2",
    status: "PENDING_SCHEDULE",
    terminal_cause: null,
    capacity_denied_at: null,
    deadline_at: new Date("2026-08-23T02:00:00.000Z"),
    projected_through: "3",
    agg_requested_rev: "1",
    agg_processed_rev: "0",
    agg_lease_expires: null,
    agg_generation: 0,
    next_seq: "1",
    search_created_at: new Date("2026-08-20T10:00:00.000Z"),
    terminalized_at: null,
    ...overrides,
  };
}

describe("findJobContext", () => {
  it("maps a well-formed joined row identically to the pre-S40 shape", async () => {
    const db = dbReturning([joinedJobRow()]);
    await expect(findJobContext(db, "job_1")).resolves.toEqual({
      job: {
        jobId: "job_1",
        searchId: "srch_1",
        kind: "SHOWTIME_FETCH",
        runKeyId: "rk_1",
        generation: 3,
        state: "LEASED",
        leaseExpiresAt: null,
        attempt: 1,
        deadlineAt: "2026-08-23T00:00:00.000Z",
        failCause: null,
        createdAt: "2026-08-21T09:00:00.000Z",
      },
      runKey: {
        runKeyId: "rk_1",
        kind: "SHOWTIME_FETCH",
        providerId: "amc",
        routeClass: "",
        showtimeId: "amc:showtime:1",
        theatreId: null,
        localDate: null,
        movieSlug: null,
        acceptedRevision: "7",
        projectedRevision: "5",
        latestObservationId: "obs_1",
        latestCapturedAt: "2026-08-22T12:00:00.000Z",
        recheckPlacement: {},
      },
      search: {
        searchId: "srch_1",
        sessionId: "sess_1",
        idempotencyKey: "idem_1",
        spec: { movies: [] },
        specHash: "spec-hash-1",
        status: "RUNNING",
        terminalCause: null,
        capacityDeniedAt: null,
        deadlineAt: "2026-08-23T01:00:00.000Z",
        projectedThrough: "42",
        aggRequestedRev: "9",
        aggProcessedRev: "8",
        aggLeaseExpires: null,
        aggGeneration: 2,
        nextSeq: "11",
        createdAt: "2026-08-20T09:00:00.000Z",
        terminalizedAt: null,
      },
    });
  });

  it("returns null on zero rows", async () => {
    await expect(findJobContext(dbReturning([]), "job_x")).resolves.toBeNull();
  });

  it("throws naming the column when a required field is missing", async () => {
    const db = dbReturning([joinedJobRow({ run_key_id: undefined })]);
    await expect(findJobContext(db, "job_1")).rejects.toThrow(
      `pg row column "run_key_id": expected string, received undefined`,
    );
  });

  it("throws naming the column when the job kind drifts off its union", async () => {
    const db = dbReturning([joinedJobRow({ job_kind: "BOGUS" })]);
    await expect(findJobContext(db, "job_1")).rejects.toThrow(/column "job_kind"/);
  });

  it("throws naming the column when an integer arrives as a string", async () => {
    const db = dbReturning([joinedJobRow({ generation: "3" })]);
    await expect(findJobContext(db, "job_1")).rejects.toThrow(
      `pg row column "generation": expected number, received string`,
    );
  });
});

describe("findRunContext", () => {
  it("maps a well-formed row; a null subscriber search stays null", async () => {
    const db = dbReturning([joinedRunRow({ search_id: null })]);
    await expect(findRunContext(db, "run_1")).resolves.toEqual({
      run: {
        runId: "run_1",
        runKeyId: "rk_1",
        observationId: "obs_9",
        state: "LEASED",
        generation: 2,
        leaseExpiresAt: null,
        attempt: 0,
        providerEpoch: "5",
        failCause: null,
        createdAt: "2026-08-21T10:00:00.000Z",
      },
      runKey: {
        runKeyId: "rk_1",
        kind: "SCHEDULE_RESOLUTION",
        providerId: "amc",
        routeClass: "",
        showtimeId: null,
        theatreId: "amc:theatre:1",
        localDate: "2026-08-05",
        movieSlug: null,
        acceptedRevision: "1",
        projectedRevision: "0",
        latestObservationId: "obs_9",
        latestCapturedAt: "2026-08-22T12:00:00.000Z",
        recheckPlacement: null,
      },
      search: null,
    });
  });

  it("throws naming the column when an integer arrives as a string", async () => {
    const db = dbReturning([joinedRunRow({ attempt: "0" })]);
    await expect(findRunContext(db, "run_1")).rejects.toThrow(
      `pg row column "attempt": expected number, received string`,
    );
  });
});

describe("findSearchById", () => {
  it("maps a well-formed search row", async () => {
    // `findSearchById` maps with an empty prefix (the bare `search` SELECT), so the
    // fixture's unprefixed deadline/created columns stand in for the search row's own.
    const db = dbReturning([
      joinedJobRow({
        deadline_at: new Date("2026-08-23T01:00:00.000Z"),
        created_at: new Date("2026-08-20T09:00:00.000Z"),
      }),
    ]);
    await expect(findSearchById(db, "srch_1")).resolves.toEqual({
      searchId: "srch_1",
      sessionId: "sess_1",
      idempotencyKey: "idem_1",
      spec: { movies: [] },
      specHash: "spec-hash-1",
      status: "RUNNING",
      terminalCause: null,
      capacityDeniedAt: null,
      deadlineAt: "2026-08-23T01:00:00.000Z",
      projectedThrough: "42",
      aggRequestedRev: "9",
      aggProcessedRev: "8",
      aggLeaseExpires: null,
      aggGeneration: 2,
      nextSeq: "11",
      createdAt: "2026-08-20T09:00:00.000Z",
      terminalizedAt: null,
    });
  });

  it("throws naming the column when a non-nullable field arrives null", async () => {
    const db = dbReturning([joinedJobRow({ status: null })]);
    await expect(findSearchById(db, "srch_1")).rejects.toThrow(
      `pg row column "status": expected string, received null`,
    );
  });
});

/** Fully-populated performance row (the UNION projection plus the theatre timezone). */
function performanceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    showtime_id: "amc:showtime:1",
    provider_id: "amc",
    theatre_id: "amc:theatre:1",
    local_date: "2026-08-05",
    starts_at: new Date("2026-08-05T19:00:00.000Z"),
    observation_id: "obs_9",
    attributes: {},
    movie_id: "amc:movie:1",
    auditorium: "7",
    utc_offset: "-05:00",
    runtime_minutes: 120,
    status: "OPEN",
    format_code: "IMAX",
    min_price: "18.50",
    currency: "USD",
    price_basis: "TICKET_ONLY",
    deep_link_url: "https://example.invalid/showtimes/1",
    layout_id: "lay_1",
    timezone: "America/Chicago",
    ...overrides,
  };
}

describe("readAggregatePerformances", () => {
  it("maps a well-formed row identically, coercing non-array attributes to []", async () => {
    const db = dbReturning([performanceRow()]);
    await expect(readAggregatePerformances(db, "srch_1")).resolves.toEqual([
      {
        showtimeId: "amc:showtime:1",
        providerId: "amc",
        theatreId: "amc:theatre:1",
        localDate: "2026-08-05",
        startsAt: "2026-08-05T19:00:00.000Z",
        observationId: "obs_9",
        attributes: [],
        movieId: "amc:movie:1",
        auditorium: "7",
        utcOffset: "-05:00",
        runtimeMinutes: 120,
        status: "OPEN",
        formatCode: "IMAX",
        minPrice: "18.50",
        currency: "USD",
        priceBasis: "TICKET_ONLY",
        deepLinkUrl: "https://example.invalid/showtimes/1",
        layoutId: "lay_1",
        timezone: "America/Chicago",
      },
    ]);
  });

  it("keeps the nullable product columns null and passes string attributes through", async () => {
    const db = dbReturning([
      performanceRow({
        attributes: ["REC"],
        movie_id: null,
        auditorium: null,
        utc_offset: null,
        runtime_minutes: null,
        status: null,
        format_code: null,
        min_price: null,
        currency: null,
        price_basis: null,
        deep_link_url: null,
        layout_id: null,
      }),
    ]);
    await expect(readAggregatePerformances(db, "srch_1")).resolves.toEqual([
      expect.objectContaining({
        attributes: ["REC"],
        movieId: null,
        runtimeMinutes: null,
        minPrice: null,
        currency: null,
        priceBasis: null,
      }),
    ]);
  });

  it("throws naming the column when a required field is missing", async () => {
    const db = dbReturning([performanceRow({ timezone: undefined })]);
    await expect(readAggregatePerformances(db, "srch_1")).rejects.toThrow(
      `pg row column "timezone": expected string, received undefined`,
    );
  });

  it("throws naming the column when an attributes entry is not a string", async () => {
    const db = dbReturning([performanceRow({ attributes: ["REC", 5] })]);
    await expect(readAggregatePerformances(db, "srch_1")).rejects.toThrow(/column "attributes"/);
  });

  it("fails loudly when a result row is not an object", async () => {
    const db = dbReturning([42]);
    await expect(readAggregatePerformances(db, "srch_1")).rejects.toThrow(
      `pg result row: expected an object, received number`,
    );
  });
});

describe("readLatestShowtimeSnapshots", () => {
  it("returns [] without querying when no showtime ids are given", async () => {
    const db = dbReturning([]);
    await expect(readLatestShowtimeSnapshots(db, [])).resolves.toEqual([]);
    expect(db.query.mock.calls).toEqual([]);
  });

  it("maps a well-formed snapshot row", async () => {
    const bitmap = Buffer.from([0b00000101]);
    const db = dbReturning([
      { showtime_id: "amc:showtime:1", bitmap, free_count: 2, captured_at: CAPTURED_AT },
    ]);
    await expect(readLatestShowtimeSnapshots(db, ["amc:showtime:1"])).resolves.toEqual([
      {
        showtimeId: "amc:showtime:1",
        bitmap,
        freeCount: 2,
        capturedAt: "2026-08-22T12:00:00.000Z",
      },
    ]);
  });

  it("throws naming the column when the bitmap is not a Buffer", async () => {
    const db = dbReturning([
      { showtime_id: "amc:showtime:1", bitmap: "0101", free_count: 2, captured_at: CAPTURED_AT },
    ]);
    await expect(readLatestShowtimeSnapshots(db, ["amc:showtime:1"])).rejects.toThrow(
      `pg row column "bitmap": expected Buffer, received string`,
    );
  });
});

describe("readAuditoriumLayouts", () => {
  it("maps a well-formed layout row", async () => {
    const geometry = Buffer.from([1, 2, 3, 4]);
    const db = dbReturning([
      { layout_id: "lay_1", geometry, rows: 10, columns: 20, timezone: "America/Chicago" },
    ]);
    await expect(readAuditoriumLayouts(db, ["lay_1"])).resolves.toEqual([
      { layoutId: "lay_1", geometry, rows: 10, columns: 20, timezone: "America/Chicago" },
    ]);
  });

  it("throws naming the column when geometry is not a Buffer", async () => {
    const db = dbReturning([
      { layout_id: "lay_1", geometry: null, rows: 10, columns: 20, timezone: "America/Chicago" },
    ]);
    await expect(readAuditoriumLayouts(db, ["lay_1"])).rejects.toThrow(
      `pg row column "geometry": expected Buffer, received null`,
    );
  });
});

describe("readAggregateScheduleOutcome", () => {
  it("returns null when no reservation and no subscriptions exist", async () => {
    const db = dbScripted([{ rows: [] }, { rows: [] }]);
    await expect(readAggregateScheduleOutcome(db, "srch_1")).resolves.toBeNull();
  });

  it("keeps the shipped string-or-number tolerance for fresh_match_seed", async () => {
    const decimalString = dbScripted([{ rows: [{ fresh_match_seed: "4" }] }, { rows: [] }]);
    await expect(readAggregateScheduleOutcome(decimalString, "srch_1")).resolves.toBe("RESOLVED");
    const plainNumber = dbScripted([{ rows: [{ fresh_match_seed: 1 }] }, { rows: [] }]);
    await expect(readAggregateScheduleOutcome(plainNumber, "srch_1")).resolves.toBe("RESOLVED");
  });

  it("throws naming the column when fresh_match_seed is neither number nor numeric string", async () => {
    const db = dbScripted([{ rows: [{ fresh_match_seed: true }] }, { rows: [] }]);
    await expect(readAggregateScheduleOutcome(db, "srch_1")).rejects.toThrow(
      `pg row column "fresh_match_seed": expected a number or numeric string, received true`,
    );
  });

  it("classifies outcomes exactly as before", async () => {
    const allFailed = dbScripted([
      { rows: [] },
      { rows: [{ schedule_outcome: "FAILED" }, { schedule_outcome: "FAILED" }] },
    ]);
    await expect(readAggregateScheduleOutcome(allFailed, "srch_1")).resolves.toBe("FAILED");

    const mixed = dbScripted([
      { rows: [{ fresh_match_seed: 2 }] },
      { rows: [{ schedule_outcome: "FAILED" }, { schedule_outcome: "RESOLVED" }] },
    ]);
    await expect(readAggregateScheduleOutcome(mixed, "srch_1")).resolves.toBe("MIXED");

    const emptyResolved = dbScripted([
      { rows: [] },
      { rows: [{ schedule_outcome: "EMPTY_RESOLVED" }] },
    ]);
    await expect(readAggregateScheduleOutcome(emptyResolved, "srch_1")).resolves.toBe(
      "EMPTY_RESOLVED",
    );

    const pending = dbScripted([{ rows: [] }, { rows: [{ schedule_outcome: null }] }]);
    await expect(readAggregateScheduleOutcome(pending, "srch_1")).resolves.toBeNull();
  });

  it("throws naming the column when schedule_outcome is not a string or null", async () => {
    const db = dbScripted([{ rows: [] }, { rows: [{ schedule_outcome: 7 }] }]);
    await expect(readAggregateScheduleOutcome(db, "srch_1")).rejects.toThrow(
      `pg row column "schedule_outcome": expected string | null, received number`,
    );
  });
});

describe("readAggregateFetchFacts", () => {
  it("returns zeros when the read yields no row", async () => {
    await expect(readAggregateFetchFacts(dbReturning([]), "srch_1")).resolves.toEqual({
      acceptedFetches: 0,
      freeSeats: 0,
    });
  });

  it("maps a well-formed ::integer row", async () => {
    const db = dbReturning([{ accepted_fetches: 3, free_seats: 12 }]);
    await expect(readAggregateFetchFacts(db, "srch_1")).resolves.toEqual({
      acceptedFetches: 3,
      freeSeats: 12,
    });
  });

  it("throws naming the column when a count arrives as a string", async () => {
    const db = dbReturning([{ accepted_fetches: "3", free_seats: 12 }]);
    await expect(readAggregateFetchFacts(db, "srch_1")).rejects.toThrow(
      `pg row column "accepted_fetches": expected number, received string`,
    );
  });
});

describe("readAggregateFetchFailures", () => {
  it("maps well-formed grouped rows, keeping a null theatre attribution", async () => {
    const db = dbReturning([
      { fail_cause: "PROVIDER_5XX", theatre_id: "amc:theatre:1", count: 2 },
      { fail_cause: "UNKNOWN", theatre_id: null, count: 1 },
    ]);
    await expect(readAggregateFetchFailures(db, "srch_1")).resolves.toEqual([
      { failCause: "PROVIDER_5XX", theatreId: "amc:theatre:1", count: 2 },
      { failCause: "UNKNOWN", theatreId: null, count: 1 },
    ]);
  });

  it("throws naming the column when count is not a number", async () => {
    const db = dbReturning([{ fail_cause: "PROVIDER_5XX", theatre_id: null, count: "2" }]);
    await expect(readAggregateFetchFailures(db, "srch_1")).rejects.toThrow(
      `pg row column "count": expected number, received string`,
    );
  });
});

describe("readAggregateFailedShowtimeIds", () => {
  it("returns the distinct set of failed showtime ids", async () => {
    const db = dbReturning([
      { showtime_id: "amc:showtime:1" },
      { showtime_id: "amc:showtime:2" },
      { showtime_id: "amc:showtime:1" },
    ]);
    await expect(readAggregateFailedShowtimeIds(db, "srch_1")).resolves.toEqual(
      new Set(["amc:showtime:1", "amc:showtime:2"]),
    );
  });

  it("throws naming the column when showtime_id is not a string", async () => {
    const db = dbReturning([{ showtime_id: 42 }]);
    await expect(readAggregateFailedShowtimeIds(db, "srch_1")).rejects.toThrow(
      `pg row column "showtime_id": expected string, received number`,
    );
  });
});
