/**
 * Local-dev-backend seed script (`dev/README.md`, "Local dev backend" plan). Populates a
 * fresh dev Postgres with real theatre-catalogue, schedule, and seat-bitmap cache rows,
 * using real durability transactions and real `@seatfirst/providers` parsers against a small
 * hand-picked corpus of real captured fixtures (`packages/providers/fixtures/redacted/`) plus
 * one dev-only re-keyed seat fixture (`dev/fixtures/amc/`, see that directory's README for
 * why the re-key exists). No live navigation, no dispatch, no Chrome: this writes cache rows
 * directly via the same boundary statements/transaction bodies the real `RUN` actor uses, so
 * `theatres.search`/`theatres.movies` browsing is genuinely real once this has run — see the
 * plan doc for why that is sound (`SCHEDULE_RESOLUTION`/`SHOWTIME_FETCH` are freshness-cached
 * reads, S15.4).
 *
 * Built only against this package's already-public exports (`../src/index.js`) plus
 * `@seatfirst/providers`' real parsers and `@seatfirst/core`'s real layout/policy helpers —
 * never `../test/`. Every multi-statement composition below (run-key → run → dispatch, then
 * acceptance) mirrors `test/support/fixtures.ts`'s `dispatchRun` and the real RUN actor's
 * acceptance composition (`apps/server/src/dispatch/handlers/provider-fetch-actor.ts`)
 * exactly, so the rows this produces are indistinguishable from what a real navigation would
 * have written.
 *
 * Not idempotent by design for `run`/`observation` rows (every run mints fresh `run`/`observation`
 * rows). `run_key` rows for the seeded SCHEDULE_RESOLUTION and SHOWTIME_FETCH keys ARE
 * idempotent: they use the same deterministic `k_sched_...`/`k_fetch_...` ids as production's
 * `stageSearchCreation`, so a later real `searches.create` converges via RUN_KEY_UPSERT's
 * ON CONFLICT (run_key_id) instead of colliding. Re-running `seed` is safe and fully
 * reproducible: date assignment uses a fixed-seed PRNG (`./seed-schedule-dates.js`), so every
 * run assigns each performance to the exact same date and converges on the same `run_key` rows.
 * No volume wipe is needed to refresh stale data (`docker compose -f docker-compose.dev.yml
 * down -v` is reserved for schema/migration changes).
 *
 * Invocation: `node dist/scripts/seed-dev-fixtures.js` (built by this package's normal
 * `tsc -p tsconfig.build.json`), `DATABASE_URL` the only required input. Fixture paths are
 * computed relative to the repo root, resolved from this script's own compiled location
 * (`dist/scripts/` → four levels up) — this matches both a local checkout and the Docker
 * image layout (`Dockerfile.app` copies `packages/`, and `docker-compose.dev.yml`'s `seed`
 * service bind-mounts `dev/fixtures/amc` at the same repo-root-relative path).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

import { buildAuditoriumLayout, performancePolicy, popcount } from "@seatfirst/core";
import { deriveDevFixtureShowtimeId, parseSeats, parseShowtimes } from "@seatfirst/providers";
import { localSeedDate } from "./seed-date.js";
import {
  addLocalDays,
  assignFixtureDatesToWindow,
  SEED_WINDOW_DAYS,
} from "./seed-schedule-dates.js";
import {
  acceptFetch,
  B2_LEASE_RUN,
  B4_PREDISPATCH,
  createPool,
  OUTBOX_CREATE_RUN,
  poolClient,
  runStatement,
  RUN_CREATE,
  RUN_KEY_UPSERT,
  stageScheduleAcceptance,
  updatePerformanceProduct,
  upsertMovie,
  upsertTheatre,
  withTransaction,
} from "../src/index.js";
import type {
  RunHandle,
  ScheduleShowtime,
  SqlClient,
  Statement,
  TheatreSlugs,
  UpsertTheatreInput,
} from "../src/index.js";

const PROVIDER_ID = "amc";

/** Fixtures were captured on 2026-08-13. SEED_LOCAL_DATE (see `scripts/seed-date.ts`: today on
 * Fri/Sat/Sun, else the upcoming Friday) is the START of the seeded window, not a single seed
 * date: every captured performance is randomly re-dated onto one of the SEED_WINDOW_DAYS dates
 * beginning here (see `./seed-schedule-dates.js`), so the whole browsable window has data. */
const ORIGINAL_FIXTURE_DATE = "2026-08-13";
function daysBetween(a: string, b: string): number {
  const toEpochDay = (s: string): number => {
    const [yStr, mStr, dStr] = s.split("-");
    return Math.floor(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr)) / 86400000);
  };
  return toEpochDay(b) - toEpochDay(a);
}
const SEED_LOCAL_DATE = localSeedDate();

interface ScheduleFixtureSpec {
  readonly file: string;
  readonly theatreId: string;
}

/** Three real captured schedule bodies, chosen to overlap the theatre catalogue seeded below
 * and span two metros (`dev/fixtures/amc/README.md` has the full rationale). Each theatre's
 * captured schedule is randomly redistributed across the SEED_WINDOW_DAYS dates starting at
 * SEED_LOCAL_DATE (via `./seed-schedule-dates.js`) so the seeded data stays fresh and is never
 * rejected by RANGE_IN_PAST. */
const SCHEDULE_FIXTURES: readonly ScheduleFixtureSpec[] = [
  {
    file: "schedule-amc-metreon-16-2026-08-13.json",
    theatreId: "amc:theatre:2325",
  },
  {
    file: "schedule-amc-kabuki-8-2026-08-13.json",
    theatreId: "amc:theatre:4145",
  },
  {
    file: "schedule-amc-southlake-24-2026-08-13.json",
    theatreId: "amc:theatre:416",
  },
];

/** Dev-only seat fixtures, keyed by their on-disk filename. The Metreon entry keeps the
 * two-stage re-key (on-disk 145927008 → load-time 145927006); the other two are single-stage
 * re-keys written directly to their final target id, so `sourceNumericShowtimeId ===
 * numericShowtimeId` and the uniform replaceAll is a no-op for them. */
const SEAT_FIXTURES: readonly SeatFixtureSpec[] = [
  {
    file: "seats-145927008.json",
    sourceNumericShowtimeId: 145_927_008,
    numericShowtimeId: 145_927_006,
    showtimeId: "amc:showtime:145927006",
  },
  {
    file: "seats-146024502.json",
    sourceNumericShowtimeId: 146_024_502,
    numericShowtimeId: 146_024_502,
    showtimeId: "amc:showtime:146024502",
  },
  {
    file: "seats-146089621.json",
    sourceNumericShowtimeId: 146_089_621,
    numericShowtimeId: 146_089_621,
    showtimeId: "amc:showtime:146089621",
  },
] as const;

interface SeatFixtureSpec {
  readonly file: string;
  readonly sourceNumericShowtimeId: number;
  readonly numericShowtimeId: number;
  readonly showtimeId: string;
}

const THEATRE_CATALOGUE_GOLDENS = [
  "theatres-market-atlanta.golden.json",
  "theatres-market-san-francisco.golden.json",
];

interface GoldenTheatre {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly location: { readonly lat: number; readonly lng: number };
  readonly timezone: string;
  readonly city: string | null;
  readonly address: string | null;
  readonly slugs: Record<string, string> | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface GoldenTheatresFile {
  readonly ok: true;
  readonly value: readonly GoldenTheatre[];
}
interface CapturedFixtureFile {
  readonly url: string;
  readonly body: string;
}

function repoRoot(): string {
  // Compiled location: <repoRoot>/packages/durability/dist/scripts/seed-dev-fixtures.js
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..");
}

function providersFixturesDir(): string {
  return join(repoRoot(), "packages", "providers", "fixtures", "redacted");
}

function devFixturesDir(): string {
  return join(repoRoot(), "dev", "fixtures", "amc");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function mustWin<T>(
  db: SqlClient,
  statement: Statement,
  values: readonly unknown[],
): Promise<T> {
  const rows = await runStatement<T>(db, statement, values);
  const [row] = rows;
  if (row === undefined) {
    throw new Error(
      `${statement.name} (${statement.boundary}) returned 0 rows.\n` +
        `0 rows means: ${statement.zeroRowsMeans || "(no defined loser path)"}`,
    );
  }
  return row;
}

/** `provider_admission` + `provider_fence` rows — seed data, not a boundary. Mirrors
 * `test/support/fixtures.ts`'s `seedProvider`, reused inline (2 raw statements) rather than
 * imported, exactly as the plan calls for. */
async function seedProvider(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO provider_admission (provider_id, pending_cost_limit, unresolved_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider_id) DO NOTHING`,
    [PROVIDER_ID, 1000, 100],
  );
  await pool.query(
    `INSERT INTO provider_fence (provider_id) VALUES ($1) ON CONFLICT (provider_id) DO NOTHING`,
    [PROVIDER_ID],
  );
}

async function seedTheatreCatalogue(pool: Pool): Promise<number> {
  const db = poolClient(pool);
  let count = 0;
  for (const filename of THEATRE_CATALOGUE_GOLDENS) {
    const golden = await readJson<GoldenTheatresFile>(join(providersFixturesDir(), filename));
    for (const theatre of golden.value) {
      const slugs: TheatreSlugs | null = theatre.slugs;
      const [marketSlug] = Object.keys(theatre.slugs ?? {});
      const input: UpsertTheatreInput = {
        theatreId: theatre.id,
        providerId: theatre.providerId,
        name: theatre.name,
        lat: theatre.location.lat,
        lng: theatre.location.lng,
        marketSlug: marketSlug ?? null,
        timezone: theatre.timezone,
        city: theatre.city ?? null,
        address: theatre.address,
        slugs,
        firstSeenAt: new Date(theatre.firstSeenAt),
        lastSeenAt: new Date(theatre.lastSeenAt),
      };
      await upsertTheatre(db, input);
      count += 1;
    }
  }
  return count;
}

/** `RUN_KEY_UPSERT` → `RUN_CREATE` → `OUTBOX_CREATE_RUN` → `B2_LEASE_RUN` → `B4_PREDISPATCH`,
 * exactly the sequence `test/support/fixtures.ts`'s `dispatchRun` uses. Leaves the run ready
 * for `acceptFetch`/`stageScheduleAcceptance`. run_key_id is deterministic matching
 * `stageSearchCreation`'s scheme (`k_sched_${providerId}_${theatreId}_${localDate}` /
 * `k_fetch_${providerId}_${showtimeId}`) so a later real search converges via
 * RUN_KEY_UPSERT's ON CONFLICT (run_key_id) instead of colliding on the other unique index. */
async function createAndDispatchRun(
  db: SqlClient,
  key: {
    readonly kind: "SCHEDULE_RESOLUTION" | "SHOWTIME_FETCH";
    readonly routeClass: "schedule" | "seat";
    readonly showtimeId: string | null;
    readonly theatreId: string | null;
    readonly localDate: string | null;
  },
): Promise<RunHandle> {
  const keyId =
    key.kind === "SCHEDULE_RESOLUTION"
      ? `k_sched_${PROVIDER_ID}_${key.theatreId}_${key.localDate}`
      : `k_fetch_${PROVIDER_ID}_${key.showtimeId}`;
  await mustWin(db, RUN_KEY_UPSERT, [
    keyId,
    key.kind,
    PROVIDER_ID,
    key.routeClass,
    key.showtimeId,
    key.theatreId,
    key.localDate,
  ]);

  const runId = `run_${randomUUID()}`;
  const observationId = `obs_${randomUUID()}`;
  await mustWin(db, RUN_CREATE, [runId, keyId, observationId, null]);
  await mustWin(db, OUTBOX_CREATE_RUN, [runId, null]);
  const leased = await mustWin<{ generation: number }>(db, B2_LEASE_RUN, [runId, "5 minutes"]);
  await mustWin(db, B4_PREDISPATCH, [runId, leased.generation]);
  return { runId, generation: leased.generation };
}

type ParsedPerformance = ReturnType<typeof parseShowtimes>[number];

/** One captured performance re-dated onto its assigned window date. */
interface AssignedPerformance {
  readonly performance: ParsedPerformance;
  readonly originalNumeric: number;
  readonly derivedNumeric: number;
  readonly derivedShowtimeId: string;
  readonly targetDate: string;
}

/** Parse one theatre fixture and deterministically assign every performance to a random date
 * in `[SEED_LOCAL_DATE, SEED_LOCAL_DATE + SEED_WINDOW_DAYS - 1]` (see
 * `./seed-schedule-dates.js`). Returns the performances grouped by target date plus the
 * `originalNumeric → targetDate` map the seat fixtures resolve through. */
async function loadAssignedSchedule(spec: ScheduleFixtureSpec): Promise<{
  readonly groups: Map<string, AssignedPerformance[]>;
  readonly idToDate: Map<number, string>;
}> {
  const fixture = await readJson<CapturedFixtureFile>(
    join(devFixturesDir(), "schedule", spec.file),
  );
  const observationTime = new Date();
  const performancesRaw = parseShowtimes(fixture.body, observationTime, fixture.url);
  const pairs = performancesRaw.map((performance) => {
    const raw = performance.showtimeId.split(":").pop();
    if (raw === undefined)
      throw new Error(`loadAssignedSchedule: invalid showtimeId ${performance.showtimeId}`);
    const originalNumeric = Number(raw);
    if (!Number.isSafeInteger(originalNumeric)) {
      throw new Error(`loadAssignedSchedule: non-numeric showtimeId ${performance.showtimeId}`);
    }
    return { performance, originalNumeric };
  });
  const idToDate = assignFixtureDatesToWindow(
    pairs.map((pair) => pair.originalNumeric),
    SEED_LOCAL_DATE,
  );
  const groups = new Map<string, AssignedPerformance[]>();
  for (const { performance, originalNumeric } of pairs) {
    const targetDate = idToDate.get(originalNumeric);
    if (targetDate === undefined) {
      throw new Error(`loadAssignedSchedule: no assigned date for ${originalNumeric}`);
    }
    // Shift the fixture's baked 2026-08-13 timestamp to this performance's own assigned date
    // so it stays fresh. parseShowtimes parses showDateTimeUtc verbatim from the fixture HTML's
    // embedded JSON (PublicTheatreSchedule), not from observationTime; the whole-day offset
    // preserves the original local time-of-day.
    const offsetMs = daysBetween(ORIGINAL_FIXTURE_DATE, targetDate) * 86_400_000;
    const shifted =
      offsetMs === 0
        ? performance
        : {
            ...performance,
            showDateTimeUtc: new Date(performance.showDateTimeUtc.getTime() + offsetMs),
          };
    // Derive date-unique showtime IDs so the same captured fixture served for
    // different localDates never collides on performance.showtime_id PK. The
    // derivation is the shared pure function keyed on the performance's own
    // targetDate — same (original, date) → same output (see
    // packages/providers/src/dev-fixtures/showtime-id.ts).
    const derivedNumeric = deriveDevFixtureShowtimeId(originalNumeric, targetDate);
    const entry: AssignedPerformance = {
      performance: shifted,
      originalNumeric,
      derivedNumeric,
      derivedShowtimeId: `${PROVIDER_ID}:showtime:${derivedNumeric}`,
      targetDate,
    };
    const list = groups.get(targetDate);
    if (list === undefined) groups.set(targetDate, [entry]);
    else list.push(entry);
  }
  return { groups, idToDate };
}

/** SCHEDULE_RESOLUTION branch: real `parseShowtimes` output (already date-assigned by
 * `loadAssignedSchedule`) accepted through one run whose `localDate` equals the group's own
 * date — mirroring how a real production schedule fetch is one run per (theatre, date).
 * `stageScheduleAcceptance` writes every performance with `local_date` = the run's
 * `run_key.local_date`, so a group MUST be accepted through its own date's run. Same
 * acceptance composition the real RUN actor uses (`stageScheduleAcceptance` + `upsertMovie` +
 * `updatePerformanceProduct` in one transaction) — see
 * `apps/server/src/dispatch/handlers/provider-fetch-actor.ts`. */
async function seedScheduleGroup(
  pool: Pool,
  spec: ScheduleFixtureSpec,
  localDate: string,
  entries: readonly AssignedPerformance[],
): Promise<{ readonly showtimeCount: number; readonly movieCount: number }> {
  const db = poolClient(pool);
  const handle = await createAndDispatchRun(db, {
    kind: "SCHEDULE_RESOLUTION",
    routeClass: "schedule",
    showtimeId: null,
    theatreId: spec.theatreId,
    localDate,
  });

  const observationTime = new Date();
  const showtimes: ScheduleShowtime[] = entries.map(({ performance, derivedShowtimeId }) => ({
    showtimeId: derivedShowtimeId,
    movieId: performance.movieId,
    startsAt: performance.showDateTimeUtc,
    skipFetch: performancePolicy(performance.status) === "SKIP_SOLD_OUT",
  }));

  await withTransaction(pool, async (tx) => {
    await stageScheduleAcceptance(tx, handle, showtimes, { capturedAt: observationTime });

    const movies = new Map<string, string>();
    for (const { performance } of entries) {
      movies.set(performance.movieId, performance.movieTitle);
    }
    for (const [movieId, title] of movies) {
      await upsertMovie(tx, {
        movieId,
        providerId: PROVIDER_ID,
        title,
        firstSeenAt: observationTime,
        lastSeenAt: observationTime,
      });
    }

    for (const { performance, derivedShowtimeId } of entries) {
      await updatePerformanceProduct(tx, {
        showtimeId: derivedShowtimeId,
        movieId: performance.movieId,
        auditorium: performance.auditorium == null ? null : String(performance.auditorium),
        utcOffset: performance.utcOffset,
        runtimeMinutes: performance.runtimeMinutes,
        status: performance.status,
        formatCode: performance.formatCode,
        minPrice: null,
        deepLinkUrl: performance.deepLinkUrl,
        providerMeta: performance.providerMeta,
        layoutId: null,
        updatedAt: observationTime,
      });
    }
  });

  return {
    showtimeCount: entries.length,
    movieCount: new Set(entries.map((entry) => entry.performance.movieId)).size,
  };
}

/** SHOWTIME_FETCH branch: real `parseSeats` + `buildAuditoriumLayout` + the real `acceptFetch`
 * transaction — same composition `apps/server/src/dispatch/handlers/parse-observation.ts` and
 * `provider-fetch-actor.ts` use for a live seat fetch. */
async function seedSeats(
  pool: Pool,
  fixtureSpec: SeatFixtureSpec,
  resolvedLocalDate: string,
): Promise<{
  readonly freeCount: number;
  readonly totalSeats: number;
  readonly derivedShowtimeId: string;
  readonly derivedNumericShowtimeId: number;
  readonly resolvedLocalDate: string;
}> {
  // Two-stage re-key: on-disk source → captured ID (existing replaceAll), then
  // captured → date-unique derived ID via the shared pure function keyed on
  // resolvedLocalDate — the date this performance actually landed on in the
  // schedule assignment (looked up from the combined id→date map in main), so
  // the seat map matches the schedule's derived performance. Preserve the
  // first stage verbatim; the second stage is the fix for the PK collision.
  const derivedNumericShowtimeId = deriveDevFixtureShowtimeId(
    fixtureSpec.numericShowtimeId,
    resolvedLocalDate,
  );
  const derivedShowtimeId = `${PROVIDER_ID}:showtime:${derivedNumericShowtimeId}`;
  const fixtureRawAfterTwoStages = fixtureRawAfterDerivation(
    await readFile(join(devFixturesDir(), "seats", fixtureSpec.file), "utf8"),
    fixtureSpec,
    derivedNumericShowtimeId,
  );
  const fixture = JSON.parse(fixtureRawAfterTwoStages) as CapturedFixtureFile;
  const db = poolClient(pool);
  const handle = await createAndDispatchRun(db, {
    kind: "SHOWTIME_FETCH",
    routeClass: "seat",
    showtimeId: derivedShowtimeId,
    theatreId: null,
    localDate: null,
  });

  const observationTime = new Date();
  const result = parseSeats(fixture.body, observationTime, fixture.url, derivedNumericShowtimeId);
  const built = buildAuditoriumLayout(result.grid);
  const totalSeats = built.layout.rows * built.layout.columns;
  const freeCount = popcount(built.availability, totalSeats);

  await withTransaction(pool, (tx) =>
    acceptFetch(tx, handle, {
      bitmap: Buffer.from(built.availability),
      freeCount,
      capturedAt: observationTime,
    }),
  );

  return { freeCount, totalSeats, derivedShowtimeId, derivedNumericShowtimeId, resolvedLocalDate };
}

function fixtureRawAfterDerivation(
  raw: string,
  spec: SeatFixtureSpec,
  derivedNumericShowtimeId: number,
): string {
  // Stage 1: on-disk file ID → captured ID (existing behaviour, e.g. Metreon 145927008 → 145927006)
  // Stage 2: captured ID → date-unique derived ID (new fix, keyed on the performance's resolved date)
  const afterStage1 = raw.replaceAll(
    String(spec.sourceNumericShowtimeId),
    String(spec.numericShowtimeId),
  );
  return afterStage1.replaceAll(String(spec.numericShowtimeId), String(derivedNumericShowtimeId));
}

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    process.stderr.write("DATABASE_URL is required\n");
    process.exitCode = 64;
    return;
  }

  const pool = createPool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 30_000,
  });

  try {
    await seedProvider(pool);
    const theatreCount = await seedTheatreCatalogue(pool);

    const windowEnd = addLocalDays(SEED_LOCAL_DATE, SEED_WINDOW_DAYS - 1);

    const scheduleResults: string[] = [];
    const showtimeDateByOriginalId = new Map<number, string>();
    for (const spec of SCHEDULE_FIXTURES) {
      const { groups, idToDate } = await loadAssignedSchedule(spec);
      for (const [originalNumeric, targetDate] of idToDate) {
        const existing = showtimeDateByOriginalId.get(originalNumeric);
        if (existing !== undefined && existing !== targetDate) {
          throw new Error(
            `seed-dev-fixtures: original showtime id ${originalNumeric} assigned to both ${existing} and ${targetDate} — fixture ids are expected to be unique across schedule fixtures`,
          );
        }
        showtimeDateByOriginalId.set(originalNumeric, targetDate);
      }
      let showtimeCount = 0;
      const orderedDates = [...groups.keys()].sort();
      for (const targetDate of orderedDates) {
        const entries = groups.get(targetDate);
        if (entries === undefined)
          throw new Error(`seed-dev-fixtures: missing group for ${targetDate}`);
        const result = await seedScheduleGroup(pool, spec, targetDate, entries);
        showtimeCount += result.showtimeCount;
      }
      // Distinct movies across all of this theatre's groups (a movie may span dates).
      const distinctMovies = new Set<string>();
      for (const entries of groups.values()) {
        for (const entry of entries) distinctMovies.add(entry.performance.movieId);
      }
      const movieCount = distinctMovies.size;
      scheduleResults.push(
        `  ${spec.theatreId}: ${showtimeCount} showtimes, ${movieCount} movies across ${groups.size} dates (${orderedDates.join(", ")})`,
      );
    }
    const seatResults: string[] = [];
    for (const spec of SEAT_FIXTURES) {
      const resolvedLocalDate = showtimeDateByOriginalId.get(spec.numericShowtimeId);
      if (resolvedLocalDate === undefined) {
        throw new Error(
          `seed-dev-fixtures: seat fixture ${spec.file} references numeric showtime id ${spec.numericShowtimeId}, which no schedule fixture assigned — fixture mismatch, refusing to guess a date`,
        );
      }
      const result = await seedSeats(pool, spec, resolvedLocalDate);
      seatResults.push(
        `  ${result.derivedShowtimeId} (${result.resolvedLocalDate}): ${result.freeCount}/${result.totalSeats} seats free`,
      );
    }
    process.stdout.write(
      [
        "seed-dev-fixtures: done",
        `  provider: ${PROVIDER_ID}`,
        `  theatres seeded: ${theatreCount}`,
        `  window: ${SEED_LOCAL_DATE}..${windowEnd} (${SEED_WINDOW_DAYS} days)`,
        "  schedules seeded:",
        ...scheduleResults,
        "  seat maps seeded:",
        ...seatResults,
        "",
        `Query dates ${SEED_LOCAL_DATE}..${windowEnd} against the theatres above to see real seeded showtimes.`,
        "Recheck any seat-map showtime above (against its theatre's schedule fixture) to exercise the seeded seat map.",
      ].join("\n") + "\n",
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`seed-dev-fixtures failed: ${String(error)}\n`);
  process.exit(1);
});
