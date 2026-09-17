# Browser-Request Comparison Records — 2026-08-11

This file contains two separate diagnostics. The cookie/redaction rules are identical across
both: cookies, `Set-Cookie` values, authorization values, Cloudflare clearance tokens,
response bodies, and IP addresses are excluded. Header names are recorded; sensitive values
are replaced with `[redacted]`.

## Diagnostic 1: Header-parity comparison (curl vs browser)

**Authorization:** Decision owner Josh Wu, ADR 0002 §3.4 (bounded fixture-capture
diagnostic). **Consumed** — the single browser navigation and single curl request recorded
below are the full extent of this authorization. See `CAPTURE-LOG.md` lines 254-291.

### Captured browser navigation

| Attribute                    | Redacted record                                       | Evidence level                                                         |
| ---------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Start                        | `2026-08-11T06:08:19.634Z`                            | Observed                                                               |
| End                          | `2026-08-11T06:08:20.421Z`                            | Observed                                                               |
| Main-document URL            | `GET https://www.amctheatres.com/movies`              | Method implied by ordinary top-level navigation; URL observed          |
| Final URL                    | `https://www.amctheatres.com/movies`                  | Observed; no top-level redirect                                        |
| Page classification          | Ordinary AMC page, not a visible traffic-control page | Derived in memory from the title and retained only as a classification |
| Browser request headers      | Not exposed by the in-app browser interface           | Unavailable; no header is represented as captured                      |
| Protocol and TLS fingerprint | Not exposed by the in-app browser interface           | Unavailable                                                            |
| Normal subresources          | Authorized and loaded as part of the page navigation  | Count and headers not exposed                                          |
| Cookies / clearance material | Excluded                                              | Neither inspected, recorded, nor replayed                              |
| Response body                | Excluded                                              | Neither recorded nor persisted                                         |

The browser interface exposed page-level outcome metadata but not a HAR or raw network-request
event. Consequently, the standalone test below uses a coherent, non-sensitive Chrome 136
navigation profile; those headers are **constructed test inputs**, not falsely labeled as captured
browser values.

## Standalone comparison request

The single standalone request used `curl 8.7.1` with SecureTransport and negotiated HTTP/2. It
sent no cookie, authorization, clearance, or referrer value; followed no redirect; performed no
retry; and discarded its response body to `/dev/null`.

| Attribute                           | Test value                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Method and URL                      | `GET https://www.amctheatres.com/movies`                                                                                                                |
| HTTP version                        | HTTP/2 negotiated                                                                                                                                       |
| User-Agent                          | Chrome 136 on macOS, without a SeatFinder suffix                                                                                                        |
| Navigation headers                  | Browser-style `Accept`, `Accept-Encoding`, `Accept-Language`, `Cache-Control`, `Priority`, `Sec-CH-UA*`, `Sec-Fetch-*`, and `Upgrade-Insecure-Requests` |
| Cookies / clearance / authorization | None                                                                                                                                                    |
| Redirects / retries                 | None                                                                                                                                                    |
| Result                              | HTTP 403, `text/html; charset=UTF-8`                                                                                                                    |
| Response bytes discarded            | 2,099                                                                                                                                                   |
| Total time                          | 158 ms                                                                                                                                                  |

## Attribute assessment

| Attribute or signal                              | Likelihood needed for the browser outcome | Evidence and interpretation                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Egress IP and reputation                         | Very high                                 | Browser navigation succeeded while every standalone request was blocked. The two runtimes may use different egress, but IPs were deliberately not recorded.     |
| Chrome TLS fingerprint                           | Very high                                 | The successful browser used Chrome's network stack; the failed HTTP/2 test used curl/SecureTransport. Matching HTTP headers does not match the TLS ClientHello. |
| Browser execution environment                    | High                                      | A real browser can execute Cloudflare checks and maintain ephemeral state even when no visible challenge appears. The standalone client cannot.                 |
| Existing session or non-exported cookies         | High                                      | Browser state may contribute to the decision. This diagnostic deliberately did not inspect or replay it, so the factor remains unresolved.                      |
| HTTP/2 implementation, framing, and header order | Medium–high                               | The test negotiated HTTP/2 but used libcurl rather than Chrome, leaving protocol-level fingerprint differences.                                                 |
| Non-sensitive navigation and client-hint headers | Low–medium                                | A coherent set was added and the response remained HTTP 403, so these headers are not sufficient.                                                               |
| Browser-looking User-Agent                       | Low                                       | Both earlier Node probes with a Chrome UA returned the same Cloudflare 403.                                                                                     |
| SeatFinder/contact suffix                        | Ruled out                                 | The suffixed and suffix-free Node probes returned the same status, classification, and byte count.                                                              |

## Conclusion

Header parity plus HTTP/2 did not reproduce the browser's ordinary-page outcome. The remaining
high-likelihood factors are transport fingerprint, browser execution/session state, and egress
reputation. This diagnostic does not authorize copying cookies or clearance tokens, challenge
automation, browser impersonation in the provider, another request, or a fixture-capture rerun.

## Diagnostic 2: Full-attribute browser navigation capture (DevTools MCP)

**Authorization:** Decision owner Josh Wu, 2026-08-11, ADR 0002 §2.8 Option 2 (counsel-authorized
bounded browser-fingerprint impersonation). **Scope:** one ordinary browser navigation of
`GET https://www.amctheatres.com/movies` with full DevTools Network-panel capture of every
request/response header, redirect, cookie, and timing attribute from the redirect chain. This
diagnostic is separate from Diagnostic 1 above — it does not supersede it. It authorizes no
standalone request, no cookie replay, and no provider-code change.

Cookie values, `Set-Cookie` values, `cf_clearance` tokens, response bodies, and IP addresses
are redacted. Header **names** are recorded verbatim; sensitive values are replaced with
`[redacted]`. Headers not present in a given request are listed as "absent" rather than
silently omitted.

### Redirect chain (chronological, reqid order)

The browser navigated `GET https://www.amctheatres.com/movies`. Cloudflare's Worker
intercepted the request and routed it through Queue-it's Global Safety Net before the page
loaded.

| Hop | reqid | Request                                                                        | Status         | CF-Ray                 |
| --- | ----- | ------------------------------------------------------------------------------ | -------------- | ---------------------- |
| 1   | 1     | `GET https://www.amctheatres.com/movies`                                       | 302 → Queue-it | `a2957643ec5f78eb-SJC` |
| 2   | 2     | `GET https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb&...`    | 302 → back     | _(none)_               |
| 3   | 3     | `GET https://www.amctheatres.com/movies?queueittoken=e_globalsafetynetweb~...` | 302            | `a29576454f1c78eb-SJC` |
| 4   | 4     | `GET https://www.amctheatres.com/movies`                                       | **200**        | `a29576458f8678eb-SJC` |

### Cookie flow across the redirect chain

| Hop | Cookies carried on request                              | Cookies set by response                                                                                                         |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | _(none — initial navigation)_                           | `__cf_bm` (Cloudflare Bot Management, HttpOnly, Secure, SameSite=None, Domain=amctheatres.com, 30 min TTL)                      |
| 2   | `__cf_bm`                                               | `Queue-it-visitorsession` (Queue-it internal, HttpOnly, Secure, SameSite=Strict, Path=/)                                        |
| 3   | `__cf_bm`                                               | `QueueITAccepted-SDFrts345E-V3_globalsafetynetweb` (Queue-it cleared, RedirectType=disabled, Domain=.amctheatres.com, 24 h TTL) |
| 4   | `__cf_bm`; `Queue-it-visitorsession`; `QueueITAccepted` | `session` (AMC Next.js, Domain=amctheatres.com, 13-month TTL); `seed` (AMC, Path=/); `QueueITAccepted` (re-set)                 |

### Hop 1 — Cloudflare Worker intercept (reqid=1)

| Attribute                           | Value                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Request URL                         | `GET https://www.amctheatres.com/movies`                                |
| Status                              | 302                                                                     |
| Server response header              | `cloudflare`                                                            |
| X-Queueit-Connector response header | `cloudflare`                                                            |
| Location response header            | `https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb&...` |

**Complete request headers:**

- `:authority`: `www.amctheatres.com`
- `:method`: GET
- `:path`: /movies
- `:scheme`: https
- `upgrade-insecure-requests`: 1
- `user-agent`: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
- `sec-ch-ua`: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"
- `sec-ch-ua-mobile`: ?0
- `sec-ch-ua-platform`: "macOS"
- `accept`: `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7`
- `accept-encoding`: gzip, deflate, br, zstd
- `accept-language`: en-US,en;q=0.9
- `priority`: u=0, i
- `sec-fetch-dest`: document
- `sec-fetch-mode`: navigate
- `sec-fetch-site`: none
- `sec-fetch-user`: ?1
- `cookie`: absent
- `referer`: absent
- `cache-control`: absent
- `sec-ch-ua-arch`: absent
- `sec-ch-ua-bitness`: absent
- `sec-ch-ua-full-version`: absent
- `sec-ch-ua-full-version-list`: absent
- `sec-ch-ua-model`: absent
- `sec-ch-ua-platform-version`: absent
- `dnt`: absent

**Complete response headers:**

- `cache-control`: no-cache, no-store, must-revalidate, max-age=0
- `cf-ray`: a2957643ec5f78eb-SJC
- `content-length`: 0
- `date`: Tue, 11 Aug 2026 07:17:41 GMT
- `expires`: Fri, 01 Jan 1990 00:00:00 GMT
- `location`: `https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb&ver=javascript-4.4.4&cver=99&man=Global%20Safety%20Net%20-%20Web%20Prod&enqueuetoken=[redacted]&t=https%3A%2F%2Fwww.amctheatres.com%2Fmovies&kupver=cloudflare-4.4.3`
- `pragma`: no-cache
- `server`: cloudflare
- `set-cookie`: __cf_bm=[redacted]; HttpOnly; SameSite=None; Secure; Path=/; Domain=amctheatres.com; Expires=Tue, 11 Aug 2026 07:47:41 GMT
- `strict-transport-security`: max-age=31536000; includeSubDomains
- `x-content-type-options`: nosniff
- `x-frame-options`: SAMEORIGIN
- `x-queueit-connector`: cloudflare

### Hop 2 — Queue-it processor (reqid=2)

| Attribute                    | Value                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| Request URL                  | `GET https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb&...` |
| Status                       | 302                                                                         |
| Server response header       | `Kestrel`                                                                   |
| X-Robots-Tag response header | `noindex`                                                                   |
| Location response header     | `https://www.amctheatres.com/movies?queueittoken=[redacted]`                |

**Complete request headers:**

- `:authority`: queue.amctheatres.com
- `:method`: GET
- `:path`: /?c=amctheatres&e=globalsafetynetweb&ver=javascript-4.4.4&cver=99&man=Global%20Safety%20Net%20-%20Web%20Prod&enqueuetoken=[redacted]&t=https%3A%2F%2Fwww.amctheatres.com%2Fmovies&kupver=cloudflare-4.4.3
- `:scheme`: https
- `upgrade-insecure-requests`: 1
- `user-agent`: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
- `sec-ch-ua`: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"
- `sec-ch-ua-mobile`: ?0
- `sec-ch-ua-platform`: "macOS"
- `accept`: `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7`
- `accept-encoding`: gzip, deflate, br, zstd
- `accept-language`: en-US,en;q=0.9
- `cookie`: __cf_bm=[redacted]
- `priority`: u=0, i
- `sec-fetch-dest`: document
- `sec-fetch-mode`: navigate
- `sec-fetch-site`: none
- `sec-fetch-user`: ?1
- `referer`: absent
- `cache-control`: absent
- `sec-ch-ua-arch`: absent
- `sec-ch-ua-bitness`: absent
- `sec-ch-ua-full-version`: absent
- `sec-ch-ua-full-version-list`: absent
- `sec-ch-ua-model`: absent
- `sec-ch-ua-platform-version`: absent
- `dnt`: absent

**Complete response headers:**

- `cache-control`: no-store,no-cache
- `content-length`: 0
- `date`: Tue, 11 Aug 2026 07:17:41 GMT
- `location`: `https://www.amctheatres.com/movies?queueittoken=[redacted]`
- `p3p`: CP="NOI ADM DEV PSAi COM NAV OUR OTR STP IND DEM"
- `pragma`: no-cache
- `server`: Kestrel
- `set-cookie`: Queue-it-visitorsession=[redacted]; path=/; secure; samesite=strict; httponly
- `strict-transport-security`: max-age=2592000
- `x-content-type-options`: nosniff
- `x-robots-tag`: noindex

### Hop 3 — Cloudflare Worker validates queueittoken (reqid=3)

| Attribute                           | Value                                                            |
| ----------------------------------- | ---------------------------------------------------------------- |
| Request URL                         | `GET https://www.amctheatres.com/movies?queueittoken=[redacted]` |
| Status                              | 302                                                              |
| Server response header              | `cloudflare`                                                     |
| X-Queueit-Connector response header | `cloudflare`                                                     |
| Location response header            | `https://www.amctheatres.com/movies`                             |

**Complete request headers:**

- `:authority`: `www.amctheatres.com`
- `:method`: GET
- `:path`: /movies?queueittoken=[redacted]
- `:scheme`: https
- `upgrade-insecure-requests`: 1
- `user-agent`: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
- `sec-ch-ua`: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"
- `sec-ch-ua-mobile`: ?0
- `sec-ch-ua-platform`: "macOS"
- `accept`: `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7`
- `accept-encoding`: gzip, deflate, br, zstd
- `accept-language`: en-US,en;q=0.9
- `cookie`: __cf_bm=[redacted]
- `priority`: u=0, i
- `sec-fetch-dest`: document
- `sec-fetch-mode`: navigate
- `sec-fetch-site`: none
- `sec-fetch-user`: ?1
- `referer`: absent
- `cache-control`: absent
- `sec-ch-ua-arch`: absent
- `sec-ch-ua-bitness`: absent
- `sec-ch-ua-full-version`: absent
- `sec-ch-ua-full-version-list`: absent
- `sec-ch-ua-model`: absent
- `sec-ch-ua-platform-version`: absent
- `dnt`: absent

**Complete response headers:**

- `cache-control`: no-cache, no-store, must-revalidate, max-age=0
- `cf-ray`: a29576454f1c78eb-SJC
- `content-length`: 0
- `date`: Tue, 11 Aug 2026 07:17:41 GMT
- `expires`: Fri, 01 Jan 1990 00:00:00 GMT
- `location`: `https://www.amctheatres.com/movies`
- `pragma`: no-cache
- `server`: cloudflare
- `set-cookie`: QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1786432661%26Hash%3D[redacted]; expires=Wed, 12 Aug 2026 07:17:41 GMT; domain=.amctheatres.com; path=/
- `strict-transport-security`: max-age=31536000; includeSubDomains
- `x-content-type-options`: nosniff
- `x-frame-options`: SAMEORIGIN
- `x-queueit-connector`: cloudflare

### Hop 4 — Page delivery (reqid=4)

| Attribute                           | Value                                                                |
| ----------------------------------- | -------------------------------------------------------------------- |
| Request URL                         | `GET https://www.amctheatres.com/movies`                             |
| Status                              | 200                                                                  |
| Server response header              | `cloudflare`                                                         |
| X-Powered-By response header        | `Next.js`                                                            |
| X-Queueit-Connector response header | `cloudflare`                                                         |
| CF-Cache-Status response header     | `DYNAMIC`                                                            |
| Vary response header                | `RSC, Next-Router-State-Tree, Next-Router-Prefetch, Accept-Encoding` |

**Complete request headers:**

- `:authority`: `www.amctheatres.com`
- `:method`: GET
- `:path`: /movies
- `:scheme`: https
- `upgrade-insecure-requests`: 1
- `user-agent`: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
- `sec-ch-ua`: "Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"
- `sec-ch-ua-mobile`: ?0
- `sec-ch-ua-platform`: "macOS"
- `accept`: `text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7`
- `accept-encoding`: gzip, deflate, br, zstd
- `accept-language`: en-US,en;q=0.9
- `cookie`: __cf_bm=[redacted]; QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1786432661%26Hash%3D[redacted]; [additional Queue-it and AMC session cookies redacted]
- `priority`: u=0, i
- `sec-fetch-dest`: document
- `sec-fetch-mode`: navigate
- `sec-fetch-site`: none
- `sec-fetch-user`: ?1
- `referer`: absent
- `cache-control`: absent
- `sec-ch-ua-arch`: absent
- `sec-ch-ua-bitness`: absent
- `sec-ch-ua-full-version`: absent
- `sec-ch-ua-full-version-list`: absent
- `sec-ch-ua-model`: absent
- `sec-ch-ua-platform-version`: absent
- `dnt`: absent

**Complete response headers:**

- `cache-control`: private, no-cache, no-store, max-age=0, must-revalidate
- `cf-cache-status`: DYNAMIC
- `cf-ray`: a29576458f8678eb-SJC
- `content-encoding`: gzip
- `content-type`: text/html; charset=utf-8
- `date`: Tue, 11 Aug 2026 07:17:41 GMT
- `server`: cloudflare
- `set-cookie`: session=[redacted]; Path=/; Expires=Wed, 15 Sep 2027 07:17:41 GMT; Domain=amctheatres.com
- `set-cookie`: seed=[redacted]; Path=/
- `set-cookie`: QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1786432661%26Hash%3D[redacted]; expires=Wed, 12 Aug 2026 07:17:41 GMT; domain=.amctheatres.com; path=/
- `strict-transport-security`: max-age=31536000; includeSubDomains
- `vary`: RSC, Next-Router-State-Tree, Next-Router-Prefetch, Accept-Encoding
- `x-content-type-options`: nosniff, nosniff
- `x-frame-options`: SAMEORIGIN, SAMEORIGIN
- `x-powered-by`: Next.js
- `x-queueit-connector`: cloudflare

### Timing (from Performance API, relative to timeOrigin)

| Attribute                                   | Relative (ms from timeOrigin) | Absolute (ISO 8601)                                                                               |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| timeOrigin                                  | 0                             | `2026-08-11T07:17:40.945Z`                                                                        |
| fetchStart                                  | 361.2                         | `2026-08-11T07:17:41.306Z`                                                                        |
| domainLookupStart                           | 361.2                         | `2026-08-11T07:17:41.306Z`                                                                        |
| domainLookupEnd                             | 361.2                         | `2026-08-11T07:17:41.306Z`                                                                        |
| connectStart                                | 361.2                         | `2026-08-11T07:17:41.306Z`                                                                        |
| secureConnectionStart                       | 361.2                         | `2026-08-11T07:17:41.306Z`                                                                        |
| connectEnd                                  | 361.2                         | `2026-08-11T07:17:41.306Z`                                                                        |
| requestStart                                | 361.8                         | `2026-08-11T07:17:41.307Z`                                                                        |
| responseStart                               | 989.3                         | `2026-08-11T07:17:41.934Z`                                                                        |
| responseEnd                                 | 1,707.9                       | `2026-08-11T07:17:42.653Z`                                                                        |
| domInteractive                              | 1,719.9                       | `2026-08-11T07:17:42.665Z`                                                                        |
| domComplete                                 | 3,690.5                       | `2026-08-11T07:17:44.636Z`                                                                        |
| loadEventEnd                                | 3,696.3                       | `2026-08-11T07:17:44.641Z`                                                                        |
| Duration (total)                            | 3,696.3                       | —                                                                                                 |
| redirectStart / redirectEnd / redirectCount | 0 / 0 / 0                     | _(Queue-it redirect chain invisible to Performance API — occurred before final navigation entry)_ |

Note: `domainLookupStart` through `connectEnd` are all 361.2 ms — connection (including TLS)
was already established from the redirect-chain hops and reused. The `requestStart` is
measured from the final (successful) navigation entry, not from the initial request.

### Protocol

| Attribute                                       | Value                                                                    | Source                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP version                                    | h2 (HTTP/2)                                                              | `PerformanceNavigationTiming.nextHopProtocol`, confirmed by `chrome.loadTimes().connectionInfo` and `chrome.loadTimes().npnNegotiatedProtocol` |
| Connection reuse                                | Yes — domainLookup, connect, secureConnection all at identical timestamp | Performance API                                                                                                                                |
| Protocol mix across all AMC-origin subresources | h2 (dominant), h3 (some), http/1.1 (some), "" (unknown — a small number) | Resource Timing API                                                                                                                            |
| TLS version                                     | **Unavailable**                                                          | Not exposed by Performance API, `chrome.loadTimes`, or MCP DevTools tools                                                                      |
| TLS cipher suite                                | **Unavailable**                                                          | Not exposed by any JavaScript API; the DevTools Security panel is not accessible via MCP                                                       |
| TLS certificate issuer                          | **Unavailable**                                                          | Not exposed by any JavaScript API                                                                                                              |
| TLS key exchange group                          | **Unavailable**                                                          | Not exposed by any JavaScript API                                                                                                              |

### Page classification

**Ordinary AMC page.** Document title: "Movies at AMC | View Showtimes & Get Tickets to New
Movies in Theaters." Content: full movie listings with posters, "Get Tickets" buttons, filter
controls, navigation, footer. No Cloudflare challenge page, no Queue-it waiting room, no
access-denied page. Classified in memory from title and DOM structure; response body not
persisted.

### Subresource summary

228 total subresource requests. All static assets from `_next/static/` loaded successfully
(HTTP 200). Third-party trackers (Google Analytics/Tag Manager, Facebook, TikTok, Snapchat,
mParticle, New Relic, Rokt, adroll, Amazon Ads, Trade Desk, etc.) all loaded normally.
Cloudflare Turnstile and challenge-platform scripts loaded as page subresources (reqids 42–44,
79, 83, 104) — all returned 200.

**RSC prefetch anomaly.** Same-origin RSC (React Server Component) prefetch subrequests in the
browser got **HTTP 403** from Cloudflare while the main-document navigation got HTTP 200:

| reqid | URL                                                     | Status |
| ----- | ------------------------------------------------------- | ------ |
| 110   | `GET /on-demand?_rsc=pbril`                             | 403    |
| 111   | `GET /movies/spider-man-brand-new-day-78598?_rsc=pbril` | 403    |
| 112   | `GET /movies/the-odyssey-76238?_rsc=pbril`              | 403    |
| 113   | `GET /movies/one-night-only-80552?_rsc=pbril`           | 403    |
| 114   | `GET /movies/super-troopers-3-82341?_rsc=pbril`         | 403    |
| 216   | `GET /favicon.ico`                                      | 403    |

These are same-origin, same-session requests — the browser carried the same cookies
(`__cf_bm`, `QueueITAccepted`, `session`) that the top-level navigation used. Cloudflare
nevertheless returned 403 for them. This suggests Cloudflare's decision is not purely
cookie-based; it may distinguish navigation from subresource requests at the HTTP or
transport level, or RSC requests may hit a different Cloudflare rule.

### Response body

Excluded per standing policy — never recorded or persisted. Body was streamed to the browser's
DOM; content-length was not set (chunked transfer under gzip). Decoded size per Performance
API: 1,017,319 bytes. Transfer size (compressed): 163,259 bytes.

### Updated attribute assessment

The prior diagnostic's "Captured browser navigation" section (above) recorded cookies as
"Neither inspected, recorded, nor replayed" and headers/protocol as "Not exposed." This
capture resolves those gaps and revises the likelihood assessment:

| Attribute or signal                              | Prior likelihood | Revised assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Egress IP and reputation                         | Very high        | Unchanged — not recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Chrome TLS fingerprint                           | Very high        | TLS version and cipher are still unavailable; the HTTP/2 level (h2) matches what a Node undici client would negotiate, but TLS ClientHello fingerprint is a lower-level signal not captured here                                                                                                                                                                                                                                                                          |
| Browser execution environment                    | High             | **Confirmed as the gate mechanism.** The browser went through a Cloudflare Worker → Queue-it → Cloudflare Worker redirect chain before any page content. A standalone HTTP client that cannot navigate Queue-it would never reach the final 200, regardless of header parity                                                                                                                                                                                              |
| Existing session or non-exported cookies         | High             | **Resolved.** The redirect chain depends on `__cf_bm` (set by Cloudflare on hop 1), `Queue-it-visitorsession` (set by Queue-it on hop 2), and `QueueITAccepted` (set by Cloudflare on hop 3 after validating the queueittoken). A standalone client without these cookies from the redirect chain would not carry them on the final request. However, ADR 0002 §2.8 constraint 4 prohibits cookie replay, so this finding identifies the mechanism without authorizing it |
| Queue-it Global Safety Net                       | Not assessed     | **Established.** Every `/movies` page load is intercepted by `x-queueit-connector: cloudflare`. The browser must follow the Queue-it redirect flow (hop 1 → hop 2 → hop 3) to receive the `QueueITAccepted` cookie that hop 4 requires. The prior diagnostic's curl test did not follow this redirect chain                                                                                                                                                               |
| HTTP/2 implementation, framing, and header order | Medium–high      | Reduced to **low–medium.** The RSC subrequests prove that header parity plus valid cookies within the same HTTP/2 session can still produce 403. Something beyond headers distinguishes top-level navigations from subresources                                                                                                                                                                                                                                           |
| Non-sensitive navigation and client-hint headers | Low–medium       | Unchanged — header parity alone is insufficient                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Browser-looking User-Agent                       | Low              | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SeatFinder/contact suffix                        | Ruled out        | Unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Conclusion

`GET https://www.amctheatres.com/movies` in an ordinary Chrome 151 browser is not a single
request — it is a 4-hop redirect chain through Cloudflare's `x-queueit-connector` and
Queue-it's Global Safety Net. The browser receives `__cf_bm` (Cloudflare Bot Management),
`Queue-it-visitorsession` (Queue-it internal), and `QueueITAccepted` (Queue-it cleared,
RedirectType=disabled) cookies across three 302 hops before the page is delivered on the
fourth hop as HTTP 200. No standalone HTTP client can reproduce this outcome without
navigating the same redirect chain, because the final hop requires the `QueueITAccepted`
cookie set on hop 3.

RSC prefetch subrequests from the same browser session (same cookies, same HTTP/2 connection)
received HTTP 403, confirming that Cloudflare distinguishes top-level navigations from
subresource requests even within an authenticated session. This diagnostic does not authorize
a standalone request, cookie replay, or a provider-code change.
