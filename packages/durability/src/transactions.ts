/**
 * Composed, exported transaction bodies for the multi-statement boundaries.
 *
 * ADR 0001 describes B5 and B8 each as "one transaction," but each is several separate
 * `boundaries.ts` exports whose ORDER is load-bearing. Before this module the only place
 * that order was encoded was the test fixtures (`test/support/fixtures.ts`), which is
 * tribal knowledge wearing a test's clothes: nothing in `src/` could be cited as the
 * composition, and nothing outside the test suite could reuse it. This module is that
 * single source of truth; the fixtures now call into it instead of re-sequencing the
 * statements themselves.
 *
 * Also carries the composed remediation for attempts-exhausted, expired-lease work
 * (`sweepFailExhaustedRuns` / `sweepFailExhaustedJobs`) — the recovery path ADR 0001 §5
 * duty 3 requires ("it runs the full B5F effects") and that no export previously provided.
 */
import { randomUUID } from "node:crypto";

import type { RankedAnswer } from "./lifecycle.js";

import * as B from "./boundaries.js";

/** Maximum age of an existing availability snapshot for authoritative backend adoption (ADR 0065). */
export const SNAPSHOT_ADOPTION_TTL_MS = 30_000;

/** Client-side presentation threshold for offer staleness (ADR 0065). */
export const OFFER_STALENESS_MS = 120_000;

/** Minimal structural client surface — deliberately narrower than the test `SqlClient`, so
 * any richer client (the test one included) satisfies it without adaptation. Row shapes are
 * intentionally unknown here: the caller (via `mustWin`/`runRows`) states the shape it
 * expects at each call site, exactly the way `boundaries.ts`'s `RETURNING` clause defines it. */
export interface SqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Nominal marker for an `SqlClient` guaranteed to be backed by a single physical connection.
 * The five `BEGIN`-emitting functions below (`acceptFetch`, `failRun`, `terminalize`,
 * `sweepFailExhaustedJobs`, `sweepFailExhaustedRuns`) compose `BEGIN`/`COMMIT`/`ROLLBACK`
 * across several `db.query()` calls; that only forms one transaction if every call lands on
 * the same connection. A pooled client that may hand out a different physical connection per
 * call (`poolClient(pool)`, `pool.ts`) would send `BEGIN` down one connection and the calls
 * that follow down others — silently running without a transaction at all, not failing
 * loudly. This used to rest on a doc-comment convention alone, and that already failed once:
 * a prior change applied the "REQUIRES a single-connection `db`" comment to four of these
 * five functions and missed the fifth in the same file. The brand makes the requirement a
 * compile error instead of a convention: only a client actually produced at the
 * single-connection DB boundary (`pool.ts`'s `sqlClient()` over one checked-out `PoolClient`,
 * `withTransaction`'s callback argument, or the test harness's dedicated single-connection
 * wrappers, `test/support/pg.ts`) carries this marker. `poolClient(pool)` deliberately does
 * not, and never should.
 */
declare const tx: unique symbol;
export interface TransactionClient extends SqlClient {
  readonly [tx]: true;
}

async function mustWin<T = unknown>(
  db: SqlClient,
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
  // S39.8 (CONTRIBUTING §2) — tolerated cast: T is the call site's declared row shape; the length fence above guarantees presence.
  return r.rows[0] as T;
}

async function runRows<T = unknown>(
  db: SqlClient,
  s: B.Statement,
  values: readonly unknown[],
): Promise<T[]> {
  // S39.8 (CONTRIBUTING §2) — tolerated cast: T[] is the call site's declared row shape, pinned by tiers 1–2.
  return (await db.query(s.text, values)).rows as T[];
}

/**
 * S39.1 — shared narrow row guards for the hand-written single-row reads that have no
 * `mustWin` fence (the B5 staged bodies' raw SELECTs, the repository's session reads).
 * Modeled on `extractRankedAnswer` below: structural checks first, throw naming the
 * reading function and what was expected — never a bare TypeError — cast last. The
 * generic funnels above stay generic; these helpers are only for call sites that state
 * their row's shape.
 */
export function firstRow(rows: readonly unknown[], reader: string): Record<string, unknown> {
  if (rows.length < 1) {
    throw new Error(`${reader} returned 0 rows`);
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new Error(`${reader} expected an object row, got ${typeof row}`);
  }
  return row;
}

/** The field kinds the row guards distinguish; `date` because pg materializes timestamptz
 * columns as Date objects, not strings. */
type RowFieldKind = "string" | "number" | "boolean" | "date";

function rowFieldIs(value: unknown, kind: RowFieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return value instanceof Date;
  }
}

/**
 * S39.1 — per-field presence check used before destructuring a guarded row. Each declared
 * field must be present with its expected kind; a missing or mistyped field throws naming
 * the reader and the field instead of letting `undefined` flow into arithmetic.
 */
export function requireFields(
  row: Record<string, unknown>,
  reader: string,
  fields: Readonly<Record<string, RowFieldKind>>,
): void {
  for (const [field, kind] of Object.entries(fields)) {
    if (!rowFieldIs(row[field], kind)) {
      throw new Error(`${reader} expected field \`${field}\` to be ${kind} on the returned row`);
    }
  }
}

export interface RunHandle {
  readonly runId: string;
  readonly generation: number;
}

export interface AcceptResult {
  readonly acceptedRevision: string;
  /** One row per subscriber that actually transitioned: `{ search_id, seq }`. */
  readonly fannedIn: { search_id: string; seq: string }[];
}

/**
 * B5(a)–(f), SHOWTIME_FETCH branch, without BEGIN/COMMIT — exposed separately so crash
 * tests can terminate the backend mid-transaction, after every effect has executed but
 * before any is durable.
 */
export async function stageFetchAcceptance(
  db: SqlClient,
  run: RunHandle,
  opts: {
    readonly freeCount?: number;
    readonly capturedAt?: Date;
    readonly bitmap?: Buffer;
    readonly layout?: {
      readonly layoutId: string;
      readonly geometry: Buffer;
      readonly rows: number;
      readonly columns: number;
    };
    readonly minPrice?: number | null | undefined;
    readonly currency?: string | null;
    readonly priceBasis?: "TICKET_ONLY" | "UNKNOWN" | null;
  } = {},
): Promise<AcceptResult> {
  const capturedAt = (opts.capturedAt ?? new Date()).toISOString();
  const fenced = await mustWin<{
    run_key_id: string;
    observation_id: string;
    provider_epoch: string;
  }>(db, B.B5A_FENCE, [run.runId, run.generation]);

  const key = await mustWin<{ kind: string; provider_id: string; route_class: string }>(
    db,
    B.B5A_DERIVE_KEY,
    [fenced.run_key_id],
  );

  await mustWin(db, B.B5B_EPOCH_FENCE, [key.provider_id, fenced.provider_epoch, key.route_class]);

  await mustWin(db, B.B5C_OBSERVATION, [
    fenced.observation_id,
    fenced.run_key_id,
    run.runId,
    capturedAt,
  ]);

  const showtimeRow = firstRow(
    (await db.query(`SELECT showtime_id FROM run_key WHERE run_key_id = $1`, [fenced.run_key_id]))
      .rows,
    "stageFetchAcceptance",
  );
  requireFields(showtimeRow, "stageFetchAcceptance", { showtime_id: "string" });
  const showtimeId = showtimeRow["showtime_id"] as string;
  await mustWin(db, B.B5C_SNAPSHOT, [
    fenced.observation_id,
    showtimeId,
    capturedAt,
    opts.bitmap ?? Buffer.from([0b1010_1010]),
    opts.freeCount ?? 4,
  ]);
  if (opts.layout) {
    await runRows(db, B.B5C_LAYOUT_UPSERT, [
      opts.layout.layoutId,
      opts.layout.geometry,
      opts.layout.rows,
      opts.layout.columns,
    ]);
    await mustWin(db, B.B5C_PERFORMANCE_LAYOUT, [showtimeId, opts.layout.layoutId]);
  }
  // B5(c) effects stay grouped before the B5(d) revision bump: moving the price write
  // after B5D_ACCEPTED_REVISION would advance the projector's "fetch fully accepted"
  // signal ahead of a staged effect a later failure could still roll back, and moving
  // it before B5C_SNAPSHOT would stage a price for an observation whose snapshot has
  // not yet been inserted. `updated_at` reuses the observation's capturedAt.
  if (opts.minPrice !== undefined) {
    await mustWin(db, B.B5C_PERFORMANCE_PRICE, [
      showtimeId,
      opts.minPrice,
      opts.currency ?? null,
      opts.priceBasis ?? null,
      capturedAt,
    ]);
  }

  const rev = await mustWin<{ accepted_revision: string }>(db, B.B5D_ACCEPTED_REVISION, [
    fenced.run_key_id,
    fenced.observation_id,
    capturedAt,
  ]);

  const fanIn = await runRows<{ search_id: string; seq: string }>(db, B.B5_FANIN, [
    fenced.run_key_id,
    run.runId,
    key.provider_id,
    key.kind,
    JSON.stringify({ observationId: fenced.observation_id }),
  ]);

  return { acceptedRevision: rev.accepted_revision, fannedIn: fanIn };
}

/**
 * B5(a)–(f) for a SHOWTIME_FETCH run, in one transaction, exactly as the ADR sequences it.
 *
 * REQUIRES a single-connection `db`: this composes `BEGIN`/`COMMIT`/`ROLLBACK` across several
 * `db.query()` calls, so every call must land on the same physical connection or the `BEGIN`
 * is invisible to the calls that follow it — silently running without a transaction at all,
 * not failing loudly. `withTransaction`'s callback argument (`pool.ts`) or a checked-out
 * `PoolClient` adapted by `sqlClient`/`poolClient` satisfy this; `poolClient(pool)` (`pool.ts`)
 * does NOT — see its doc comment.
 */
export async function acceptFetch(
  db: TransactionClient,
  run: RunHandle,
  opts: {
    readonly freeCount?: number;
    readonly capturedAt?: Date;
    readonly bitmap?: Buffer;
    readonly layout?: {
      readonly layoutId: string;
      readonly geometry: Buffer;
      readonly rows: number;
      readonly columns: number;
    };
    readonly minPrice?: number | null | undefined;
    readonly currency?: string | null;
    readonly priceBasis?: "TICKET_ONLY" | "UNKNOWN" | null;
  } = {},
): Promise<AcceptResult> {
  await db.query("BEGIN");
  try {
    const result = await stageFetchAcceptance(db, run, opts);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/** A showtime resolved by a SCHEDULE_RESOLUTION run, as carried from the parse seam into
 * `acceptSchedule`. `movieId` is needed by the injected per-subscriber predicate filter;
 * only the base columns `B5C_PERFORMANCE` writes have a persistence home here.
 *
 * `skipFetch` is computed by the caller from `performancePolicy` (ADR 0009). A skipped
 * showtime still gets its `performance` row but creates no fetch work and reserves no
 * capacity; durability only ever sees this plain flag, never a `ShowtimeStatus`. */
export interface ScheduleShowtime {
  readonly showtimeId: string;
  readonly movieId: string;
  readonly startsAt: Date;
  readonly skipFetch: boolean;
  readonly dispatchRank?: number | null;
  readonly formatCode?: string | null;
  readonly distanceKm?: number | null;
  readonly theatreId?: string;
  /**
   * C4 — observed schedule title for title-based MOVIE predicate matching in the
   * cold fan-out filter. Optional so older callers/tests that only carry
   * provider movie IDs keep compiling; absent reads as `null` (id-only match).
   */
  readonly movieTitle?: string | null;
  /**
   * S57 — theatre-local ISO datetime (`YYYY-MM-DDTHH:mm:ss`), computed by the
   * production `scheduleSubscriberFilter` in apps/server (which owns the timezone
   * conversion via `@seatfirst/core`'s `toTheatreLocal`; durability is firewalled
   * from importing core). Carried here so `stageScheduleAcceptance` can echo
   * admitted cold-discovered showtimes as `scheduleSkeleton` entries. Absent in
   * older callers/tests — the emission below skips such entries defensively.
   */
  readonly showDateTimeLocal?: string;
}

/**
 * S36 — plain-data seam for per-subscriber cold fan-out filtering.
 * Durability must never import @seatfirst/core; the production implementation
 * lives in apps/server, parses the stored spec, and applies the shared movie and
 * schedule-window predicate evaluators. Durability fixtures pass deterministic selectors.
 */
export interface ScheduleSubscriberFilterInput {
  readonly searchId: string;
  readonly spec: unknown;
  readonly timezone: string;
  readonly showtimes: readonly ScheduleShowtime[];
}

export type ScheduleSubscriberFilter = (
  input: ScheduleSubscriberFilterInput,
) => readonly ScheduleShowtime[];

/**
 * B5(a)–(f), SCHEDULE_RESOLUTION branch, without BEGIN/COMMIT — the schedule counterpart
 * of `stageFetchAcceptance`, exposed separately for the same reason: crash tests can
 * terminate the backend mid-transaction, after every effect has executed but before any
 * is durable.
 *
 * Promoted from the test fixture (`test/support/fixtures.ts`, formerly `acceptSchedule`)
 * so the composition has one citable home in `src/` — before this, the only place the
 * schedule branch's sequence plus B6's expansion order existed was tribal knowledge
 * wearing a test's clothes, the same defect-4 gap the module header names for the fetch
 * branch. The body reproduces the fixture's composition exactly: B5A fence → derive key →
 * B5B epoch fence → B5C_OBSERVATION → one `B5C_PERFORMANCE` per showtime → B5D revision →
 * B5_FANIN → per subscriber that transitioned, filtered B6 expansion with cumulative
 * capacity gate (S36.6), `B6_SET_SCHEDULE_MATCH_COUNT`, `B6_RECONCILE_SEARCH_WIDE` or
 * `B6_DENY_CAPACITY` + `cancelOrphanedWorkOnDenial`, `B6_SUBSCRIPTION_OUTCOME`,
 * `B6_SEARCH_RUNNING`). `showtimes` empty means `EMPTY_RESOLVED`.
 */
export async function stageScheduleAcceptance(
  db: SqlClient,
  run: RunHandle,
  showtimes: readonly ScheduleShowtime[],
  opts: {
    readonly capturedAt?: Date;
    readonly stage1Share?: number;
    readonly filter?: ScheduleSubscriberFilter;
  } = {},
): Promise<AcceptResult & { readonly expandedFor: string[] }> {
  const capturedAt = (opts.capturedAt ?? new Date()).toISOString();
  const outcome = showtimes.length > 0 ? "RESOLVED" : "EMPTY_RESOLVED";
  const fenced = await mustWin<{
    run_key_id: string;
    observation_id: string;
    provider_epoch: string;
  }>(db, B.B5A_FENCE, [run.runId, run.generation]);

  const key = await mustWin<{ kind: string; provider_id: string; route_class: string }>(
    db,
    B.B5A_DERIVE_KEY,
    [fenced.run_key_id],
  );

  await mustWin(db, B.B5B_EPOCH_FENCE, [key.provider_id, fenced.provider_epoch, key.route_class]);

  await mustWin(db, B.B5C_OBSERVATION, [
    fenced.observation_id,
    fenced.run_key_id,
    run.runId,
    capturedAt,
  ]);

  const keyRow = firstRow(
    (
      await db.query(`SELECT theatre_id, local_date FROM run_key WHERE run_key_id = $1`, [
        fenced.run_key_id,
      ])
    ).rows,
    "stageScheduleAcceptance",
  );
  // `run_key.local_date` is a PG `date` column (001_schema.sql:64): pg materializes it as
  // a Date, so the pre-S39 `as string` here was itself a mistyped cast — the guard now
  // states the real shape.
  requireFields(keyRow, "stageScheduleAcceptance", { theatre_id: "string", local_date: "date" });
  const theatreId = keyRow["theatre_id"] as string;
  const localDate = keyRow["local_date"] as Date;
  for (const st of showtimes) {
    await mustWin(db, B.B5C_PERFORMANCE, [
      st.showtimeId,
      key.provider_id,
      theatreId,
      localDate,
      st.startsAt.toISOString(),
      fenced.observation_id,
      JSON.stringify({}),
    ]);
  }

  const rev = await mustWin<{ accepted_revision: string }>(db, B.B5D_ACCEPTED_REVISION, [
    fenced.run_key_id,
    fenced.observation_id,
    capturedAt,
  ]);

  const fanIn = await runRows<{ search_id: string; seq: string }>(db, B.B5_FANIN, [
    fenced.run_key_id,
    run.runId,
    key.provider_id,
    key.kind,
    JSON.stringify({ observationId: fenced.observation_id, outcome }),
  ]);

  // S36: per-subscriber filtered fan-out with cumulative capacity gate before dispatch.
  // For each subscriber that transitioned via B5_FANIN, apply the injected
  // ScheduleSubscriberFilter (plain-data, no @seatfirst/core import) to the accepted
  // day's showtimes using that subscriber's stored spec + theatre timezone, then gate
  // the filtered count against the search-wide provisional 200 + provider headroom
  // before publishing any fetch jobs. The gate prevents the B5_FANIN race where
  // provider_admission.pending_cost would otherwise go negative on the 201st fetch.
  const expandedFor: string[] = [];
  for (const row of fanIn) {
    const searchId = row.search_id;
    const subRow = firstRow(
      (
        await db.query(
          `SELECT deadline_at FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`,
          [fenced.run_key_id, searchId],
        )
      ).rows,
      "stageScheduleAcceptance",
    );
    requireFields(subRow, "stageScheduleAcceptance", { deadline_at: "date" });
    const subDeadlineAt = subRow["deadline_at"] as Date;

    // Load this subscriber's stored spec and the schedule key's theatre timezone.
    // S39.8 (CONTRIBUTING §2) — tolerated cast: undefined handled below (spec defaults to null); the SELECT projects only spec.
    const searchRow = (await db.query(`SELECT spec FROM search WHERE search_id = $1`, [searchId]))
      .rows[0] as { spec: unknown } | undefined;
    const spec = searchRow?.spec ?? null;
    // S39.8 (CONTRIBUTING §2) — tolerated cast: undefined handled below (timezone defaults to UTC); the SELECT projects only timezone.
    const theatreRow = (
      await db.query(`SELECT timezone FROM theatre WHERE theatre_id = $1`, [theatreId])
    ).rows[0] as { timezone: string } | undefined;
    const timezone = theatreRow?.timezone ?? "UTC";

    const filter = opts.filter;
    const filteredShowtimes: readonly ScheduleShowtime[] = filter
      ? filter({ searchId, spec, timezone, showtimes })
      : showtimes;
    const filteredCount = filteredShowtimes.filter((s) => !s.skipFetch).length;

    // S36.6 cumulative gate — serialize on both reservation and provider rows.
    // Compute cumulative = fresh_match_seed + sum(existing schedule_match_count) + filteredCountThisDate
    // and check against 200 and provider headroom (pending_cost + delta <= limit) with
    // FOR UPDATE locks exactly as B6_RECONCILE_STAGE2's pa_locked does.
    // S39.8 (CONTRIBUTING §2) — tolerated cast: undefined handled below (missing reservation → no gate, no fetch filter gate needed); the SELECT projects exactly these four columns.
    const reservationLock = (
      await db.query(
        `SELECT fresh_match_seed, reserved_total, schedule_slot_held, schedule_reconciled FROM admission_reservation WHERE search_id = $1 FOR UPDATE`,
        [searchId],
      )
    ).rows[0] as
      | {
          fresh_match_seed: number;
          reserved_total: string;
          schedule_slot_held: boolean;
          schedule_reconciled: boolean;
        }
      | undefined;
    // Warm path or non-cold search has no reservation — no gate, no fetch filter gate needed.
    // But S36 cold/mixed searches always have a reservation (B1 inserted). If missing, treat as no limit.
    let shouldDeny = false;
    if (reservationLock) {
      const existingSumRow = firstRow(
        (
          await db.query(
            `SELECT COALESCE(SUM(schedule_match_count),0)::integer AS sum FROM run_subscription WHERE search_id = $1 AND schedule_match_count IS NOT NULL`,
            [searchId],
          )
        ).rows,
        "stageScheduleAcceptance",
      );
      requireFields(existingSumRow, "stageScheduleAcceptance", { sum: "number" });
      const existingSum = existingSumRow["sum"] as number;
      // S39.8 (CONTRIBUTING §2) — tolerated cast: undefined handled below (absent provider_admission row → no limit); both fields pass through Number().
      const paLock = (
        await db.query(
          `SELECT pending_cost, pending_cost_limit FROM provider_admission WHERE provider_id = $1 FOR UPDATE`,
          [key.provider_id],
        )
      ).rows[0] as { pending_cost: string; pending_cost_limit: string } | undefined;
      const cumulative = reservationLock.fresh_match_seed + existingSum + filteredCount;
      const durableDelta = cumulative - Number(reservationLock.reserved_total);
      const pendingCost = paLock ? Number(paLock.pending_cost) : 0;
      const pendingLimit = paLock ? Number(paLock.pending_cost_limit) : Number.MAX_SAFE_INTEGER;
      if (cumulative > 200 || pendingCost + durableDelta > pendingLimit) {
        shouldDeny = true;
      }
    }

    if (shouldDeny) {
      // Do not publish any fetch jobs/outbox for this date; record this date's count
      // once (first writer wins, WHERE schedule_match_count IS NULL) then deny.
      await runRows(db, B.B6_SET_SCHEDULE_MATCH_COUNT, [
        fenced.run_key_id,
        searchId,
        filteredCount,
      ]);
      const denied = await runRows(db, B.B6_DENY_CAPACITY, [searchId]);
      if (denied.length > 0) {
        await cancelOrphanedWorkOnDenial(db, searchId);
      }
      await mustWin(db, B.B6_SUBSCRIPTION_OUTCOME, [fenced.run_key_id, searchId, outcome]);
      await mustWin(db, B.B6_SEARCH_RUNNING, [searchId, outcome]);
      expandedFor.push(searchId);
      continue;
    }

    // Gate passed — create filtered fetch work.
    for (const st of filteredShowtimes) {
      if (st.skipFetch) continue;
      const fetchRunKeyId = `k_fetch_${key.provider_id}_${st.showtimeId}`;
      await mustWin(db, B.RUN_KEY_UPSERT, [
        fetchRunKeyId,
        "SHOWTIME_FETCH",
        key.provider_id,
        "seat",
        st.showtimeId,
        null,
        null,
      ]);
      // Warm discovery can subscribe this search to the same showtime before a cold
      // schedule result arrives. B5_FANIN holds the search row lock for this transaction,
      // so this read also serializes concurrent schedule dates for the same search. Keep
      // the existing job instead of creating a second job whose subscription must lose
      // the `(run_key_id, search_id)` key.
      const alreadySubscribed = (
        await db.query(`SELECT 1 FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`, [
          fetchRunKeyId,
          searchId,
        ])
      ).rows;
      if (alreadySubscribed.length > 0) continue;
      const jobId = randomUUID();
      await mustWin(db, B.JOB_CREATE, [
        jobId,
        searchId,
        "SHOWTIME_FETCH",
        fetchRunKeyId,
        subDeadlineAt.toISOString(),
      ]);
      await mustWin(db, B.SUBSCRIPTION_CREATE, [
        fetchRunKeyId,
        searchId,
        jobId,
        subDeadlineAt.toISOString(),
      ]);
      await runRows(db, B.COST_ABUSE_JOIN, [fetchRunKeyId, searchId]);
      await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, null]);
    }

    // Record this date's filtered count once, then attempt search-wide reconciliation
    // only when every planned schedule date is now terminal (including FAILED zeroes).
    await runRows(db, B.B6_SET_SCHEDULE_MATCH_COUNT, [fenced.run_key_id, searchId, filteredCount]);
    // S57 (ADR 0054 decision 2) — progressive cold-date skeleton emission: echo the
    // just-admitted showtimes (the fetch-job-creation loop above is the admission
    // decision; this reuses its `filteredShowtimes` source list, not a second
    // eligibility pass) as `resolved: false` skeleton entries, streamed over the
    // existing B7_SKELETON_EVENT boundary. `admitted: true` unconditionally: this
    // branch has no batch-of-20 slicing, so every `!skipFetch` entry reaching here
    // genuinely has an active SHOWTIME_FETCH job. Entries missing
    // `showDateTimeLocal` are skipped defensively (never emit a malformed entry).
    // No dedup against the existing skeleton: a cold-discovered showtime was by
    // construction invisible at create time, and the client already splits
    // new-vs-existing IDs. Zero rows from the boundary (terminalized/vanished
    // search mid-pass) is a stale-pass no-op, not an error.
    const skeletonEntries = filteredShowtimes
      .filter((st) => !st.skipFetch)
      .flatMap((st) =>
        st.showDateTimeLocal === undefined
          ? []
          : [
              {
                showtimeId: st.showtimeId,
                theatreId: st.theatreId ?? theatreId,
                showDateTimeLocal: st.showDateTimeLocal,
                formatCode: st.formatCode ?? null,
                distanceKm: st.distanceKm ?? null,
                rank: st.dispatchRank ?? 0,
                admitted: true,
                resolved: false,
              },
            ],
      );
    if (skeletonEntries.length > 0) {
      await runRows(db, B.B7_SKELETON_EVENT, [
        searchId,
        JSON.stringify({ scheduleSkeleton: skeletonEntries }),
      ]);
    }

    // Try search-wide reconciliation. Zero rows means not yet all dates terminal or
    // already reconciled — normal. Non-zero means we just moved to the final aggregate.
    // Do not treat zero as error; a follow-up date will retry.
    const reconciled = await runRows(db, B.B6_RECONCILE_SEARCH_WIDE, [key.provider_id, searchId]);
    if (reconciled.length === 0) {
      // If all dates are now terminal (no NULL match counts) but reconciliation still
      // zero-rowed, it must be a headroom/aggregate gate failure — deny for that case.
      // Check terminality to decide whether to deny.
      const pendingCheck = (
        await db.query(
          `SELECT 1 FROM run_subscription rs JOIN run_key rk USING (run_key_id) WHERE rs.search_id = $1 AND rk.kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION') AND rs.schedule_match_count IS NULL LIMIT 1`,
          [searchId],
        )
      ).rows;
      if (pendingCheck.length === 0) {
        // All schedule dates terminal but reconciliation failed -> must be over 200 or headroom.
        // Verify by re-reading reservation to see if still not reconciled and slot held.
        const postCheck = await readReconciliationPostCheck(db, searchId);
        if (postCheck && !postCheck.schedule_reconciled && postCheck.schedule_slot_held) {
          const denied = await runRows(db, B.B6_DENY_CAPACITY, [searchId]);
          if (denied.length > 0) await cancelOrphanedWorkOnDenial(db, searchId);
        }
      }
    }

    await mustWin(db, B.B6_SUBSCRIPTION_OUTCOME, [fenced.run_key_id, searchId, outcome]);
    await mustWin(db, B.B6_SEARCH_RUNNING, [searchId, outcome]);
    expandedFor.push(searchId);
  }

  return { acceptedRevision: rev.accepted_revision, fannedIn: fanIn, expandedFor };
}

/**
 * A movie-first payload spans theatre schedules, but is deliberately sparse: accepting it
 * must write its observed performances without creating a theatre-day cache entry.  Product
 * columns travel with the same atomic acceptance so aggregate readers never observe a
 * base performance without its catalogue data.
 */
export interface MovieScheduleShowtime extends ScheduleShowtime {
  readonly theatreId: string;
  readonly movieTitle: string;
  readonly auditorium: string | null;
  readonly utcOffset: string | null;
  readonly runtimeMinutes: number | null;
  readonly status: string;
  readonly deepLinkUrl: string | null;
  readonly providerMeta: unknown;
}

/**
 * S65 / ADR 0104 movie-first acceptance.  It mirrors the B5/B6 effects of a normal
 * schedule acceptance while using each payload performance's theatre id and intentionally
 * never deriving a `(theatre_id, local_date)` complete schedule cache row.
 */
export async function stageMovieScheduleAcceptance(
  db: SqlClient,
  run: RunHandle,
  showtimes: readonly MovieScheduleShowtime[],
  opts: { readonly capturedAt?: Date; readonly filter?: ScheduleSubscriberFilter } = {},
): Promise<AcceptResult & { readonly expandedFor: string[] }> {
  const capturedAt = (opts.capturedAt ?? new Date()).toISOString();
  const outcome = showtimes.length > 0 ? "RESOLVED" : "EMPTY_RESOLVED";
  const fenced = await mustWin<{
    run_key_id: string;
    observation_id: string;
    provider_epoch: string;
  }>(db, B.B5A_FENCE, [run.runId, run.generation]);
  const key = await mustWin<{
    kind: string;
    provider_id: string;
    route_class: string;
  }>(db, B.B5A_DERIVE_KEY, [fenced.run_key_id]);
  if (key.kind !== "MOVIE_SCHEDULE_RESOLUTION") {
    throw new Error(
      `stageMovieScheduleAcceptance expected MOVIE_SCHEDULE_RESOLUTION, got ${key.kind}`,
    );
  }
  await mustWin(db, B.B5B_EPOCH_FENCE, [key.provider_id, fenced.provider_epoch, key.route_class]);
  await mustWin(db, B.B5C_OBSERVATION, [
    fenced.observation_id,
    fenced.run_key_id,
    run.runId,
    capturedAt,
  ]);

  const keyRow = firstRow(
    (await db.query(`SELECT local_date FROM run_key WHERE run_key_id = $1`, [fenced.run_key_id]))
      .rows,
    "stageMovieScheduleAcceptance",
  );
  requireFields(keyRow, "stageMovieScheduleAcceptance", { local_date: "date" });
  const localDate = keyRow["local_date"] as Date;
  const movies = new Map<string, string>();
  for (const st of showtimes) {
    await mustWin(db, B.B5C_PERFORMANCE, [
      st.showtimeId,
      key.provider_id,
      st.theatreId,
      localDate,
      st.startsAt.toISOString(),
      fenced.observation_id,
      JSON.stringify({}),
    ]);
    movies.set(st.movieId, st.movieTitle);
  }
  for (const [movieId, title] of movies) {
    await mustWin(db, B.MOVIE_UPSERT, [movieId, key.provider_id, title, capturedAt, capturedAt]);
  }
  for (const st of showtimes) {
    await mustWin(db, B.PERFORMANCE_UPDATE_PRODUCT, [
      st.showtimeId,
      st.movieId,
      st.auditorium,
      st.utcOffset,
      st.runtimeMinutes,
      st.status,
      st.formatCode ?? null,
      null,
      st.deepLinkUrl,
      JSON.stringify(st.providerMeta) ?? "{}",
      null,
      capturedAt,
    ]);
  }

  const rev = await mustWin<{ accepted_revision: string }>(db, B.B5D_ACCEPTED_REVISION, [
    fenced.run_key_id,
    fenced.observation_id,
    capturedAt,
  ]);
  const fanIn = await runRows<{ search_id: string; seq: string }>(db, B.B5_FANIN, [
    fenced.run_key_id,
    run.runId,
    key.provider_id,
    key.kind,
    JSON.stringify({ observationId: fenced.observation_id, outcome }),
  ]);

  const observedTheatreIds = new Set(showtimes.map((showtime) => showtime.theatreId));
  const expandedFor: string[] = [];
  for (const row of fanIn) {
    const subscription = firstRow(
      (
        await db.query(
          `SELECT rs.deadline_at, rs.movie_candidate_theatre_ids, s.spec
           FROM run_subscription rs
           JOIN search s ON s.search_id = rs.search_id
           WHERE rs.run_key_id = $1 AND rs.search_id = $2`,
          [fenced.run_key_id, row.search_id],
        )
      ).rows,
      "stageMovieScheduleAcceptance",
    );
    requireFields(subscription, "stageMovieScheduleAcceptance", { deadline_at: "date" });
    const encodedCandidates = subscription["movie_candidate_theatre_ids"];
    if (
      !Array.isArray(encodedCandidates) ||
      encodedCandidates.length === 0 ||
      encodedCandidates.some((candidate) => typeof candidate !== "string")
    ) {
      throw new Error(
        "stageMovieScheduleAcceptance requires a non-empty movie candidate theatre array",
      );
    }
    const candidateTheatreIds = [...new Set(encodedCandidates as string[])];
    const theatreRows = (
      await db.query(
        `SELECT theatre_id, timezone FROM theatre WHERE theatre_id = ANY($1::text[])`,
        [candidateTheatreIds],
      )
    ).rows;
    const timezoneByTheatre = new Map<string, string>();
    for (const theatre of theatreRows) {
      if (
        typeof theatre !== "object" ||
        theatre === null ||
        typeof (theatre as Record<string, unknown>)["theatre_id"] !== "string" ||
        typeof (theatre as Record<string, unknown>)["timezone"] !== "string"
      ) {
        throw new Error("stageMovieScheduleAcceptance received an invalid theatre row");
      }
      const values = theatre as Record<string, unknown>;
      timezoneByTheatre.set(values["theatre_id"] as string, values["timezone"] as string);
    }
    if (timezoneByTheatre.size !== candidateTheatreIds.length) {
      throw new Error("stageMovieScheduleAcceptance candidate theatre has no catalogue row");
    }

    const candidateSet = new Set(candidateTheatreIds);
    const filteredShowtimes: ScheduleShowtime[] = [];
    for (const theatreId of candidateTheatreIds) {
      const forTheatre = showtimes.filter(
        (showtime) => showtime.theatreId === theatreId && candidateSet.has(showtime.theatreId),
      );
      const timezone = timezoneByTheatre.get(theatreId)!;
      const filtered = opts.filter
        ? opts.filter({
            searchId: row.search_id,
            spec: subscription["spec"] ?? null,
            timezone,
            showtimes: forTheatre,
          })
        : forTheatre;
      filteredShowtimes.push(...filtered);
    }
    const filteredCount = filteredShowtimes.filter((showtime) => !showtime.skipFetch).length;

    const reservationLock = (
      await db.query(
        `SELECT fresh_match_seed, reserved_total, schedule_slot_held, schedule_reconciled
         FROM admission_reservation WHERE search_id = $1 FOR UPDATE`,
        [row.search_id],
      )
    ).rows[0] as
      | {
          fresh_match_seed: number;
          reserved_total: string;
          schedule_slot_held: boolean;
          schedule_reconciled: boolean;
        }
      | undefined;
    let shouldDeny = false;
    if (reservationLock !== undefined) {
      const existingSumRow = firstRow(
        (
          await db.query(
            `SELECT COALESCE(SUM(schedule_match_count),0)::integer AS sum
             FROM run_subscription
             WHERE search_id = $1 AND schedule_match_count IS NOT NULL`,
            [row.search_id],
          )
        ).rows,
        "stageMovieScheduleAcceptance",
      );
      requireFields(existingSumRow, "stageMovieScheduleAcceptance", { sum: "number" });
      const paLock = (
        await db.query(
          `SELECT pending_cost, pending_cost_limit
           FROM provider_admission WHERE provider_id = $1 FOR UPDATE`,
          [key.provider_id],
        )
      ).rows[0] as { pending_cost: string; pending_cost_limit: string } | undefined;
      const cumulative =
        reservationLock.fresh_match_seed + (existingSumRow["sum"] as number) + filteredCount;
      const durableDelta = cumulative - Number(reservationLock.reserved_total);
      if (
        cumulative > 200 ||
        (paLock !== undefined &&
          Number(paLock.pending_cost) + durableDelta > Number(paLock.pending_cost_limit))
      ) {
        shouldDeny = true;
      }
    }

    if (shouldDeny) {
      await runRows(db, B.B6_SET_SCHEDULE_MATCH_COUNT, [
        fenced.run_key_id,
        row.search_id,
        filteredCount,
      ]);
      const denied = await runRows(db, B.B6_DENY_CAPACITY, [row.search_id]);
      if (denied.length > 0) await cancelOrphanedWorkOnDenial(db, row.search_id);
      await mustWin(db, B.B6_SUBSCRIPTION_OUTCOME, [fenced.run_key_id, row.search_id, outcome]);
      await mustWin(db, B.B6_SEARCH_RUNNING, [row.search_id, outcome]);
      expandedFor.push(row.search_id);
      continue;
    }

    const deadline = (subscription["deadline_at"] as Date).toISOString();
    for (const st of filteredShowtimes) {
      if (st.skipFetch) continue;
      const fetchRunKeyId = `k_fetch_${key.provider_id}_${st.showtimeId}`;
      await mustWin(db, B.RUN_KEY_UPSERT, [
        fetchRunKeyId,
        "SHOWTIME_FETCH",
        key.provider_id,
        "seat",
        st.showtimeId,
        null,
        null,
      ]);
      const alreadySubscribed = (
        await db.query(`SELECT 1 FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`, [
          fetchRunKeyId,
          row.search_id,
        ])
      ).rows;
      if (alreadySubscribed.length > 0) continue;
      const jobId = randomUUID();
      await mustWin(db, B.JOB_CREATE, [
        jobId,
        row.search_id,
        "SHOWTIME_FETCH",
        fetchRunKeyId,
        deadline,
      ]);
      await mustWin(db, B.SUBSCRIPTION_CREATE, [fetchRunKeyId, row.search_id, jobId, deadline]);
      await runRows(db, B.COST_ABUSE_JOIN, [fetchRunKeyId, row.search_id]);
      await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, null]);
    }

    // AMC's nearby payload can omit outlier theatres.  Only absent theatres fall back;
    // a theatre represented by an empty group is a successful zero-showtime observation.
    for (const theatreId of candidateTheatreIds) {
      if (observedTheatreIds.has(theatreId)) continue;
      const fallbackRunKeyId = `k_sched_${key.provider_id}_${theatreId}_${localDate
        .toISOString()
        .slice(0, 10)}`;
      await mustWin(db, B.RUN_KEY_UPSERT, [
        fallbackRunKeyId,
        "SCHEDULE_RESOLUTION",
        key.provider_id,
        "schedule",
        null,
        theatreId,
        localDate,
      ]);
      const alreadySubscribed = (
        await db.query(`SELECT 1 FROM run_subscription WHERE run_key_id = $1 AND search_id = $2`, [
          fallbackRunKeyId,
          row.search_id,
        ])
      ).rows;
      if (alreadySubscribed.length > 0) continue;
      const jobId = randomUUID();
      await mustWin(db, B.JOB_CREATE, [
        jobId,
        row.search_id,
        "SCHEDULE_RESOLUTION",
        fallbackRunKeyId,
        deadline,
      ]);
      await mustWin(db, B.SUBSCRIPTION_CREATE, [fallbackRunKeyId, row.search_id, jobId, deadline]);
      await runRows(db, B.COST_ABUSE_JOIN, [fallbackRunKeyId, row.search_id]);
      await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, null]);
    }

    await runRows(db, B.B6_SET_SCHEDULE_MATCH_COUNT, [
      fenced.run_key_id,
      row.search_id,
      filteredCount,
    ]);
    const reconciled = await runRows(db, B.B6_RECONCILE_SEARCH_WIDE, [
      key.provider_id,
      row.search_id,
    ]);
    if (reconciled.length === 0) {
      const pendingSchedule = (
        await db.query(
          `SELECT 1 FROM run_subscription rs
           JOIN run_key rk USING (run_key_id)
           WHERE rs.search_id = $1
             AND rk.kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION')
             AND rs.schedule_match_count IS NULL
           LIMIT 1`,
          [row.search_id],
        )
      ).rows;
      if (pendingSchedule.length === 0) {
        const postCheck = await readReconciliationPostCheck(db, row.search_id);
        if (postCheck && !postCheck.schedule_reconciled && postCheck.schedule_slot_held) {
          const denied = await runRows(db, B.B6_DENY_CAPACITY, [row.search_id]);
          if (denied.length > 0) await cancelOrphanedWorkOnDenial(db, row.search_id);
        }
      }
    }
    await mustWin(db, B.B6_SUBSCRIPTION_OUTCOME, [fenced.run_key_id, row.search_id, outcome]);
    await mustWin(db, B.B6_SEARCH_RUNNING, [row.search_id, outcome]);
    expandedFor.push(row.search_id);
  }

  return { acceptedRevision: rev.accepted_revision, fannedIn: fanIn, expandedFor };
}

/**
 * B5(a)–(f) for a SCHEDULE_RESOLUTION run, in one transaction, exactly as the ADR
 * sequences it — the schedule counterpart of `acceptFetch`, wrapping
 * `stageScheduleAcceptance` in BEGIN/COMMIT/ROLLBACK.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above; this
 * function composes `BEGIN`/`COMMIT`/`ROLLBACK` the same way and has the same hazard.
 */
export async function acceptSchedule(
  db: TransactionClient,
  run: RunHandle,
  showtimes: readonly ScheduleShowtime[],
  opts: {
    readonly capturedAt?: Date;
    readonly stage1Share?: number;
    readonly filter?: ScheduleSubscriberFilter;
  } = {},
): Promise<AcceptResult & { readonly expandedFor: string[] }> {
  await db.query("BEGIN");
  try {
    const result = await stageScheduleAcceptance(db, run, showtimes, opts);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/** B5F(a)+(b)(c) — failure acceptance for a run whose caller already knows it has failed
 * (e.g. it self-reports attempts exhausted while it still holds the lease). For the
 * sweeper's own discovery of exhausted, LEASED-but-abandoned runs, see
 * `sweepFailExhaustedRuns` below — that path cannot supply `generation` from a caller.
 * S36: on SCHEDULE_RESOLUTION failures, the failed date contributes 0 to the durable
 * aggregate via `schedule_match_count = 0` (distinct from EMPTY_RESOLVED 0) and the
 * same all-terminal reconciliation/denial as the accepted path is attempted.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above; this function
 * composes `BEGIN`/`COMMIT`/`ROLLBACK` the same way and has the same hazard. */
export async function failRun(
  db: TransactionClient,
  run: RunHandle,
  cause: string,
  maxAttempts: number,
): Promise<{ affected: { search_id: string; seq: string }[] } | null> {
  await db.query("BEGIN");
  try {
    const fence = await db.query(B.B5F_FENCE.text, [run.runId, run.generation, cause, maxAttempts]);
    if (fence.rows.length === 0) {
      await db.query("ROLLBACK");
      return null;
    }
    // S39.8 (CONTRIBUTING §2) — tolerated cast: behind the rows.length === 0 fence above; B5F_FENCE's RETURNING enumerates run_key_id.
    const runKeyId = (fence.rows[0] as { run_key_id: string }).run_key_id;
    const key = await mustWin<{ kind: string; provider_id: string }>(db, B.B5A_DERIVE_KEY, [
      runKeyId,
    ]);
    const effects = await runRows<{ search_id: string; seq: string }>(db, B.B5F_EFFECTS, [
      runKeyId,
      key.kind,
      cause,
      key.provider_id,
      JSON.stringify({ cause }),
    ]);
    // S36: every affected schedule subscription must durably record its zero count and
    // participate in the search-wide all-terminal check, exactly as the accepted path does.
    if (key.kind === "SCHEDULE_RESOLUTION" || key.kind === "MOVIE_SCHEDULE_RESOLUTION") {
      for (const a of effects) {
        await runRows(db, B.B6_SET_SCHEDULE_MATCH_COUNT, [runKeyId, a.search_id, 0]);
        const reconciled = await runRows(db, B.B6_RECONCILE_SEARCH_WIDE, [
          key.provider_id,
          a.search_id,
        ]);
        if (reconciled.length === 0) {
          const pendingCheck = (
            await db.query(
              `SELECT 1 FROM run_subscription rs JOIN run_key rk USING (run_key_id) WHERE rs.search_id = $1 AND rk.kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION') AND rs.schedule_match_count IS NULL LIMIT 1`,
              [a.search_id],
            )
          ).rows;
          if (pendingCheck.length === 0) {
            const postCheck = await readReconciliationPostCheck(db, a.search_id);
            if (postCheck && !postCheck.schedule_reconciled && postCheck.schedule_slot_held) {
              const denied = await runRows(db, B.B6_DENY_CAPACITY, [a.search_id]);
              if (denied.length > 0) await cancelOrphanedWorkOnDenial(db, a.search_id);
            }
          }
        }
      }
    }
    await db.query("COMMIT");
    return { affected: effects };
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export interface DenialCleanup {
  readonly cancelledJobIds: string[];
  readonly expiredRunKeyIds: string[];
  readonly voidedOutboxIds: string[];
}

/**
 * Defect 2 — cancel-on-denial. Call immediately after `B6_DENY_CAPACITY` succeeds, in the
 * SAME transaction as the expansion + `B6_RECONCILE_STAGE2` that preceded it (that
 * ordering is decided and unchanged; see `B6_VOID_ORPHANED_OUTBOX`'s comment in
 * boundaries.ts). Order here is load-bearing the same way B8's is: jobs are cancelled
 * before subscriptions are expired (so a job the sweeper is mid-re-arming still finds its
 * subscription LIVE and gets cancelled cleanly rather than racing a state neither step
 * alone would resolve), and outbox is voided last, once nothing can re-arm a cancelled job
 * back onto the queue.
 */
export async function cancelOrphanedWorkOnDenial(
  db: SqlClient,
  searchId: string,
): Promise<DenialCleanup> {
  const cancelledJobs = await runRows<{ job_id: string }>(db, B.B8_CANCEL_JOBS, [searchId]);
  const expiredSubs = await runRows<{ run_key_id: string }>(db, B.B8_EXPIRE_SUBSCRIPTIONS, [
    searchId,
  ]);
  const voidedOutbox = await runRows<{ outbox_id: string }>(db, B.B6_VOID_ORPHANED_OUTBOX, [
    searchId,
  ]);
  return {
    cancelledJobIds: cancelledJobs.map((r) => r.job_id),
    expiredRunKeyIds: expiredSubs.map((r) => r.run_key_id),
    voidedOutboxIds: voidedOutbox.map((r) => r.outbox_id),
  };
}

/**
 * S39.7 — the B6 reconciliation post-check read, previously duplicated verbatim at the
 * three denial tails (`stageScheduleAcceptance`, `failRun`, `sweepFailExhaustedJobs`):
 * after a zero-row search-wide reconcile with every schedule date terminal, re-read the
 * reservation to see whether it is still unreconciled while holding its slot — the
 * signature of an aggregate/headroom gate failure that must deny. `undefined` when no
 * reservation row exists (warm path / non-cold search): every caller treats that as "no
 * denial evidence", so undefined stays part of the contract. Fields are validated through
 * the S39.1 guards when the row exists; the query text is unchanged, and being a read it
 * does not become a boundary statement.
 */
async function readReconciliationPostCheck(
  db: SqlClient,
  searchId: string,
): Promise<{ schedule_reconciled: boolean; schedule_slot_held: boolean } | undefined> {
  const rows = (
    await db.query(
      `SELECT schedule_reconciled, schedule_slot_held FROM admission_reservation WHERE search_id = $1`,
      [searchId],
    )
  ).rows;
  if (rows.length === 0) {
    return undefined;
  }
  const row = firstRow(rows, "readReconciliationPostCheck");
  requireFields(row, "readReconciliationPostCheck", {
    schedule_reconciled: "boolean",
    schedule_slot_held: "boolean",
  });
  return {
    schedule_reconciled: row["schedule_reconciled"] as boolean,
    schedule_slot_held: row["schedule_slot_held"] as boolean,
  };
}

export interface TerminalState {
  readonly status: string;
  readonly cause: string | null;
}

export interface TerminalizeOptions {
  /**
   * The aggregator's immutable result, built only after B8 has derived status and cause
   * from the locked rows. Optional in signature, but HARD-REQUIRED in effect since
   * S6U3.1: the payload must carry an `answer` field whose value is the non-null
   * `deriveRankedAnswer` return for the search's terminal facts — a terminal status
   * must never persist without a revealable answer (ADR 0012's reveal rule made
   * unconditional). `stageTerminalization` throws when it is absent or malformed.
   */
  readonly resultPayload?: (terminal: TerminalState) => unknown;
}

const EMPTY_CAUSES = [
  "CAPACITY",
  "HALTED",
  "NO_SHAPE_MATCH",
  "PARTIAL_SCHEDULE",
  "SOLD_OUT",
  "TOO_FEW_SHOWTIMES",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * S6U3.1 — structural answer extraction. `resultPayload` is `unknown` at this layer by
 * design (ADR 0009's dependency boundary, preserved by S15.13): no `@seatfirst/core`
 * schema may land here, so the gate validates against `lifecycle.ts`'s own `RankedAnswer`
 * shape instead — mode must be one of the three discriminants and every required field
 * must be present. Absent or malformed → throw, before any write executes.
 */
function extractRankedAnswer(resultPayload: unknown): RankedAnswer {
  if (!isRecord(resultPayload)) {
    throw new Error(
      "stageTerminalization requires a resultPayload object whose `answer` is the " +
        "deriveRankedAnswer return for the search's terminal facts (S6U3.1)",
    );
  }
  const answer = resultPayload["answer"];
  if (!isRecord(answer)) {
    throw new Error(
      "resultPayload.answer is missing or not an object: a terminal status must never " +
        "persist without a revealable answer (S6U3.1)",
    );
  }
  const { mode } = answer;
  if (mode === "CONFIDENT") {
    if (!isRecord(answer["primary"]) || !Array.isArray(answer["otherFormats"])) {
      throw new Error("resultPayload.answer (CONFIDENT) is missing `primary` or `otherFormats`");
    }
  } else if (mode === "HEDGED") {
    const alternatives = answer["alternatives"];
    if (
      !Array.isArray(alternatives) ||
      (alternatives.length !== 2 && alternatives.length !== 3) ||
      !Array.isArray(answer["otherFormats"])
    ) {
      throw new Error(
        "resultPayload.answer (HEDGED) needs two or three `alternatives` plus `otherFormats`",
      );
    }
  } else if (mode === "EMPTY") {
    if (
      typeof answer["cause"] !== "string" ||
      !(EMPTY_CAUSES as readonly string[]).includes(answer["cause"]) ||
      !Array.isArray(answer["suggestions"])
    ) {
      throw new Error(
        "resultPayload.answer (EMPTY) needs a `cause` from the EmptyCause vocabulary plus `suggestions`",
      );
    }
  } else {
    throw new Error(
      `resultPayload.answer.mode must be CONFIDENT, HEDGED, or EMPTY — got ${String(mode)}`,
    );
  }
  return answer as RankedAnswer;
}

/**
 * S6U3.1 — the write side of A8: the persisted reveal must satisfy the same
 * status↔answer agreement `RevealPayloadSchema` enforces at delivery (PARTIAL never
 * CONFIDENT; HALTED only `EMPTY:HALTED`/`EMPTY:CAPACITY`; COMPLETE-EMPTY only a
 * complete-coverage cause or — per ADR 0009's widened guard — `HALTED`). A mismatched
 * pair throws before any write, so a reveal-invalid answer can never persist.
 */
function assertAnswerRevealable(status: string, answer: RankedAnswer): void {
  if (status === "PARTIAL") {
    const allowed =
      answer.mode === "HEDGED" ||
      (answer.mode === "EMPTY" &&
        (answer.cause === "HALTED" ||
          answer.cause === "NO_SHAPE_MATCH" ||
          answer.cause === "PARTIAL_SCHEDULE"));
    if (!allowed) {
      throw new Error(
        `a PARTIAL search cannot reveal ${answer.mode}${answer.mode === "EMPTY" ? `:${answer.cause}` : ""} (A8)`,
      );
    }
    return;
  }
  if (status === "HALTED") {
    const allowed =
      answer.mode === "EMPTY" && (answer.cause === "HALTED" || answer.cause === "CAPACITY");
    if (!allowed) {
      throw new Error(`a HALTED search can reveal only EMPTY:HALTED or EMPTY:CAPACITY (A8)`);
    }
    return;
  }
  if (status === "COMPLETE") {
    if (answer.mode !== "EMPTY") return;
    const allowed =
      answer.cause === "SOLD_OUT" ||
      answer.cause === "TOO_FEW_SHOWTIMES" ||
      answer.cause === "NO_SHAPE_MATCH" ||
      answer.cause === "HALTED";
    if (!allowed) {
      throw new Error(
        `a COMPLETE search cannot reveal EMPTY:${answer.cause} (complete-coverage causes only, plus ADR 0009's HALTED)`,
      );
    }
    return;
  }
  if (status === "CANCELLED") {
    const allowed =
      answer.mode === "HEDGED" ||
      (answer.mode === "EMPTY" && (answer.cause === "HALTED" || answer.cause === "NO_SHAPE_MATCH"));
    if (!allowed) {
      throw new Error(
        `a CANCELLED search can reveal only HEDGED, EMPTY:HALTED, or EMPTY:NO_SHAPE_MATCH (ADR 0018)`,
      );
    }
    return;
  }
  throw new Error(`no answer-matrix row for terminal status ${status}`);
}

/** B8's same-transaction body — release→clear-slots and expire-subs→cancel-orphaned-runs
 * are ordering-dependent, so this is the one place that order is written down. Exposed
 * separately (no BEGIN/COMMIT) so crash tests can control the COMMIT. */
export async function stageTerminalization(
  db: SqlClient,
  searchId: string,
  aggGeneration: number,
  aggRequestedRev: string,
  opts: TerminalizeOptions = {},
): Promise<TerminalState | null> {
  const terminal = await db.query(B.B8_TERMINALIZE.text, [
    searchId,
    aggGeneration,
    aggRequestedRev,
  ]);
  if (terminal.rows.length === 0) return null;

  // S39.8 (CONTRIBUTING §2) — tolerated cast: behind the rows.length === 0 fence above; B8_TERMINALIZE's RETURNING enumerates these columns.
  const { next_seq, status, terminal_cause } = terminal.rows[0] as {
    next_seq: string;
    status: string;
    terminal_cause: string | null;
  };
  const state: TerminalState = { status, cause: terminal_cause };
  const resultPayload = opts.resultPayload?.(state);
  // S6U3.1: extract and gate the answer BEFORE any write — absent or malformed throws,
  // and the throw must precede B8_RESULT_VERSION so no write ever precedes it (swap
  // these two statements and a terminal status could persist without a revealable
  // answer).
  const answer = extractRankedAnswer(resultPayload);
  assertAnswerRevealable(status, answer);
  await mustWin(db, B.B8_RESULT_VERSION, [searchId, JSON.stringify(resultPayload)]);
  await runRows(db, B.B8_CANCEL_JOBS, [searchId]);
  await runRows(db, B.B8_EXPIRE_SUBSCRIPTIONS, [searchId]);
  await runRows(db, B.B8_RELEASE_ADMISSION, [searchId]);
  await runRows(db, B.B8_CLEAR_SCHEDULE_SLOTS, [searchId]);
  await runRows(db, B.B8_MARK_RESERVATION_RELEASED, [searchId]);
  await runRows(db, B.B8_CANCEL_ORPHANED_RUNS, [searchId]);
  await mustWin(db, B.B8_TERMINAL_EVENT, [
    searchId,
    next_seq,
    "SEARCH_TERMINAL",
    JSON.stringify({ status, cause: terminal_cause, answer }),
  ]);
  return state;
}

/**
 * S27.10 — claim-less terminalization: the `terminalize()` body minus the claim. The
 * caller (the AGGREGATE dispatch handler) already holds the B7 claim the consumer
 * acquired before invoking it, so the claim values are passed in rather than acquired
 * here — a second `B7_CLAIM` inside the handler would fence it out (`boundaries.ts`
 * B7_CLAIM). `BEGIN` → `stageTerminalization` → `ROLLBACK`-and-return-null on zero rows →
 * else `COMMIT` + `B7_RELEASE`. `B7_RELEASE` stays AFTER `COMMIT`, exactly as in
 * `terminalize()`: releasing inside the transaction would publish an aggregate the fence
 * could still discard.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above.
 */
export async function terminalizeClaimed(
  db: TransactionClient,
  searchId: string,
  aggGeneration: number,
  aggRequestedRev: string,
  opts: TerminalizeOptions = {},
): Promise<TerminalState | null> {
  await db.query("BEGIN");
  try {
    const state = await stageTerminalization(db, searchId, aggGeneration, aggRequestedRev, opts);
    if (!state) {
      await db.query("ROLLBACK");
      return null;
    }
    await db.query("COMMIT");
    await runRows(db, B.B7_RELEASE, [searchId, aggRequestedRev, aggGeneration]);
    return state;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/**
 * B7 claim → B8 terminalization and its same-transaction tail. Returns the derived status.
 * Extraction-only delegate to `terminalizeClaimed` (S27.10): the claim is acquired here,
 * then the claim-less body runs. Behavior is byte-identical to before the refactor — the
 * existing tier-2 tests (`tier2.effects.test.ts`) pass unmodified.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above; this function
 * composes `BEGIN`/`COMMIT`/`ROLLBACK` the same way and has the same hazard.
 */
export async function terminalize(
  db: TransactionClient,
  searchId: string,
  opts: TerminalizeOptions = {},
): Promise<TerminalState | null> {
  const claim = await db.query(B.B7_CLAIM.text, [searchId, "1 minute"]);
  if (claim.rows.length === 0) return null;
  // S39.8 (CONTRIBUTING §2) — tolerated cast: behind the claim zero-row fence above; B7_CLAIM's RETURNING enumerates these fields.
  const { agg_generation, agg_requested_rev } = claim.rows[0] as {
    agg_generation: number;
    agg_requested_rev: string;
  };
  return terminalizeClaimed(db, searchId, agg_generation, agg_requested_rev, opts);
}

export interface CancelState {
  readonly status: "CANCELLED";
  readonly cause: null;
}

/**
 * S23.3 — the CANCELLED transition and its same-transaction tail, mirroring
 * `stageTerminalization` exactly (B8_RESULT_VERSION → cancel jobs → expire subs →
 * release admission → clear slots → mark reservation released → cancel orphaned runs →
 * B8_TERMINAL_EVENT). There is no B7_CLAIM/B7_RELEASE: cancel is user-initiated and
 * claimless — the single fenced `B8_CANCEL_SEARCH` UPDATE is the ownership mechanism.
 * `resultPayload` is composed by the caller (the route) from frozen pre-cancel facts via
 * `deriveRankedAnswer`, and is gated by the same S6U3.1 reveal check; a CANCELLED search
 * may reveal HEDGED, EMPTY:HALTED, or EMPTY:NO_SHAPE_MATCH only (ADR 0018). Exposed
 * separately (no BEGIN/COMMIT) for crash tests. Returns null when the search is already
 * terminal (zero-row fence — an idempotent no-op, S23.5).
 */
export async function stageSearchCancellation(
  db: SqlClient,
  searchId: string,
  opts: TerminalizeOptions = {},
): Promise<CancelState | null> {
  const transition = await db.query(B.B8_CANCEL_SEARCH.text, [searchId]);
  if (transition.rows.length === 0) return null;

  // S39.8 (CONTRIBUTING §2) — tolerated cast: behind the zero-row fence above; B8_CANCEL_SEARCH's RETURNING enumerates next_seq.
  const { next_seq } = transition.rows[0] as { next_seq: string };
  const state: CancelState = { status: "CANCELLED", cause: null };
  const resultPayload = opts.resultPayload?.(state);
  const answer = extractRankedAnswer(resultPayload);
  assertAnswerRevealable("CANCELLED", answer);
  await mustWin(db, B.B8_RESULT_VERSION, [searchId, JSON.stringify(resultPayload)]);
  await runRows(db, B.B8_CANCEL_JOBS, [searchId]);
  await runRows(db, B.B8_EXPIRE_SUBSCRIPTIONS, [searchId]);
  await runRows(db, B.B8_RELEASE_ADMISSION, [searchId]);
  await runRows(db, B.B8_CLEAR_SCHEDULE_SLOTS, [searchId]);
  await runRows(db, B.B8_MARK_RESERVATION_RELEASED, [searchId]);
  await runRows(db, B.B8_CANCEL_ORPHANED_RUNS, [searchId]);
  await mustWin(db, B.B8_TERMINAL_EVENT, [
    searchId,
    next_seq,
    "SEARCH_TERMINAL",
    JSON.stringify({ status: "CANCELLED", cause: null, answer }),
  ]);
  return state;
}

/**
 * S23.3 — the durable transaction for an explicit user cancel. Composes
 * `BEGIN`/`COMMIT`/`ROLLBACK` like `terminalize`; REQUIRES a single-connection `db`.
 * Returns `{ status: 'CANCELLED', cause: null }` on success or null when the search was
 * already terminal (idempotent no-op).
 */
export async function cancelSearch(
  db: TransactionClient,
  searchId: string,
  opts: TerminalizeOptions = {},
): Promise<CancelState | null> {
  await db.query("BEGIN");
  try {
    const state = await stageSearchCancellation(db, searchId, opts);
    if (!state) {
      await db.query("ROLLBACK");
      return null;
    }
    await db.query("COMMIT");
    return state;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export interface FailedExhaustedRun {
  readonly runId: string;
  readonly affected: { search_id: string; seq: string }[];
}

/**
 * Defect-1 remediation: discovers `LEASED` runs whose lease has expired AND whose
 * attempts are exhausted (`SWEEP_RECLAIM_RUNS` deliberately excludes these — see its
 * comment), then routes each through the SAME B5F effects a self-reported failure would
 * use. One transaction per run: `B5F_FENCE` re-checks `generation`/`state`/`attempt` at
 * the moment of failing, so a run whose lease was renewed (or which another sweep pass
 * already failed) between discovery and this call simply loses the fence and is skipped,
 * never double-processed.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above; this function
 * calls `failRun`, which composes `BEGIN`/`COMMIT`/`ROLLBACK` the same way and has the same
 * hazard, once per candidate run.
 */
export async function sweepFailExhaustedRuns(
  db: TransactionClient,
  maxAttempts: number,
  cause = "ATTEMPTS_EXHAUSTED",
): Promise<FailedExhaustedRun[]> {
  const candidates = await runRows<{ run_id: string; generation: number }>(
    db,
    B.SWEEP_DISCOVER_EXHAUSTED_RUNS,
    [maxAttempts],
  );
  const results: FailedExhaustedRun[] = [];
  for (const row of candidates) {
    const outcome = await failRun(
      db,
      { runId: row.run_id, generation: row.generation },
      cause,
      maxAttempts,
    );
    if (outcome) results.push({ runId: row.run_id, affected: outcome.affected });
  }
  return results;
}

export interface FailedExhaustedJob {
  readonly jobId: string;
  readonly affected: { search_id: string; seq: string }[];
}

/**
 * Job-side counterpart of `sweepFailExhaustedRuns`. A `search_job` row is one search's own
 * subscription — it has no other subscribers — so its exhaustion needs exactly that
 * subscription failed, not the run-wide B5F fan-out. One transaction per job:
 * `SWEEP_FAIL_EXHAUSTED_JOB` re-checks state/lease/attempt at the moment of failing, same
 * discipline as the run path.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above. This function
 * opens and commits a fresh `BEGIN`/`COMMIT` per candidate job, so the hazard applies on
 * every iteration, not just once.
 */
export async function sweepFailExhaustedJobs(
  db: TransactionClient,
  maxAttempts: number,
  cause = "ATTEMPTS_EXHAUSTED",
): Promise<FailedExhaustedJob[]> {
  const candidates = await runRows<{ job_id: string }>(db, B.SWEEP_DISCOVER_EXHAUSTED_JOBS, [
    maxAttempts,
  ]);
  const results: FailedExhaustedJob[] = [];
  for (const row of candidates) {
    await db.query("BEGIN");
    try {
      const fence = await db.query(B.SWEEP_FAIL_EXHAUSTED_JOB.text, [
        row.job_id,
        maxAttempts,
        cause,
      ]);
      if (fence.rows.length === 0) {
        await db.query("ROLLBACK");
        continue;
      }
      // S39.8 (CONTRIBUTING §2) — tolerated cast: behind the rows.length === 0 fence above; SWEEP_FAIL_EXHAUSTED_JOB's RETURNING enumerates these fields.
      const { search_id: searchId, run_key_id: runKeyId } = fence.rows[0] as {
        search_id: string;
        run_key_id: string;
      };
      const key = await mustWin<{ kind: string; provider_id: string }>(db, B.B5A_DERIVE_KEY, [
        runKeyId,
      ]);
      const effects = await runRows<{ search_id: string; seq: string }>(
        db,
        B.SWEEP_JOB_FAIL_EFFECTS,
        [runKeyId, searchId, key.kind, key.provider_id, JSON.stringify({ cause })],
      );
      // S36: failed schedule job contributes zero to durable aggregate, same as direct failRun.
      if (key.kind === "SCHEDULE_RESOLUTION" || key.kind === "MOVIE_SCHEDULE_RESOLUTION") {
        await runRows(db, B.B6_SET_SCHEDULE_MATCH_COUNT, [runKeyId, searchId, 0]);
        const reconciled = await runRows(db, B.B6_RECONCILE_SEARCH_WIDE, [
          key.provider_id,
          searchId,
        ]);
        if (reconciled.length === 0) {
          const pendingCheck = (
            await db.query(
              `SELECT 1 FROM run_subscription rs JOIN run_key rk USING (run_key_id) WHERE rs.search_id = $1 AND rk.kind IN ('SCHEDULE_RESOLUTION','MOVIE_SCHEDULE_RESOLUTION') AND rs.schedule_match_count IS NULL LIMIT 1`,
              [searchId],
            )
          ).rows;
          if (pendingCheck.length === 0) {
            const postCheck = await readReconciliationPostCheck(db, searchId);
            if (postCheck && !postCheck.schedule_reconciled && postCheck.schedule_slot_held) {
              const denied = await runRows(db, B.B6_DENY_CAPACITY, [searchId]);
              if (denied.length > 0) await cancelOrphanedWorkOnDenial(db, searchId);
            }
          }
        }
      }
      await db.query("COMMIT");
      results.push({ jobId: row.job_id, affected: effects });
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    }
  }
  return results;
}

/* ------------------------------------------- provider control (ADR 0001 B9, amended) */

/**
 * The closed set of provider-control triggers. Callers supply one of these, never raw
 * `{ state, routeClass, cause }` triples: the persisted scope, state, and deadline are
 * DERIVED from the trigger (S5.1). `CORRIDOR_GUARD_DRIFT` is deliberately NOT a member —
 * safe corridor drift mutates no provider status or fence, and it must be structurally
 * unable to reach the traffic-control entry point (T41). `RATE_LIMITED` requires a
 * concrete `notBefore`; a validated `PARSER_SCHEMA_INCOMPATIBLE` is an indefinite scoped
 * pause (S5.3).
 */
export type ProviderControlTrigger =
  | { readonly kind: "UPSTREAM_BLOCKED" }
  | { readonly kind: "CHALLENGE_REQUIRED" }
  | { readonly kind: "UPSTREAM_QUEUED" }
  | { readonly kind: "LEGAL_KILL_SWITCH" }
  | { readonly kind: "RATE_LIMITED"; readonly routeClass: string; readonly notBefore: Date }
  | { readonly kind: "PARSER_SCHEMA_INCOMPATIBLE"; readonly routeClass: string };

export interface ProviderControlOutcome {
  readonly providerId: string;
  /** The persisted scope: the empty route class for every provider-wide halt. */
  readonly routeClass: string;
  readonly state: "HALTED" | "PAUSED";
  readonly cause: string;
  /** The provider fence epoch after this transition — every acceptance must carry it. */
  readonly epoch: string;
  readonly fencedJobIds: readonly string[];
  readonly fencedRunIds: readonly string[];
  readonly aggregatedSearchIds: readonly string[];
}

interface DerivedControlTransition {
  readonly routeClass: string;
  readonly state: "HALTED" | "PAUSED";
  readonly cause: string;
  readonly notBefore: Date | null;
}

/** The ADR 0001 B9 mapping, exhaustive: the trigger IS the persisted scope/state/deadline. */
function deriveControlTransition(trigger: ProviderControlTrigger): DerivedControlTransition {
  switch (trigger.kind) {
    case "UPSTREAM_BLOCKED":
    case "CHALLENGE_REQUIRED":
    case "UPSTREAM_QUEUED":
    case "LEGAL_KILL_SWITCH":
      // The four halt triggers cannot accept a route class from their caller: the empty
      // route class is derived here, so one Queue-it waiting result halts every route.
      return { routeClass: "", state: "HALTED", cause: trigger.kind, notBefore: null };
    case "RATE_LIMITED":
      return {
        routeClass: trigger.routeClass,
        state: "PAUSED",
        cause: "RATE_LIMITED",
        notBefore: trigger.notBefore,
      };
    case "PARSER_SCHEMA_INCOMPATIBLE":
      return {
        routeClass: trigger.routeClass,
        state: "PAUSED",
        cause: "PARSER_SCHEMA_INCOMPATIBLE",
        notBefore: null,
      };
    default: {
      const never: never = trigger;
      throw new Error(`unknown provider-control trigger: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * B9's halt/pause body without BEGIN/COMMIT — exposed separately so crash tests can kill
 * Order is load-bearing: the fence bump precedes the status write. If the status write
 * went first, a crash between the two would persist the new status under the OLD epoch,
 * and an acceptance that already passed B5(b) with that epoch could commit against a
 * provider this transaction meant to fence off. Bumping first means a lost status write
 * leaves the old state under a raised epoch, which fails closed at B4/B5(b) until a
 * manual reopen.
 */
export async function stageProviderControlTransition(
  db: SqlClient,
  providerId: string,
  trigger: ProviderControlTrigger,
): Promise<ProviderControlOutcome> {
  const derived = deriveControlTransition(trigger);
  const fenced = await mustWin<{ epoch: string }>(db, B.B9_BUMP_FENCE, [providerId]);
  await mustWin(db, B.B9_UPSERT_STATUS, [
    providerId,
    derived.routeClass,
    derived.state,
    derived.cause,
    derived.notBefore ? derived.notBefore.toISOString() : null,
  ]);
  // Leased work on the provider loses its fences so running workers abort via B3; zero
  // rows here is normal (nothing leased), never a caller loss.
  const fencedJobs = await runRows<{ job_id: string }>(db, B.B9_FENCE_JOBS, [providerId]);
  const fencedRuns = await runRows<{ run_id: string }>(db, B.B9_FENCE_RUNS, [providerId]);
  const aggregated = await runRows<{ search_id: string }>(db, B.B9_REQUEST_AGGREGATION, [
    providerId,
  ]);
  return {
    providerId,
    routeClass: derived.routeClass,
    state: derived.state,
    cause: derived.cause,
    epoch: fenced.epoch,
    fencedJobIds: fencedJobs.map((row) => row.job_id),
    fencedRunIds: fencedRuns.map((row) => row.run_id),
    aggregatedSearchIds: aggregated.map((row) => row.search_id),
  };
}

/**
 * The typed B9 transition in one transaction: fence, status, leased-job/run generations,
 * and aggregation requests commit together or not at all.
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above; this function
 * composes `BEGIN`/`COMMIT`/`ROLLBACK` the same way and has the same hazard.
 */
export async function applyProviderControlTransition(
  db: TransactionClient,
  providerId: string,
  trigger: ProviderControlTrigger,
): Promise<ProviderControlOutcome> {
  await db.query("BEGIN");
  try {
    const outcome = await stageProviderControlTransition(db, providerId, trigger);
    await db.query("COMMIT");
    return outcome;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

export interface ReopenOutcome {
  readonly providerId: string;
  readonly routeClass: string;
  readonly epoch: string;
}

/** The manual reopen body without BEGIN/COMMIT, for crash tests. */
export async function stageReopenProviderScope(
  db: SqlClient,
  providerId: string,
  routeClass: string,
): Promise<ReopenOutcome> {
  // Same load-bearing order as the halt: the fence bumps first, so a crash between the
  // two statements leaves the scope non-OPEN under a raised epoch (fail-closed) rather
  // than OPEN under the pre-reopen epoch, which late B5(b) acceptances would pass.
  const fenced = await mustWin<{ epoch: string }>(db, B.B9_BUMP_FENCE, [providerId]);
  await mustWin(db, B.B9_REOPEN_SCOPE, [providerId, routeClass]);
  return { providerId, routeClass, epoch: fenced.epoch };
}

/**
 * The typed manual-reopen transaction (S5.7): increments the provider fence and changes
 * only the named EXISTING scope to `OPEN`, clearing cause and deadline. Nothing calls this
 * automatically for block, challenge, queue, or legal-kill-switch halts; and reopening a
 * route beneath an unscoped halt leaves the effective state halted, because B4/B5(b) read
 * the provider-wide row too (T44).
 *
 * REQUIRES a single-connection `db` — see `acceptFetch`'s doc comment above.
 */
export async function reopenProviderScope(
  db: TransactionClient,
  providerId: string,
  routeClass: string,
): Promise<ReopenOutcome> {
  await db.query("BEGIN");
  try {
    const outcome = await stageReopenProviderScope(db, providerId, routeClass);
    await db.query("COMMIT");
    return outcome;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/* ------------------------------------------------------------------ B1 — search creation */

/**
 * One showtime a warm-path search subscribes to (S15.13). Durability only ever sees a
 * plain post-policy-filtered `{ showtimeId }` list — `performancePolicy` and
 * `ShowtimeStatus` stay in `apps/server`, exactly the boundary ADR 0009 already
 * established and preserved (`docs/adr/0009-p5-5-schedule-status-evidence-policy.md:51-54`);
 * this package gains no dependency on `@seatfirst/core`.
 */
export interface SearchCreationShowtime {
  readonly showtimeId: string;
  readonly dispatchRank?: number | null;
}

/** The schedules a cold search subscribes to: one SCHEDULE_RESOLUTION run key per planned date (S36). */
export interface SearchCreationScheduleKey {
  readonly theatreId: string;
  readonly localDate: string;
}

/** S65: one movie-first cluster run per AMC market and local date. */
export interface SearchCreationMovieScheduleKey {
  readonly movieSlug: string;
  readonly anchorTheatreId: string;
  readonly candidateTheatreIds: readonly string[];
  readonly localDate: string;
}

export interface StageSearchCreationInput {
  readonly searchId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  /** The wire spec as the search row stores it: JSON.stringify of the parsed input spec. */
  readonly spec: unknown;
  readonly specHash: string;
  readonly deadlineAt: Date;
  readonly providerId: string;
  /**
   * Stage-1 reservation (S15.5/S15.6, S36.5): `maxResolvedShowtimes` on the cold path,
   * the policy-eligible count on warm. Already decided upstream; never derived here.
   * For S36 mixed creation, reserve is still 200 for any cold/mixed search (one provisional
   * reservation), and the real fresh count is carried separately in freshMatchCount.
   */
  readonly reserve: number;
  /** S36: one entry per planned cold date; empty means all-fresh. Replaces the old single scheduleKey. */
  readonly scheduleKeys: readonly SearchCreationScheduleKey[];
  /** S65: movie-first cluster work replacing per-theatre schedule keys for an eligible search. */
  readonly movieScheduleKeys?: readonly SearchCreationMovieScheduleKey[];
  /** The warm/mixed path's policy-eligible, window-matching showtimes; may be empty on all-cold. */
  readonly showtimes: readonly SearchCreationShowtime[];
  /** S36: count of policy-eligible, window-matching fresh performances for which this transaction creates SHOWTIME_FETCH work. Durably persisted as fresh_match_seed. Must be 0..200. */
  readonly freshMatchCount: number;
  /** W3C traceparent captured at the HTTP boundary via propagation.inject (O7.6); null when no request span is active. */
  readonly traceparent: string | null;
  /** S46 schedule skeleton (one entry per matched performance, ordered by dispatchRank). Threaded to a B7_SKELETON_EVENT in the same transaction so SSE subscribers see it before the first group event (no new race). Omit on replay — the original row already has it. */
  readonly skeletonEntries?: readonly unknown[] | null;
  /** S45 continuation link: parent search_id when this search continues a BATCH_DEFERRED chain. Null for fresh searches. FK-less per 001_schema soft-reference convention. */
  readonly continuesSearchId?: string | null;
}

export type SearchCreationResult =
  | {
      readonly kind: "created";
      readonly searchId: string;
      readonly status: "PENDING_SCHEDULE" | "RUNNING";
    }
  | {
      readonly kind: "replay";
      readonly searchId: string;
      /** The stored status, verbatim — including terminal statuses the caller must map. */
      readonly status: string;
      /** Durable SHOWTIME_FETCH job count, for a warm replay whose cache has gone cold. */
      readonly fetchJobCount: number;
    };

/**
 * Thrown when `B1_STAGE1_ADMISSION`'s gate closes (S15.7): zero rows mean the ADR 0006
 * §D.1 ceiling (`pending_cost_limit`/`unresolved_limit`) would be exceeded. Carries only
 * the `providerId` — the caller owns the HTTP shape and the `Retry-After` figure
 * (S15.9/S15.10); durability owns no wire format.
 */
export class AdmissionRejectedError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `admission rejected for provider ${providerId}: pending-cost or unresolved-schedule ` +
        "ceiling exceeded",
    );
    this.name = "AdmissionRejectedError";
    this.providerId = providerId;
  }
}

/**
 * Thrown when `B1_CREATE_SEARCH` zero-rows and the existing row's `spec_hash` differs
 * (S15.3). Carries the pre-existing `searchId` — the route's 409 body must name the
 * FIRST call's search, exactly as `IdempotencyKeyConflictSchema` requires.
 */
export class IdempotencyKeyConflictError extends Error {
  readonly searchId: string;

  constructor(searchId: string) {
    super(
      `idempotency key conflict: a search already exists (searchId ${searchId}) with a ` +
        "different spec",
    );
    this.name = "IdempotencyKeyConflictError";
    this.searchId = searchId;
  }
}
/**
 * B1's full create body without BEGIN/COMMIT — the crash-test hook, mirroring
 * `stageScheduleAcceptance`'s shape (this module's established pattern). The sequence is
 * load-bearing (S15.7/S36.5):
 *
 * 1. `B1_CREATE_SEARCH` — the idempotency fence. Zero rows: read the existing
 *    `(session_id, idempotency_key)` row. Same `spec_hash` → `{ kind: "replay" }` (a
 *    lost response retried identically is a normal 202 body,
 *    `seatfirst-architecture.md:267-269`). Different `spec_hash` →
 *    `IdempotencyKeyConflictError`, short-circuiting BEFORE any admission is touched.
 * 2. `B1_STAGE1_ADMISSION` — the ADR 0006 §D.1 gate, now search-wide (S36). Zero rows:
 *    `AdmissionRejectedError`, so the search row inserted in step 1 rolls back with it —
 *    a search with no reservation is never committed (S15.7's orphan clause). Takes
 *    coldDelta = 1 when scheduleKeys nonempty else 0 (never length) and freshMatchCount
 *    (0..200) persisted as fresh_match_seed in the same statement.
 * 3. `B7_UPSERT_AGGREGATE` seeds a revision-0 zero-state `search_aggregate` row in the
 *    SAME transaction as admission (S19.5): resolved 0, total `input.reserve`, no
 *    groups/exclusions, `answer: null`. Without this write, `searches.get`'s nonterminal
 *    branch has a real window — between this commit and the AGGREGATE handler's (S27)
 *    first pass — where no aggregate row exists and the route 500s. `agg_requested_rev`
 *    stays untouched at its DEFAULT 0 through this whole function, so revision 0 is
 *    exactly "satisfies the current requested revision." The first real AGGREGATE pass
 *    later writes a higher revision through the same statement, whose
 *    `revision <= EXCLUDED.revision` guard lets it replace this seed unconditionally.
 * 4. Work creation: deterministic `k_sched_<provider>_<theatre>_<date>` key/job/
 *    subscription/outbox for every cold plan date plus deterministic
 *    `k_fetch_<provider>_<showtime>` work for every fresh eligible showtime
 *    (post-S36.2, post-policy), one subscription unit each. Ordering is load-bearing
 *    (ADR 0005 §I point 2): the subscriber must exist before its join charge is
 *    assessed, and a rolled-back subscription must roll back its charge. Swapping
 *    those two statements would bill a search that never subscribed.
 * 5. Warm path only: `B1_MARK_RUNNING` only when scheduleKeys is empty (all-fresh).
 *    Mixed (both lists nonempty) stays PENDING_SCHEDULE with one 200 reservation + one slot.
 */
export async function stageSearchCreation(
  db: SqlClient,
  input: StageSearchCreationInput,
): Promise<SearchCreationResult> {
  if (input.freshMatchCount < 0 || input.freshMatchCount > 200) {
    throw new Error(
      `stageSearchCreation: freshMatchCount must be 0..200, got ${input.freshMatchCount}`,
    );
  }
  // S45: batch admission slices to top 20 by dispatch_rank, so showtimes.length
  // (admitted) may be less than freshMatchCount (total matched). The invariant
  // is admitted <= total, not equality, and batch_deferred_count captures the
  // remainder. Ordering-sensitive: this check must precede any write.
  if (input.freshMatchCount < input.showtimes.length) {
    throw new Error(
      `stageSearchCreation: freshMatchCount ${input.freshMatchCount} must be >= showtimes.length ${input.showtimes.length}`,
    );
  }
  const movieScheduleKeys = input.movieScheduleKeys ?? [];
  const hasScheduleWork = input.scheduleKeys.length > 0 || movieScheduleKeys.length > 0;
  const coldDelta = hasScheduleWork ? 1 : 0;
  const inserted = await runRows<{ search_id: string }>(db, B.B1_CREATE_SEARCH, [
    input.searchId,
    input.sessionId,
    input.idempotencyKey,
    JSON.stringify(input.spec),
    input.specHash,
    input.deadlineAt.toISOString(),
  ]);

  // S45 continuation chain: persist parent link so the exclusion walk can follow
  // the full chain (not just immediate parent). What breaks if this swaps with
  // admission: a crash after admission but before link would make a continuation's
  // second hop re-fetch the grandparent's showtimes (single-hop bug).
  if (input.continuesSearchId) {
    await runRows(db, B.SEARCH_SET_CONTINUES, [input.searchId, input.continuesSearchId]);
  }

  if (inserted.length < 1) {
    // The (session_id, idempotency_key) row already exists: replay or conflict (S15.3).
    // S39.8 (CONTRIBUTING §2) — tolerated cast: undefined handled below; the SELECT projects exactly the conflict path's fields.
    const existing = (
      await db.query(
        `SELECT search_id, status, spec_hash FROM search WHERE session_id = $1 AND idempotency_key = $2`,
        [input.sessionId, input.idempotencyKey],
      )
    ).rows[0] as { search_id: string; status: string; spec_hash: string } | undefined;
    if (existing === undefined) {
      throw new Error(
        "B1_CREATE_SEARCH returned 0 rows but no (session_id, idempotency_key) row exists",
      );
    }
    if (existing.spec_hash !== input.specHash) {
      throw new IdempotencyKeyConflictError(existing.search_id);
    }
    const countRows = await runRows<{ n: number }>(db, B.B1_SEARCH_FETCH_JOB_COUNT, [
      existing.search_id,
    ]);
    return {
      kind: "replay",
      searchId: existing.search_id,
      status: existing.status,
      fetchJobCount: countRows[0]?.n ?? 0,
    };
  }

  const admitted = await runRows<{ search_id: string }>(db, B.B1_STAGE1_ADMISSION, [
    input.providerId,
    input.reserve,
    coldDelta,
    input.searchId,
    input.freshMatchCount,
  ]);
  if (admitted.length < 1) {
    throw new AdmissionRejectedError(input.providerId);
  }

  const status: "PENDING_SCHEDULE" | "RUNNING" = hasScheduleWork ? "PENDING_SCHEDULE" : "RUNNING";

  await mustWin(db, B.B7_UPSERT_AGGREGATE, [
    input.searchId,
    0,
    JSON.stringify({
      searchId: input.searchId,
      spec: input.spec,
      status,
      resolved: 0,
      total: input.reserve,
      capturedAtRange: null,
      groups: [],
      excluded: {
        soldOut: 0,
        outsideWindow: 0,
        outsideRegion: 0,
        outsideArea: 0,
        wrongAttributes: 0,
        overPrice: 0,
        notReservedSeating: 0,
        fetchFailed: 0,
        fetchFailedByCause: {},
        byTheatre: {},
      },
      answer: null,
    }),
    // S60 (ADR 0066 §2): a freshly-admitted search has no evidence yet.
    JSON.stringify(null),
  ]);

  // S45: batch-of-20 admission — create jobs only for top 20 by dispatch_rank.
  // The remainder get no search_job/run_key/run_subscription and become S46
  // skeleton rows. batch_deferred_count is set once here to the exact deferred
  // count so B8_TERMINALIZE can derive PARTIAL/BATCH_DEFERRED without inventing
  // a new job-state branch. What breaks if this UPDATE swaps with job
  // creation: a crash between jobs and the count would leave B8 believing the
  // search is COMPLETE while N showtimes were deliberately never fetched.
  const totalMatched = input.freshMatchCount;
  const admittedShowtimes = [...input.showtimes]
    .sort((a, b) => {
      const ar = (a as { dispatchRank?: number | null }).dispatchRank ?? 32767;
      const br = (b as { dispatchRank?: number | null }).dispatchRank ?? 32767;
      return ar - br;
    })
    .slice(0, 20);
  const batchDeferred = Math.max(0, totalMatched - admittedShowtimes.length);
  // Persist batch_deferred_count for B8. This must happen inside the same
  // transaction as job creation so a terminalizing B8 sees the correct cause.
  // Use the new boundary SEARCH_SET_BATCH_DEFERRED.
  if (admittedShowtimes.length !== input.showtimes.length || batchDeferred > 0) {
    await runRows(db, B.SEARCH_SET_BATCH_DEFERRED, [input.searchId, batchDeferred]);
  } else if (totalMatched > 0) {
    // Even when all are admitted, ensure the column is set (default 0 covers pre-feature rows, but be explicit).
    await runRows(db, B.SEARCH_SET_BATCH_DEFERRED, [input.searchId, 0]);
  }

  // S46.5 — emit skeleton as the first search_event in the same transaction as
  // creation, before any group/progress event. What breaks if this swaps after
  // job creation or outside the transaction: a subscriber that connects after
  // the 202 but before the skeleton row would see group events without ever
  // having received the schedule context (new race window).
  if (input.skeletonEntries !== undefined && input.skeletonEntries !== null) {
    await mustWin(db, B.B7_SKELETON_EVENT, [
      input.searchId,
      JSON.stringify({ scheduleSkeleton: input.skeletonEntries }),
    ]);
  }

  const deadline = input.deadlineAt.toISOString();
  // S36: create N schedule subscriptions (stale/absent dates) atomically with M fresh fetches.
  for (const key of input.scheduleKeys) {
    const runKeyId = `k_sched_${input.providerId}_${key.theatreId}_${key.localDate}`;
    await mustWin(db, B.RUN_KEY_UPSERT, [
      runKeyId,
      "SCHEDULE_RESOLUTION",
      input.providerId,
      "schedule",
      null,
      key.theatreId,
      key.localDate,
    ]);
    const jobId = randomUUID();
    await mustWin(db, B.JOB_CREATE, [
      jobId,
      input.searchId,
      "SCHEDULE_RESOLUTION",
      runKeyId,
      deadline,
    ]);
    await mustWin(db, B.SUBSCRIPTION_CREATE, [runKeyId, input.searchId, jobId, deadline]);
    await runRows(db, B.COST_ABUSE_JOIN, [runKeyId, input.searchId]);
    await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, input.traceparent]);
  }

  for (const key of movieScheduleKeys) {
    if (key.candidateTheatreIds.length === 0) {
      throw new Error("stageSearchCreation: movie schedule key requires a candidate theatre");
    }
    const runKeyId = `k_movie_sched_${input.providerId}_${key.movieSlug}_${key.anchorTheatreId}_${key.localDate}`;
    await mustWin(db, B.MOVIE_SCHEDULE_RUN_KEY_UPSERT, [
      runKeyId,
      input.providerId,
      key.movieSlug,
      key.anchorTheatreId,
      key.localDate,
    ]);
    const jobId = randomUUID();
    await mustWin(db, B.JOB_CREATE, [
      jobId,
      input.searchId,
      "MOVIE_SCHEDULE_RESOLUTION",
      runKeyId,
      deadline,
    ]);
    await mustWin(db, B.MOVIE_SCHEDULE_SUBSCRIPTION_CREATE, [
      runKeyId,
      input.searchId,
      jobId,
      deadline,
      JSON.stringify(key.candidateTheatreIds),
    ]);
    await runRows(db, B.COST_ABUSE_JOIN, [runKeyId, input.searchId]);
    await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, input.traceparent]);
  }

  // S44 — ranked dispatch: showtimes are expected already sorted by rankCandidate
  // descending with dispatchRank 0..N-1 assigned by the caller (apps/server create.ts).
  // This transaction threads the ordinal through to provider_run.dispatch_rank via
  // RUN_CREATE so SWEEP_OVERDUE_OUTBOX drains best-rank-first.
  for (const showtime of admittedShowtimes) {
    const runKeyId = `k_fetch_${input.providerId}_${showtime.showtimeId}`;
    await mustWin(db, B.RUN_KEY_UPSERT, [
      runKeyId,
      "SHOWTIME_FETCH",
      input.providerId,
      "seat",
      showtime.showtimeId,
      null,
      null,
    ]);
    const jobId = randomUUID();
    await mustWin(db, B.JOB_CREATE, [jobId, input.searchId, "SHOWTIME_FETCH", runKeyId, deadline]);
    await mustWin(db, B.SUBSCRIPTION_CREATE, [runKeyId, input.searchId, jobId, deadline]);
    await runRows(db, B.COST_ABUSE_JOIN, [runKeyId, input.searchId]);
    await mustWin(db, B.OUTBOX_CREATE_JOB, [jobId, input.traceparent]);
  }

  if (status === "RUNNING") {
    await mustWin(db, B.B1_MARK_RUNNING, [input.searchId]);
  }
  return { kind: "created", searchId: input.searchId, status };
}

/**
 * B1 in one transaction, exactly as the ADR sequences it (S15.7) — the thin
 * `TransactionClient`-typed wrapper that owns BEGIN/COMMIT/ROLLBACK, mirroring
 * `acceptFetch`/`acceptSchedule`. The production route composes the same body via
 * `withTransaction` (pool.ts), which provides the identical commit-on-return /
 * rollback-on-throw contract; this wrapper serves callers that already hold a
 * single-connection client and the tier tests that bind the composition.
 *
 * REQUIRES a single-connection `db` — see the module header.
 */
export async function acceptSearchCreation(
  db: TransactionClient,
  input: StageSearchCreationInput,
): Promise<SearchCreationResult> {
  await db.query("BEGIN");
  try {
    const result = await stageSearchCreation(db, input);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/* --------------------------------------------------------- S22 — recheck */

/** The single-use nonce was already consumed — a replay (S22.9, ADR 0017). */
export class NonceReplayError extends Error {
  readonly nonceId: string;

  constructor(nonceId: string) {
    super(`recheck nonce already consumed: ${nonceId}`);
    this.name = "NonceReplayError";
    this.nonceId = nonceId;
  }
}

export interface StageRecheckRunInput {
  readonly providerId: string;
  readonly showtimeId: string;
  readonly placementKey: string;
  /** D1 (S31.4) — the placement's 0-based dense geometry, carried so the recheck verdict
   * can locate the block in the freshly parsed grid. Numbers only: durability must not
   * depend on `@seatfirst/core` (S15.13/ADR 0009). */
  readonly row: number;
  readonly startCol: number;
  readonly rowSpan: number;
  readonly count: number;
  /** The nonce token's own id, minted at issuance and embedded in the HMAC token (ADR 0017). */
  readonly nonceId: string;
}

export interface RecheckRunResult {
  readonly runId: string;
}

/**
 * S22.7 — the durable recheck-run creation body without BEGIN/COMMIT. One transaction:
 * `RECHECK_RUN_KEY_CREATE` → `RUN_CREATE` → `OUTBOX_CREATE_RUN` → the nonce consumption.
 *
 * Ordering is load-bearing: the nonce is consumed LAST. A consumed nonce whose run insert
 * failed would burn the caller's single-use token; a run dispatched before the nonce row
 * exists would let a replay navigate twice — the exact crime seatfirst-architecture.md:397
 * forbids. Because NONCE_CONSUME is last, a replay rolls the whole creation back.
 *
 * The run_key_id embeds a fresh ULID so a recheck NEVER coalesces onto an existing key
 * (S22.5(a); seatfirst-architecture.md:703) — unlike RUN_KEY_UPSERT's deterministic
 * coalescing key. `recheck_placement` carries the placement geometry the recheck verdict
 * re-verifies (D1, S31.4).
 */
export async function stageRecheckRun(
  db: SqlClient,
  input: StageRecheckRunInput,
): Promise<RecheckRunResult> {
  const runKeyId = `k_recheck_${input.providerId}_${input.showtimeId}_${randomUUID()}`;
  const runId = randomUUID();
  const observationId = randomUUID();

  await mustWin(db, B.RECHECK_RUN_KEY_CREATE, [
    runKeyId,
    input.providerId,
    input.showtimeId,
    JSON.stringify({
      placementKey: input.placementKey,
      row: input.row,
      startCol: input.startCol,
      rowSpan: input.rowSpan,
      count: input.count,
    }),
  ]);
  await mustWin(db, B.RUN_CREATE, [runId, runKeyId, observationId, null]);
  await mustWin(db, B.OUTBOX_CREATE_RUN, [runId, null]);
  const consumed = await runRows<{ nonce_id: string }>(db, B.NONCE_CONSUME, [input.nonceId]);
  if (consumed.length < 1) {
    throw new NonceReplayError(input.nonceId);
  }
  return { runId };
}

/**
 * S22.7 — the typed transaction-owning wrapper (the `stageSearchCreation`/`acceptSearchCreation`
 * pattern) that composes BEGIN/COMMIT/ROLLBACK. The production route composes the same body via
 * `withTransaction`; this wrapper serves tier tests that bind the composition.
 */
export async function acceptRecheckRun(
  db: TransactionClient,
  input: StageRecheckRunInput,
): Promise<RecheckRunResult> {
  await db.query("BEGIN");
  try {
    const result = await stageRecheckRun(db, input);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/**
 * S22.5(b) — the SUCCESS completion body (AVAILABLE/GONE), without BEGIN/COMMIT. A single
 * data-modifying CTE transitions the run to DONE and writes its outcome atomically; the fence
 * (`state='LEASED' AND generation`) makes a halted/reclaimed run yield zero rows, so no outcome
 * is written and the route's deadline yields TIMEOUT. Returns whether the completion fenced.
 */
export async function stageRecheckComplete(
  db: SqlClient,
  handle: RunHandle,
  status: "AVAILABLE" | "GONE",
  payload: unknown,
): Promise<boolean> {
  const done = await runRows<{ run_id: string }>(db, B.RECHECK_COMPLETE, [
    handle.runId,
    handle.generation,
    status,
    JSON.stringify(payload),
  ]);
  return done.length > 0;
}

/**
 * S22.4 — the failure outcome for a run already FAILED by `failRun` in the same transaction.
 * `cause` is one of the S22.12 UNAVAILABLE causes; `status` is always UNAVAILABLE.
 */
export async function stageRecheckFail(db: SqlClient, runId: string, cause: string): Promise<void> {
  await mustWin(db, B.RECHECK_FAIL, [runId, JSON.stringify({ cause })]);
}

/* --------------------------------------------------- S30 — job admission/dedup */

/** S30.3 — caller-supplied input for find-or-create run admission. Only `runKeyId` is
 * provided by the caller; `runId`/`observationId` are generated internally (ULIDs), and
 * `kind`/`priority` derive from the `run_key` row inside `RUN_CREATE` (`boundaries.ts:647`). */
export interface FindOrCreateRunInput {
  readonly runKeyId: string;
  readonly dispatchRank?: number | null;
}

/** S30.3 — the find-or-create result. `runId` is null and `created` false when a live run
 * already existed for the key (zero rows from `RUN_CREATE`'s fence is NORMAL, not an error). */
export interface FindOrCreateRunResult {
  readonly runId: string | null;
  readonly created: boolean;
}

/**
 * S30.3/S30.4 — the find-or-create admission body without BEGIN/COMMIT:
 * `RUN_CREATE` → conditional `OUTBOX_CREATE_RUN`.
 *
 * Order is load-bearing: the outbox is created ONLY for the run this call actually created.
 * `RUN_CREATE`'s fence is `state IN ('PENDING','LEASED')` (`boundaries.ts:650`), so zero rows
 * means a live run already exists for the key and this search's subscription will be applied
 * by `B5_FANIN` at acceptance — normal, not an error. This is the deliberate inverse of
 * `stageRecheckRun`'s `mustWin` on `RUN_CREATE`: a recheck key is always fresh and must win,
 * an admission key must coalesce onto the existing live run instead of dispatching a second.
 *
 * `runId`/`observationId` are fresh ULIDs generated here (`randomUUID()`), mirroring
 * `stageRecheckRun` (`transactions.ts:1348-1350`); `observation_id` is fixed before dispatch
 * (`001_schema.sql:116`).
 */
export async function stageFindOrCreateRun(
  db: SqlClient,
  input: FindOrCreateRunInput,
): Promise<FindOrCreateRunResult> {
  const runId = randomUUID();
  const observationId = randomUUID();
  const dispatchRank = input.dispatchRank ?? null;
  const created = await runRows<{ run_id: string }>(db, B.RUN_CREATE, [
    runId,
    input.runKeyId,
    observationId,
    dispatchRank,
  ]);
  if (created.length < 1) {
    return { runId: null, created: false };
  }
  // S44: RUN_CREATE now DO UPDATEs dispatch_rank on conflict and returns the
  // winner's run_id. If we lost the race the returned id is the existing
  // live run's id, not our freshly minted runId — creating an outbox for our
  // stale id would violate the FK. Only the insert winner creates an outbox.
  if (created[0]!.run_id !== runId) {
    return { runId: null, created: false };
  }
  await mustWin(db, B.OUTBOX_CREATE_RUN, [runId, null]);
  return { runId, created: true };
}

/**
 * S30.3 — the typed transaction-owning wrapper (the `acceptRecheckRun` pattern) that composes
 * BEGIN/COMMIT/ROLLBACK around `stageFindOrCreateRun`. The production route composes the same
 * body via `withTransaction` (`pool.ts`); this wrapper serves callers that already hold a
 * single-connection client and the tier tests that bind the composition.
 */
export async function findOrCreateRun(
  db: TransactionClient,
  input: FindOrCreateRunInput,
): Promise<FindOrCreateRunResult> {
  await db.query("BEGIN");
  try {
    const result = await stageFindOrCreateRun(db, input);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/* ---------------- S61 — showtime run micro-cache / snapshot adoption (ADR 0065) */

export interface StageAdoptOrCreateOptions {
  readonly jobId: string;
  readonly jobGeneration: number;
  readonly searchId: string;
  readonly runKeyId: string;
  readonly providerId: string;
  readonly snapshotAdoptionTtlMs?: number;
}

export type AdoptOrCreateOutcome =
  | { outcome: "ADOPTED"; runId: string; capturedAt: Date; freeCount: number }
  | { outcome: "RUN_CREATED"; runId: string | null }
  | { outcome: "FENCE_REJECTED" };

/**
 * S61 (ADR 0065) — adopt a recent authoritative snapshot for a SHOWTIME_FETCH job,
 * or fall back to creating a fresh run. Satisfies S61.1–S61.6:
 *
 * S61.1: the snapshot cutoff uses `opts.snapshotAdoptionTtlMs ?? SNAPSHOT_ADOPTION_TTL_MS`
 *   (never `OFFER_STALENESS_MS`, which is presentation-only).
 * S61.2: all effects go through the `B5_ADOPT_*` / `B5_FIND_RECENT_SNAPSHOT` boundaries.
 * S61.3: the provider epoch fence (`B5B_EPOCH_FENCE`, route_class `'seat'`) gates adoption;
 *   a halted/paused provider or missing fence row yields FENCE_REJECTED, not a throw.
 * S61.4: the adopted `run_id` resolves via `run_key.latest_observation_id ->
 *   observation.run_id` and is recorded in `run_application`.
 * S61.5: the job/subscription/reservation/event effects mirror `B5_FANIN`'s transitions
 *   (DONE / SATISFIED / decrement / FETCH_ACCEPTED) for this single subscriber.
 * S61.6: a stale/missing snapshot falls back to `stageFindOrCreateRun` (fresh fetch run).
 *
 * Like `stageFindOrCreateRun`, this is the staged body without BEGIN/COMMIT — the caller
 * (already under the S60 two-row admission fence) owns the transaction.
 */
export async function stageAdoptOrCreateShowtimeWork(
  db: SqlClient,
  opts: StageAdoptOrCreateOptions,
): Promise<AdoptOrCreateOutcome> {
  // S61.3 — provider fence first, mirroring `stageFetchAcceptance`'s
  // `B5B_EPOCH_FENCE` call. Unlike acceptance there is no prior run/generation to
  // fence against, so read the CURRENT epoch and re-assert it through the fence:
  // a halted/paused provider (or a missing fence row, which the fence predicate
  // would also fail closed on) is a normal FENCE_REJECTED, not a crash.
  // Route class is hardcoded to "seat": this function is showtime-only by
  // name/contract, and `run_key`'s CHECK constraint enforces
  // `(kind = 'SHOWTIME_FETCH') = (route_class = 'seat')` as a schema invariant.
  try {
    const fenceRows = (
      await db.query(`SELECT epoch FROM provider_fence WHERE provider_id = $1::text`, [
        opts.providerId,
      ])
    ).rows as { epoch: unknown }[];
    if (fenceRows.length < 1) return { outcome: "FENCE_REJECTED" };
    const epoch = fenceRows[0]!.epoch;
    await mustWin(db, B.B5B_EPOCH_FENCE, [opts.providerId, epoch, "seat"]);
  } catch {
    return { outcome: "FENCE_REJECTED" };
  }

  const ttlMs = opts.snapshotAdoptionTtlMs ?? SNAPSHOT_ADOPTION_TTL_MS;
  const cutoff = new Date(Date.now() - ttlMs);
  const snapshots = await runRows<{
    observation_id: string;
    run_id: string;
    free_count: number;
    captured_at: Date;
  }>(db, B.B5_FIND_RECENT_SNAPSHOT, [opts.runKeyId, cutoff.toISOString()]);
  if (snapshots.length < 1) {
    const { runId } = await stageFindOrCreateRun(db, { runKeyId: opts.runKeyId });
    return { outcome: "RUN_CREATED", runId };
  }
  const row = snapshots[0]!;
  await runRows(db, B.B5_ADOPT_RUN_APPLICATION, [row.run_id, opts.searchId]);
  const jobDone = await runRows<{ search_id: string }>(db, B.B5_ADOPT_SHOWTIME_JOB_DONE, [
    opts.jobId,
    opts.jobGeneration,
    opts.runKeyId,
  ]);
  if (jobDone.length < 1) return { outcome: "FENCE_REJECTED" };
  await runRows(db, B.B5_ADOPT_RESERVED_REMAINING, [opts.searchId]);
  await runRows(db, B.B5_ADOPT_SEARCH_EVENT, [
    opts.searchId,
    JSON.stringify({
      runKeyId: opts.runKeyId,
      observationId: row.observation_id,
      freeCount: row.free_count,
      capturedAt: row.captured_at,
      adopted: true,
    }),
  ]);
  return {
    outcome: "ADOPTED",
    runId: row.run_id,
    capturedAt: new Date(row.captured_at),
    freeCount: row.free_count,
  };
}

/* ------------------- ADR 0039 Amendment A1 — capacity-preview schedule resolution */

export interface PreviewScheduleKey {
  readonly theatreId: string;
  readonly localDate: string;
}

export interface StagePreviewScheduleRunsInput {
  readonly providerId: string;
  /** One entry per cold (theatre, date) the preview needs resolved. */
  readonly keys: readonly PreviewScheduleKey[];
}

export interface StagePreviewScheduleRunsResult {
  /** Run ids THIS call created; empty when every date already had a live run. */
  readonly createdRunIds: readonly string[];
}

/**
 * ADR 0039 Amendment A1 — durable subscription-less capacity-preview schedule resolution,
 * without BEGIN/COMMIT. For each cold date, in one transaction:
 *
 * 1. `RUN_KEY_UPSERT` — the SAME deterministic `k_sched_<provider>_<theatre>_<date>` key a
 *    cold search creates (`stageSearchCreation`), so previews and searches coalesce onto
 *    one run per date by construction; repeated previews can never multiply upstream load.
 * 2. `stageFindOrCreateRun` — `RUN_CREATE` + conditional `OUTBOX_CREATE_RUN`, with NO
 *    `JOB_CREATE`/`SUBSCRIPTION_CREATE`: both require a `search_id`, and a preview mints
 *    no search state. Zero rows from `RUN_CREATE` means a live run already exists for the
 *    date (a concurrent preview or a search got there first) — normal, not an error.
 *
 * What re-arms and what completes these zero-subscriber runs: `SWEEP_REARM_RUNS`'s
 * SCHEDULE_RESOLUTION-with-no-subscriptions branch (re-arm after outbox loss), and
 * `stageScheduleAcceptance`'s zero-fan-in path (completion — B5C_PERFORMANCE snapshot rows
 * plus run terminalization happen before any subscriber iteration). Both are guarded by
 * the `preview_runs_never_stranded` invariant (`src/invariants.ts`) and tier-tested in
 * `test/tier2.preview-schedule-runs.test.ts`.
 */
export async function stagePreviewScheduleRuns(
  db: SqlClient,
  input: StagePreviewScheduleRunsInput,
): Promise<StagePreviewScheduleRunsResult> {
  const createdRunIds: string[] = [];
  for (const key of input.keys) {
    const runKeyId = `k_sched_${input.providerId}_${key.theatreId}_${key.localDate}`;
    await mustWin(db, B.RUN_KEY_UPSERT, [
      runKeyId,
      "SCHEDULE_RESOLUTION",
      input.providerId,
      "schedule",
      null,
      key.theatreId,
      key.localDate,
    ]);
    const { runId, created } = await stageFindOrCreateRun(db, { runKeyId });
    if (created && runId !== null) createdRunIds.push(runId);
  }
  return { createdRunIds };
}

/**
 * ADR 0039 Amendment A1 — the typed transaction-owning wrapper (the `acceptRecheckRun`
 * pattern). The production route composes the same body via `withTransaction`; this
 * wrapper serves callers that already hold a single-connection client and the tier tests
 * that bind the composition.
 */
export async function previewScheduleRuns(
  db: TransactionClient,
  input: StagePreviewScheduleRunsInput,
): Promise<StagePreviewScheduleRunsResult> {
  await db.query("BEGIN");
  try {
    const result = await stagePreviewScheduleRuns(db, input);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

/* ------------------------- S63 — on-demand D+0 schedule refresh (ADR 0100) */

export interface StageOnDemandScheduleRefreshInput {
  readonly providerId: string;
  readonly theatreId: string;
  /** D+0 in the theatre's own timezone (`YYYY-MM-DD`), computed by the caller. */
  readonly localDate: string;
}

export interface StageOnDemandScheduleRefreshResult {
  /**
   * The run to poll: this call's run when created, else the live winner's run_id that
   * `RUN_CREATE`'s `RETURNING` yields on coalescence. Null when nothing was staged and
   * nothing exists to poll (missing provider fence — see below).
   */
  readonly runId: string | null;
  readonly runKeyId: string;
  /** True iff this call created the run (and staged its outbox row). */
  readonly created: boolean;
}

/**
 * S63.5 (ADR 0100, "Explicit On-Demand Refresh") — run-only SCHEDULE_RESOLUTION
 * staging for one theatre date, without BEGIN/COMMIT. The run-only path mirrors
 * `stagePreviewScheduleRuns` (the same deterministic
 * `k_sched_<provider>_<theatre>_<date>` key, so a refresh coalesces with searches and
 * previews onto one run per date by construction), but unlike the preview it returns
 * the EFFECTIVE run id in every case: `RUN_CREATE`'s
 * `ON CONFLICT ... DO UPDATE ... RETURNING run_id` yields the live winner's id when a
 * concurrent stager got there first (S44), and only the insert winner stages an outbox
 * row (with a NULL traceparent, mirroring `stageFindOrCreateRun` — this context
 * carries no request span) — creating one for a lost id would violate the outbox FK.
 * No `JOB_CREATE`/`SUBSCRIPTION_CREATE`: both require a `search_id`, and a refresh
 * mints no search state (the same reason the preview path skips them).
 *
 * Zero rows from `RUN_CREATE` means no live run exists AND none could be created — the
 * `RUN_KEY_UPSERT` above guarantees the key, so only a missing `provider_fence` row
 * explains it. `{ runId: null }` (not a throw): there is nothing to poll, and the route
 * maps it to an honest retryable `FAILED`.
 */
export async function stageOnDemandScheduleRefresh(
  db: SqlClient,
  input: StageOnDemandScheduleRefreshInput,
): Promise<StageOnDemandScheduleRefreshResult> {
  const runKeyId = `k_sched_${input.providerId}_${input.theatreId}_${input.localDate}`;
  await mustWin(db, B.RUN_KEY_UPSERT, [
    runKeyId,
    "SCHEDULE_RESOLUTION",
    input.providerId,
    "schedule",
    null,
    input.theatreId,
    input.localDate,
  ]);
  const runId = randomUUID();
  const created = await runRows<{ run_id: string }>(db, B.RUN_CREATE, [
    runId,
    runKeyId,
    randomUUID(),
    null,
  ]);
  const winner = created[0]?.run_id;
  if (winner === undefined) {
    return { runId: null, runKeyId, created: false };
  }
  if (winner !== runId) {
    // Converged onto the live run a concurrent stager created (S44): its outbox row
    // already exists — stage no second. Poll the winner.
    return { runId: winner, runKeyId, created: false };
  }
  await mustWin(db, B.OUTBOX_CREATE_RUN, [runId, null]);
  return { runId, runKeyId, created: true };
}

/**
 * S63.5 — the typed transaction-owning wrapper (the `acceptSearchCreation` pattern).
 * The production route composes the same body via `withTransaction` (`pool.ts`); this
 * wrapper serves callers that already hold a single-connection client.
 */
export async function acceptOnDemandScheduleRefresh(
  db: TransactionClient,
  input: StageOnDemandScheduleRefreshInput,
): Promise<StageOnDemandScheduleRefreshResult> {
  await db.query("BEGIN");
  try {
    const result = await stageOnDemandScheduleRefresh(db, input);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}
