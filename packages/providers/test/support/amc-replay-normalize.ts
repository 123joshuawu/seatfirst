/**
 * AMC adapter normalize step for the fixture replay harness (P5.12) — the "later, separately
 * gate-cleared adapter parser" `test/support/replay.ts`'s module comment anticipated plugging
 * into its `normalize` seam without replay.ts itself changing (replay.ts:14-15, 39-41).
 *
 * Replays each redacted fixture `{url, status, headers, body}` through the exact production
 * request pipeline `AmcProvider` (src/amc/provider.ts) runs, minus the network hop and the
 * fetcher's per-request log object:
 *
 *   1. `classifyResponse` first (src/amc/fetcher.ts:274-277): if it fails, that IS the outcome
 *      and no parser runs — the same gate that precedes every parser in production.
 *   2. On success, dispatch by URL route (route → parser table, fixtures/README.md):
 *        /movie-theatres?q=<query>                 → parseTheatres    (searchTheatres)
 *        /movie-theatres (bare, no `q`)            → parseMarketSlugs (S26.4 directory index)
 *        /movie-theatres/<marketSlug>                → parseTheatres    (per-market theatre list,
 *                                                      ADR 0021 — no production caller yet)
 *        /movie-theatres/<m>/<t>/showtimes?date=   → parseShowtimes   (getSchedule, incl. its
 *                                                      deep-link enrichment)
 *        /showtimes/<id>/seats                     → parseSeats       (getSeatPage; the id
 *                                                      argument comes from the URL segment)
 *      The bare `/movie-theatres` directory index is dispatched to `parseMarketSlugs`
 *      (S26.4): it is a market/state link list, not theatre records, so it has its own
 *      parser/golden pair rather than running through `parseTheatres`.
 *      An unknown route throws and surfaces as NORMALIZE_FAILED — never silently skipped.
 *   3. `ProviderError` → {ok:false, code, message, providerMeta}; any other throw →
 *      {ok:false, code:"UPSTREAM_CHANGED", ...} — provider.ts's own catch-block translation.
 *
 * `observationTime` comes from the fixture's authoritative `headers.date` capture timestamp, not
 * `new Date()` as provider.ts uses: replay must be reproducible run to run, and every promoted
 * fixture records its own capture time in `date`.
 */

import type { Performance, ProviderOutcome } from "../../src/contract.js";
import { classifyResponse } from "../../src/amc/classify.js";
import { isAllowedUrl } from "../../src/amc/routes.js";
import { parseTheatres } from "../../src/amc/parse/theatres.js";
import { parseShowtimes } from "../../src/amc/parse/showtimes.js";
import { parseSeats } from "../../src/amc/parse/seats.js";
import { parseMarketSlugs } from "../../src/amc/parse/market-slugs.js";
import { ProviderError, type ProviderErrorCode } from "../../src/errors.js";
import type { Normalize } from "./replay.js";

export interface FixturePayload {
  readonly url: string;
  readonly status: number;
  readonly headers: Record<string, string | undefined>;
  readonly body: string;
}

function asFixturePayload(payload: unknown): FixturePayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("fixture payload must be a JSON object");
  }
  const record = payload as Record<string, unknown>;
  const { url, status, headers, body } = record;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error('fixture payload field "url" must be a non-empty string');
  }
  if (typeof status !== "number" || !Number.isInteger(status)) {
    throw new Error('fixture payload field "status" must be an integer');
  }
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new Error('fixture payload field "headers" must be an object');
  }
  if (typeof body !== "string") {
    throw new Error('fixture payload field "body" must be a string');
  }
  return {
    url,
    status,
    headers: headers as Record<string, string | undefined>,
    body,
  };
}

/**
 * Exact failure messages `AmcFetcher.fetch` returns per classification code
 * (src/amc/fetcher.ts:300-350). `providerMeta` is `{}` here rather than the fetcher's `log`
 * object: the log embeds `new Date().toISOString()`, which would make goldens unreproducible.
 */
const CLASSIFICATION_MESSAGES: Readonly<Record<string, string>> = {
  CHALLENGE_REQUIRED: "Traffic control blocked request",
  UPSTREAM_BLOCKED: "Traffic control blocked request",
  UPSTREAM_QUEUED: "Traffic control blocked request",
  RATE_LIMITED: "Rate limited",
  NOT_FOUND: "Not found",
};

function classificationOutcome(code: ProviderErrorCode): ProviderOutcome<never> {
  return {
    ok: false,
    code,
    message: CLASSIFICATION_MESSAGES[code] ?? "Upstream error",
    providerMeta: {},
  };
}

/** provider.ts's catch-block translation: ProviderError passes through, anything else is UPSTREAM_CHANGED. */
function parseOutcome<T>(fn: () => T): ProviderOutcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof ProviderError) {
      return { ok: false, code: err.code, message: err.message, providerMeta: err.providerMeta };
    }
    return { ok: false, code: "UPSTREAM_CHANGED", message: String(err), providerMeta: {} };
  }
}

/** Mirrors AmcProvider.deepLink (provider.ts:131-140). */
function deepLinkFor(performance: Performance): string {
  const showtimesUrl = performance.providerMeta?.showtimesUrl;
  if (typeof showtimesUrl === "string") {
    const parsed = new URL(showtimesUrl);
    if (isAllowedUrl(parsed)) {
      return parsed.toString();
    }
  }
  return "https://www.amctheatres.com/";
}

export const amcReplayNormalize: Normalize = (payload: unknown): unknown => {
  const fixture = asFixturePayload(payload);
  const { url, status, headers, body } = fixture;

  const observationTime = new Date(headers.date ?? "");
  if (Number.isNaN(observationTime.getTime())) {
    throw new Error(
      `fixture headers.date must be a parseable date, got ${JSON.stringify(headers.date)}`,
    );
  }

  // 1. Classify first — mirrors src/amc/fetcher.ts:274-277; a failure short-circuits before any
  //    parser runs, exactly as in production.
  const classification = classifyResponse(status, headers, {
    finalHost: new URL(url).host,
    bodyPrefix: body, // fetcher.ts:248 (Finding 7): scan the complete body
  });
  if (!classification.ok) {
    return classificationOutcome(classification.code);
  }

  // 2. Dispatch by route shape.
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname;

  // The bare `/movie-theatres` pathname is shared by two distinct pages: the `?q=` search
  // results (real theatre records) and the bare directory index (a market/state link list).
  if (pathname === "/movie-theatres" && parsedUrl.searchParams.has("q")) {
    return parseOutcome(() => parseTheatres(body, observationTime, url));
  }

  // S26.4 — the bare directory index has no theatre records; `parseMarketSlugs` extracts the
  // market-slug links it is actually made of (the same shape routes.ts's marketMatch validates).
  if (pathname === "/movie-theatres") {
    return parseOutcome(() => parseMarketSlugs(body));
  }

  if (/^\/movie-theatres\/[^/]+$/.test(pathname)) {
    return parseOutcome(() => parseTheatres(body, observationTime, url));
  }

  if (/^\/movie-theatres\/[^/]+\/[^/]+\/showtimes$/.test(pathname)) {
    return parseOutcome(() => {
      const performances = parseShowtimes(body, observationTime, url);
      // getSchedule's enrichment (provider.ts:63-71), mirrored verbatim.
      const linked = performances.map((p) => ({
        ...p,
        providerMeta: { ...p.providerMeta, showtimesUrl: url },
      }));
      return linked.map((p) => ({ ...p, deepLinkUrl: deepLinkFor(p) }));
    });
  }

  const seatsMatch = /^\/showtimes\/([^/]+)\/seats$/.exec(pathname);
  if (seatsMatch) {
    const id = seatsMatch[1] ?? "";
    if (!/^\d+$/.test(id)) {
      throw new Error(`showtimes URL "${url}" carries a non-numeric id`);
    }
    const numericId = Number(id);
    return parseOutcome(() => parseSeats(body, observationTime, url, numericId));
  }

  throw new Error(
    `no VenueProvider method consumes route "${url}" — every fixture under fixtures/redacted/ must match a provider route`,
  );
};
