/**
 * S31.2 — the `buildTargetUrl` producer. Route class `seat` (SHOWTIME_FETCH/RECHECK) →
 * `buildSeatsUrl` from the run key's numeric showtime id; route class `schedule`
 * (SCHEDULE_RESOLUTION) → `buildShowtimesUrl` after reading the theatre's slugs through the
 * named boundary `THEATRE_READ_BY_ID` (D2). Async because the schedule branch reads the
 * catalogue.
 */
import type { Pool } from "pg";

import { poolClient, readTheatreById } from "@seatfirst/durability";
import { buildMovieShowtimesUrl, buildSeatsUrl, buildShowtimesUrl } from "@seatfirst/providers";

import type { RunKeyRow } from "../queries.js";
import { parseNumericShowtimeId } from "./parse-observation.js";

export function createBuildTargetUrl(pool: Pool): (runKey: RunKeyRow) => Promise<string> {
  const db = poolClient(pool);
  return async (runKey) => {
    if (runKey.routeClass === "seat") {
      return buildSeatsUrl(parseNumericShowtimeId(runKey.showtimeId)).toString();
    }
    if (runKey.routeClass === "schedule") {
      if (runKey.theatreId === null || runKey.localDate === null) {
        throw new Error("schedule run key carries no theatre id or local date");
      }
      const rows = await readTheatreById(db, runKey.theatreId);
      if (rows.length === 0) {
        throw new Error(`no theatre catalogue row for ${runKey.theatreId}`);
      }
      const row = rows[0]!;
      if (row.market_slug === null || row.slugs === null) {
        throw new Error(`theatre ${runKey.theatreId} has no market slug or slugs`);
      }
      const theatreSlug = row.slugs[row.market_slug];
      if (theatreSlug === undefined) {
        throw new Error(`theatre ${runKey.theatreId} has no slug for market ${row.market_slug}`);
      }
      return buildShowtimesUrl(row.market_slug, theatreSlug, runKey.localDate).toString();
    }
    if (runKey.routeClass === "movie-schedule") {
      if (
        runKey.movieSlug === null ||
        runKey.movieSlug === "" ||
        runKey.theatreId === null ||
        runKey.localDate === null
      ) {
        throw new Error("movie-schedule run key missing movieSlug, theatreId, or localDate");
      }
      const rows = await readTheatreById(db, runKey.theatreId);
      const theatre = rows[0];
      if (theatre === undefined) {
        throw new Error(`no theatre catalogue row for ${runKey.theatreId}`);
      }
      if (theatre.market_slug === null || theatre.slugs === null) {
        throw new Error(`theatre ${runKey.theatreId} has no market slug or slugs`);
      }
      const theatreSlug = theatre.slugs[theatre.market_slug];
      if (theatreSlug === undefined) {
        throw new Error(`theatre ${runKey.theatreId} has no slug for market ${theatre.market_slug}`);
      }
      return buildMovieShowtimesUrl(runKey.movieSlug, theatreSlug, runKey.localDate).toString();
    }
    throw new Error(`unhandled route class: ${runKey.routeClass}`);
  };
}
