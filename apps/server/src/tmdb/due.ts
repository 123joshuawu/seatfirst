/**
 * Pure due-ness arithmetic for the daily TMDB pre-warm (S25.3, ADR 0019 amendment decision 1).
 *
 * The cadence literal — "4:00 AM America/New_York, daily" — is hard-coded by the amendment,
 * not an injected gate-14 parameter. It must never become configurable: a configurable cron
 * time would let a deployment silently violate the ADR's decision (mirroring S26's
 * hard-coding of the ADR-0022-fixed cadence in `due.ts`, `docs/gates.md`'s Fetch-layer
 * tunables row).
 *
 * Timezone arithmetic is computed against `America/New_York` via `Intl.DateTimeFormat`
 * (the same offset-derivation technique `packages/core/src/local-time.ts` uses for the
 * theatre-local clock). A pre-warm pass is due iff the current instant has passed *today's*
 * 04:00 in `America/New_York` AND the last completed pass predates that same boundary (or
 * no pass has ever completed). The boundary is computed from the Eastern wall-clock date of
 * `now` with the Eastern UTC offset sampled at `now`; on the (two-days-per-year) DST
 * transition the offset may differ from the offset *at* 04:00, which shifts the boundary by
 * at most one hour for that single pass — a background pre-warm, not a correctness-critical
 * instant, so the simplification is accepted and noted in review.md.
 */

const PREWARM_TIME_ZONE = "America/New_York";
const PREWARM_HOUR = 4;

interface EasternParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly offsetMs: number;
}

/**
 * Reads `instant`'s year/month/day in `America/New_York` plus that zone's UTC offset at
 * `instant` (positive east of UTC). The offset is derived by formatting the wall clock and
 * comparing it against the same wall-clock digits read as UTC — the inverse of the offset.
 */
function easternParts(instant: Date): EasternParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PREWARM_TIME_ZONE,
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

/** The absolute instant of today's 04:00 in `America/New_York`, for the given `now`. */
export function todayFourAmEastern(now: Date): Date {
  const { year, month, day, offsetMs } = easternParts(now);
  return new Date(Date.UTC(year, month - 1, day, PREWARM_HOUR, 0, 0) - offsetMs);
}

/**
 * The next 04:00 `America/New_York` boundary strictly after `now` — the sleep target for
 * the pre-warm loop. Uses the same naive +24h advance for "tomorrow" that `easternParts`
 * documents: on a DST-transition day the boundary lands up to one hour off the true wall
 * clock, which is accepted because the tick's own `isTmdbPrewarmDue` re-check (and the
 * persisted checkpoint) is authoritative — the loop sleep is only a wake-up hint.
 */
export function nextFourAmEastern(now: Date): Date {
  const today = todayFourAmEastern(now);
  if (now.getTime() < today.getTime()) {
    return today;
  }
  return new Date(today.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * True when a pre-warm pass is due. `lastCompletedAt` null means no pass has ever completed
 * — immediately due. A completed pass suppresses the next run until today's 04:00 Eastern
 * boundary has passed.
 */
export function isTmdbPrewarmDue(lastCompletedAt: Date | null, now: Date): boolean {
  const boundary = todayFourAmEastern(now);
  if (now.getTime() < boundary.getTime()) {
    return false;
  }
  if (lastCompletedAt === null) {
    return true;
  }
  return lastCompletedAt.getTime() < boundary.getTime();
}
