import {
  type VenueProvider,
  type ProviderOutcome,
  type SeatPageResult,
  type Performance,
} from "../contract.js";
import { type Theatre, type TheatreRef, type ShowtimeId, parseNamespacedId } from "@seatfirst/core";
import { type AmcFetcher } from "./fetcher.js";
import { buildTheatresUrl, buildShowtimesUrl, buildSeatsUrl, isAllowedUrl } from "./routes.js";
import { parseTheatres } from "./parse/theatres.js";
import { parseShowtimes } from "./parse/showtimes.js";
import { parseSeats } from "./parse/seats.js";
import { ProviderError } from "../errors.js";
import { EXTRACTOR_VERSION } from "./flight.js";

export class AmcProvider implements VenueProvider {
  public readonly id = "amc";

  constructor(private readonly fetcher: AmcFetcher) {}

  async searchTheatres(query: string): Promise<ProviderOutcome<readonly Theatre[]>> {
    const url = buildTheatresUrl(query);
    const fetchOutcome = await this.fetcher.fetch(url);
    if (!fetchOutcome.ok) return fetchOutcome;

    try {
      const theatres = parseTheatres(fetchOutcome.value.body, new Date(), url.toString());
      fetchOutcome.value.log.enrich(EXTRACTOR_VERSION, null);
      return { ok: true, value: theatres };
    } catch (err) {
      fetchOutcome.value.log.enrich(
        EXTRACTOR_VERSION,
        err instanceof Error ? err.message : String(err),
      );
      if (err instanceof ProviderError) {
        return { ok: false, code: err.code, message: err.message, providerMeta: err.providerMeta };
      }
      return { ok: false, code: "UPSTREAM_CHANGED", message: String(err), providerMeta: {} };
    }
  }

  async getSchedule(
    theatreRef: TheatreRef,
    localDate: string,
  ): Promise<ProviderOutcome<readonly Performance[]>> {
    const slugs = theatreRef.slugs ?? {};
    if (!slugs.market || !slugs.theatre) {
      return {
        ok: false,
        code: "UPSTREAM_CHANGED",
        message: "Missing required slugs",
        providerMeta: {},
      };
    }

    const url = buildShowtimesUrl(slugs.market, slugs.theatre, localDate);
    const fetchOutcome = await this.fetcher.fetch(url);
    if (!fetchOutcome.ok) return fetchOutcome;

    try {
      const performances = parseShowtimes(fetchOutcome.value.body, new Date(), url.toString());
      fetchOutcome.value.log.enrich(EXTRACTOR_VERSION, null);
      // Populate deep links using our own provider method
      // Attach the constructed URL to providerMeta so deepLink can use it without ID synthesis
      const linked = performances.map((p) => ({
        ...p,
        providerMeta: { ...p.providerMeta, showtimesUrl: url.toString() },
      }));
      // Now set the actual deepLinkUrl field
      const finalized = linked.map((p) => ({ ...p, deepLinkUrl: this.deepLink(p) }));
      return { ok: true, value: finalized };
    } catch (err) {
      fetchOutcome.value.log.enrich(
        EXTRACTOR_VERSION,
        err instanceof Error ? err.message : String(err),
      );
      if (err instanceof ProviderError) {
        return { ok: false, code: err.code, message: err.message, providerMeta: err.providerMeta };
      }
      return { ok: false, code: "UPSTREAM_CHANGED", message: String(err), providerMeta: {} };
    }
  }

  async getSeatPage(showtimeId: ShowtimeId): Promise<ProviderOutcome<SeatPageResult>> {
    const parsed = parseNamespacedId(showtimeId);
    if (!parsed.ok || parsed.value.providerId !== "amc" || parsed.value.kind !== "showtime") {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Invalid showtime ID namespace",
        providerMeta: {},
      };
    }
    if (!/^\d+$/.test(parsed.value.raw)) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Invalid showtime ID format",
        providerMeta: {},
      };
    }
    const numericId = parseInt(parsed.value.raw, 10);
    if (!Number.isSafeInteger(numericId)) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Invalid showtime ID magnitude",
        providerMeta: {},
      };
    }
    const url = buildSeatsUrl(numericId);
    const fetchOutcome = await this.fetcher.fetch(url);
    if (!fetchOutcome.ok) return fetchOutcome;

    try {
      const seats = parseSeats(fetchOutcome.value.body, new Date(), url.toString(), numericId);
      fetchOutcome.value.log.enrich(EXTRACTOR_VERSION, null);
      return { ok: true, value: seats };
    } catch (err) {
      fetchOutcome.value.log.enrich(
        EXTRACTOR_VERSION,
        err instanceof Error ? err.message : String(err),
      );
      if (err instanceof ProviderError) {
        return { ok: false, code: err.code, message: err.message, providerMeta: err.providerMeta };
      }
      return { ok: false, code: "UPSTREAM_CHANGED", message: String(err), providerMeta: {} };
    }
  }

  deepLink(performance: Performance, seatNames?: readonly string[]): string {
    // ADR 0002 §3.5 Phase 2 (2026-09-05): resolve the seat-level URL from the namespaced
    // numeric showtime ID and the placement's validated `seatNames`, validating through
    // `isAllowedUrl` before return.
    const parsed = parseNamespacedId(performance.showtimeId);
    if (
      parsed.ok &&
      parsed.value.providerId === "amc" &&
      parsed.value.kind === "showtime" &&
      /^\d+$/.test(parsed.value.raw)
    ) {
      const numericId = parseInt(parsed.value.raw, 10);
      if (Number.isSafeInteger(numericId)) {
        const seatsUrl = buildSeatsUrl(numericId, seatNames);
        if (isAllowedUrl(seatsUrl)) {
          return seatsUrl.toString();
        }
      }
    }
    const showtimesUrl = performance.providerMeta?.showtimesUrl;
    if (typeof showtimesUrl === "string") {
      const parsedShowtimes = new URL(showtimesUrl);
      if (isAllowedUrl(parsedShowtimes)) {
        return parsedShowtimes.toString();
      }
    }
    return "https://www.amctheatres.com/";
  }
}
