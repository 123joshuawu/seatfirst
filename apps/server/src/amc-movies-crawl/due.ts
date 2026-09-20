/**
 * Pure due-ness arithmetic for the daily AMC movies catalogue fetch (ADR 0102 decisions 1–2).
 *
 * The cadence literal — "07:00 America/New_York, daily, ± up to 5 minutes of jitter, give up
 * after 4 hours of retrying" — is hard-coded by the ADR, not an injected gate-14 parameter.
 * It must never become configurable (mirrors `catalogue-crawl/due.ts`'s and `tmdb/due.ts`'s
 * own hard-coding rationale, `docs/gates.md`'s Fetch-layer tunables row).
 *
 * Timezone arithmetic reuses `tmdb/due.ts`'s `Intl.DateTimeFormat`-based Eastern offset
 * technique. ADR 0102 decision 1's jitter is "re-rolled fresh... not persisted as a fixed
 * per-day value ahead of time, so the exact minute is unobservable until the pass actually
 * fires": implemented here as a pure deterministic hash of the Eastern calendar date (never
 * `Math.random()`), so the same day always derives the same boundary — a 10-minute-interval
 * due-ness check never flip-flops within one day — while no per-day target is ever computed
 * or stored ahead of the day arriving.
 */

const AMC_MOVIES_CRAWL_TIME_ZONE = "America/New_York";
const AMC_MOVIES_CRAWL_HOUR = 7;

/** ADR 0102 decision 1 — the jitter window is ±5 minutes around the 07:00 boundary. */
const JITTER_RANGE_MS = 5 * 60 * 1000;

/** ADR 0102 decision 2 — give up for the Eastern day after 4 hours of retrying `sem:amc`. */
const GIVE_UP_AFTER_MS = 4 * 60 * 60 * 1000;

interface EasternParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly offsetMs: number;
}

/**
 * Reads `instant`'s year/month/day in `America/New_York` plus that zone's UTC offset at
 * `instant` (positive east of UTC) — identical technique to `tmdb/due.ts`'s `easternParts`,
 * duplicated rather than shared because the two due-ness modules are deliberately independent
 * (ADR 0102 decision 1 is "this ADR's own number, not a reuse of the TMDB one").
 */
function easternParts(instant: Date): EasternParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: AMC_MOVIES_CRAWL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return { year, month, day, offsetMs: asUtc - instant.getTime() };
}

/** Deterministic 32-bit FNV-1a hash of a short ASCII string. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic jitter in `[-JITTER_RANGE_MS, +JITTER_RANGE_MS]` for one Eastern calendar
 * day, derived from a hash of its `YYYY-MM-DD` key. Never stored, never `Math.random()`.
 */
function jitterForEasternDay(year: number, month: number, day: number): number {
  const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hash = fnv1a(key);
  return (hash % (2 * JITTER_RANGE_MS + 1)) - JITTER_RANGE_MS;
}

/**
 * The absolute instant of today's jittered 07:00 `America/New_York` boundary, for the given
 * `now`. Exported for direct testing of the jitter arithmetic.
 */
export function amcMoviesCrawlBoundary(now: Date): Date {
  const { year, month, day, offsetMs } = easternParts(now);
  const base = Date.UTC(year, month - 1, day, AMC_MOVIES_CRAWL_HOUR, 0, 0) - offsetMs;
  return new Date(base + jitterForEasternDay(year, month, day));
}

/**
 * True when an AMC movies catalogue pass is due (ADR 0102 decisions 1–2): `now` has crossed
 * today's jittered boundary, the boundary's 4-hour give-up window has not yet elapsed, and no
 * pass has completed since that boundary (or none has ever completed).
 */
export function isAmcMoviesCrawlDue(lastCompletedAt: Date | null, now: Date): boolean {
  const boundary = amcMoviesCrawlBoundary(now).getTime();
  const nowMs = now.getTime();
  if (nowMs < boundary) {
    return false;
  }
  if (nowMs >= boundary + GIVE_UP_AFTER_MS) {
    return false;
  }
  if (lastCompletedAt !== null && lastCompletedAt.getTime() >= boundary) {
    return false;
  }
  return true;
}
