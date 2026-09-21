import type { NavigationAttempt, NavigationScope } from "@seatfirst/browser-runtime";
import { formatNamespacedId, type Theatre } from "@seatfirst/core";
import type { CatalogueCrawlStateRow, UpsertTheatreInput } from "@seatfirst/durability";
import { ProviderError } from "@seatfirst/providers";

import { isCatalogueCrawlDue } from "./due.js";

/**
 * The monthly theatre-catalogue crawl's single duty (S26.6/S26.8/S26.9). Composed from the
 * S26.3 durability wrappers, S5's `readProviderControlState`, S8's semaphore scripts,
 * P6's `runCorridorNavigation`, and the two providers parsers. Every external touchpoint is
 * injected so the duty is testable without a database, Redis, or Chrome (S26.13).
 */

/**
 * The restart-safety cursor (S26.10): the pass's market-slug list plus the index of the
 * next market page to fetch. `nextIndex === slugs.length` means every market page is
 * processed and the next tick completes the pass. Round-trips through the opaque `cursor`
 * jsonb column untouched.
 */
export interface CatalogueCursor {
  readonly slugs: readonly string[];
  readonly nextIndex: number;
}

/** What one tick did — the observability and test-assertion surface. */
export type CatalogueCrawlTick =
  | { readonly kind: "SKIPPED_CONTROL"; readonly state: "PAUSED" | "HALTED" }
  | { readonly kind: "SKIPPED_SEMAPHORE" }
  | { readonly kind: "SKIPPED_NOT_DUE" }
  | {
      readonly kind: "PAGE_PROCESSED";
      readonly page: "DIRECTORY" | "MARKET";
      readonly slugCount: number;
      readonly theatreCount: number;
    }
  | {
      // A single theatre's unrecognized data (e.g. an AMC postal code missing from the
      // vendored timezone table) must not block every other market page forever — mirrors
      // the per-route isolation in provider-fetch-actor.ts (PARSER_SCHEMA_INCOMPATIBLE):
      // skip just this page, advance the cursor, let the pass keep making progress. The
      // page is not retried automatically; a human fixes the vendored data and the next
      // monthly pass revisits it.
      readonly kind: "PAGE_SKIPPED_PARSER_INCOMPATIBLE";
      readonly slug: string;
      readonly parserErrorCode: string;
      readonly parserErrorMessage: string;
    }
  | { readonly kind: "PASS_COMPLETED" }
  | { readonly kind: "NAVIGATION_UNSUCCESSFUL"; readonly outcome: string };

export interface CatalogueCrawlDeps {
  readonly providerId: string;
  /** Deployment-assigned audit label (ADR 0004), copied into each navigation scope. */
  readonly egressIdentityLabel: string;

  readonly readState: (providerId: string) => Promise<CatalogueCrawlStateRow[]>;
  readonly beginPass: (providerId: string) => Promise<CatalogueCrawlStateRow[]>;
  readonly advanceCursor: (
    providerId: string,
    cursor: CatalogueCursor,
  ) => Promise<CatalogueCrawlStateRow[]>;
  readonly completePass: (providerId: string) => Promise<CatalogueCrawlStateRow[]>;
  readonly upsertTheatre: (input: UpsertTheatreInput) => Promise<unknown>;

  readonly readControlState: () => Promise<"OPEN" | "PAUSED" | "HALTED">;
  readonly acquireSemaphore: (holderId: string) => Promise<number | false>;
  readonly releaseSemaphore: (holderId: string, generation: number) => Promise<unknown>;

  readonly navigate: (targetUrl: string, scope: NavigationScope) => Promise<NavigationAttempt>;
  readonly parseMarketSlugs: (html: string) => readonly string[];
  readonly parseTheatres: (html: string, observationTime: Date, requestUrl: string) => Theatre[];
  readonly buildDirectoryUrl: () => string;
  readonly buildMarketUrl: (marketSlug: string) => string;

  readonly mintId: () => string;
  readonly now: () => Date;
}

/** The page-walk decision computed from durable state before the semaphore is touched. */
type NextAction =
  | { readonly kind: "SKIP_NOT_DUE" }
  | { readonly kind: "BEGIN_PASS" }
  | { readonly kind: "PROCESS_MARKET"; readonly slug: string; readonly cursor: CatalogueCursor }
  | { readonly kind: "COMPLETE_PASS" };

/** Rehydrate the opaque jsonb cursor; a null or malformed value means "no cursor". */
function parseCursor(value: unknown): CatalogueCursor | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { slugs?: unknown; nextIndex?: unknown };
  if (!Array.isArray(candidate.slugs)) return null;
  if (candidate.slugs.some((slug) => typeof slug !== "string")) return null;
  const { nextIndex } = candidate;
  if (typeof nextIndex !== "number" || !Number.isInteger(nextIndex) || nextIndex < 0) return null;
  return { slugs: candidate.slugs, nextIndex };
}

function nextAction(state: CatalogueCrawlStateRow | null, now: Date): NextAction {
  const cursor = parseCursor(state?.cursor ?? null);
  if (cursor !== null) {
    if (cursor.nextIndex >= cursor.slugs.length) {
      return { kind: "COMPLETE_PASS" };
    }
    const slug = cursor.slugs[cursor.nextIndex];
    if (slug === undefined) {
      return { kind: "COMPLETE_PASS" };
    }
    return { kind: "PROCESS_MARKET", slug, cursor };
  }

  const due = isCatalogueCrawlDue(
    state?.last_pass_started_at ?? null,
    state?.last_pass_completed_at ?? null,
    now,
  );
  return due ? { kind: "BEGIN_PASS" } : { kind: "SKIP_NOT_DUE" };
}

/**
 * Mint per-navigation scope identifiers (S26.12). There is no run_key row to source
 * `observationId`/`fetchRunId`/`routeClass` from, so the worker mints a fresh namespaced id
 * per navigation (C2's `formatNamespacedId`, kind `theatre`) and uses ADR 0022 §6's
 * provider-wide no-scope sentinel `''` for `routeClass` — the crawl gets "no separate lane,
 * no separate egress, no exception", so `''` means it obeys only provider-wide
 * halt/kill-switch, never a narrower lane gate.
 */
function mintScope(deps: CatalogueCrawlDeps): NavigationScope {
  const mint = (): string =>
    formatNamespacedId({ providerId: deps.providerId, kind: "theatre", raw: deps.mintId() });
  return {
    providerId: deps.providerId,
    observationId: mint(),
    fetchRunId: mint(),
    routeClass: "",
    egressIdentityLabel: deps.egressIdentityLabel,
  };
}

/** Map a parsed `Theatre` to the durable upsert input, tagged with the page's market slug. */
function toUpsertInput(theatre: Theatre, marketSlug: string): UpsertTheatreInput {
  return {
    theatreId: theatre.id,
    providerId: theatre.providerId,
    name: theatre.name,
    lat: theatre.location.lat,
    lng: theatre.location.lng,
    marketSlug,
    timezone: theatre.timezone,
    city: theatre.city,
    address: theatre.address,
    slugs: theatre.slugs,
    firstSeenAt: theatre.firstSeenAt,
    lastSeenAt: theatre.lastSeenAt,
  };
}

/**
 * One pacing tick (S26.8): fail-closed control read → due/resume decision → single-flight
 * semaphore acquire → re-check control → navigate at most one page → release. The release
 * runs on every branch after acquisition (S26.8: never leak the semaphore).
 */
export async function runCatalogueCrawlTick(deps: CatalogueCrawlDeps): Promise<CatalogueCrawlTick> {
  const stateBefore = await deps.readControlState();
  if (stateBefore !== "OPEN") {
    return { kind: "SKIPPED_CONTROL", state: stateBefore };
  }

  const state = (await deps.readState(deps.providerId))[0] ?? null;
  const action = nextAction(state, deps.now());

  if (action.kind === "SKIP_NOT_DUE") {
    return { kind: "SKIPPED_NOT_DUE" };
  }

  // COMPLETE_PASS is a local durable write, not a browser navigation — it needs no
  // single-flight semaphore (the semaphore gates the corridor, which this tick does not use).
  if (action.kind === "COMPLETE_PASS") {
    await deps.completePass(deps.providerId);
    return { kind: "PASS_COMPLETED" };
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

    const targetUrl =
      action.kind === "BEGIN_PASS" ? deps.buildDirectoryUrl() : deps.buildMarketUrl(action.slug);

    attempt = await deps.navigate(targetUrl, mintScope(deps));
    if (attempt.outcome.kind !== "SUCCESS") {
      return { kind: "NAVIGATION_UNSUCCESSFUL", outcome: attempt.outcome.kind };
    }
    const documentHtml = attempt.outcome.payload.documentHtml;

    if (action.kind === "BEGIN_PASS") {
      const slugs = deps.parseMarketSlugs(documentHtml);
      await deps.beginPass(deps.providerId);
      await deps.advanceCursor(deps.providerId, { slugs, nextIndex: 0 });
      return {
        kind: "PAGE_PROCESSED",
        page: "DIRECTORY",
        slugCount: slugs.length,
        theatreCount: 0,
      };
    }

    const observationTime = deps.now();
    let parseResult:
      | { readonly ok: true; readonly theatres: Theatre[] }
      | { readonly ok: false; readonly error: ProviderError };
    try {
      parseResult = {
        ok: true,
        theatres: deps.parseTheatres(documentHtml, observationTime, targetUrl),
      };
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== "UPSTREAM_CHANGED") {
        throw error;
      }
      parseResult = { ok: false, error };
    }

    if (parseResult.ok) {
      for (const theatre of parseResult.theatres) {
        await deps.upsertTheatre(toUpsertInput(theatre, action.slug));
      }
    }
    await deps.advanceCursor(deps.providerId, {
      slugs: action.cursor.slugs,
      nextIndex: action.cursor.nextIndex + 1,
    });

    if (!parseResult.ok) {
      return {
        kind: "PAGE_SKIPPED_PARSER_INCOMPATIBLE",
        slug: action.slug,
        parserErrorCode: parseResult.error.code,
        parserErrorMessage: parseResult.error.message,
      };
    }
    return {
      kind: "PAGE_PROCESSED",
      page: "MARKET",
      slugCount: action.cursor.slugs.length,
      theatreCount: parseResult.theatres.length,
    };
  } finally {
    if (attempt !== null) {
      await attempt.cleanupCompleted;
    }
    await deps.releaseSemaphore(holderId, generation);
  }
}
