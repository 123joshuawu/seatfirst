import * as B from "../../src/boundaries.js";
import { deriveRankedAnswer } from "../../src/lifecycle.js";
import type {
  AggregateScheduleOutcome,
  LifecycleFacts,
  LifecycleStatus,
} from "../../src/lifecycle.js";

import * as T from "../../src/transactions.js";

import type { SqlClient as Db } from "./pg.js";

/**
 * Scenario builders composed **out of the boundary statements themselves**, never out of
 * hand-written SQL. If a fixture needs a statement the ADR does not have, that is a
 * finding about the ADR, not a licence to write a one-off INSERT here.
 */

let n = 0;
export const id = (prefix: string): string => `${prefix}_${(++n).toString().padStart(6, "0")}`;

export const PROVIDER = "amc";

export interface ProviderCaps {
  readonly pendingCostLimit?: number;
  readonly unresolvedLimit?: number;
}

/** provider_admission + provider_fence rows. Seed data, not a boundary. */
export async function seedProvider(
  db: Db,
  { pendingCostLimit = 1000, unresolvedLimit = 100 }: ProviderCaps = {},
  providerId = PROVIDER,
): Promise<string> {
  await db.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)`,
    [providerId, pendingCostLimit, unresolvedLimit],
  );
  await db.query(`INSERT INTO provider_fence (provider_id) VALUES ($1)`, [providerId]);
  return providerId;
}

export async function runQuery(db: Db, s: B.Statement, values: readonly unknown[]) {
  return db.query(s.text, values);
}

/** Exactly-one-row wrapper: 0 rows at a fence means the caller lost, which is a test failure. */
export async function mustWin<T = any>(
  db: Db,
  s: B.Statement,
  values: readonly unknown[],
): Promise<T> {
  const r = await db.query(s.text, values);
  if (r.rows.length < 1) {
    throw new Error(
      `${s.name} (${s.boundary}) returned 0 rows.\n` +
        `0 rows means: ${s.zeroRowsMeans || "(no defined loser path)"}`,
    );
  }
  return r.rows[0] as T;
}

const minutes = (m: number) => `${m} minutes`;

export interface SearchFixture {
  readonly searchId: string;
  readonly deadlineAt: Date;
}
export interface CreateSearchOptions {
  readonly deadlineMinutes?: number;
  /** Stage-1 reservation: the validator maximum for a cold search, the real count for warm. */
  readonly reserve?: number;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  readonly specHash?: string;
  /** S36: durable fresh contribution (0..200) written once in B1. */
  readonly freshMatchSeed?: number;
}

/**
 * B1 — the `search` row plus its stage-1 reservation. `coldDelta` MUST be 0 or 1: zero on
 * the warm path, one for any cold/mixed search regardless of how many schedule keys it
 * subscribes to. S36 redesigned the admission slot from one-per-key to one-per-search
 * (migration 013): `B1_STAGE1_ADMISSION` sets `schedule_slot_held = (coldDelta = 1)` while
 * incrementing `unresolved_schedules` by the raw `coldDelta` value (boundaries.ts), so a
 * caller passing a raw schedule-key count silently desyncs the two. Mirror
 * `stageSearchCreation`'s `scheduleKeys.length > 0 ? 1 : 0` at every call site.
 * S36: B1_STAGE1_ADMISSION now takes 5 params (fresh_match_seed); default 0 preserves v1 tests.
 */
export async function createSearch(
  db: Db,
  coldDelta: number,
  opts: CreateSearchOptions = {},
  providerId = PROVIDER,
): Promise<SearchFixture> {
  const searchId = id("srch");
  const deadlineAt = new Date(Date.now() + (opts.deadlineMinutes ?? 10) * 60_000);
  await mustWin(db, B.B1_CREATE_SEARCH, [
    searchId,
    opts.sessionId ?? id("sess"),
    opts.idempotencyKey ?? id("idem"),
    JSON.stringify({ v: 1 }),
    opts.specHash ?? "hash_a",
    deadlineAt.toISOString(),
  ]);
  await mustWin(db, B.B1_STAGE1_ADMISSION, [
    providerId,
    opts.reserve ?? 1,
    coldDelta,
    searchId,
    opts.freshMatchSeed ?? 0,
  ]);
  return { searchId, deadlineAt };
}

export interface KeyFixture {
  readonly runKeyId: string;
  readonly kind: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION" | "MOVIE_SCHEDULE_RESOLUTION";
  readonly showtimeId: string | null;
  readonly theatreId: string | null;
  readonly localDate: string | null;
}

/**
 * A permanent run key. The real id is `hash(kind, provider_id, parts)`; here it is
 * derived from the same parts so concurrent creators converge exactly as they would.
 */
export async function fetchKey(
  db: Db,
  showtimeId: string,
  providerId = PROVIDER,
): Promise<KeyFixture> {
  const runKeyId = `k_fetch_${providerId}_${showtimeId}`;
  await mustWin(db, B.RUN_KEY_UPSERT, [
    runKeyId,
    "SHOWTIME_FETCH",
    providerId,
    "seat",
    showtimeId,
    null,
    null,
  ]);
  return { runKeyId, kind: "SHOWTIME_FETCH", showtimeId, theatreId: null, localDate: null };
}

export async function scheduleKey(
  db: Db,
  theatreId: string,
  localDate: string,
  providerId = PROVIDER,
): Promise<KeyFixture> {
  const runKeyId = `k_sched_${providerId}_${theatreId}_${localDate}`;
  await mustWin(db, B.RUN_KEY_UPSERT, [
    runKeyId,
    "SCHEDULE_RESOLUTION",
    providerId,
    "schedule",
    null,
    theatreId,
    localDate,
  ]);
  return { runKeyId, kind: "SCHEDULE_RESOLUTION", showtimeId: null, theatreId, localDate };
}

export async function movieScheduleKey(
  db: Db,
  movieSlug: string,
  anchorTheatreId: string,
  localDate: string,
  providerId = PROVIDER,
): Promise<KeyFixture> {
  const runKeyId = `k_movie_sched_${providerId}_${movieSlug}_${anchorTheatreId}_${localDate}`;
  await mustWin(db, B.MOVIE_SCHEDULE_RUN_KEY_UPSERT, [
    runKeyId,
    providerId,
    movieSlug,
    anchorTheatreId,
    localDate,
  ]);
  return {
    runKeyId,
    kind: "MOVIE_SCHEDULE_RESOLUTION",
    showtimeId: null,
    theatreId: anchorTheatreId,
    localDate,
  };
}

export interface SubscriptionFixture {
  readonly jobId: string;
  readonly runKeyId: string;
  readonly searchId: string;
}

/** Job + subscription + outbox row: the unit B1 writes on the warm path and B6 writes on expansion. */
export async function subscribe(
  db: Db,
  search: SearchFixture,
  key: KeyFixture,
  opts: { readonly deadlineAt?: Date; readonly admissionCounted?: boolean } = {},
): Promise<SubscriptionFixture> {
  const jobId = id("job");
  const deadline = (opts.deadlineAt ?? search.deadlineAt).toISOString();
  await mustWin(db, B.JOB_CREATE, [jobId, search.searchId, key.kind, key.runKeyId, deadline]);
  // S36 clean cutover: SUBSCRIPTION_CREATE now 4 args (no admission_counted); slot is search-level.
  // opts.admissionCounted retained for call-site compat but ignored — S36 keeps one slot per search.
  await mustWin(db, B.SUBSCRIPTION_CREATE, [key.runKeyId, search.searchId, jobId, deadline]);
  await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, null]);
  return { jobId, runKeyId: key.runKeyId, searchId: search.searchId };
}

export async function subscribeMovieSchedule(
  db: Db,
  search: SearchFixture,
  key: KeyFixture,
  candidateTheatreIds: readonly string[],
): Promise<SubscriptionFixture> {
  if (key.kind !== "MOVIE_SCHEDULE_RESOLUTION") {
    throw new Error("subscribeMovieSchedule requires a movie schedule key");
  }
  const jobId = id("job");
  const deadline = search.deadlineAt.toISOString();
  await mustWin(db, B.JOB_CREATE, [jobId, search.searchId, key.kind, key.runKeyId, deadline]);
  await mustWin(db, B.MOVIE_SCHEDULE_SUBSCRIPTION_CREATE, [
    key.runKeyId,
    search.searchId,
    jobId,
    deadline,
    JSON.stringify(candidateTheatreIds),
  ]);
  await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, null]);
  return { jobId, runKeyId: key.runKeyId, searchId: search.searchId };
}

export interface RunFixture {
  readonly runId: string;
  readonly runKeyId: string;
  readonly observationId: string;
  readonly generation: number;
  readonly epoch: string;
}

/** RUN_CREATE → outbox → B2 lease → B4 pre-dispatch. Leaves the run ready to accept. */
export async function dispatchRun(db: Db, key: KeyFixture): Promise<RunFixture> {
  const runId = id("run");
  const observationId = id("obs");
  await mustWin(db, B.RUN_CREATE, [runId, key.runKeyId, observationId, null]);
  await mustWin(db, B.OUTBOX_CREATE_RUN, [runId, null]);
  const leased = await mustWin<{ generation: number }>(db, B.B2_LEASE_RUN, [runId, minutes(5)]);
  const dispatched = await mustWin<{ provider_epoch: string }>(db, B.B4_PREDISPATCH, [
    runId,
    leased.generation,
  ]);
  return {
    runId,
    runKeyId: key.runKeyId,
    observationId,
    generation: leased.generation,
    epoch: dispatched.provider_epoch,
  };
}

export type AcceptResult = T.AcceptResult;

/**
 * The B5(a)–(f) fetch body without BEGIN/COMMIT. Crash tests use this to terminate the
 * backend after all effects have executed but before any are durable.
 *
 * Thin wrapper: the actual composition lives in `src/transactions.ts`
 * (`stageFetchAcceptance`) so it is a single source of truth citable from the ADR, not
 * tribal knowledge that only exists in this test fixture (defect 4).
 */
export const stageFetchAcceptance = T.stageFetchAcceptance;

/** B5(a)–(f) for a SHOWTIME_FETCH run, in one transaction, exactly as the ADR sequences it. */
export const acceptFetch = T.acceptFetch;

export type ScheduleShowtime = T.ScheduleShowtime;

/**
 * B5(a)–(f) for a SCHEDULE_RESOLUTION run, including B6's expansion for each subscriber
 * that actually transitioned. `showtimes` empty means `EMPTY_RESOLVED`.
 *
 * Thin wrapper: the actual composition lives in `src/transactions.ts` (`acceptSchedule`,
 * promoted from this file's former hand-rolled copy) so it is a single source of truth
 * citable from the ADR, not tribal knowledge that only exists in this test fixture
 * (defect 4) — the same promotion the fetch branch already got.
 */
export const acceptSchedule = T.acceptSchedule;

/**
 * B5F(a)+(b)(c) — failure acceptance for an attempts-exhausted run, self-reported by a
 * caller that still holds the lease. Delegates to `T.failRun` (src/transactions.ts); the
 * `attempt = 5` write below is test scaffolding (simulating "attempts are exhausted"), not
 * a boundary statement, so it stays here rather than in src.
 */
export async function failRun(
  db: Db,
  run: RunFixture,
  cause = "ATTEMPTS_EXHAUSTED",
): Promise<{ affected: { search_id: string; seq: string }[] }> {
  await db.query(`UPDATE provider_run SET attempt = 5 WHERE run_id = $1`, [run.runId]);
  const result = await T.failRun(db, run, cause, 5);
  if (!result) {
    throw new Error(`failRun: B5F_FENCE returned 0 rows for run ${run.runId}`);
  }
  return result;
}

export type TerminalState = T.TerminalState;
export type TerminalizeOptions = T.TerminalizeOptions;

/**
 * B8's same-transaction body, exposed so crash/race tests can control its COMMIT.
 *
 * Thin wrapper with S6U3.2's default-answer supply: the actual composition
 * (release→clear-slots, expire-subs→cancel-orphaned-runs — both orderings load-bearing)
 * lives in `src/transactions.ts`, the single source of truth for what the ADR calls "one
 * transaction" (defect 4); the answer S6U3.1 hard-requires comes from
 * `deriveRankedAnswer` over the search's facts when the caller passes no `resultPayload`
 * — tier 3 keeps supplying explicit evidence payloads.
 */
export async function stageTerminalization(
  db: Db,
  searchId: string,
  aggGeneration: number,
  aggRequestedRev: string,
  opts?: T.TerminalizeOptions,
): Promise<T.TerminalState | null> {
  return T.stageTerminalization(
    db,
    searchId,
    aggGeneration,
    aggRequestedRev,
    await defaultTerminalizeOptions(db, searchId, opts),
  );
}

/** B7 claim → B8 terminalization and its same-transaction tail. Returns the derived status. */
export async function terminalize(
  db: Db,
  searchId: string,
  opts?: T.TerminalizeOptions,
): Promise<T.TerminalState | null> {
  return T.terminalize(db, searchId, await defaultTerminalizeOptions(db, searchId, opts));
}

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

/** The search's lifecycle facts, read exactly as tier 3's `terminalizeWithAnswer` does
 * (`packages/durability/test/tier3.lifecycle.test.ts:136-177`) — support SQL, not a
 * transition. */
async function readTerminalFacts(db: Db, searchId: string): Promise<LifecycleFacts> {
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

/**
 * S6U3.2: when the caller passes no `resultPayload`, supply one whose `answer` is
 * `deriveRankedAnswer(facts, { exact: null, hedged: null })` — always a valid EMPTY
 * answer for a terminal search by construction (`lifecycle.ts:94-147`), so the
 * tier-2/4/5/6 tests that assert only status/cause/event counts keep passing unchanged.
 */
async function defaultTerminalizeOptions(
  db: Db,
  searchId: string,
  opts?: T.TerminalizeOptions,
): Promise<T.TerminalizeOptions | undefined> {
  if (opts?.resultPayload) return opts;
  const facts = await readTerminalFacts(db, searchId);
  return {
    ...opts,
    resultPayload(state) {
      const answer = deriveRankedAnswer(
        {
          ...facts,
          status: state.status as LifecycleStatus,
          terminalCause: state.cause,
        },
        { exact: null, hedged: null },
      );
      return { status: state.status, answer };
    },
  };
}

/** Time is data: expiring a deadline is an UPDATE, never a sleep. */
export async function expireSearchDeadline(db: Db, searchId: string): Promise<void> {
  await db.query(
    `UPDATE search SET deadline_at = now() - interval '1 second' WHERE search_id = $1`,
    [searchId],
  );
}

export async function expireSubscriptionDeadline(
  db: Db,
  runKeyId: string,
  searchId: string,
): Promise<void> {
  await db.query(
    `UPDATE run_subscription SET deadline_at = now() - interval '1 second'
     WHERE run_key_id = $1 AND search_id = $2`,
    [runKeyId, searchId],
  );
}
