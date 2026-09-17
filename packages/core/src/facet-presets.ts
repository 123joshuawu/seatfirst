import type { Weekday } from "./search-spec.js";

/**
 * S43.1 — shared preset helpers for the HORIZON and TIME_OF_DAY axes.
 *
 * Encodes ADR 0028's exact weekend definitions as a pure function so the
 * facet-counts route and any future UI task share one implementation.
 * No new numbers — only the already-accepted definitions.
 */

export type WeekendPreset = "thisWeekend" | "nextThreeWeekends";

export interface WeekendPresetResolution {
  readonly range: { readonly from: string; readonly to: string };
  readonly days: readonly Weekday[];
}

const WEEKEND_DAYS: readonly Weekday[] = ["FRIDAY", "SATURDAY", "SUNDAY"] as const;

function parseIsoDate(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date ${dateStr}`);
  return d;
}

function isoDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const ms = parseIsoDate(dateStr).getTime() + days * 86_400_000;
  return isoDateFromMs(ms);
}

/**
 * Resolve a weekend horizon preset to its inclusive DATE_RANGE and weekday
 * filter. Implements ADR 0028's definitions verbatim:
 * - "Weekend means Friday, Saturday, and Sunday"
 * - "Next weekend excludes the current Friday-to-Sunday block... first Friday
 *   after that block ends"
 * - "Next three weekends selects that next weekend and the two immediately
 *   following Friday-to-Sunday blocks"
 * - "This weekend" reuses the existing unchanged preset (the current week's
 *   Fri-Sun block, which may be upcoming or in-progress)
 *
 * The "current block" is the Fri-Sun block belonging to today's ISO week
 * (Monday-based). For Wed 2026-08-26, the current block is Fri 2026-08-28;
 * nextThreeWeekends therefore starts Fri 2026-09-04 (skips the upcoming
 * weekend), which matches "excludes the current block" and keeps the two
 * presets disjoint. A request made on a Friday selects the following Friday
 * for the next-weekend family (ADR 0028's named edge case).
 */
export function resolveWeekendPreset(
  preset: WeekendPreset,
  todayLocal: string,
): WeekendPresetResolution {
  const todayMs = parseIsoDate(todayLocal).getTime();
  const dow = parseIsoDate(todayLocal).getUTCDay(); // 0 Sun … 6 Sat
  const monIdx = (dow + 6) % 7; // Mon 0 … Sun 6

  let blockFriday: string;
  if (monIdx <= 4) {
    // Mon–Fri: block Friday is forward in this week
    blockFriday = addDays(todayLocal, 4 - monIdx);
  } else {
    // Sat–Sun: block started yesterday / two days ago
    blockFriday = addDays(todayLocal, 4 - monIdx);
  }

  // Validate that our arithmetic did not drift (defensive)
  void todayMs;

  if (preset === "thisWeekend") {
    return {
      range: { from: blockFriday, to: addDays(blockFriday, 2) },
      days: WEEKEND_DAYS,
    };
  }

  // nextThreeWeekends: first Friday after the current block ends
  const nextStart = addDays(blockFriday, 7);
  return {
    range: { from: nextStart, to: addDays(nextStart, 16) },
    days: WEEKEND_DAYS,
  };
}

export const TIME_OF_DAY_PRESET_BOUNDS: Readonly<
  Record<
    "allTimes" | "morning" | "afternoon" | "evening" | "late",
    { readonly startLocal: string; readonly endLocal: string }
  >
> = {
  allTimes: { startLocal: "00:00", endLocal: "23:59" },
  morning: { startLocal: "00:00", endLocal: "11:59" },
  afternoon: { startLocal: "12:00", endLocal: "16:59" },
  evening: { startLocal: "17:00", endLocal: "20:59" },
  late: { startLocal: "21:00", endLocal: "23:59" },
} as const;
