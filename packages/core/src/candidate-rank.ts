import type { SearchSpec, PerformancePredicate } from "./search-spec.js";
import { toTheatreLocal } from "./local-time.js";
import { IanaTimezoneSchema } from "./timezone.js";
import { UtcInstantSchema } from "./result-contracts.js";
/** Minimal performance shape needed for ranking — mirrors ScheduleRangePerformance fields used here. */
interface RankablePerformance {
  readonly showtimeId: string;
  readonly formatCode: string | null;
  readonly startsAt: Date;
}

/**
 * S44 — cheap-tier candidate ranking (ADR 0037 decision 1).
 *
 * Pure function over schedule-only signals, computed once per matched
 * performance at admission time. Weights 0.5/0.3/0.2 and cap 15 are
 * fixed by ADR 0037, not derived here.
 */

export type TaggedFreshPerformance = {
  readonly performance: RankablePerformance;
  readonly theatreId: string;
  readonly distanceKm: number | null;
  readonly timezone?: string;
};

const PROXIMITY_CAP_KM = 15;

export function candidateProximity(distanceKm: number | null): number {
  if (distanceKm === null || distanceKm === undefined) {
    return 1;
  }
  const d = Number(distanceKm);
  if (!Number.isFinite(d) || d < 0) {
    return 1;
  }
  return 1 - Math.min(d, PROXIMITY_CAP_KM) / PROXIMITY_CAP_KM;
}

function collectTimeWindows(
  where: PerformancePredicate,
): Extract<PerformancePredicate, { kind: "TIME_WINDOW" }>[] {
  const windows: Extract<PerformancePredicate, { kind: "TIME_WINDOW" }>[] = [];
  let violated = false;
  function walk(node: PerformancePredicate, allowed: boolean): void {
    const kind = (node as { kind: string }).kind;
    switch (kind) {
      case "AND": {
        for (const child of (node as { of: PerformancePredicate[] }).of) walk(child, allowed);
        break;
      }
      case "OR": {
        for (const child of (node as { of: PerformancePredicate[] }).of) walk(child, false);
        break;
      }
      case "NOT": {
        walk((node as { of: PerformancePredicate }).of, false);
        break;
      }
      case "TIME_WINDOW": {
        if (allowed) windows.push(node as Extract<PerformancePredicate, { kind: "TIME_WINDOW" }>);
        else violated = true;
        break;
      }
      case "MOVIE":
      case "ATTRIBUTE":
      case "AUDITORIUM":
      case "PRICE":
      case "RUNTIME":
      case "DATE_RANGE":
        break;
      default: {
        // S42 FORMAT not yet in type union — treat unknown leaf as neutral
        break;
      }
    }
  }
  try {
    walk(where, true);
  } catch {
    return [];
  }
  if (violated) {
    // ambiguous predicate — treat as no window for ranking (neutral)
    return [];
  }
  return windows;
}

function collectFormatCodes(where: PerformancePredicate): string[] {
  const codes: string[] = [];
  function walk(node: PerformancePredicate): void {
    if (node === null || typeof node !== "object") return;
    const kind = (node as { kind?: string }).kind;
    if (kind === "FORMAT") {
      const code = (node as { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
      return;
    }
    if (kind === "AND" || kind === "OR") {
      const of = (node as { of?: unknown }).of;
      if (Array.isArray(of)) {
        for (const child of of) walk(child as PerformancePredicate);
      }
      return;
    }
    if (kind === "NOT") {
      const of = (node as { of?: unknown }).of;
      if (of !== null && typeof of === "object") walk(of as PerformancePredicate);
    }
  }
  try {
    walk(where);
  } catch {
    return [];
  }
  return codes;
}

function parseLocalMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

export function candidateTimeFit(
  startsAt: Date,
  spec: SearchSpec,
  timezone?: string | null,
): number {
  const windows = collectTimeWindows(spec.where);
  if (windows.length === 0) {
    return 1;
  }
  const window = windows[0]!;
  const start = parseLocalMinutes(window.startLocal);
  const end = parseLocalMinutes(window.endLocal);
  if (start === null || end === null || end <= start) {
    return 1;
  }
  // Theatre-local wall time via local-time.ts (same conversion every other
  // TIME_WINDOW site uses). ADR 0037 decision 1's "tapers linearly to 0 at
  // the window edges" is interpreted without inventing a buffer width:
  // the window's own bounds are the taper domain — midpoint peaks at 1.0,
  // each edge is 0.0, using only numbers the window already supplies.
  // No magic buffer constant is introduced (gate 14).
  let localMinutes: number | null | undefined;
  try {
    const tz = IanaTimezoneSchema.parse(timezone ?? "UTC");
    const utcInstant = UtcInstantSchema.parse(startsAt.toISOString());
    const local = toTheatreLocal(utcInstant, tz);
    localMinutes = parseLocalMinutes(local.localDateTime.slice(11, 16));
  } catch {
    localMinutes = startsAt.getUTCHours() * 60 + startsAt.getUTCMinutes();
  }
  if (localMinutes == null) {
    return 1;
  }
  const midpoint = (start + end) / 2;
  const halfWidth = (end - start) / 2;
  if (halfWidth <= 0) {
    return 1;
  }
  const distance = Math.abs(localMinutes - midpoint);
  const fit = 1 - distance / halfWidth;
  return Math.max(0, Math.min(1, fit));
}

function formatMatchForPerformance(formatCode: string | null, spec: SearchSpec): number {
  const codes = collectFormatCodes(spec.where);
  if (codes.length === 0) {
    return 0;
  }
  for (const code of codes) {
    if (code === "STANDARD") {
      if (formatCode === null) return 1;
    } else if (formatCode !== null && formatCode === code) {
      return 1;
    }
  }
  return 0;
}

export function rankCandidate(
  performance: TaggedFreshPerformance,
  spec: SearchSpec,
  timezone?: string | null,
): number {
  const formatMatch = formatMatchForPerformance(performance.performance.formatCode, spec);
  const proximity = candidateProximity(performance.distanceKm);
  const tz = timezone ?? (performance as { timezone?: string }).timezone ?? null;
  const timeFit = candidateTimeFit(performance.performance.startsAt, spec, tz);
  return 0.5 * formatMatch + 0.3 * proximity + 0.2 * timeFit;
}
