import type { NavigationAttempt, NavigationScope } from "@seatfirst/browser-runtime";
import { formatNamespacedId } from "@seatfirst/core";
import type {
  AmcMovieCatalogueStateRow,
  UpsertAmcMovieCatalogueInput,
} from "@seatfirst/durability";
import type { PublicMovieSummary } from "@seatfirst/providers";

import { isAmcMoviesCrawlDue } from "./due.js";

/**
 * The daily AMC movies catalogue fetch's single duty (ADR 0102 decisions 2–4). Composed
 * from the ADR 0102 durability wrappers, S5's `readProviderControlState`, S8's semaphore
 * scripts, P6's `runCorridorNavigation`, and the providers `/movies` parser. Every
 * external touchpoint is injected so the duty is testable without a database, Redis, or
 * Chrome (mirrors `catalogue-crawl/duties.ts`'s S26.13 DI seam per ADR 0102 decision 8).
 */

/** What one tick did — the observability and test-assertion surface. */
export type AmcMoviesCrawlTick =
  | { readonly kind: "SKIPPED_CONTROL"; readonly state: "PAUSED" | "HALTED" }
  | { readonly kind: "SKIPPED_SEMAPHORE" }
  | { readonly kind: "SKIPPED_NOT_DUE" }
  | { readonly kind: "CRAWL_COMPLETED"; readonly movieCount: number }
  | { readonly kind: "NAVIGATION_UNSUCCESSFUL"; readonly outcome: string };

export interface AmcMoviesCrawlDeps {
  readonly readControlState: () => Promise<"OPEN" | "PAUSED" | "HALTED">;
  /**
   * ADR 0102 decision 1 — the checkpoint table is a bare singleton (no provider row),
   * so unlike `CatalogueCrawlDeps.readState` this takes no provider id.
   */
  readonly readState: () => Promise<AmcMovieCatalogueStateRow[]>;
  readonly completeCrawl: () => Promise<AmcMovieCatalogueStateRow[]>;
  readonly upsertMovie: (input: UpsertAmcMovieCatalogueInput) => Promise<unknown>;

  readonly acquireSemaphore: (holderId: string) => Promise<number | false>;
  readonly releaseSemaphore: (holderId: string, generation: number) => Promise<unknown>;

  readonly navigate: (targetUrl: string, scope: NavigationScope) => Promise<NavigationAttempt>;
  readonly parseMovies: (
    html: string,
    observationTime: Date,
    requestUrl: string,
  ) => readonly PublicMovieSummary[];
  readonly buildMoviesUrl: () => string;

  readonly mintId: () => string;
  readonly now: () => Date;
  /** Deployment-assigned audit label (ADR 0004), copied into each navigation scope. */
  readonly egressIdentityLabel: string;
}

/**
 * Mint per-navigation scope identifiers. Mirrors `catalogue-crawl/duties.ts`'s private
 * `mintScope` helper: a fresh namespaced id per navigation (C2's `formatNamespacedId`,
 * kind `movie` — this worker navigates the movies catalogue, not theatre records) and
 * ADR 0022 §6's provider-wide no-scope sentinel `''` for `routeClass` — the crawl gets
 * "no separate lane, no separate egress, no exception" (ADR 0102 decision 2 reuses the
 * same `sem:amc` corridor), so `''` means it obeys only the provider-wide halt/kill-switch.
 */
function mintScope(deps: AmcMoviesCrawlDeps): NavigationScope {
  const mint = (): string =>
    formatNamespacedId({ providerId: "amc", kind: "movie", raw: deps.mintId() });
  return {
    providerId: "amc",
    observationId: mint(),
    fetchRunId: mint(),
    routeClass: "",
    egressIdentityLabel: deps.egressIdentityLabel,
  };
}

/**
 * Map a parsed `PublicMovieSummary` to the durable upsert input (ADR 0102 decision 4 —
 * one upsert per parsed hit, no delete path). The parser marks every enrichment field
 * `.nullable().optional()` (AMC's own page omits them for some entries), so a missing
 * value reads as "unknown" (`null`), never fabricated.
 */
function toUpsertInput(hit: PublicMovieSummary): UpsertAmcMovieCatalogueInput {
  return {
    movieId: hit.movieId,
    slug: hit.slug,
    name: hit.name,
    mpaaRating: hit.mpaaRating ?? null,
    runtimeMinutes: hit.runTimeMinutes ?? null,
    releaseDate: hit.releaseDate ?? null,
    status: hit.status ?? null,
    imageUrl: hit.imageUrl ?? null,
    detailsPath: hit.detailsPath,
    showtimesPath: hit.showtimesPath,
  };
}

/**
 * One pacing tick (ADR 0102 decision 2): fail-closed control read → due-ness check
 * against the singleton checkpoint → single-flight semaphore acquire → re-check control
 * → navigate the one `/movies` page → upsert every parsed hit → checkpoint completion.
 * The release runs on every branch after acquisition (never leak the semaphore); the
 * navigation cleanup await runs whenever a navigation was issued. Mirrors
 * `runCatalogueCrawlTick`'s exact control-flow shape, minus the cursor state machine —
 * the movies catalogue is a single page, not a directory-plus-markets walk.
 */
export async function runAmcMoviesCrawlTick(deps: AmcMoviesCrawlDeps): Promise<AmcMoviesCrawlTick> {
  const stateBefore = await deps.readControlState();
  if (stateBefore !== "OPEN") {
    return { kind: "SKIPPED_CONTROL", state: stateBefore };
  }

  const state = (await deps.readState())[0] ?? null;
  if (!isAmcMoviesCrawlDue(state?.last_completed_at ?? null, deps.now())) {
    return { kind: "SKIPPED_NOT_DUE" };
  }

  const holderId = deps.mintId();
  const acquired = await deps.acquireSemaphore(holderId);
  if (typeof acquired !== "number") {
    return { kind: "SKIPPED_SEMAPHORE" };
  }
  const generation = acquired;

  let attempt: NavigationAttempt | null = null;
  try {
    const stateAfter = await deps.readControlState();
    if (stateAfter !== "OPEN") {
      return { kind: "SKIPPED_CONTROL", state: stateAfter };
    }

    const targetUrl = deps.buildMoviesUrl();
    attempt = await deps.navigate(targetUrl, mintScope(deps));
    if (attempt.outcome.kind !== "SUCCESS") {
      return { kind: "NAVIGATION_UNSUCCESSFUL", outcome: attempt.outcome.kind };
    }
    const documentHtml = attempt.outcome.payload.documentHtml;

    const observationTime = deps.now();
    const movies = deps.parseMovies(documentHtml, observationTime, targetUrl);
    for (const movie of movies) {
      await deps.upsertMovie(toUpsertInput(movie));
    }
    await deps.completeCrawl();
    return { kind: "CRAWL_COMPLETED", movieCount: movies.length };
  } finally {
    if (attempt !== null) {
      await attempt.cleanupCompleted;
    }
    await deps.releaseSemaphore(holderId, generation);
  }
}
