/**
 * Dev-fixture showtime ID derivation (dev/test-tooling-only).
 *
 * Restores the architectural invariant that production already has: every
 * performance's showtime ID is globally unique, never reused across calendar
 * dates. The dev fixtures violate this — the same captured `showtimeId` digits
 * appear verbatim for every `localDate` they are seeded/served for — which
 * collides on `performance.showtime_id PRIMARY KEY` (ON CONFLICT upsert).
 *
 * This is the single source of truth for the derivation; both the fetch-worker
 * seam (`infra/docker/fetch-worker/dev-entrypoint.mjs`) and the DB seed
 * (`packages/durability/scripts/seed-dev-fixtures.ts`) must import this exact
 * symbol so the two paths never drift. Any change here is dev-tooling-only and
 * requires no ADR (cf. ADR 0040 gates closed: none for fixture-only tooling).
 */

const FACTOR = 1_000_000;

/**
 * Derive a date-unique showtime ID from a captured numeric showtime ID and a
 * target `localDate` (`YYYY-MM-DD`).
 *
 * - Pure/deterministic: same inputs → same output, no randomness/clock/order.
 * - Cross-date uniqueness: same `originalShowtimeId`, different `localDate`
 *   → different outputs (entire fix).
 * - Output is a non-negative JS-safe integer whose decimal rendering is all-digits
 *   with no leading zeros, so it round-trips through `z.number()` and
 *   `SEATS_ROUTE`'s `/\d+/` URL matcher.
 *
 * Formula: `originalShowtimeId * 1_000_000 + epochDay(localDate)` where
 * `epochDay` is whole days since Unix epoch (UTC). For any realistic dev-stack
 * date `epochDay` is a small positive integer (< 100 000), comfortably keeping
 * the result under `Number.MAX_SAFE_INTEGER` for any captured ID up to
 * ~9e9 (`9e9 * 1e6 = 9e15 ≈ MAX_SAFE_INTEGER`); captured IDs are 9 digits
 * (~1.5e8) so the product is ~1.5e14, decades of headroom.
 *
 * @param originalShowtimeId - captured numeric showtime ID (e.g. 145927006)
 * @param localDate - target local date in `YYYY-MM-DD` format
 */
export function deriveDevFixtureShowtimeId(originalShowtimeId: number, localDate: string): number {
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
  // Rendering check: must be all-digits, no leading zeros (except "0" itself, which
  // never occurs here because original ids are 9-digit and epochDay > 0).
  const rendered = String(derived);
  if (!/^\d+$/.test(rendered)) {
    throw new Error(
      `deriveDevFixtureShowtimeId: derived value rendered non-digit string ${rendered}`,
    );
  }
  return derived;
}

function parseLocalDateToEpochDay(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(
      `deriveDevFixtureShowtimeId: invalid localDate ${JSON.stringify(value)} — expected YYYY-MM-DD`,
    );
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Validate via UTC round-trip (rejects 2026-02-31 etc.)
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`deriveDevFixtureShowtimeId: invalid calendar date ${JSON.stringify(value)}`);
  }
  return Math.floor(ms / 86_400_000);
}
