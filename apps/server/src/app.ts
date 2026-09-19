import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span, Tracer } from "@opentelemetry/api";
import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

import type { ResultContractConfig, SearchLimits } from "@seatfirst/core";
import type { SeatfirstLogger } from "@seatfirst/config/logger";
import type { SeatfirstMetrics } from "@seatfirst/config/otel";
import { createMapboxGeocodeResolver } from "./geocode/mapbox.js";
import type { GeocodeResolver, ResolvedPlace, SuggestCandidate } from "./geocode/resolver.js";
import { createGeocodeMemo, type GeocodeMemo } from "./geocode/memo.js";
import { createGeocodeTokenBucket, type GeocodeTokenBucket } from "./geocode/token-bucket.js";
import { createSearchResponseMeta } from "./routes/searches/create.js";
import { createSearchCreateContextFactory } from "./routes/searches/createContext.js";
import { registerSearchGet } from "./routes/searches/get.js";
import { createSearchGetContextFactory } from "./routes/searches/getContext.js";
import { appRouter } from "./routes/searches/router.js";
import type { AppRouter } from "./routes/searches/router.js";
import { createMoviesSearchContextFactory } from "./routes/movies/context.js";
import type { TmdbClient } from "./tmdb/client.js";
import {
  createSessionBootstrapContextFactory,
  registerSessionBootstrap,
} from "./routes/session/bootstrap.js";
import type { SessionCookiePolicy } from "./session/cookie.js";
import type { AsnLookup } from "./session/extract.js";
import type { SessionRateLimitConfig, SessionRateLimiter } from "./session/limiter.js";
import { registerSessionPlugin } from "./session/plugin.js";
import {
  createRecheckContextFactory,
  type RecoverySeam,
} from "./routes/showtimes/recheckContext.js";
import { registerShowtimesRecheck } from "./routes/showtimes/register.js";
import { createContextFactory as createStreamContextFactory } from "./streaming/context.js";
import { registerOnProgressSse } from "./streaming/sse.js";

/**
 * The first production app assembly (S16.15): Fastify + the session plugin + the two
 * bespoke routes (`onProgress` SSE, `session.bootstrap`) + `fastifyTRPCPlugin` mounting
 * the `appRouter`. Registration order follows the rule already documented at
 * `apps/server/src/streaming/sse.ts:201-208` — bespoke routes register BEFORE
 * `fastifyTRPCPlugin`, whose `fastify.all` catch-all would otherwise win.
 *
 * Every tunable is a REQUIRED option — no defaults, matching `relayConfigFromEnv`'s
 * discipline (gate 14, `apps/server/src/relay/entrypoint.ts:14-29`). The logger, the
 * request-id seam, and the RED metrics are all injected options (O5.1/O5.2/O5.6), so
 * the IP/XFF/ASN field-allowlist surface (ADR 0005 §A:168-195) is enforced by the
 * caller-supplied `logger`'s serializers (O5.1), not hardcoded here. Not built here:
 * the listen loop, entrypoint, signal handling, and env→config wiring —
 * `apps/server/src/index.ts` stays untouched.
 */

export interface BuildAppOptions {
  readonly db: Pool;
  /** S15's injected search-spec limits (DEFAULT_SEARCH_LIMITS in deployments). */
  readonly searchLimits: SearchLimits;
  /** ADR 0006 §A.1's freshness ceiling, injected (S15.4). */
  readonly freshnessMs: number;
  /** S15.9's admission-rejection `Retry-After`, injected (finding, no default). */
  readonly retryAfterSeconds: number;
  /** S16.4/S16.9's limiter windows — every number injected (ADR 0006 §A.6). */
  readonly rateLimitConfig: SessionRateLimitConfig;
  /** The sliding-window engine over the shared Redis instance. */
  readonly limiter: SessionRateLimiter;
  /** S16.10's cookie signing secret — injected, never in the repo. */
  readonly cookieSecret: string;
  /** S16.10's cookie policy — SameSite value + Max-Age are injected findings. */
  readonly cookiePolicy: SessionCookiePolicy;
  /** S16.7 — the relay's specific tailnet peer CIDR (not `true`, not a header name). */
  readonly relayPeerCidr: string;
  /** S16.8 — the offline ASN lookup loaded from the local fixture/database file. */
  readonly asnLookup: AsnLookup;
  /** S12's streaming Redis (the shared instance). */
  readonly streamRedisUrl: string;
  /** S12's injected XREAD BLOCK window. */
  readonly streamBlockTimeoutMs: number;
  /**
   * S6U3.5's reveal-validator provider deep-link allowlists — ops data config, injected
   * like every other environment number (gate 14); no default in the repo.
   */
  readonly providerHostAllowlists: ResultContractConfig["providerHostAllowlists"];
  /** S22.9 — the recheck nonce HMAC secret (ADR 0017), injected like `cookieSecret`. */
  readonly nonceSecret: string;
  /** S22.11 — the 30 s recheck deadline (ADR 0006 §A.2), injected (no default). */
  readonly recheckDeadlineMs: number;
  /** S22.12 — the GONE recovery-ladder seam (no default; the assembler is unlanded). */
  readonly recheckRecovery: RecoverySeam;
  /** S51 — Mapbox access token for Geocoding v6 (ADR 0045 §2), requiredString, no default. */
  readonly mapboxAccessToken?: string;
  /** S47 / ADR 0039 Amendment A3+A2 test seams — production omits both; the route
   *  falls back to the accepted SEARCH_DEADLINE_MS and its engineering poll tick. */
  readonly capacityPreviewDeadlineMs?: number | undefined;
  readonly capacityPreviewPollIntervalMs?: number | undefined;
  /**
   * CORS allowlist — exact-match origins allowed to call the API with credentials.
   * Injected with no default (gate 14); `CORS_ALLOWED_ORIGINS` env var.
   * See `apps/server/src/app-config.ts` (S28.2) and `.env.dev.example`.
   */
  readonly corsAllowedOrigins: readonly string[];
  /**
   * O5.1 — the Fastify request logger: the caller's O4 `createLogger` instance (a real
   * pino logger, so Fastify-compatible) with the inbound req/res allowlist serializers
   * applied (ADR 0005 §A:168-195). Injected with no default, like every other tunable.
   */
  readonly logger: FastifyBaseLogger;
  /**
   * O5.2 — the ULID request-id seam (`mintSessionId` in deployments), injected so
   * `genReqId` reuses the repo's id convention instead of Fastify's counter.
   */
  readonly mintId: () => string;
  /** O5.6 — the RED metrics instruments, from `ConfiguredOtel.metrics`. */
  readonly metrics: SeatfirstMetrics;
  /**
   * O11.1 — the request-root-span tracer, from `ConfiguredOtel.tracer`. Every inbound
   * request gets a real span (not the prior no-op `getActiveSpan()?.setAttribute` call),
   * made the ambient active context for the whole request lifecycle via the registered
   * `AsyncLocalStorageContextManager` (`packages/config/src/context.ts:25-58`), so
   * downstream spans — including O8's pg auto-instrumented query spans — nest under it.
   */
  readonly tracer: Tracer;
  /** S51 test seam — injected geocode resolver (stub). Production omits and gets Mapbox impl. */
  readonly geocodeResolver?: GeocodeResolver | undefined;
  /** S51 test seam — injected geocode memo for resolve (stub or clock-controlled). */
  readonly geocodeMemo?: GeocodeMemo<ResolvedPlace> | undefined;
  /** S52 test seam — injected suggest memo (stub or clock-controlled). */
  readonly suggestMemo?: GeocodeMemo<readonly SuggestCandidate[]> | undefined;
  /** S51 test seam — injected token bucket (spy). */
  readonly geocodeBucket?: GeocodeTokenBucket | undefined;
  /** Readiness check callback verifying required internal dependencies (e.g. Redis). */
  readonly readinessCheck?: () => Promise<boolean>;
  /**
   * S63.4 — the live TMDB client for `movies.search` typed queries (Bearer key +
   * token bucket, built by `startApp` from `TMDB_API_KEY`). Optional seam: tests
   * inject a fake; assemblies that omit it still serve the empty-query slate path
   * (local Postgres only) while typed queries fail closed (`search.ts`).
   */
  readonly tmdbClient?: TmdbClient | undefined;
}

/** O11.1 — the request's root span, keyed by request so `onResponse` can end it. A
 * WeakMap avoids widening `FastifyRequest`'s type with a new decorated property. */
const requestSpans = new WeakMap<FastifyRequest, Span>();

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const geocodeBucket = opts.geocodeBucket ?? createGeocodeTokenBucket();
  const geocodeMemo = opts.geocodeMemo ?? createGeocodeMemo<ResolvedPlace>();
  const suggestMemo = opts.suggestMemo ?? createGeocodeMemo<readonly SuggestCandidate[]>();
  const geocodeResolver =
    opts.geocodeResolver ??
    createMapboxGeocodeResolver({
      accessToken: opts.mapboxAccessToken ?? "test-mapbox-token",
      bucket: geocodeBucket,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- FastifyBaseLogger to SeatfirstLogger needs narrowing
      logger: opts.logger as SeatfirstLogger,
    });

  const fastify = Fastify({
    // O5.1: the caller-supplied pino logger (allowlist serializers applied); O5.2:
    // request ids come from the injected ULID seam, not Fastify's incrementing counter.
    loggerInstance: opts.logger,
    genReqId: () => opts.mintId(),
    // S16.7: trust exactly the relay's tailnet peer CIDR for Fastify's own proxy
    // handling. (Extraction itself is the explicit socket-peer gate in plugin.ts —
    // this configures Fastify's `req.ip` the same way, never `true`.)
    trustProxy: opts.relayPeerCidr,
    // BATCH-414: batched tRPC procedure names are comma-joined into a single
    // dynamic path segment; the 100-char default is too low for realistic
    // multi-theatre batches (6x `theatres.movies` = 101 chars → 414). Nested under
    // `routerOptions` per Fastify 5's find-my-way router config (the top-level
    // `maxParamLength` shorthand is deprecated as of FSTDEP022).
    routerOptions: { maxParamLength: 2048 },
  });

  // O11.1 — start a real request-root span and make it the ambient active context for
  // the REST of this request's lifecycle (not just this hook's own execution), so every
  // downstream span — route-handler awaits, O8's pg auto-instrumented queries — nests
  // under it. Callback-style (not async) hook: `context.with` runs its callback through
  // `AsyncLocalStorage.run` (packages/config/src/context.ts:32-44), which propagates the
  // store to everything created during that SYNCHRONOUS callback execution — including
  // Fastify's own continuation of the hook chain via `done()`, called INSIDE the
  // callback (not after it) so the continuation is itself created under the new store.
  fastify.addHook("onRequest", (request, _reply, done) => {
    const span = opts.tracer.startSpan(request.routeOptions.url ?? request.url, {
      kind: SpanKind.SERVER,
      attributes: { "seatfirst.request_id": request.id },
    });
    requestSpans.set(request, span);
    context.with(trace.setSpan(context.active(), span), () => {
      request.log = request.log.child({ requestId: request.id });
      done();
    });
  });

  // O5.6 — RED metrics: record count + duration per matched route pattern and status
  // code, with an error flag when the response is >= 500. Uses the matched route
  // pattern (`request.routeOptions.url`), never the raw URL, so label cardinality
  // stays bounded (no unbounded per-request dimensions).
  // O11.1 — also ends this request's root span here, status-flagged on a >= 500 response.
  fastify.addHook("onResponse", async (request, reply) => {
    const span = requestSpans.get(request);
    if (span !== undefined) {
      if (reply.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
      requestSpans.delete(request);
    }
    const attributes = {
      route: request.routeOptions.url ?? "unknown",
      statusCode: reply.statusCode,
      error: reply.statusCode >= 500,
    };
    opts.metrics.httpRequestCount.add(1, attributes);
    opts.metrics.httpRequestDuration.record(reply.elapsedTime, attributes);
  });

  // CORS — register before any route/bespoke registration (same ordering rule as
  // sse.ts:201-208: bespoke/CORS concerns must win before fastifyTRPCPlugin's catch-all).
  // Exact-match allowlist, credentials required for cookie-based session (cookieJar.ts).
  void fastify.register(cors, {
    origin: [...opts.corsAllowedOrigins],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Cookie"],
    maxAge: 86400,
  });

  // S16.16 — the session decoration must exist before any route's onRequest runs.
  registerSessionPlugin(fastify, {
    cookieSecret: opts.cookieSecret,
    relayPeerCidr: opts.relayPeerCidr,
    asnLookup: opts.asnLookup,
  });

  // Bespoke routes first (the sse.ts:201-208 ordering rule).
  registerOnProgressSse(fastify, {
    router: appRouter,
    createContext: createStreamContextFactory({
      db: opts.db,
      redisUrl: opts.streamRedisUrl,
      blockTimeoutMs: opts.streamBlockTimeoutMs,
      providerHostAllowlists: opts.providerHostAllowlists,
      nonceSecret: opts.nonceSecret,
    }),
  });
  registerSessionBootstrap(fastify, {
    router: appRouter,
    createContext: createSessionBootstrapContextFactory({
      db: opts.db,
      sessionSecret: opts.cookieSecret,
      cookiePolicy: opts.cookiePolicy,
      rateLimitConfig: opts.rateLimitConfig,
    }),
  });
  registerShowtimesRecheck(fastify, {
    router: appRouter,
    createContext: createRecheckContextFactory({
      db: opts.db,
      limiter: opts.limiter,
      nonceSecret: opts.nonceSecret,
      deadlineMs: opts.recheckDeadlineMs,
      recovery: opts.recheckRecovery,
    }),
  });
  // S19.8 — `searches.get` is a query served through its own registration (its minimal
  // context, `SearchGetContext`, is not the router's `SearchCreateContext`). Registered
  // before `fastifyTRPCPlugin` like the other bespoke routes.
  registerSearchGet(fastify, {
    router: appRouter,
    createContext: createSearchGetContextFactory({
      db: opts.db,
      providerHostAllowlists: opts.providerHostAllowlists,
      nonceSecret: opts.nonceSecret,
    }),
  });
  // I10.3 — unauthenticated liveness probe for deploy smoke checks (Task I7.5)
  // through the relay. No auth logic here by design (ADR 0014 no-accounts freeze);
  // Caddy exempts /healthz from edge basic auth. Registered ahead of
  // fastifyTRPCPlugin per the bespoke-routes-first ordering rule.
  fastify.get("/healthz", () => ({ status: "ok" }));

  // Readiness probe: verifies that database and required internal dependencies are ready.
  fastify.get("/readyz", async (_req, reply) => {
    try {
      await opts.db.query("SELECT 1");
      if (opts.readinessCheck !== undefined) {
        const ok = await opts.readinessCheck();
        if (!ok) {
          return reply.status(503).send({ status: "not ready", reason: "dependency check failed" });
        }
      }
      return reply.status(200).send({ status: "ready" });
    } catch (error) {
      return reply.status(503).send({
        status: "not ready",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  void fastify.register(fastifyTRPCPlugin<AppRouter>, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      // S63.4 — the router-wide context is the search-create slice PLUS the movies
      // slice (pool + TMDB client): each area's procedures see their own context
      // type, and the merged object satisfies all of them (the same structural
      // subset discipline the `theatres` router relies on).
      createContext: ({ req }) => ({
        ...createSearchCreateContextFactory({
          db: opts.db,
          limits: opts.searchLimits,
          freshnessMs: opts.freshnessMs,
          retryAfterSeconds: opts.retryAfterSeconds,
          rateLimitConfig: opts.rateLimitConfig,
          limiter: opts.limiter,
          resolver: geocodeResolver,
          memo: geocodeMemo,
          suggestMemo,
          capacityPreviewDeadlineMs: opts.capacityPreviewDeadlineMs,
          capacityPreviewPollIntervalMs: opts.capacityPreviewPollIntervalMs,
        })(req),
        ...createMoviesSearchContextFactory({ db: opts.db, tmdbClient: opts.tmdbClient })(req),
      }),
      responseMeta: createSearchResponseMeta,
    },
  });

  return fastify;
}
