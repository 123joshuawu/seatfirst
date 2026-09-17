import { describe, expect, it } from "vitest";

import { terminalize as rawTerminalize } from "../src/transactions.js";

import * as B from "../src/boundaries.js";
import {
  deriveRankedAnswer,
  type AggregateScheduleOutcome,
  type AnswerEvidence,
  type ConfidentRecommendation,
  type EmptyCause,
  type HedgedAlternatives,
  type LifecycleFacts,
  type LifecycleStatus,
  type Placement,
  type RankedAnswer,
  type TerminalCause,
} from "../src/lifecycle.js";

import {
  acceptFetch,
  acceptSchedule,
  createSearch,
  dispatchRun,
  expireSearchDeadline,
  failRun,
  fetchKey,
  id,
  mustWin,
  PROVIDER,
  runQuery,
  scheduleKey,
  seedProvider,
  subscribe,
  terminalize,
  type SearchFixture,
  type ScheduleShowtime,
} from "./support/fixtures.js";
import { expireAggregationLease } from "./support/clock.js";
import { type Db, useDatabase } from "./support/pg.js";

/**
 * Tier 3 — ADR 0003's answer × status × schedule-outcome matrix as executable scenarios.
 *
 * Every lifecycle fact below is reached through B1–B9 statements. The only synthetic
 * input is placement evidence: seat scoring is outside this harness, while accepted
 * observation counts and free-seat totals come from PostgreSQL. B8 owns status/cause and
 * `src/lifecycle.ts` owns answer classification.
 *
 * The result classifier has one return for every reachable row. It throws on an unknown
 * terminal cause, terminal rows persist the classified answer in the immutable result
 * version, and the table asserts both the B8 state and the exact answer shape.
 */

interface ArrangedScenario {
  readonly searchId: string;
  readonly evidence: AnswerEvidence;
}

interface LifecycleScenario {
  readonly id: `A${number}`;
  readonly description: string;
  readonly expectedStatus: LifecycleStatus;
  readonly expectedCause: TerminalCause;
  readonly expectedScheduleOutcome: AggregateScheduleOutcome;
  readonly expectedAnswer: RankedAnswer | null;
  readonly arrange: (db: Db) => Promise<ArrangedScenario>;
}

const EMPTY = (cause: EmptyCause): RankedAnswer => ({ mode: "EMPTY", cause, suggestions: [] });
const PLACEMENT = (placementKey: string): Placement => ({
  layoutId: "layout_fixture",
  row: 5,
  startCol: 8,
  rowSpan: 1,
  count: 4,
  seatNames: ["F8", "F9", "F10", "F11"],
  placementKey,
});
const CONFIDENT_RECOMMENDATION: ConfidentRecommendation = {
  placement: PLACEMENT("placement_exact"),
  reasons: [],
  relaxed: [],
  showtimes: [],
};
const HEDGED_ALTERNATIVES: HedgedAlternatives = [
  {
    placement: PLACEMENT("placement_hedged_1"),
    reasons: [],
    relaxed: [{ kind: "FEWER_SHOWTIMES" }],
    showtimes: [],
  },
  {
    placement: PLACEMENT("placement_hedged_2"),
    reasons: [],
    relaxed: [{ kind: "FEWER_SHOWTIMES" }],
    showtimes: [],
  },
];
const CONFIDENT: RankedAnswer = {
  mode: "CONFIDENT",
  primary: CONFIDENT_RECOMMENDATION,
  otherFormats: [],
};
const HEDGED: RankedAnswer = {
  mode: "HEDGED",
  alternatives: HEDGED_ALTERNATIVES,
  otherFormats: [],
};
const EXACT_EVIDENCE: AnswerEvidence = {
  exact: CONFIDENT_RECOMMENDATION,
  hedged: HEDGED_ALTERNATIVES,
};
const RELAXED_EVIDENCE: AnswerEvidence = { exact: null, hedged: HEDGED_ALTERNATIVES };
const NO_PLACEMENT: AnswerEvidence = { exact: null, hedged: null };

async function aggregateScheduleOutcome(
  db: Db,
  searchId: string,
): Promise<AggregateScheduleOutcome> {
  const rows = await db.rows<{ schedule_outcome: "RESOLVED" | "EMPTY_RESOLVED" | "FAILED" | null }>(
    `SELECT rs.schedule_outcome
     FROM run_subscription rs
     JOIN run_key k USING (run_key_id)
     WHERE rs.search_id = $1 AND k.kind = 'SCHEDULE_RESOLUTION'`,
    [searchId],
  );

  if (rows.length === 0) return null;
  const outcomes = rows.map((row) => row.schedule_outcome);
  const failed = outcomes.filter((outcome) => outcome === "FAILED").length;
  if (failed === outcomes.length) return "FAILED";
  if (failed > 0) return "MIXED";
  if (outcomes.some((outcome) => outcome === null)) return null;
  if (outcomes.every((outcome) => outcome === "EMPTY_RESOLVED")) return "EMPTY_RESOLVED";
  return "RESOLVED";
}

async function readFacts(db: Db, searchId: string): Promise<LifecycleFacts> {
  const search = await db.one<{
    status: LifecycleStatus;
    terminal_cause: string | null;
  }>(`SELECT status, terminal_cause FROM search WHERE search_id = $1`, [searchId]);
  const accepted = await db.one<{ accepted_fetches: number; free_seats: number }>(
    `SELECT count(*)::integer AS accepted_fetches,
            coalesce(sum(snap.free_count), 0)::integer AS free_seats
     FROM run_application ra
     JOIN provider_run pr ON pr.run_id = ra.run_id
     JOIN run_key k ON k.run_key_id = pr.run_key_id AND k.kind = 'SHOWTIME_FETCH'
     JOIN observation o ON o.run_id = pr.run_id
     JOIN availability_snapshot snap ON snap.observation_id = o.observation_id
     WHERE ra.search_id = $1`,
    [searchId],
  );

  return {
    status: search.status,
    terminalCause: search.terminal_cause,
    scheduleOutcome: await aggregateScheduleOutcome(db, searchId),
    acceptedFetches: accepted.accepted_fetches,
    freeSeats: accepted.free_seats,
  };
}

async function terminalizeWithAnswer(db: Db, searchId: string, evidence: AnswerEvidence) {
  const beforeTerminalization = await readFacts(db, searchId);
  return terminalize(db, searchId, {
    resultPayload(state) {
      const answer = deriveRankedAnswer(
        {
          ...beforeTerminalization,
          status: state.status as LifecycleStatus,
          terminalCause: state.cause,
        },
        evidence,
      );
      return { status: state.status, answer };
    },
  });
}

async function resolveSchedule(
  db: Db,
  showtimeCount: number,
  acceptedFreeSeats: readonly number[],
): Promise<{ readonly search: SearchFixture; readonly showtimes: readonly ScheduleShowtime[] }> {
  await seedProvider(db);
  const schedule = await scheduleKey(db, id("theatre"), "2026-08-02");
  const search = await createSearch(db, 1, { reserve: Math.max(showtimeCount, 1) });
  await subscribe(db, search, schedule);

  const showtimes = Array.from({ length: showtimeCount }, (_, index) => ({
    showtimeId: id(`showtime_${index + 1}`),
    movieId: "amc:movie:test",
    startsAt: new Date(),
    skipFetch: false,
  }));
  await acceptSchedule(db, await dispatchRun(db, schedule), showtimes, {
    stage1Share: Math.max(showtimeCount, 1),
  });

  for (const [index, freeCount] of acceptedFreeSeats.entries()) {
    const showtime = showtimes[index];
    if (!showtime) throw new Error(`cannot accept missing showtime at index ${index}`);
    const key = await fetchKey(db, showtime.showtimeId);
    await acceptFetch(db, await dispatchRun(db, key), { freeCount });
  }

  return { search, showtimes };
}

async function haltProvider(db: Db): Promise<void> {
  await db.query("BEGIN");
  try {
    await mustWin(db, B.B9_BUMP_FENCE, [PROVIDER]);
    await mustWin(db, B.B9_UPSERT_STATUS, [PROVIDER, "", "HALTED", "BLOCKED", null]);
    await runQuery(db, B.B9_FENCE_JOBS, [PROVIDER]);
    await runQuery(db, B.B9_FENCE_RUNS, [PROVIDER]);
    await mustWin(db, B.B9_REQUEST_AGGREGATION, [PROVIDER]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

const SCENARIOS = [
  {
    id: "A1",
    description: "pending schedule has no answer",
    expectedStatus: "PENDING_SCHEDULE",
    expectedCause: null,
    expectedScheduleOutcome: null,
    expectedAnswer: null,
    async arrange(db) {
      await seedProvider(db);
      const search = await createSearch(db, 1, { reserve: 1 });
      await subscribe(db, search, await scheduleKey(db, id("theatre"), "2026-08-02"));
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A2",
    description: "running with partial observations has no terminal answer",
    expectedStatus: "RUNNING",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: null,
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, []);
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A3",
    description: "complete exact placement is confident",
    expectedStatus: "COMPLETE",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: CONFIDENT,
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, [4]);
      return { searchId: search.searchId, evidence: EXACT_EVIDENCE };
    },
  },
  {
    id: "A4",
    description: "complete relaxed placement is hedged",
    expectedStatus: "COMPLETE",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: HEDGED,
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, [4]);
      return { searchId: search.searchId, evidence: RELAXED_EVIDENCE };
    },
  },
  {
    id: "A5",
    description: "free seats without a fitting placement are an honest shape miss",
    expectedStatus: "COMPLETE",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("NO_SHAPE_MATCH"),
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, [4]);
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A6",
    description: "complete zero-free-seat evidence is sold out",
    expectedStatus: "COMPLETE",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("SOLD_OUT"),
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, [0]);
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A7",
    description: "fully resolved empty schedules are too few showtimes",
    expectedStatus: "COMPLETE",
    expectedCause: "TOO_FEW_SHOWTIMES",
    expectedScheduleOutcome: "EMPTY_RESOLVED",
    expectedAnswer: EMPTY("TOO_FEW_SHOWTIMES"),
    async arrange(db) {
      const { search } = await resolveSchedule(db, 0, []);
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A8",
    description: "partial accepted evidence is hedged, never confident",
    expectedStatus: "PARTIAL",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: HEDGED,
    async arrange(db) {
      const { search } = await resolveSchedule(db, 2, [4]);
      await expireSearchDeadline(db, search.searchId);
      return { searchId: search.searchId, evidence: EXACT_EVIDENCE };
    },
  },
  {
    id: "A9",
    description: "deadline with zero accepted fetches is halted data, not sold out",
    expectedStatus: "PARTIAL",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("HALTED"),
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, []);
      await expireSearchDeadline(db, search.searchId);
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A10",
    description: "exhausted schedule retries halt without fabricating observations",
    expectedStatus: "HALTED",
    expectedCause: null,
    expectedScheduleOutcome: "FAILED",
    expectedAnswer: EMPTY("HALTED"),
    async arrange(db) {
      await seedProvider(db);
      const search = await createSearch(db, 1, { reserve: 1 });
      const schedule = await scheduleKey(db, id("theatre"), "2026-08-02");
      await subscribe(db, search, schedule);
      await failRun(db, await dispatchRun(db, schedule));
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A11",
    description: "provider halt wins over otherwise live resolved work",
    expectedStatus: "HALTED",
    expectedCause: "PROVIDER_HALTED",
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("HALTED"),
    async arrange(db) {
      const { search } = await resolveSchedule(db, 1, []);
      await haltProvider(db);
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A12",
    description: "all fetch jobs failing halts instead of becoming sold out",
    expectedStatus: "HALTED",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("HALTED"),
    async arrange(db) {
      const { search, showtimes } = await resolveSchedule(db, 2, []);
      for (const showtime of showtimes) {
        const key = await fetchKey(db, showtime.showtimeId);
        await failRun(db, await dispatchRun(db, key));
      }
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A13",
    description: "post-create stage-2 denial reports capacity",
    expectedStatus: "HALTED",
    expectedCause: "CAPACITY",
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("CAPACITY"),
    async arrange(db) {
      await seedProvider(db, { pendingCostLimit: 1 });
      const schedule = await scheduleKey(db, id("theatre"), "2026-08-02");
      const search = await createSearch(db, 1, { reserve: 1 });
      await subscribe(db, search, schedule);
      const showtimes = [1, 2].map((value) => ({
        showtimeId: id(`showtime_${value}`),
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: false,
      }));
      await acceptSchedule(db, await dispatchRun(db, schedule), showtimes, { stage1Share: 1 });
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A14",
    description: "mixed schedule coverage is partial, never too few showtimes",
    expectedStatus: "PARTIAL",
    expectedCause: "PARTIAL_SCHEDULE",
    expectedScheduleOutcome: "MIXED",
    expectedAnswer: EMPTY("PARTIAL_SCHEDULE"),
    async arrange(db) {
      await seedProvider(db);
      // S36: one search-wide unresolved slot per search (coldDelta 1), not per key.
      const search = await createSearch(db, 1, { reserve: 1 });
      const resolved = await scheduleKey(db, id("theatre_resolved"), "2026-08-02");
      const failed = await scheduleKey(db, id("theatre_failed"), "2026-08-02");
      await subscribe(db, search, resolved);
      await subscribe(db, search, failed);
      await acceptSchedule(db, await dispatchRun(db, resolved), [], { stage1Share: 1 });
      await failRun(db, await dispatchRun(db, failed));
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
  {
    id: "A15",
    description: "every performance policy-skipped is halted data, never sold out",
    expectedStatus: "COMPLETE",
    expectedCause: null,
    expectedScheduleOutcome: "RESOLVED",
    expectedAnswer: EMPTY("HALTED"),
    async arrange(db) {
      await seedProvider(db);
      const schedule = await scheduleKey(db, id("theatre"), "2026-08-02");
      const search = await createSearch(db, 1, { reserve: 2 });
      await subscribe(db, search, schedule);
      const showtimes = [1, 2].map((value) => ({
        showtimeId: id(`showtime_${value}`),
        movieId: "amc:movie:test",
        startsAt: new Date(),
        skipFetch: true,
      }));
      await acceptSchedule(db, await dispatchRun(db, schedule), showtimes, { stage1Share: 2 });
      return { searchId: search.searchId, evidence: NO_PLACEMENT };
    },
  },
] satisfies readonly LifecycleScenario[];

describe("tier 3 — ADR 0003 lifecycle matrix", () => {
  const db = useDatabase();

  it.each(SCENARIOS)("$id — $description", async (scenario) => {
    const arranged = await scenario.arrange(db());
    const isTerminal = ["COMPLETE", "PARTIAL", "HALTED"].includes(scenario.expectedStatus);

    if (isTerminal) {
      const terminal = await terminalizeWithAnswer(db(), arranged.searchId, arranged.evidence);
      expect(terminal).not.toBeNull();
    } else {
      // A1/A2 are guard tests too: neither may produce an immutable result early.
      expect(await terminalize(db(), arranged.searchId)).toBeNull();
    }

    const facts = await readFacts(db(), arranged.searchId);
    expect({
      status: facts.status,
      cause: facts.terminalCause,
      scheduleOutcome: facts.scheduleOutcome,
    }).toEqual({
      status: scenario.expectedStatus,
      cause: scenario.expectedCause,
      scheduleOutcome: scenario.expectedScheduleOutcome,
    });

    const answer = deriveRankedAnswer(facts, arranged.evidence);
    expect(answer).toEqual(scenario.expectedAnswer);

    const versions = await db().rows<{ payload: { status: string; answer: RankedAnswer } }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1 ORDER BY version`,
      [arranged.searchId],
    );
    if (isTerminal) {
      expect(versions).toHaveLength(1);
      expect(versions[0]?.payload).toEqual({ status: scenario.expectedStatus, answer });
    } else {
      expect(versions).toEqual([]);
    }
  });

  it("does not call one empty schedule key globally empty when another key resolved", async () => {
    await seedProvider(db());
    // S36: multi-key cold search holds one schedule slot, not one per key.
    const search = await createSearch(db(), 1, { reserve: 1 });
    const emptyKey = await scheduleKey(db(), id("theatre_empty"), "2026-08-02");
    const resolvedKey = await scheduleKey(db(), id("theatre_resolved"), "2026-08-02");
    await subscribe(db(), search, emptyKey);
    await subscribe(db(), search, resolvedKey);

    await acceptSchedule(db(), await dispatchRun(db(), emptyKey), [], { stage1Share: 1 });
    const showtimeId = id("showtime_resolved");
    await acceptSchedule(
      db(),
      await dispatchRun(db(), resolvedKey),
      [{ showtimeId, movieId: "amc:movie:test", startsAt: new Date(), skipFetch: false }],
      { stage1Share: 1 },
    );
    await acceptFetch(db(), await dispatchRun(db(), await fetchKey(db(), showtimeId)), {
      freeCount: 4,
    });

    expect(await terminalizeWithAnswer(db(), search.searchId, EXACT_EVIDENCE)).toEqual({
      status: "COMPLETE",
      cause: null,
    });
    const facts = await readFacts(db(), search.searchId);
    expect(facts.scheduleOutcome).toBe("RESOLVED");
    expect(facts.terminalCause).toBeNull();
    expect(deriveRankedAnswer(facts, EXACT_EVIDENCE)).toEqual(CONFIDENT);
  });

  it("does not call empty plus unresolved schedule coverage too few at the deadline", async () => {
    await seedProvider(db());
    // S36: search-wide slot — single reservation for the empty+pending key set.
    const search = await createSearch(db(), 1, { reserve: 1 });
    const emptyKey = await scheduleKey(db(), id("theatre_empty"), "2026-08-02");
    const pendingKey = await scheduleKey(db(), id("theatre_pending"), "2026-08-02");
    await subscribe(db(), search, emptyKey);
    await subscribe(db(), search, pendingKey);
    await acceptSchedule(db(), await dispatchRun(db(), emptyKey), [], { stage1Share: 1 });
    await expireSearchDeadline(db(), search.searchId);

    expect(await terminalizeWithAnswer(db(), search.searchId, NO_PLACEMENT)).toEqual({
      status: "PARTIAL",
      cause: null,
    });
    const facts = await readFacts(db(), search.searchId);
    expect(facts.scheduleOutcome).toBeNull();
    expect(deriveRankedAnswer(facts, NO_PLACEMENT)).toEqual(EMPTY("HALTED"));
  });
});

describe("tier 3 — S6U3 write gate", () => {
  const db = useDatabase();

  async function arrangeA14World(): Promise<string> {
    await seedProvider(db());
    // S36: A14's two schedule keys share one search-wide slot (coldDelta 1).
    const search = await createSearch(db(), 1, { reserve: 1 });
    const resolved = await scheduleKey(db(), id("theatre_resolved"), "2026-08-02");
    const failed = await scheduleKey(db(), id("theatre_failed"), "2026-08-02");
    await subscribe(db(), search, resolved);
    await subscribe(db(), search, failed);
    await acceptSchedule(db(), await dispatchRun(db(), resolved), [], { stage1Share: 1 });
    await failRun(db(), await dispatchRun(db(), failed));
    return search.searchId;
  }

  async function terminalEvent(db: Db, searchId: string) {
    const rows = await db.rows<{
      type: string;
      payload: { status: string; cause: string | null; answer: RankedAnswer };
    }>(`SELECT type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`, [searchId]);
    return rows.at(-1);
  }

  it("S6U3.1/verification 2: a PARTIAL search with hedged evidence reveals HEDGED, never CONFIDENT", async () => {
    const searchId = await arrangeA14World();
    await terminalizeWithAnswer(db(), searchId, RELAXED_EVIDENCE);

    const reveal = await terminalEvent(db(), searchId);
    expect(reveal?.type).toBe("SEARCH_TERMINAL");
    expect(reveal?.payload).toEqual({
      status: "PARTIAL",
      cause: "PARTIAL_SCHEDULE",
      answer: HEDGED,
    });
  });

  it("S6U3.1/verification 2: invalid-state control — PARTIAL with CONFIDENT throws and rolls back; the same world with a valid answer succeeds", async () => {
    const searchId = await arrangeA14World();
    const before = await db().one<{ status: string }>(
      `SELECT status FROM search WHERE search_id = $1`,
      [searchId],
    );
    const eventsBefore = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM search_event WHERE search_id = $1`,
      [searchId],
    );

    await expect(
      terminalize(db(), searchId, {
        resultPayload: (state) => ({ status: state.status, answer: CONFIDENT }),
      }),
    ).rejects.toThrow(/PARTIAL.*CONFIDENT/);

    // Rollback: status untouched (the B8_TERMINALIZE transition was in the same
    // transaction), no terminal event, no immutable result version.
    expect(
      await db().one<{ status: string }>(`SELECT status FROM search WHERE search_id = $1`, [
        searchId,
      ]),
    ).toEqual(before);
    expect(["PENDING_SCHEDULE", "RUNNING"]).toContain(before.status);
    expect(
      await db().one<{ n: string }>(`SELECT count(*) AS n FROM search_event WHERE search_id = $1`, [
        searchId,
      ]),
    ).toEqual(eventsBefore);
    expect(
      await db().rows(`SELECT version FROM search_result_version WHERE search_id = $1`, [searchId]),
    ).toEqual([]);

    // Positive control: the claim committed before the transaction began, so move the
    // lease into the past and terminalize the same world with a valid answer.
    await expireAggregationLease(db(), searchId);
    expect(await terminalizeWithAnswer(db(), searchId, NO_PLACEMENT)).toEqual({
      status: "PARTIAL",
      cause: "PARTIAL_SCHEDULE",
    });
    expect(await terminalEvent(db(), searchId)).toEqual({
      type: "SEARCH_TERMINAL",
      payload: { status: "PARTIAL", cause: "PARTIAL_SCHEDULE", answer: EMPTY("PARTIAL_SCHEDULE") },
    });
  });

  it("S6U3.1/verification 3: terminalize with no resultPayload throws and persists nothing", async () => {
    const searchId = await arrangeA14World();
    const before = await db().one<{ status: string }>(
      `SELECT status FROM search WHERE search_id = $1`,
      [searchId],
    );
    const eventsBefore = await db().one<{ n: string }>(
      `SELECT count(*) AS n FROM search_event WHERE search_id = $1`,
      [searchId],
    );

    // The raw composition, not the fixtures wrapper — S6U3.2's default answer exists
    // exactly so the tiers keep passing; the hard-require itself lives in src.
    await expect(rawTerminalize(db(), searchId)).rejects.toThrow(/resultPayload/);

    expect(
      await db().one<{ status: string }>(`SELECT status FROM search WHERE search_id = $1`, [
        searchId,
      ]),
    ).toEqual(before);
    expect(
      await db().one<{ n: string }>(`SELECT count(*) AS n FROM search_event WHERE search_id = $1`, [
        searchId,
      ]),
    ).toEqual(eventsBefore);
    expect(
      await db().rows(`SELECT version FROM search_result_version WHERE search_id = $1`, [searchId]),
    ).toEqual([]);
  });
});

describe("tier 3 — answer classifier exhaustiveness", () => {
  const base: LifecycleFacts = {
    status: "COMPLETE",
    terminalCause: null,
    scheduleOutcome: "RESOLVED",
    acceptedFetches: 1,
    freeSeats: 4,
  };

  it("rejects an unknown terminal cause instead of inventing an answer", () => {
    expect(() =>
      deriveRankedAnswer({ ...base, status: "HALTED", terminalCause: "UNKNOWN" }, NO_PLACEMENT),
    ).toThrow(/no answer-matrix row/);
  });

  it("rejects TOO_FEW_SHOWTIMES without complete empty coverage", () => {
    expect(() =>
      deriveRankedAnswer({ ...base, terminalCause: "TOO_FEW_SHOWTIMES" }, NO_PLACEMENT),
    ).toThrow(/complete, empty schedule coverage/);
  });
});
