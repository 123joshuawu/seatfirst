/**
 * Fetch-worker process composition (S29.1 + S31.8): starts the dispatch worker set (the three
 * BullMQ consumers, seeded with the placeholder registry plus the real AGGREGATE handler from
 * S27 and the real RUN handlers from S31) and S26's catalogue-crawl tick loop as two concurrent
 * in-process loops sharing the deployment's single warm Chrome process (ADR 0022 §6 — exactly
 * one `BrowserSupervisor` starts here, owned by `startFetchWorker` and injected into both
 * `createCatalogueCrawler` and the RUN actor deps; `startDispatchWorker` launches no Chrome).
 *
 * JOB is wired by S30's admission/dedup layer (`withJobAdmissionDedup`, find-or-create only).
 * It remains bounded by the sweeper's re-arm + deadline-terminalization duties (F6): this
 * process must never be deployed without the `sweeper` role also running.
 *
 * Exposed as `startFetchWorker(env)` so `infra/docker/fetch-worker/entrypoint.mjs` (the
 * container bootstrap) can import it directly; the module is not a `node dist/index.js`
 * role — the fetch-worker is a separate image (`Dockerfile.fetch-worker`).
 *
 * The optional second `options.navigationSeams` parameter is additive/optional (local-dev-
 * backend plan, `dev/README.md`): it threads straight through to BOTH consumers of the one
 * shared warm Chrome (ADR 0022 §6) — `actorDeps.navigationSeams` (`ProviderFetchActorDeps`,
 * an optional field P6/S8 defined for exactly this) and `createCatalogueCrawler`'s
 * `fetchHop` option — so one supplied seam guards the RUN actor's and the catalogue crawl's
 * navigations identically (P6's offline synthetic-harness seams, the same mechanism
 * `packages/browser-runtime/test/support/harness.ts` already uses in CI). Production's one
 * call site (`infra/docker/fetch-worker/entrypoint.mjs`) passes no second argument, so
 * `navigationSeams` stays `undefined` there — byte-for-byte the same behavior as before this
 * parameter existed. Only `infra/docker/fetch-worker/dev-entrypoint.mjs` (dev-only, bind-
 * mounted, never built into the production image) supplies one.
 */
import { createLogger, logLevelFromEnv, type SeatfirstLogger } from "@seatfirst/config/logger";
import { buildOtelFromEnv } from "@seatfirst/config/otel-bootstrap";
import type { ConfiguredOtel } from "@seatfirst/config/otel";
import { installCrashHandlers } from "../crash-handlers.js";
import { BrowserSupervisor } from "@seatfirst/browser-runtime";

import {
  catalogueCrawlConfigFromEnv,
  createCatalogueCrawler,
} from "../catalogue-crawl/entrypoint.js";
import { dispatchConfigFromEnv, startDispatchWorker } from "../dispatch/entry.js";
import { createPlaceholderRegistry, withProviderFetchActor } from "../dispatch/handlers.js";
import { withAnswerAssembler } from "../dispatch/handlers/aggregate-answer-assembler.js";
import { createBuildTargetUrl } from "../dispatch/handlers/build-target-url.js";
import { withJobAdmissionDedup } from "../dispatch/handlers/job-admission-dedup.js";
import { parseObservation } from "../dispatch/handlers/parse-observation.js";
import { scheduleSubscriberFilter } from "../dispatch/handlers/provider-fetch-actor.js";
import type {
  ProviderFetchActorDeps,
  ProviderFetchNavigationSeams,
} from "../dispatch/handlers/provider-fetch-actor.js";

import { answerAssemblerDepsFromEnv } from "./aggregate-config.js";
import { providerFetchActorDepsFromEnv } from "./provider-fetch-actor-config.js";

/** ADR 0022 is AMC-specific: the one provider both the crawl and the RUN actor serve. */
const PROVIDER_ID = "amc";

export interface FetchWorkerHandle {
  close(): Promise<void>;
  isReady(): boolean;
  onReadinessChange?(listener: (ready: boolean) => void): () => void;
  readonly supervisor: BrowserSupervisor;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

export interface StartFetchWorkerOptions {
  /** Dev-only offline navigation seams (P6/S8) — omitted in production. */
  readonly navigationSeams?: ProviderFetchNavigationSeams;
  readonly logger?: SeatfirstLogger;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Pure helper for the injection seam (O6.5): returns the logger that
 * `startFetchWorker` would use given the same `env` and `options`, without
 * launching Chrome or any other side effect beyond a throwaway OTel handle.
 * Tests assert that an injected logger wins by reference, proving the seam is
 * real and not a renamed global.
 */
export function resolveFetchWorkerLogger(
  env: NodeJS.ProcessEnv,
  options?: Pick<StartFetchWorkerOptions, "logger" | "env">,
): SeatfirstLogger {
  if (options?.logger !== undefined) return options.logger;
  // Build a throwaway OTel handle so the returned logger mirrors the
  // production branch's `otelLogger` wiring; the handle is not retained.
  const otel = buildOtelFromEnv(
    options?.env ?? env,
    { serviceName: "seatfirst-fetch-worker", component: "worker" },
    {},
  );
  return createLogger({
    service: "seatfirst-fetch-worker",
    component: "worker",
    level: logLevelFromEnv(env),
    otelLogger: otel.logger,
  });
}

export async function startFetchWorker(
  env: NodeJS.ProcessEnv = process.env,
  options?: StartFetchWorkerOptions,
): Promise<FetchWorkerHandle> {
  const otel: ConfiguredOtel = buildOtelFromEnv(
    options?.env ?? env,
    { serviceName: "seatfirst-fetch-worker", component: "worker" },
    {},
  );
  const logger: SeatfirstLogger =
    options?.logger ??
    createLogger({
      service: "seatfirst-fetch-worker",
      component: "worker",
      level: logLevelFromEnv(env),
      otelLogger: otel.logger,
    });
  installCrashHandlers({ logger, otel, exit: (code) => process.exit(code) });

  // Build the assembler deps once — its own pg pool, S29.3.
  const assemblerDeps = answerAssemblerDepsFromEnv(env);
  // Schema-version gate (ADR 0005 §G, option C): verify every migration this
  // binary expects is recorded in the `schema_migration` ledger before starting
  // Chrome or any BullMQ consumers. Reuses the assembler pool opened above — no
  // additional pool is opened here — and fails before `BrowserSupervisor.start()`
  // so a doomed boot does not leak a warm Chrome process.
  // Dynamic import mirrors `apps/server/src/index.ts:39-46`'s O8 ordering
  // constraint: kept as a dynamic import at the insertion point for consistency,
  // though no `pg` evaluation ordering hazard exists in this image the way it does
  // for the role dispatcher. No pool sizing decision arises here — this reuses the
  // assembler pool rather than opening one, so gate 14 has nothing to bite on.
  {
    const { verifySchemaVersion, SchemaVersionError } = await import("@seatfirst/durability");
    try {
      await verifySchemaVersion(assemblerDeps.pool);
    } catch (error: unknown) {
      if (error instanceof SchemaVersionError) {
        process.stderr.write(
          `schema version check failed: missing migrations: ${error.missing.join(", ")}\n` +
            `run the migrate service first\n`,
        );
      }
      await assemblerDeps.pool.end().catch(() => undefined);
      throw error;
    }
  }

  // S31.7/S31.10 — the actor's non-code deps (own pool + ioredis client + limiter).
  const envDeps = providerFetchActorDepsFromEnv(env);

  // S31.8 — the single warm Chrome, built from the crawl's chrome/readiness/cleanup config
  // and shared by both the RUN actor and the crawler (ADR 0022 §6).
  const crawlConfig = {
    ...catalogueCrawlConfigFromEnv(reconcileEgressIdentity(env)),
    logger,
  };
  const supervisor = await BrowserSupervisor.start({
    executablePath: crawlConfig.chromeExecutablePath,
    egressIdentityLabel: crawlConfig.egressIdentityLabel,
    providerId: PROVIDER_ID,
    cleanupGracePeriodMs: crawlConfig.cleanupGracePeriodMs,
    readinessTimeoutMs: crawlConfig.readinessTimeoutMs,
    readinessTargetUrl: crawlConfig.readinessTargetUrl,
  });

  const actorDeps: ProviderFetchActorDeps = {
    pool: envDeps.pool,
    redis: envDeps.redis,
    controlSource: envDeps.controlSource,
    supervisor,
    userAgent: envDeps.userAgent,
    navigationLimits: envDeps.navigationLimits,
    semaphoreTtlMs: envDeps.semaphoreTtlMs,
    heartbeatIntervalMs: envDeps.heartbeatIntervalMs,
    runLeaseTtl: envDeps.runLeaseTtl,
    maxAttempts: envDeps.maxAttempts,
    buildTargetUrl: createBuildTargetUrl(envDeps.pool),
    parseObservation,
    scheduleSubscriberFilter,
    chargeSubscriberFetch: envDeps.chargeSubscriberFetch,
    ...(options?.navigationSeams !== undefined ? { navigationSeams: options.navigationSeams } : {}),
  };

  // Compose the registry: JOB is S30's find-or-create admission/dedup layer, RUN the real S31
  // handler set, AGGREGATE the real S27 handler.
  const registry = withJobAdmissionDedup(
    withProviderFetchActor(
      withAnswerAssembler(createPlaceholderRegistry(), assemblerDeps),
      actorDeps,
    ),
    { pool: actorDeps.pool },
  );

  // Start the three BullMQ dispatch consumers (no Chrome).
  const dispatch = startDispatchWorker({
    ...dispatchConfigFromEnv(env),
    registry,
    logger,
  });

  // Start the catalogue-crawl tick loop, sharing the supervisor built above.
  const crawler = await createCatalogueCrawler({
    ...crawlConfig,
    supervisor,
    metrics: otel.metrics,
    // ADR 0022 §6 — no separate lane: forward the SAME dev fixture seam the RUN actor
    // got above, so crawler navigations are intercepted/refused identically and a fresh
    // dev stack can never leak an unintercepted directory hop to the live network.
    ...(options?.navigationSeams?.fetchHop !== undefined
      ? { fetchHop: options.navigationSeams.fetchHop }
      : {}),
  });

  let closing = false;
  let paused = false;
  const readinessListeners = new Set<(ready: boolean) => void>();

  const notifyReadiness = (ready: boolean) => {
    for (const listener of readinessListeners) {
      try {
        listener(ready);
      } catch {
        // Listener errors must not crash the worker
      }
    }
  };

  supervisor.addReadinessListener?.((ready) => {
    if (!closing && !paused) {
      notifyReadiness(ready);
    }
  });

  return {
    isReady() {
      return (
        !closing &&
        !paused &&
        (typeof supervisor.isReady === "function" ? supervisor.isReady() : true)
      );
    },
    onReadinessChange(listener: (ready: boolean) => void): () => void {
      readinessListeners.add(listener);
      return () => {
        readinessListeners.delete(listener);
      };
    },
    supervisor,
    async pause() {
      if (paused || closing) return;
      paused = true;
      notifyReadiness(false);
      crawler.pause();
      await dispatch.pause();
      await supervisor.shutdown().catch(() => undefined);
    },
    async resume() {
      if (!paused || closing) return;
      paused = false;
      await supervisor.recycle().catch(() => undefined);
      await dispatch.resume();
      crawler.resume();
      notifyReadiness(supervisor.isReady());
    },
    async close() {
      closing = true;
      notifyReadiness(false);
      // Stop the crawl loop + its own pool/redis first, then the dispatch consumers, then the
      // actor's and assembler's own pools and the actor's redis client. The shared supervisor
      // is owned here and shut down last: no Chrome after every loop has stopped issuing
      // navigations.
      await crawler.close();
      await dispatch.close();
      await envDeps.pool.end();
      await assemblerDeps.pool.end();
      await envDeps.redisClient.quit().catch(() => undefined);
      await supervisor.shutdown().catch(() => undefined);
      await otel.shutdown().catch(() => undefined);
    },
  };
}

/** F4 — maps the canonical `EGRESS_IDENTITY_LABEL` (ADR 0004) to the name S26's
 * `catalogueCrawlConfigFromEnv` reads. The operator supplies exactly one name; the
 * `AMC_EGRESS_IDENTITY_LABEL` spelling is never an operator input for the fetch-worker. */
function reconcileEgressIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const egressIdentityLabel = env["EGRESS_IDENTITY_LABEL"];
  if (egressIdentityLabel === undefined || egressIdentityLabel === "") {
    throw new Error("EGRESS_IDENTITY_LABEL is required and has no default (gate 14)");
  }
  return { ...env, AMC_EGRESS_IDENTITY_LABEL: egressIdentityLabel };
}
