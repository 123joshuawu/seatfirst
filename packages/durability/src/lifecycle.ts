/**
 * Executable answer classification for ADR 0003's lifecycle matrix.
 *
 * B8 derives status and terminal cause from locked persisted state. The answer assembler
 * supplies placement evidence; this module is the single implementation that combines
 * those inputs into the immutable answer mode. Keeping it in source (rather than in the
 * Tier 3 test) makes the matrix an implementation exercised by the harness, not its own
 * test oracle.
 */

export type LifecycleStatus =
  "PENDING_SCHEDULE" | "RUNNING" | "COMPLETE" | "PARTIAL" | "HALTED" | "CANCELLED";

export type TerminalCause =
  | "CAPACITY"
  | "PARTIAL_SCHEDULE"
  | "PROVIDER_HALTED"
  | "TOO_FEW_SHOWTIMES"
  | "BATCH_DEFERRED"
  | null;

export type AggregateScheduleOutcome = "RESOLVED" | "EMPTY_RESOLVED" | "FAILED" | "MIXED" | null;

export type EmptyCause =
  "CAPACITY" | "HALTED" | "NO_SHAPE_MATCH" | "PARTIAL_SCHEDULE" | "SOLD_OUT" | "TOO_FEW_SHOWTIMES";

export interface Placement {
  readonly layoutId: string;
  readonly row: number;
  readonly startCol: number;
  readonly rowSpan: number;
  readonly count: number;
  readonly seatNames: readonly string[];
  readonly placementKey: string;
}

export interface Relaxation {
  readonly kind: string;
  readonly [detail: string]: unknown;
}

export interface Recommendation {
  readonly placement: Placement;
  readonly reasons: readonly unknown[];
  readonly relaxed: readonly Relaxation[];
  readonly showtimes: readonly unknown[];
}

export type ConfidentRecommendation = Omit<Recommendation, "relaxed"> & {
  readonly relaxed: readonly [];
};

export type HedgedRecommendation = Omit<Recommendation, "relaxed"> & {
  readonly relaxed: readonly [Relaxation, ...Relaxation[]];
};

export type HedgedAlternatives =
  | readonly [HedgedRecommendation, HedgedRecommendation]
  | readonly [HedgedRecommendation, HedgedRecommendation, HedgedRecommendation];

export type RankedAnswer =
  | {
      readonly mode: "CONFIDENT";
      readonly primary: ConfidentRecommendation;
      readonly otherFormats: readonly unknown[];
    }
  | {
      readonly mode: "HEDGED";
      readonly alternatives: HedgedAlternatives;
      readonly otherFormats: readonly unknown[];
    }
  | {
      readonly mode: "EMPTY";
      readonly cause: EmptyCause;
      readonly suggestions: readonly unknown[];
    };

export interface AnswerEvidence {
  /** Exact, unrelaxed recommendation, when the scorer found one. */
  readonly exact: ConfidentRecommendation | null;
  /** Two or three labeled alternatives, used for relaxed or incomplete evidence. */
  readonly hedged: HedgedAlternatives | null;
}

export interface LifecycleFacts {
  readonly status: LifecycleStatus;
  /** String at the boundary so an unrecognized persisted cause fails closed at runtime. */
  readonly terminalCause: string | null;
  readonly scheduleOutcome: AggregateScheduleOutcome;
  readonly acceptedFetches: number;
  readonly freeSeats: number;
}

const empty = (cause: EmptyCause): RankedAnswer => ({ mode: "EMPTY", cause, suggestions: [] });

/**
 * Derive exactly one ADR 0003 answer, or throw when persisted state has no matrix row.
 * `null` is returned only for the two nonterminal phases.
 */
export function deriveRankedAnswer(
  facts: LifecycleFacts,
  evidence: AnswerEvidence,
): RankedAnswer | null {
  if (facts.status === "PENDING_SCHEDULE" || facts.status === "RUNNING") {
    if (facts.terminalCause !== null) {
      throw new Error(`nonterminal ${facts.status} carried terminal cause ${facts.terminalCause}`);
    }
    return null;
  }
  switch (facts.terminalCause) {
    case "CAPACITY":
      if (facts.status !== "HALTED") throw new Error("CAPACITY requires HALTED status");
      return empty("CAPACITY");
    case "PROVIDER_HALTED":
      if (facts.status !== "HALTED") throw new Error("PROVIDER_HALTED requires HALTED status");
      return empty("HALTED");
    case "TOO_FEW_SHOWTIMES":
      if (facts.status !== "COMPLETE" || facts.scheduleOutcome !== "EMPTY_RESOLVED") {
        throw new Error("TOO_FEW_SHOWTIMES requires complete, empty schedule coverage");
      }
      return empty("TOO_FEW_SHOWTIMES");
    case "PARTIAL_SCHEDULE":
      if (facts.status !== "PARTIAL" || facts.scheduleOutcome !== "MIXED") {
        throw new Error("PARTIAL_SCHEDULE requires a partial search with mixed schedule coverage");
      }
      return evidence.hedged
        ? { mode: "HEDGED", alternatives: evidence.hedged, otherFormats: [] }
        : empty("PARTIAL_SCHEDULE");
    case "BATCH_DEFERRED":
      // ADR 0037: BATCH_DEFERRED must be indistinguishable from any other PARTIAL for
      // reveal purposes (docs/adr/0037-progressive-ranked-search-resolution.md:179-183) —
      // no special-cased answer; fall through to the shared PARTIAL fallback below.
      if (facts.status !== "PARTIAL") throw new Error("BATCH_DEFERRED requires PARTIAL status");
      break;
    case null:
      break;
    default:
      throw new Error(`terminal state has no answer-matrix row: ${facts.terminalCause}`);
  }

  if (facts.status === "HALTED") return empty("HALTED");

  // No accepted fetch observation is absence of data, never evidence of sold-out seats,
  // and never enough to stand behind a confident or hedged recommendation either — whether
  // that absence is a partial search or every showtime being policy-skipped (ADR 0009).
  if (facts.acceptedFetches === 0) return empty("HALTED");

  if (facts.status === "COMPLETE" && evidence.exact) {
    return { mode: "CONFIDENT", primary: evidence.exact, otherFormats: [] };
  }
  if (evidence.hedged) {
    return { mode: "HEDGED", alternatives: evidence.hedged, otherFormats: [] };
  }

  if (facts.freeSeats > 0) return empty("NO_SHAPE_MATCH");
  // SOLD_OUT is reachable only with complete evidence (ADR 0003 A6).
  return facts.status === "COMPLETE" ? empty("SOLD_OUT") : empty("HALTED");
}
