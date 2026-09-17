/**
 * Pure due-ness arithmetic for the theatre catalogue crawl (S26.7).
 *
 * The cadence literal — "one calendar month" — is hard-coded by ADR 0022 §1
 * (`docs/adr/0022-theatre-catalogue-crawl-worker-policy.md:38-47`), not an injected
 * gate-14 parameter. It must never become configurable: a configurable cadence would let a
 * deployment silently violate the ADR's decision (S26.7, `docs/gates.md`'s Fetch-layer
 * tunables row).
 *
 * Calendar-month arithmetic is computed in UTC, matching the repo's `timestamptz`-as-
 * absolute-instant convention. Day-of-month clamping follows the common calendar-library
 * convention: adding one month to a date whose day-of-month exceeds the target month's
 * length clamps to the target month's last day (e.g. Jan 31 + 1 month -> Feb 28/29). This
 * exact rule is asserted below and re-stated in review.md so product can override it cheaply.
 */

/**
 * Adds `months` calendar months to `date`, clamping the day-of-month to the target month's
 * length when the source day does not exist in the target month (UTC arithmetic).
 */
export function addCalendarMonths(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDayOfTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTarget));
  return target;
}

/**
 * True when a new monthly pass is due. `lastPassCompletedAt` takes precedence; when no pass
 * has ever completed, `lastPassStartedAt` is the reference — a started-but-never-completed
 * pass is due only once it has itself exceeded one calendar month (a pass takes ~26 hours,
 * so one still running after a month is stuck and may be superseded by a fresh pass). Both
 * timestamps null (no row yet) means immediately due.
 */
export function isCatalogueCrawlDue(
  lastPassStartedAt: Date | null,
  lastPassCompletedAt: Date | null,
  now: Date,
): boolean {
  const reference = lastPassCompletedAt ?? lastPassStartedAt;
  if (reference === null) {
    return true;
  }
  return now.getTime() >= addCalendarMonths(reference, 1).getTime();
}
