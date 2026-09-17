import { describe, expect, it } from "vitest";

import { checkInvariants, formatViolations } from "../src/invariants.js";

import {
  acceptFetch,
  acceptSchedule,
  createSearch,
  dispatchRun,
  expireSearchDeadline,
  failRun,
  fetchKey,
  PROVIDER,
  scheduleKey,
  seedProvider,
  subscribe,
  terminalize,
  type KeyFixture,
  type SearchFixture,
} from "./support/fixtures.js";
import { type Db, session, useDatabase } from "./support/pg.js";
import {
  regressionSeeds,
  replayDiagnostic,
  SeededRandom,
  type Weighted,
} from "./support/random.js";

const LOCAL_TIMEOUT = 120_000;
type ScheduleOutcome = "RESOLVED" | "EMPTY_RESOLVED" | "FAILED";
type FetchOutcome = "ACCEPTED" | "FAILED" | "PENDING";
type JobState = "PENDING" | "DONE" | "FAILED" | "CANCELLED";
type SubscriptionState = "LIVE" | "SATISFIED" | "CANCELLED" | "EXPIRED";
type TerminalStatus = "COMPLETE" | "PARTIAL" | "HALTED";
type TerminalCause = "TOO_FEW_SHOWTIMES" | "PARTIAL_SCHEDULE" | null;

interface ExpectedTerminal {
  readonly status: TerminalStatus;
  readonly cause: TerminalCause;
}

interface TransitionProgress {
  index: number;
  label: string;
}

interface SearchPlan {
  readonly name: string;
  readonly scheduleKeys: string[];
  readonly warmFetchKeys: string[];
  readonly deadline: boolean;
}

interface SchedulePlan {
  readonly label: string;
  readonly subscribers: string[];
  readonly stage1Share: number;
  readonly outcome: ScheduleOutcome;
  readonly showtimeKeys: string[];
}

interface FetchPlan {
  readonly label: string;
  readonly outcome: FetchOutcome;
}

interface WorldPlan {
  readonly searches: SearchPlan[];
  readonly schedules: SchedulePlan[];
  readonly fetches: FetchPlan[];
}

interface JobModel {
  readonly kind: "SHOWTIME_FETCH" | "SCHEDULE_RESOLUTION";
  state: JobState;
}

interface SubscriptionModel {
  state: SubscriptionState;
  outcome: ScheduleOutcome | null;
  admissionCounted: boolean;
  /**
   * S36: mirrors `run_subscription.schedule_match_count` — null until the schedule
   * settles, then 0 for FAILED (a failed date contributes nothing to the durable
   * aggregate, distinct from EMPTY_RESOLVED which is also 0 via an empty showtime list)
   * or the matched showtime count for RESOLVED/EMPTY_RESOLVED. Unused for SHOWTIME_FETCH
   * subscriptions (always null).
   */
  scheduleMatchCount: number | null;
}

interface SearchModel {
  readonly name: string;
  readonly fixture: SearchFixture;
  total: number;
  remaining: number;
  released: boolean;
  readonly heldSchedules: Set<string>;
  /**
   * S36: mirrors `admission_reservation.schedule_slot_held AND NOT schedule_reconciled`.
   * One slot per search regardless of schedule-key count; true from creation for any cold
   * search, flips false the moment every SCHEDULE_RESOLUTION subscription is terminal
   * (accepted or failed — B6_RECONCILE_SEARCH_WIDE fires search-wide, not per key), or at
   * release. `heldSchedules` above tracks outstanding per-key coverage for other
   * assertions and must not be reused for slot accounting (that is exactly last state's
   * bug: it desyncs on FAILED keys, which never leave `heldSchedules`).
   */
  scheduleSlotHeld: boolean;
  readonly jobs: Map<string, JobModel>;
  readonly subscriptions: Map<string, SubscriptionModel>;
  readonly events: string[];
  applications: number;
  acceptedFetches: number;
  /** Sum of the `freeCount`s of every accepted fetch — the model's free-seat accounting. */
  freeSeats: number;
  terminal: TerminalStatus | null;
  terminalCause: TerminalCause;
  finalPayload: unknown;
  finalAnswer: ExpectedAnswer | null;
}

/**
 * The model's expected reveal answer. Generated worlds pass `skipFetch: false` for every
 * showtime and supply no placement evidence, so every reachable answer is an EMPTY row;
 * the cause set is the four EMPTY rows those worlds can reach.
 */
interface ExpectedAnswer {
  readonly mode: "EMPTY";
  readonly cause:
    "HALTED" | "NO_SHAPE_MATCH" | "SOLD_OUT" | "PARTIAL_SCHEDULE" | "TOO_FEW_SHOWTIMES";
  readonly suggestions: readonly [];
}

const weighted = <T>(rng: SeededRandom, choices: readonly Weighted<T>[]): T =>
  rng.weighted(choices);

function generatePlan(seed: number): WorldPlan {
  const rng = new SeededRandom(seed);
  const searches: SearchPlan[] = [];
  const schedules: SchedulePlan[] = [];
  const fetches = new Map<string, FetchPlan>();
  const addFetch = (label: string, outcome: FetchOutcome) => {
    fetches.set(label, { label, outcome });
  };
  const addSearch = (
    name: string,
    scheduleKeys: string[],
    warmFetchKeys: string[] = [],
    deadline = false,
  ) => searches.push({ name, scheduleKeys, warmFetchKeys, deadline });

  // Forced COMPLETE warm path, with both accepted and exhausted fetch coverage.
  const warmKeys = Array.from({ length: rng.integer(2, 3) }, (_, index) => `warm_${index}`);
  warmKeys.forEach((label, index) =>
    addFetch(
      label,
      index === 0 ? "ACCEPTED" : index === 1 ? "FAILED" : weighted(rng, fetchOutcomeWeights),
    ),
  );
  addSearch("complete_warm", [], warmKeys);

  // Forced deadline PARTIAL with live fetch work at B8.
  const partialSchedules = Array.from(
    { length: rng.integer(1, 3) },
    (_, index) => `partial_schedule_${index}`,
  );
  partialSchedules.forEach((label, index) => {
    const showtimeKeys =
      index === 0
        ? Array.from({ length: rng.integer(2, 3) }, (_, fanout) => `partial_fetch_${fanout}`)
        : [];
    schedules.push({
      label,
      subscribers: ["partial_deadline"],
      stage1Share: rng.integer(1, 3),
      outcome: showtimeKeys.length > 0 ? "RESOLVED" : "EMPTY_RESOLVED",
      showtimeKeys,
    });
    showtimeKeys.forEach((fetchLabel, fanout) =>
      addFetch(fetchLabel, fanout === 0 ? "ACCEPTED" : "PENDING"),
    );
  });
  addSearch("partial_deadline", partialSchedules, [], true);

  // Forced HALTED and randomized 2..N failed schedule coverage. Every failed key keeps its
  // admission_counted slot until B8, structurally exercising a multi-slot release.
  const haltedSchedules = Array.from(
    { length: rng.integer(2, 3) },
    (_, index) => `halted_schedule_${index}`,
  );
  haltedSchedules.forEach((label) =>
    schedules.push({
      label,
      subscribers: ["halted_schedules"],
      stage1Share: rng.integer(1, 3),
      outcome: "FAILED",
      showtimeKeys: [],
    }),
  );
  addSearch("halted_schedules", haltedSchedules);

  // Forced N-schedule cumulative accounting: two RESOLVED keys and at least one EMPTY.
  const nSchedules = Array.from({ length: rng.integer(3, 4) }, (_, index) => `n_schedule_${index}`);
  nSchedules.forEach((label, index) => {
    const outcome: ScheduleOutcome = index === 1 ? "EMPTY_RESOLVED" : "RESOLVED";
    const showtimeKeys =
      outcome === "RESOLVED"
        ? Array.from({ length: rng.integer(1, 2) }, (_, fanout) => `n_fetch_${index}_${fanout}`)
        : [];
    schedules.push({
      label,
      subscribers: ["n_schedule_complete"],
      stage1Share: rng.integer(1, 3),
      outcome,
      showtimeKeys,
    });
    showtimeKeys.forEach((fetchLabel, fanout) =>
      addFetch(
        fetchLabel,
        index === 0 && fanout === 0 ? "ACCEPTED" : weighted(rng, fetchOutcomeWeights),
      ),
    );
  });
  addSearch("n_schedule_complete", nSchedules);

  // Equal stage-1 shares are deliberate for a shared schedule fixture. Its expanded fetch
  // keys are shared too, so one schedule run and each one fetch run fan into both parents.
  const sharedFanout = rng.integer(1, 3);
  const sharedFetches = Array.from({ length: sharedFanout }, (_, index) => `shared_fetch_${index}`);
  schedules.push({
    label: "shared_schedule",
    subscribers: ["shared_a", "shared_b"],
    stage1Share: rng.integer(1, 3),
    outcome: "RESOLVED",
    showtimeKeys: sharedFetches,
  });
  sharedFetches.forEach((label) => addFetch(label, "ACCEPTED"));
  addSearch("shared_a", ["shared_schedule"]);
  addSearch("shared_b", ["shared_schedule"]);

  // One genuinely generated world member broadens reachability without making essential
  // COMPLETE/PARTIAL/HALTED/shared/N coverage depend on chance.
  if (rng.pick(["warm", "cold"] as const) === "warm") {
    const keys = Array.from({ length: rng.integer(1, 3) }, (_, index) => `random_warm_${index}`);
    keys.forEach((label) => addFetch(label, weighted(rng, fetchOutcomeWeights)));
    addSearch("randomized", [], keys);
  } else {
    const keys = Array.from(
      { length: rng.integer(1, 3) },
      (_, index) => `random_schedule_${index}`,
    );
    keys.forEach((label, index) => {
      const outcome = weighted(rng, scheduleOutcomeWeights);
      const showtimeKeys =
        outcome === "RESOLVED"
          ? Array.from(
              { length: rng.integer(1, 3) },
              (_, fanout) => `random_fetch_${index}_${fanout}`,
            )
          : [];
      schedules.push({
        label,
        subscribers: ["randomized"],
        stage1Share: rng.integer(1, 3),
        outcome,
        showtimeKeys,
      });
      showtimeKeys.forEach((fetchLabel) =>
        addFetch(fetchLabel, weighted(rng, fetchOutcomeWeights)),
      );
    });
    addSearch("randomized", keys);
  }

  return { searches, schedules, fetches: [...fetches.values()] };
}

const fetchOutcomeWeights = [
  { value: "ACCEPTED", weight: 3 },
  { value: "FAILED", weight: 2 },
] as const satisfies readonly Weighted<FetchOutcome>[];
const scheduleOutcomeWeights = [
  { value: "RESOLVED", weight: 4 },
  { value: "EMPTY_RESOLVED", weight: 2 },
  { value: "FAILED", weight: 2 },
] as const satisfies readonly Weighted<ScheduleOutcome>[];

async function inTransaction<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const result = await work();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

function mapByLabel<T extends { readonly label: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.label, value]));
}

async function assertWorld(db: Db, models: Map<string, SearchModel>): Promise<void> {
  const violations = await checkInvariants(db);
  expect(violations, formatViolations(violations)).toEqual([]);

  const expectedPending = [...models.values()].reduce(
    (sum, model) => sum + (model.released ? 0 : model.remaining),
    0,
  );
  // S36: unresolved_schedules is a count of searches currently holding their one
  // search-wide slot, not a sum of outstanding per-key coverage (heldSchedules tracks the
  // latter for other assertions and must not be reused here).
  const expectedUnresolved = [...models.values()].filter(
    (model) => model.scheduleSlotHeld && !model.released,
  ).length;
  const admission = await db.one<{
    pending_cost: string;
    pending_cost_limit: string;
    unresolved_schedules: number;
    unresolved_limit: number;
  }>(
    `SELECT pending_cost, pending_cost_limit, unresolved_schedules, unresolved_limit
     FROM provider_admission WHERE provider_id = $1`,
    [PROVIDER],
  );
  expect(Number(admission.pending_cost)).toBe(expectedPending);
  expect(admission.unresolved_schedules).toBe(expectedUnresolved);
  expect(Number(admission.pending_cost)).toBeLessThanOrEqual(Number(admission.pending_cost_limit));
  expect(admission.unresolved_schedules).toBeLessThanOrEqual(admission.unresolved_limit);

  const duplicateApplications = await db.rows(
    `SELECT run_id, search_id, count(*) AS n FROM run_application
     GROUP BY run_id, search_id HAVING count(*) > 1`,
  );
  expect(duplicateApplications).toEqual([]);

  for (const model of models.values()) {
    const reservation = await db.one<{
      reserved_total: string;
      reserved_remaining: string;
      released: boolean;
    }>(
      `SELECT reserved_total, reserved_remaining, released
       FROM admission_reservation WHERE search_id = $1`,
      [model.fixture.searchId],
    );
    expect(reservation).toEqual({
      reserved_total: String(model.total),
      reserved_remaining: String(model.remaining),
      released: model.released,
    });

    const search = await db.one<{
      status: string;
      terminal_cause: TerminalCause;
      next_seq: string;
    }>(`SELECT status, terminal_cause, next_seq FROM search WHERE search_id = $1`, [
      model.fixture.searchId,
    ]);
    if (model.terminal !== null) {
      expect({ status: search.status, cause: search.terminal_cause }).toEqual({
        status: model.terminal,
        cause: model.terminalCause,
      });
    } else {
      expect(["PENDING_SCHEDULE", "RUNNING"]).toContain(search.status);
      expect(search.terminal_cause).toBeNull();
    }
    expect(Number(search.next_seq)).toBe(model.events.length);

    const events = await db.rows<{ seq: string; type: string }>(
      `SELECT seq, type FROM search_event WHERE search_id = $1 ORDER BY seq`,
      [model.fixture.searchId],
    );
    expect(events.map((event) => Number(event.seq))).toEqual(
      Array.from({ length: model.events.length }, (_, index) => index + 1),
    );
    expect(events.map((event) => event.type)).toEqual(model.events);

    // S6U3.8 — the model enforces the reveal contract: exactly the SEARCH_TERMINAL
    // event carries an `answer`, and its payload is the widened { status, cause, answer }.
    const payloads = await db.rows<{ type: string; payload: unknown }>(
      `SELECT type, payload FROM search_event WHERE search_id = $1 ORDER BY seq`,
      [model.fixture.searchId],
    );
    for (const row of payloads) {
      const hasAnswer =
        typeof row.payload === "object" && row.payload !== null && "answer" in row.payload;
      expect(
        row.type === "SEARCH_TERMINAL" ? hasAnswer : !hasAnswer,
        `reveal contract violated by ${row.type} row`,
      ).toBe(true);
    }
    if (model.terminal !== null) {
      expect(payloads.at(-1)).toEqual({
        type: "SEARCH_TERMINAL",
        payload: {
          status: model.terminal,
          cause: model.terminalCause,
          answer: model.finalAnswer,
        },
      });
    }

    const jobs = await db.rows<{ run_key_id: string; kind: JobModel["kind"]; state: JobState }>(
      `SELECT run_key_id, kind, state FROM search_job WHERE search_id = $1 ORDER BY run_key_id`,
      [model.fixture.searchId],
    );
    expect(jobs).toHaveLength(model.jobs.size);
    for (const job of jobs) expect(job).toMatchObject(model.jobs.get(job.run_key_id)!);
    const jobOutbox = await db.one<{ total: string; distinct_jobs: string }>(
      `SELECT count(*) AS total, count(DISTINCT o.job_id) AS distinct_jobs
       FROM outbox o JOIN search_job j ON j.job_id = o.job_id
       WHERE j.search_id = $1 AND o.target_kind = 'JOB'`,
      [model.fixture.searchId],
    );
    expect(jobOutbox).toEqual({
      total: String(model.jobs.size),
      distinct_jobs: String(model.jobs.size),
    });

    const subscriptions = await db.rows<{
      run_key_id: string;
      state: SubscriptionState;
      schedule_outcome: ScheduleOutcome | null;
    }>(
      `SELECT run_key_id, state, schedule_outcome
       FROM run_subscription WHERE search_id = $1 ORDER BY run_key_id`,
      [model.fixture.searchId],
    );
    expect(subscriptions).toHaveLength(model.subscriptions.size);
    for (const [expectedRunKeyId, expected] of model.subscriptions) {
      const subscription = subscriptions.find((row) => row.run_key_id === expectedRunKeyId);
      expect(subscription).toEqual({
        run_key_id: expectedRunKeyId,
        state: expected.state,
        schedule_outcome: expected.outcome,
      });
    }

    const applications = await db.one<{ n: string }>(
      `SELECT count(*) AS n FROM run_application WHERE search_id = $1`,
      [model.fixture.searchId],
    );
    expect(Number(applications.n)).toBe(model.applications);

    const versions = await db.rows<{ payload: unknown }>(
      `SELECT payload FROM search_result_version WHERE search_id = $1 ORDER BY version`,
      [model.fixture.searchId],
    );
    expect(versions).toHaveLength(model.terminal === null ? 0 : 1);
    const terminalEvents = model.events.filter((event) => event === "SEARCH_TERMINAL");
    expect(terminalEvents).toHaveLength(model.terminal === null ? 0 : 1);
    if (model.terminal !== null) {
      expect(versions[0]?.payload).toEqual(model.finalPayload);
      expect(jobs.some((job) => job.state === "PENDING")).toBe(false);
      expect(subscriptions.some((subscription) => subscription.state === "LIVE")).toBe(false);
    }
  }
}

function expectedTerminal(model: SearchModel): ExpectedTerminal {
  const scheduleOutcomes = [...model.subscriptions.entries()]
    .filter(([key]) => model.jobs.get(key)?.kind === "SCHEDULE_RESOLUTION")
    .map(([, subscription]) => subscription.outcome);
  const allSchedulesEmpty =
    scheduleOutcomes.length > 0 &&
    scheduleOutcomes.every((outcome) => outcome === "EMPTY_RESOLVED");
  const mixedScheduleCoverage =
    scheduleOutcomes.some((outcome) => outcome === "FAILED") &&
    scheduleOutcomes.some((outcome) => outcome !== "FAILED");
  const cause: TerminalCause = allSchedulesEmpty
    ? "TOO_FEW_SHOWTIMES"
    : mixedScheduleCoverage
      ? "PARTIAL_SCHEDULE"
      : null;

  if (scheduleOutcomes.length > 0 && scheduleOutcomes.every((outcome) => outcome === "FAILED")) {
    return { status: "HALTED", cause };
  }
  if (mixedScheduleCoverage) return { status: "PARTIAL", cause };
  if ([...model.jobs.values()].some((job) => job.state === "PENDING")) {
    return { status: "PARTIAL", cause };
  }
  // ADR 0009 review: this model predicts B8's persisted status, not the ranked answer.
  // A fully policy-skipped schedule creates zero SHOWTIME_FETCH jobs and B8 still derives
  // COMPLETE for it (both HALTED branches here require a fetch job to exist); the widened
  // absence-of-data guard in deriveRankedAnswer turns that state's *answer* into HALTED,
  // which is tier 3's domain. Generated worlds pass skipFetch: false for every showtime,
  // so `!hasFetch` remains "every schedule key resolved empty" and this branch is exact.
  const hasFetch = [...model.jobs.values()].some((job) => job.kind === "SHOWTIME_FETCH");
  if (hasFetch && model.acceptedFetches === 0) return { status: "HALTED", cause };
  return { status: "COMPLETE", cause };
}

/**
 * The model's hand-derivation of the reveal answer from ADR 0003 §6 plus ADR 0009's
 * widened absence-of-data guard — independent accounting over `acceptedFetches` and
 * `freeSeats`, never a call into `deriveRankedAnswer`. Generated worlds supply no
 * placement evidence, so only EMPTY rows are reachable (fixtures' S6U3.2 default).
 */
function expectedAnswer(model: SearchModel, expected: ExpectedTerminal): ExpectedAnswer {
  const empty = (cause: ExpectedAnswer["cause"]): ExpectedAnswer => ({
    mode: "EMPTY",
    cause,
    suggestions: [],
  });
  if (expected.status === "HALTED") return empty("HALTED");
  if (expected.cause === "PARTIAL_SCHEDULE") return empty("PARTIAL_SCHEDULE");
  if (expected.cause === "TOO_FEW_SHOWTIMES") return empty("TOO_FEW_SHOWTIMES");
  // Cause-null COMPLETE/PARTIAL: no accepted fetch observation is absence of data,
  // never evidence of seats (ADR 0009) — and no evidence ever HEDGED/CONFIDENT.
  if (model.acceptedFetches === 0) return empty("HALTED");
  if (model.freeSeats > 0) return empty("NO_SHAPE_MATCH");
  return expected.status === "COMPLETE" ? empty("SOLD_OUT") : empty("HALTED");
}

function markTerminal(model: SearchModel, expected: ExpectedTerminal): void {
  model.terminal = expected.status;
  model.terminalCause = expected.cause;
  model.finalAnswer = expectedAnswer(model, expected);
  model.finalPayload = { status: expected.status, answer: model.finalAnswer };
  model.events.push("SEARCH_TERMINAL");
  model.remaining = 0;
  model.released = true;
  model.heldSchedules.clear();
  model.scheduleSlotHeld = false;
  for (const job of model.jobs.values()) if (job.state === "PENDING") job.state = "CANCELLED";
  for (const subscription of model.subscriptions.values()) {
    if (subscription.state === "LIVE") subscription.state = "EXPIRED";
    subscription.admissionCounted = false;
  }
}

function beginTransition(progress: TransitionProgress, label: string): void {
  progress.index++;
  progress.label = label;
}

async function runRandomWorld(
  db: Db,
  seed: number,
  plan: WorldPlan,
  progress: TransitionProgress,
): Promise<void> {
  const rng = new SeededRandom(seed ^ 0x9e37_79b9);
  const models = new Map<string, SearchModel>();
  const schedulePlans = mapByLabel(plan.schedules);
  const fetchPlans = mapByLabel(plan.fetches);
  const scheduleKeys = new Map<string, KeyFixture>();
  const fetchKeys = new Map<string, KeyFixture>();

  beginTransition(progress, "seed provider admission");
  await seedProvider(db, { pendingCostLimit: 10_000, unresolvedLimit: 1_000 });

  for (const searchPlan of rng.shuffle(plan.searches)) {
    beginTransition(progress, `create search ${searchPlan.name}`);
    await inTransaction(db, async () => {
      const ownedSchedules = searchPlan.scheduleKeys.map((label) => schedulePlans.get(label)!);
      const reserve =
        ownedSchedules.length > 0
          ? ownedSchedules.reduce((sum, schedule) => sum + schedule.stage1Share, 0)
          : searchPlan.warmFetchKeys.length;
      // S36: coldDelta MUST be 0 or 1 (one search-wide slot), never the raw schedule-key
      // count — see fixtures.ts's createSearch doc comment for the desync this caused.
      const fixture = await createSearch(db, ownedSchedules.length > 0 ? 1 : 0, { reserve });
      const model: SearchModel = {
        name: searchPlan.name,
        fixture,
        total: reserve,
        remaining: reserve,
        released: false,
        scheduleSlotHeld: ownedSchedules.length > 0,
        heldSchedules: new Set(),
        jobs: new Map(),
        subscriptions: new Map(),
        events: [],
        applications: 0,
        acceptedFetches: 0,
        terminal: null,
        terminalCause: null,
        finalPayload: undefined,
        freeSeats: 0,
        finalAnswer: null,
      };

      for (const label of searchPlan.scheduleKeys) {
        let key = scheduleKeys.get(label);
        if (!key) {
          key = await scheduleKey(db, `theatre_${label}`, "2026-08-02");
          scheduleKeys.set(label, key);
        }
        await subscribe(db, fixture, key);
        model.heldSchedules.add(key.runKeyId);
        model.jobs.set(key.runKeyId, { kind: "SCHEDULE_RESOLUTION", state: "PENDING" });
        model.subscriptions.set(key.runKeyId, {
          state: "LIVE",
          outcome: null,
          admissionCounted: true,
          scheduleMatchCount: null,
        });
      }
      for (const label of searchPlan.warmFetchKeys) {
        let key = fetchKeys.get(label);
        if (!key) {
          key = await fetchKey(db, `showtime_${label}`);
          fetchKeys.set(label, key);
        }
        await subscribe(db, fixture, key);
        model.jobs.set(key.runKeyId, { kind: "SHOWTIME_FETCH", state: "PENDING" });
        model.subscriptions.set(key.runKeyId, {
          state: "LIVE",
          outcome: null,
          admissionCounted: false,
          scheduleMatchCount: null,
        });
      }
      models.set(searchPlan.name, model);
    });
    await assertWorld(db, models);
  }

  const sharedScheduleFanIn: number[] = [];
  for (const schedulePlan of rng.shuffle(plan.schedules)) {
    const key = scheduleKeys.get(schedulePlan.label)!;
    beginTransition(progress, `dispatch schedule ${schedulePlan.label}`);
    const subscribers = schedulePlan.subscribers.map((name) => models.get(name)!);
    const run = await dispatchRun(db, key);
    await assertWorld(db, models);
    beginTransition(progress, `settle schedule ${schedulePlan.label} as ${schedulePlan.outcome}`);
    if (schedulePlan.outcome === "FAILED") {
      const result = await failRun(db, run);
      expect(result.affected).toHaveLength(subscribers.length);
      for (const model of subscribers) {
        model.jobs.get(key.runKeyId)!.state = "FAILED";
        const subscription = model.subscriptions.get(key.runKeyId)!;
        subscription.state = "CANCELLED";
        subscription.outcome = "FAILED";
        subscription.scheduleMatchCount = 0;
        model.events.push("FETCH_FAILED");
      }
    } else {
      const showtimes = schedulePlan.showtimeKeys.map((label, index) => ({
        showtimeId: `showtime_${label}`,
        movieId: "amc:movie:test",
        startsAt: new Date(Date.UTC(2026, 7, 2, 12 + index)),
        skipFetch: false,
      }));
      const result = await acceptSchedule(db, run, showtimes, {
        stage1Share: schedulePlan.stage1Share,
      });
      expect(new Set(result.expandedFor)).toEqual(
        new Set(subscribers.map((model) => model.fixture.searchId)),
      );
      if (schedulePlan.subscribers.length > 1) sharedScheduleFanIn.push(result.fannedIn.length);
      for (const model of subscribers) {
        model.jobs.get(key.runKeyId)!.state = "DONE";
        const subscription = model.subscriptions.get(key.runKeyId)!;
        subscription.state = "SATISFIED";
        subscription.outcome = schedulePlan.outcome;
        subscription.admissionCounted = false;
        subscription.scheduleMatchCount = schedulePlan.showtimeKeys.length;
        model.heldSchedules.delete(key.runKeyId);
        model.events.push("FETCH_ACCEPTED");
        model.applications++;

        for (const fetchLabel of schedulePlan.showtimeKeys) {
          const fetchPlan = fetchPlans.get(fetchLabel);
          expect(fetchPlan, `missing fetch plan for expanded key ${fetchLabel}`).toBeDefined();
          if (!fetchPlan) throw new Error(`missing fetch plan for expanded key ${fetchLabel}`);
          expect(fetchPlan.label).toBe(fetchLabel);
          let fetch = fetchKeys.get(fetchLabel);
          if (!fetch) {
            fetch = await fetchKey(db, `showtime_${fetchLabel}`);
            fetchKeys.set(fetchLabel, fetch);
          }
          model.jobs.set(fetch.runKeyId, { kind: "SHOWTIME_FETCH", state: "PENDING" });
          model.subscriptions.set(fetch.runKeyId, {
            state: "LIVE",
            outcome: null,
            admissionCounted: false,
            scheduleMatchCount: null,
          });
        }
      }
    }
    // S36: B6_RECONCILE_SEARCH_WIDE fires once every SCHEDULE_RESOLUTION subscription for
    // a search is terminal (accepted or failed — reconciliation is search-wide, not
    // per-key), releasing that search's one admission slot. Mirror it here so
    // `scheduleSlotHeld` matches `admission_reservation.schedule_slot_held AND NOT
    // schedule_reconciled` at every `assertWorld` check, including mid-run ones before
    // this search's own terminalization.
    for (const model of subscribers) {
      if (!model.scheduleSlotHeld) continue;
      const scheduleSubs = [...model.subscriptions.entries()].filter(
        ([runKeyId]) => model.jobs.get(runKeyId)?.kind === "SCHEDULE_RESOLUTION",
      );
      if (scheduleSubs.some(([, subscription]) => subscription.outcome === null)) continue;
      // S36: reconciliation replaces the provisional reservation with the durable
      // aggregate in one shot (fresh_match_seed is always 0 in this fuzzer — no search
      // here mixes warm and cold work) minus whatever this reservation has already
      // spent (always 0 here: fetches dispatch only after every schedule in the plan
      // has settled), mirroring B6_RECONCILE_SEARCH_WIDE exactly — never a per-key sum
      // of (showtimeKeys.length - stage1Share) applied incrementally, which double
      // counts nothing for RESOLVED dates but silently keeps a FAILED date's
      // provisional stage1Share instead of zeroing it.
      const durable = scheduleSubs.reduce(
        (sum, [, subscription]) => sum + (subscription.scheduleMatchCount ?? 0),
        0,
      );
      const spent = model.total - model.remaining;
      model.total = durable;
      model.remaining = durable - spent;
      model.scheduleSlotHeld = false;
    }
    await assertWorld(db, models);
  }
  expect(sharedScheduleFanIn).toContain(2);

  const sharedFetchFanIn: number[] = [];
  for (const fetchPlan of rng.shuffle(
    plan.fetches.filter((fetch) => fetch.outcome !== "PENDING"),
  )) {
    const key = fetchKeys.get(fetchPlan.label)!;
    beginTransition(progress, `dispatch fetch ${fetchPlan.label}`);
    const subscribers = [...models.values()].filter(
      (model) => model.subscriptions.get(key.runKeyId)?.state === "LIVE",
    );
    const run = await dispatchRun(db, key);
    await assertWorld(db, models);
    beginTransition(progress, `settle fetch ${fetchPlan.label} as ${fetchPlan.outcome}`);
    if (fetchPlan.outcome === "ACCEPTED") {
      const freeCount = rng.integer(0, 8);
      const result = await acceptFetch(db, run, { freeCount });
      expect(new Set(result.fannedIn.map((row) => row.search_id))).toEqual(
        new Set(subscribers.map((model) => model.fixture.searchId)),
      );
      if (subscribers.length > 1) sharedFetchFanIn.push(result.fannedIn.length);
      for (const model of subscribers) {
        model.jobs.get(key.runKeyId)!.state = "DONE";
        model.subscriptions.get(key.runKeyId)!.state = "SATISFIED";
        model.remaining--;
        model.events.push("FETCH_ACCEPTED");
        model.applications++;
        model.acceptedFetches++;
        model.freeSeats += freeCount;
      }
    } else {
      const result = await failRun(db, run);
      expect(result.affected).toHaveLength(subscribers.length);
      for (const model of subscribers) {
        model.jobs.get(key.runKeyId)!.state = "FAILED";
        model.subscriptions.get(key.runKeyId)!.state = "CANCELLED";
        model.remaining--;
        model.events.push("FETCH_FAILED");
      }
    }
    await assertWorld(db, models);
  }
  expect(sharedFetchFanIn).toContain(2);

  for (const searchPlan of rng.shuffle(plan.searches.filter((search) => search.deadline))) {
    beginTransition(progress, `expire deadline ${searchPlan.name}`);
    await expireSearchDeadline(db, models.get(searchPlan.name)!.fixture.searchId);
    await assertWorld(db, models);
  }

  const reached = new Set<TerminalStatus>();
  const terminalReleaseCoverage: { name: string; heldSchedules: number }[] = [];
  for (const searchPlan of rng.shuffle(plan.searches)) {
    const model = models.get(searchPlan.name)!;
    const expected = expectedTerminal(model);
    terminalReleaseCoverage.push({ name: model.name, heldSchedules: model.heldSchedules.size });
    beginTransition(progress, `terminalize ${model.name}`);
    const terminal = await terminalize(db, model.fixture.searchId);
    expect(terminal).toEqual(expected);
    markTerminal(model, expected);
    reached.add(expected.status);
    await assertWorld(db, models);

    // Release/application/event/job/result behavior is idempotent after the first winner.
    beginTransition(progress, `retry terminalization ${model.name}`);
    expect(await terminalize(db, model.fixture.searchId)).toBeNull();
    await assertWorld(db, models);
  }

  beginTransition(progress, "assert forced reachability coverage");
  expect(reached).toEqual(new Set<TerminalStatus>(["COMPLETE", "PARTIAL", "HALTED"]));
  expect(
    terminalReleaseCoverage.some(
      (coverage) => coverage.name === "halted_schedules" && coverage.heldSchedules >= 2,
    ),
    `terminal release coverage: ${JSON.stringify(terminalReleaseCoverage)}`,
  ).toBe(true);
  expect(Math.max(...plan.searches.map((search) => search.scheduleKeys.length))).toBeGreaterThan(2);
  expect(new Set(plan.schedules.map((schedule) => schedule.outcome))).toEqual(
    new Set<ScheduleOutcome>(["RESOLVED", "EMPTY_RESOLVED", "FAILED"]),
  );
  const fetchOutcomes = new Set(plan.fetches.map((fetch) => fetch.outcome));
  expect(fetchOutcomes.has("ACCEPTED"), "generated plan must force accepted fetch coverage").toBe(
    true,
  );
  expect(fetchOutcomes.has("FAILED"), "generated plan must force exhausted fetch coverage").toBe(
    true,
  );

  const live = await db.one<{ jobs: string; subscriptions: string; runs: string }>(
    `SELECT (SELECT count(*) FROM search_job WHERE state IN ('PENDING','LEASED')) AS jobs,
            (SELECT count(*) FROM run_subscription WHERE state = 'LIVE') AS subscriptions,
            (SELECT count(*) FROM provider_run WHERE state IN ('PENDING','LEASED')) AS runs`,
  );
  expect(live).toEqual({ jobs: "0", subscriptions: "0", runs: "0" });
  const admission = await db.one<{ pending_cost: string; unresolved_schedules: number }>(
    `SELECT pending_cost, unresolved_schedules FROM provider_admission WHERE provider_id = $1`,
    [PROVIDER],
  );
  expect(admission).toEqual({ pending_cost: "0", unresolved_schedules: 0 });
}

describe("tier 6 — deterministic randomized conservation and reachability", () => {
  const db = useDatabase();

  it.each(regressionSeeds())(
    "seed %s",
    async (seed) => {
      const plan = generatePlan(seed);
      const progress: TransitionProgress = { index: 0, label: "before first transition" };
      try {
        await runRandomWorld(db(), seed, plan, progress);
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new Error(
          `${detail}\ntransition ${progress.index}: ${progress.label}` +
            `\n\nTier 6 replay diagnostic:\n${replayDiagnostic(seed, plan)}`,
          { cause: error },
        );
      }
    },
    LOCAL_TIMEOUT,
  );
});

describe("tier 6 — gate 11 semantic load profile", () => {
  const db = useDatabase();

  it(
    "coalesces 350 naive jobs into 35 stable-key runs at the configured ceiling",
    async () => {
      const searchCount = 10;
      const keyCount = 35;
      const capacity = searchCount * keyCount;
      // This is an all-warm fetch profile; schedule-slot admission is intentionally not part
      // of Gate 11's fixed shape, so only the pending-cost ceiling is varied and asserted here.
      await seedProvider(db(), { pendingCostLimit: capacity });
      const keys = await Promise.all(
        Array.from({ length: keyCount }, (_, index) => fetchKey(db(), `load_${index}`)),
      );

      const connections = await Promise.all(
        Array.from({ length: searchCount }, () => db().connect()),
      );
      const searches = await Promise.all(
        connections.map(async (connection) => {
          const tx = session(connection);
          await tx.query("BEGIN");
          try {
            const search = await createSearch(tx, 0, { reserve: keyCount });
            for (const key of keys) await subscribe(tx, search, key);
            await tx.query("COMMIT");
            return search;
          } catch (error) {
            await tx.query("ROLLBACK");
            throw error;
          }
        }),
      );

      const ceiling = await db().one<{
        pending_cost: string;
        pending_cost_limit: string;
        unresolved_schedules: number;
      }>(
        `SELECT pending_cost, pending_cost_limit, unresolved_schedules
         FROM provider_admission WHERE provider_id = $1`,
        [PROVIDER],
      );
      expect(ceiling).toEqual({
        pending_cost: String(capacity),
        pending_cost_limit: String(capacity),
        unresolved_schedules: 0,
      });

      // B1's losing reservation must be atomic: rejection leaves both durable entities and
      // provider accounting exactly as they were before the attempt.
      const losingReservationSnapshot = `
        SELECT (SELECT count(*) FROM search) AS searches,
               (SELECT count(*) FROM admission_reservation) AS reservations,
               (SELECT count(*) FROM run_subscription) AS subscriptions,
               (SELECT pending_cost FROM provider_admission WHERE provider_id = $1)
                 AS pending_cost,
               (SELECT unresolved_schedules FROM provider_admission WHERE provider_id = $1)
                 AS unresolved_schedules`;
      const beforeLoser = await db().one(losingReservationSnapshot, [PROVIDER]);
      const loserConnection = await db().connect();
      const loser = session(loserConnection);
      await loser.query("BEGIN");
      let rejection: unknown;
      try {
        await createSearch(loser, 0, { reserve: 1 });
      } catch (error) {
        rejection = error;
      } finally {
        await loser.query("ROLLBACK");
      }
      expect(rejection).toBeInstanceOf(Error);
      expect(String(rejection)).toContain("B1_STAGE1_ADMISSION");
      expect(await db().one(losingReservationSnapshot, [PROVIDER])).toEqual(beforeLoser);

      const runs = await Promise.all(keys.map((key) => dispatchRun(db(), key)));
      const fanIns: number[] = [];
      const startedAt = performance.now();
      for (const run of runs) {
        const accepted = await acceptFetch(db(), run);
        fanIns.push(accepted.fannedIn.length);
      }
      const elapsedFanInMs = performance.now() - startedAt;
      expect(fanIns).toEqual(Array.from({ length: keyCount }, () => searchCount));

      const counts = await db().one<{
        runs: string;
        applications: string;
        done_jobs: string;
        satisfied_subscriptions: string;
        accepted_events: string;
        max_fan_in: number;
        job_outbox: string;
      }>(
        `SELECT (SELECT count(*) FROM provider_run) AS runs,
                (SELECT count(*) FROM run_application) AS applications,
                (SELECT count(*) FROM search_job WHERE state = 'DONE') AS done_jobs,
                (SELECT count(*) FROM run_subscription WHERE state = 'SATISFIED')
                  AS satisfied_subscriptions,
                (SELECT count(*) FROM search_event WHERE type = 'FETCH_ACCEPTED')
                  AS accepted_events,
                (SELECT max(n)::integer FROM
                  (SELECT count(*) AS n FROM run_application GROUP BY run_id) fan_in)
                  AS max_fan_in,
                (SELECT count(*) FROM outbox WHERE target_kind = 'JOB') AS job_outbox`,
      );
      expect(counts).toEqual({
        runs: "35",
        applications: "350",
        done_jobs: "350",
        satisfied_subscriptions: "350",
        accepted_events: "350",
        max_fan_in: 10,
        job_outbox: "350",
      });
      const naiveJobs = Number(counts.done_jobs);
      const coalescingRatio = naiveJobs / Number(counts.runs);
      expect(naiveJobs).toBe(searchCount * keyCount);
      expect(coalescingRatio).toBe(searchCount);

      process.stdout.write(
        `${JSON.stringify({
          durabilityTier6Load: {
            naiveJobs,
            runs: Number(counts.runs),
            applications: Number(counts.applications),
            completedJobs: Number(counts.done_jobs),
            satisfiedSubscriptions: Number(counts.satisfied_subscriptions),
            fetchAcceptedEvents: Number(counts.accepted_events),
            coalescingRatio,
            maxFanIn: counts.max_fan_in,
            elapsedFanInMs: Number(elapsedFanInMs.toFixed(3)),
          },
        })}\n`,
      );

      for (const search of searches) {
        expect(await terminalize(db(), search.searchId)).toEqual({
          status: "COMPLETE",
          cause: null,
        });
      }
      const baseline = await db().one<{ pending_cost: string; unresolved_schedules: number }>(
        `SELECT pending_cost, unresolved_schedules
         FROM provider_admission WHERE provider_id = $1`,
        [PROVIDER],
      );
      expect(baseline).toEqual({ pending_cost: "0", unresolved_schedules: 0 });
      const violations = await checkInvariants(db());
      expect(violations, formatViolations(violations)).toEqual([]);
    },
    LOCAL_TIMEOUT,
  );
});
