import type {
  Placement as ApiPlacement,
  Money,
  Recommendation,
  RecommendationReason,
  Relaxation,
  ShowtimeOffer,
} from "@seatfirst/core";

// Live wire types — picker and movie grid read from these, not demo TheaterInfo.
export type {
  TheatreSearchHit,
  TheatreSearchResponse,
  TheatreMoviesResponse,
  TheatreMovieGroup,
} from "@seatfirst/core";

// Re-exported so callers can pull the contract shapes from this module alongside the
// UI-only ones below, instead of reaching into `@seatfirst/core` directly.
export type {
  ApiPlacement,
  Money,
  Recommendation,
  RecommendationReason,
  Relaxation,
  ShowtimeOffer,
};

export type PlacementHue = "indigo" | "amber";

export interface ShowtimeViewItem {
  time: string;
  price: string;
  // Carry-through for UI6 deep-link handoff — not rendered as display copy (UI4.8).
  // Must be preserved so `showtimes.recheck` can mint `Linking.openURL(deepLinkUrl)` with
  // the server-minted `nonce` and correct `timezone`/`showDateTimeUtc`.
  showtimeId: string;
  theatreId: string;
  deepLinkUrl: string;
  nonce: string | null;
  timezone: string;
  showDateTimeUtc: string;
}

/**
 * The per-card view model a result screen renders. Every field here is DERIVED from a
 * `Recommendation` + `ResultGroup` (see `lib/presentation.ts`) — this module holds no
 * source-of-truth seat/showtime data itself, so nothing here can drift from the
 * `@seatfirst/core` contract shapes without the derivation function's own logic changing too.
 */
export interface PlacementCard {
  id: string;
  format: string;
  auditorium: string;
  seats: string;
  seatDesc: string;
  altDesc: string;
  hue: PlacementHue;
  /** The single contiguous run this card highlights on the demo grid (rowSpan is always 1 in v1 — see ADR 0025 §3/decision log on split placements). */
  run: { row: number; startCol: number; count: number };
  showtimes: ShowtimeViewItem[];
  explanation: {
    concise: string;
    balanced: string;
    detailed: string;
  };
}

export interface SeatDotData {
  active: boolean;
  hue: PlacementHue;
  size: number;
  /** A seat from the original placement that is no longer available. */
  lost?: boolean;
}

export interface SeatGridRow {
  dots: SeatDotData[];
}

export type FormatPref = "any" | "imax" | "dolby" | "standard";

export type ResultMode = "clear" | "noExact" | "noValid";

export type TerminalScreen = "partial" | "halted";

export type Screen =
  "search" | "checking" | "result" | "partial" | "halted" | "recheck" | "replacement" | "confirmed";

export type SeatPrefName = "Centered" | "Aisle" | "Avoid front";
