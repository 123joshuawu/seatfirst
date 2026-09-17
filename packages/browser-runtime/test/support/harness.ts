/**
 * Offline synthetic "network" for the corridor suite (P6.17, P6.19).
 *
 * The harness is the ENTIRE network: `runCorridorNavigation` performs each document
 * hop by calling its injected `fetchHop` seam, so no request ever resolves DNS or
 * touches a socket. Requests outside the scripted corridor are refused and recorded,
 * which is the suite's network-denial enforcement for AMC hostnames. A subresource
 * can never reach the seam at all: the transport aborts non-document requests before
 * dispatch (verified through the `subresourceAborts` count, not this harness).
 */

import type { Route } from "playwright-core";
import type { HopResponse } from "../../src/transport.js";

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface SyntheticHop {
  /** The exact document URL this hop must carry (WHATWG-normalized). */
  readonly url: string;
  readonly status: number;
  /** Extra response headers (lowercase names); `location` is added for redirects automatically. */
  readonly headers?: Record<string, string>;
  /** Present for 3xx hops: the next hop's URL. */
  readonly location?: string;
  readonly body?: string;
  /**
   * When set, the handler withholds the response until the test resolves the deferred —
   * used to hold a hop open (cancellation / wedged-cleanup tests).
   */
  readonly hold?: Deferred;
}

export interface DocumentRecord {
  readonly url: string;
  readonly cookies: string;
}

export interface SyntheticHarness {
  /** Guard-accepted document requests, in order, with the Cookie header they carried. */
  readonly documents: readonly DocumentRecord[];
  /** Document requests the script did not include or that mismatched the scripted URL. */
  readonly refusals: readonly string[];
  /** The `fetchHop` seam to inject into `runCorridorNavigation`. */
  readonly fetchHop: (route: Route) => Promise<HopResponse>;
}

export function createHarness(hops: readonly SyntheticHop[]): SyntheticHarness {
  const documents: DocumentRecord[] = [];
  const refusals: string[] = [];

  async function fetchHop(route: Route): Promise<HopResponse> {
    const request = route.request();
    const url = request.url();
    const index = documents.length;
    documents.push({ url, cookies: request.headers()["cookie"] ?? "" });
    const hop = hops[index];
    if (hop === undefined || hop.url !== url) {
      // Unscripted or misordered document: refuse — this is the denial posture.
      refusals.push(url);
      throw new Error("synthetic network refused an unscripted document request");
    }
    if (hop.hold !== undefined) {
      await hop.hold.promise;
    }
    const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      ...hop.headers,
    };
    if (hop.location !== undefined) {
      headers["location"] = hop.location;
    }
    return { status: hop.status, headers, body: hop.body ?? "" };
  }

  return { documents, refusals, fetchHop };
}

export const SEAT_PAGE_HTML = `<!doctype html>
<html>
  <head><title>seat page</title></head>
  <body>
    <h1>Seats</h1>
    <div id="seat-map"></div>
    <link rel="stylesheet" href="/assets/seat.css" />
    <img src="/assets/poster.jpg" alt="poster" />
    <script src="/assets/seat-app.js"></script>
</html>`;

export const QUEUE_WAITING_HTML = `<!doctype html>
<html>
  <head><title>queue waiting</title></head>
  <body>
    <h1>You are in the queue</h1>
    <script src="/queueit/waitingroom.js"></script>
  </body>
</html>`;

/**
 * ADR 0010 synthetic pages. Each dispatches its XHR from a classic inline `<script>`
 * using a SYNCHRONOUS request: `send()` blocks the parser until the request settles
 * (the corridor's abort fails it, or the mapped synthetic server answers it), so the
 * document's `load` event — which the transport waits for before capturing the
 * outcome — cannot fire until the XHR resolved. The abort count and the post-request
 * DOM markers are therefore captured deterministically instead of racing the walker.
 */
export const THEATRE_SEARCH_PAGE_HTML = `<!doctype html>
<html>
  <head><title>theatre search</title></head>
  <body>
    <h1>Find a Theatre</h1>
    <div id="search-results"></div>
    <script>
      document.body.dataset.fetchDispatched = "yes";
      var request = new XMLHttpRequest();
      try {
        request.open("GET", "/api/theatre-search-results", false);
        request.send(null);
        document.body.dataset.searchResult = request.responseText;
      } catch (error) {
        document.body.dataset.searchResult = "aborted";
      }
    </script>
  </body>
</html>`;

export const THEATRE_SEARCH_ABORTED_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <title>theatre search</title>
    <link rel="stylesheet" href="/assets/search.css" />
  </head>
  <body>
    <h1>Find a Theatre</h1>
    <img src="/assets/poster.jpg" alt="poster" />
    <script src="/assets/search-app.js"></script>
    <script>
      document.body.dataset.crossOriginDispatched = "yes";
      var request = new XMLHttpRequest();
      try {
        request.open("GET", "https://cdn.example.invalid/results.json", false);
        request.send(null);
        document.body.dataset.crossOriginFetch = "unexpected-success";
      } catch (error) {
        document.body.dataset.crossOriginFetch = "aborted";
      }
    </script>
  </body>
</html>`;

export const MOVIES_XHR_PAGE_HTML = `<!doctype html>
<html>
  <head><title>movies</title></head>
  <body>
    <h1>Movies</h1>
    <script>
      document.body.dataset.fetchDispatched = "yes";
      var request = new XMLHttpRequest();
      try {
        request.open("GET", "/api/theatre-search-results", false);
        request.send(null);
        document.body.dataset.fetchOutcome = "unexpected-success";
      } catch (error) {
        document.body.dataset.fetchOutcome = "aborted";
      }
    </script>
  </body>
</html>`;
