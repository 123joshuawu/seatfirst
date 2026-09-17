/**
 * Fetch-worker container entrypoint for the local-dev-backend `full` mode
 * (`dev/README.md`, `docker-compose.dev.yml`'s `fetch-worker` service, `profiles: ["full"]`).
 *
 * Same shape as the real `entrypoint.mjs` — hosts P6's local synthetic-page readiness
 * server, then starts the composed fetch-worker process — with exactly one difference: it
 * builds a dev-only `fetchHop` (P6/S8's offline synthetic-harness seam,
 * `ProviderFetchNavigationSeams.fetchHop`, the same mechanism
 * `packages/browser-runtime/test/support/harness.ts` already uses in CI) that answers every
 * intercepted AMC-shaped document request from `dev/fixtures/amc/` instead of the real
 * network, and passes it to `startFetchWorker` via the additive `options.navigationSeams`
 * parameter (`apps/server/src/fetch-worker/entrypoint.ts`) — which forwards that ONE seam
 * to BOTH consumers of the shared warm Chrome (the RUN provider-fetch actor AND S26's
 * catalogue-crawl tick loop). A fresh `--profile full` stack therefore cannot leak the
 * crawl's directory/market navigations either: they are served from fixtures when scripted
 * and refused otherwise, making "zero live AMC traffic" structurally enforced by the seam
 * rather than merely documented. Real Chrome still launches, still
 * navigates, still runs the real `buildTargetUrl`/`parseObservation` on both sides of this —
 * only the network hop is fake. Anything not scripted below is refused, never silently
 * passed through to the real network — the same refusal posture P6's own test harness uses.
 *
 * Bind-mounted into the fetch-worker container by `docker-compose.dev.yml` (this file is
 * NOT baked into `Dockerfile.fetch-worker` — no image change), alongside `dev/fixtures/amc`
 * at the same repo-root-relative path the seed script assumes
 * (`/app/dev/fixtures/amc`, matching `packages/durability/scripts/seed-dev-fixtures.ts`'s
 * own path computation, so both files' path logic actually agrees with each other; kept as
 * one literal constant below rather than re-derived, since this file has no package.json of
 * its own to compute a "repo root" from).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Shared derivation — keep in sync with `packages/providers/src/dev-fixtures/showtime-id.ts`.
// Prefer the compiled `dist` import when the container image has it (its
// `node_modules/@seatfirst/providers -> ../../packages/providers` symlink resolves
// `@seatfirst/providers` to `packages/providers/dist/index.js`); locally the
// root `node_modules` does not link `@seatfirst/providers` (so a bare
// `import "@seatfirst/providers"` from `infra/.../dev-entrypoint.mjs` would
// fail in `vitest run --config vitest.config.scripts.mjs`), so we keep a
// verbatim fallback and upgrade to the shared symbol when the dynamic import
// succeeds. The two implementations are intentionally identical.
const FACTOR = 1_000_000;
function parseLocalDateToEpochDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(
      `deriveDevFixtureShowtimeId: invalid localDate ${JSON.stringify(value)} — expected YYYY-MM-DD`,
    );
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`deriveDevFixtureShowtimeId: invalid calendar date ${JSON.stringify(value)}`);
  }
  return Math.floor(ms / 86_400_000);
}
let deriveDevFixtureShowtimeId = (originalShowtimeId, localDate) => {
  if (!Number.isSafeInteger(originalShowtimeId) || originalShowtimeId < 0) {
    throw new Error(
      `deriveDevFixtureShowtimeId: originalShowtimeId must be a non-negative safe integer, got ${String(originalShowtimeId)}`,
    );
  }
  const epochDay = parseLocalDateToEpochDay(localDate);
  const derived = originalShowtimeId * FACTOR + epochDay;
  if (!Number.isSafeInteger(derived) || derived < 0) {
    throw new Error(
      `deriveDevFixtureShowtimeId: derived value is not a safe integer for original ${originalShowtimeId} and date ${localDate}`,
    );
  }
  const rendered = String(derived);
  if (!/^\d+$/.test(rendered)) {
    throw new Error(
      `deriveDevFixtureShowtimeId: derived value rendered non-digit string ${rendered}`,
    );
  }
  return derived;
};
try {
  const mod = await import("@seatfirst/providers");
  if (typeof mod.deriveDevFixtureShowtimeId === "function") {
    deriveDevFixtureShowtimeId = mod.deriveDevFixtureShowtimeId;
  }
} catch (_err) {
  void _err;
}

const READINESS_PORT = 8787;
const FIXTURES_DIR = process.env.DEV_FIXTURES_DIR ?? "/app/dev/fixtures/amc";
const ORIGINAL_SCHEDULE_DATE = "2026-08-13";
const DAY_MS = 86_400_000;

const SEATS_ROUTE = /^\/showtimes\/(\d+)\/seats$/;
const SCHEDULE_ROUTE = /^\/movie-theatres\/([^/]+)\/([^/]+)\/showtimes$/;

/** Market-slug/theatre-slug → schedule fixture filename, matching what
 * `dev/fixtures/amc/README.md` documents and `seed-dev-fixtures.ts` seeded into the
 * catalogue (`upsertTheatre`'s `marketSlug`/`slugs`, read back by the real
 * `buildTargetUrl` — `apps/server/src/dispatch/handlers/build-target-url.ts` — from the
 * theatre catalogue, not hardcoded here). */
const SCHEDULE_FIXTURES = {
  "san-francisco/amc-metreon-16": "schedule-amc-metreon-16-2026-08-13.json",
  "san-francisco/amc-kabuki-8": "schedule-amc-kabuki-8-2026-08-13.json",
  "atlanta/amc-southlake-24": "schedule-amc-southlake-24-2026-08-13.json",
};

/** Three re-keyable synthetic seat-map profiles. The fixture route selects one by a stable
 * hash of the configured seed and numeric showtime id, so every showtime in the seeded
 * schedules can exercise the real seat-fetch path without copied fixture bodies. */
const SEAT_FIXTURE_PROFILES = [
  {
    filename: "seats-145927008.json",
    sourceShowtimeId: "145927008",
  },
  {
    filename: "seats-146024502.json",
    sourceShowtimeId: "146024502",
  },
  {
    filename: "seats-146089621.json",
    sourceShowtimeId: "146089621",
  },
];

const DEFAULT_FIXTURE_SCENARIO = "full";
const DEFAULT_FIXTURE_SEED = "seatfirst-dev-fixture-v1";
const FIXTURE_SCENARIOS = new Set(["full", "mixed-partial", "all-error"]);

/** @param {string} value */
function parseLocalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`dev fixture: invalid schedule date ${String(value)}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`dev fixture: invalid schedule date ${value}`);
  }
  return parsed;
}

/**
 * Shift the captured fixture's two UTC calendar dates to the requested schedule date while
 * preserving every time, offset, and non-date byte, and derive date-unique showtime IDs
 * (see `packages/providers/src/dev-fixtures/showtime-id.ts`). The fixture's original
 * `showtimeId` digits are replaced via the shared pure derivation keyed on `requestedDate`,
 * so the same captured ID served for two different dates yields two different IDs
 * (fixing the PRIMARY KEY collision on `performance.showtime_id`). The regex handles both
 * `"showtimeId":123` and the flight-payload-escaped `\"showtimeId\":123` form found in
 * the raw HTML body, and the generic word-boundary pass also covers the anchor
 * `id="123"`, `href="/showtimes/123"`, `id="123-details"`, and flight list keys
 * `"li","123"` that the parser cross-checks against the JSON's `showtimeId`
 * (otherwise `parseShowtimes` throws "anchor has no matching showtime record").
 * @param {string} body
 * @param {string} requestedDate
 */
export function rebaseScheduleFixture(body, requestedDate) {
  const original = parseLocalDate(ORIGINAL_SCHEDULE_DATE);
  const requested = parseLocalDate(requestedDate);
  const dayOffset = Math.round((requested.getTime() - original.getTime()) / DAY_MS);
  const dateRebased = body.replace(/2026-08-(?:13|14)/g, (capturedDate) => {
    const shifted = parseLocalDate(capturedDate);
    shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
    return shifted.toISOString().slice(0, 10);
  });
  // Build map from each original showtimeId seen in the JSON flight payload to its
  // date-unique derived value. The fixture's showtimeId appears as both
  // `"showtimeId":123` and escaped `\"showtimeId\":123`; collecting from that
  // source gives the canonical set without risking unrelated 9-digit numbers.
  const derivedMap = new Map();
  for (const match of dateRebased.matchAll(/(\\?"showtimeId\\?":\s*)(\d+)/g)) {
    const idStr = match[2];
    if (!derivedMap.has(idStr)) {
      const originalId = Number(idStr);
      if (Number.isSafeInteger(originalId)) {
        derivedMap.set(idStr, String(deriveDevFixtureShowtimeId(originalId, requestedDate)));
      }
    }
  }
  if (derivedMap.size === 0) return dateRebased;
  let result = dateRebased;
  for (const [orig, derived] of derivedMap) {
    result = result.replace(new RegExp(`\\b${orig}\\b`, "g"), derived);
  }
  return result;
}

/**
 * Re-key the synthetic seat body without modifying the captured fixture on disk.
 * @param {string} body
 * @param {string} sourceShowtimeId
 * @param {string} targetShowtimeId
 */
export function rekeySeatFixture(body, sourceShowtimeId, targetShowtimeId) {
  return body.replaceAll(sourceShowtimeId, targetShowtimeId);
}

/** @typedef {"full" | "mixed-partial" | "all-error"} FixtureScenario */

/**
 * @param {{ readonly DEV_FIXTURE_SCENARIO?: string; readonly DEV_FIXTURE_SEED?: string }} environment
 * @returns {{ readonly scenario: FixtureScenario; readonly seed: string }}
 */
export function fixtureSimulationFromEnvironment(environment) {
  const scenario = environment.DEV_FIXTURE_SCENARIO ?? DEFAULT_FIXTURE_SCENARIO;
  if (!FIXTURE_SCENARIOS.has(scenario)) {
    throw new Error(`dev fixture: invalid DEV_FIXTURE_SCENARIO ${JSON.stringify(scenario)}`);
  }
  const seed = environment.DEV_FIXTURE_SEED ?? DEFAULT_FIXTURE_SEED;
  if (seed.trim() === "") {
    throw new Error("dev fixture: DEV_FIXTURE_SEED must not be empty");
  }
  return { scenario, seed };
}

/** @param {string} seed @param {string} showtimeId */
export function fixtureSimulationHash(seed, showtimeId) {
  return createHash("sha256").update(`${seed}:${showtimeId}`).digest().readUInt32BE(0);
}

/** @param {string} seed @param {string} showtimeId */
export function fixtureSimulationOutcomeBucket(seed, showtimeId) {
  return (fixtureSimulationHash(seed, showtimeId) >>> 2) & 0b11;
}

/**
 * @param {{ readonly scenario: FixtureScenario; readonly seed: string }} simulation
 * @param {string} showtimeId
 */
export function resolveFixtureSimulation(simulation, showtimeId) {
  const hash = fixtureSimulationHash(simulation.seed, showtimeId);
  if (
    simulation.scenario === "all-error" ||
    (simulation.scenario === "mixed-partial" &&
      fixtureSimulationOutcomeBucket(simulation.seed, showtimeId) === 0)
  ) {
    return { kind: "failure" };
  }
  return {
    kind: "success",
    fixture: SEAT_FIXTURE_PROFILES[hash % SEAT_FIXTURE_PROFILES.length],
  };
}

const FIXTURE_SIMULATION = fixtureSimulationFromEnvironment(process.env);

async function readFixtureBody(path) {
  const raw = await readFile(path, "utf8");
  /** @type {{ body: string }} */
  const parsed = JSON.parse(raw);
  return parsed.body;
}

/** @param {import("playwright-core").Route} route */
async function fetchHop(route) {
  const url = new URL(route.request().url());

  const seatsMatch = SEATS_ROUTE.exec(url.pathname);
  if (seatsMatch !== null) {
    const showtimeId = seatsMatch[1];
    const outcome = resolveFixtureSimulation(FIXTURE_SIMULATION, showtimeId);
    if (outcome.kind === "failure") {
      throw new Error(`dev fixture: simulated fetch failure for showtime ${showtimeId}`);
    }
    const { fixture } = outcome;
    const path = join(FIXTURES_DIR, "seats", fixture.filename);
    const body = await readFixtureBody(path).catch(() => {
      throw new Error(`dev fixture: no seat fixture for showtime ${showtimeId} (${path})`);
    });
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: rekeySeatFixture(body, fixture.sourceShowtimeId, showtimeId),
    };
  }

  const scheduleMatch = SCHEDULE_ROUTE.exec(url.pathname);
  if (scheduleMatch !== null) {
    const [, marketSlug, theatreSlug] = scheduleMatch;
    const filename = SCHEDULE_FIXTURES[`${marketSlug}/${theatreSlug}`];
    if (filename === undefined) {
      throw new Error(`dev fixture: no schedule fixture for ${marketSlug}/${theatreSlug}`);
    }
    const requestedDate = url.searchParams.get("date");
    if (requestedDate === null) {
      throw new Error("dev fixture: schedule request has no date");
    }
    const body = await readFixtureBody(join(FIXTURES_DIR, "schedule", filename));
    return {
      status: 200,
      headers: { "content-type": "text/html" },
      body: rebaseScheduleFixture(body, requestedDate),
    };
  }

  throw new Error(`dev fixture: unscripted navigation refused: ${url.toString()}`);
}

async function main() {
  const { startReadinessServer } = await import("@seatfirst/browser-runtime");
  // O8.2 — register pg instrumentation before importing the server module graph, whose
  // static imports reach @seatfirst/durability's pool.
  const { ensurePgInstrumented } = await import("@seatfirst/config/otel-bootstrap");
  ensurePgInstrumented();
  const { startFetchWorker } = await import("@seatfirst/server/dist/fetch-worker/entrypoint.js");

  const server = await startReadinessServer({ port: READINESS_PORT });
  const worker = await startFetchWorker(process.env, { navigationSeams: { fetchHop } });
  let shuttingDown = false;
  server.setReady?.(typeof worker.isReady === "function" ? worker.isReady() : true);
  worker.onReadinessChange?.((ready) => {
    if (!shuttingDown) {
      server.setReady?.(ready);
    }
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      server.setReady?.(false);
      void Promise.resolve()
        .then(() => worker.close())
        .then(() => server.close())
        .then(() => process.exit(0))
        .catch((error) => {
          process.stderr.write(`shutdown on ${signal} failed: ${String(error)}\n`);
          process.exit(1);
        });
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
