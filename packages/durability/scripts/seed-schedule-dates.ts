/**
 * Deterministic 30-day date assignment for the dev-backend seed script
 * (`scripts/seed-dev-fixtures.ts`). Pure, dependency-free, and unit-tested in
 * `test/seed-schedule-dates.test.ts` (sibling pattern of `seed-date.test.ts`).
 *
 * The seed script re-dates every captured performance (all originally captured
 * on one day) onto a random date inside the browsable window, so the seeded
 * dev database has real showtime data across the whole window instead of a
 * single calendar date. The assignment MUST be byte-identical on every run —
 * the script's `run_key` idempotency (`k_sched_...` rows upserted via
 * RUN_KEY_UPSERT) depends on repeated `seed` runs producing identical
 * assignments — so this uses a seeded PRNG with a fixed literal seed, never
 * `Math.random()`/`Date.now()`.
 */

/** Mirror of `apps/mobile-web/src/lib/dates.ts`'s `MOVIE_BROWSE_SPAN_DAYS`
 * policy value. This package cannot import from `apps/mobile-web`, so the
 * number is hardcoded here with this citation. Dev-tooling mirroring an
 * already-approved policy value, not a new numeric policy — no ADR needed. */
export const SEED_WINDOW_DAYS = 30;

/**
 * Fixed RNG seed literal. The value itself is arbitrary and means nothing —
 * it is fixed (not time-derived) so that repeated `seed` runs assign every
 * performance to the exact same date, keeping the script's "re-running is
 * safe" guarantee.
 */
export const SEED_RNG_SEED = 0x5eed2026;

/** Standard mulberry32 seeded PRNG: pure, deterministic, no clock/randomness. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Add a whole number of days to a `YYYY-MM-DD` local date (UTC-based). */
export function addLocalDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) {
    throw new Error(`addLocalDays: invalid localDate ${JSON.stringify(localDate)}`);
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const out = new Date(ms + days * 86_400_000);
  return out.toISOString().slice(0, 10);
}

/**
 * Assign each captured numeric showtime id to a random date in
 * `[windowStartLocalDate, windowStartLocalDate + windowDays - 1]`, using a
 * PRNG seeded with `rngSeed` (default `SEED_RNG_SEED`).
 *
 * Deterministic: same inputs → same output, always. Order-independent: ids
 * are sorted before any RNG draw is consumed, so the result never depends on
 * incidental parse order. Duplicate ids (should not occur — ids are unique
 * across the fixture corpus in practice) collapse to a single entry, so each
 * numeric id maps to exactly one date and seat-fixture lookups stay
 * unambiguous.
 *
 * Some dates may end up with zero performances purely by chance — that is the
 * explicit product decision; callers MUST NOT add top-up logic.
 */
export function assignFixtureDatesToWindow(
  originalIds: readonly number[],
  windowStartLocalDate: string,
  windowDays: number = SEED_WINDOW_DAYS,
  rngSeed: number = SEED_RNG_SEED,
): Map<number, string> {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error(`assignFixtureDatesToWindow: windowDays must be a positive integer`);
  }
  const uniqueSorted = [...new Set(originalIds)].sort((a, b) => a - b);
  const rng = mulberry32(rngSeed);
  const assigned = new Map<number, string>();
  for (const id of uniqueSorted) {
    const offset = Math.floor(rng() * windowDays);
    assigned.set(id, addLocalDays(windowStartLocalDate, offset));
  }
  return assigned;
}
