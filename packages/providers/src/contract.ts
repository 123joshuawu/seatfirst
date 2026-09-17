// Deviations from source prose, each deliberate:
//   a. All three fetch methods resolve `ProviderOutcome<T>`, not the bare `Promise<T>` P1.1
//      (`docs/backend-work-plan.md:640`) shows from `seatfirst-query-design.md:18-24` —
//      required by P1.5's "first-class result states, never empty data"
//      (`docs/backend-work-plan.md:644`; `seatfirst-query-design.md:49`).
//   b. `tier` is `string | null`, where `seatfirst-query-design.md:40` has `tier?: string`
//      — matches the actual consumer, `SparseLayoutCell.tier?: string | null`
//      (`packages/core/src/layout.ts:43`).
//   c. The `minPrice` × `priceBasis` `.superRefine` is a real semantic constraint present in no
//      source document, reasoned below on `checkPriceBasisConsistency`.
//   d. `.min(1)` and `.nonnegative()` tighten several fields the source prose leaves as bare
//      `string`/`number`.
//   e. `Performance` gains `movieTitle` — a one-field widening of the settled shape at
//      `seatfirst-query-design.md:114-130`, which has no title field (S24). The upstream
//      source is the parser's `group.movie.name`, which was previously discarded at the parse
//      seam; the field is added in place (S24.3) so the durable movie catalogue (S24) can be
//      populated from the same payload S14 already writes `performance.movie_id` from.

import { z } from "zod";

import {
  MoneySchema,
  MovieIdSchema,
  SeatKindSchema,
  ShowtimeIdSchema,
  ShowtimeStatusSchema,
  TheatreIdSchema,
  TheatreRefSchema,
  TheatreSchema,
  type MovieId,
  type SeatKind,
  type Theatre,
  type TheatreId,
  type TheatreRef,
  type ShowtimeId,
  type ShowtimeStatus,
} from "@seatfirst/core";

import type { ProviderErrorCode } from "./errors.js";

// Re-export so a consumer of this package can build a full `VenueProvider` without a second
// import from `@seatfirst/core`; the schema/type are not redefined here (P1.6). `TheatreRef`'s
// numeric upstream ID (kept only inside the namespaced `TheatreId`) is never synthesized into a
// URL (`seatfirst-query-design.md:55`) — see the note on `VenueProvider.deepLink` below,
// which is where that rule actually bites: a deep link is the one place a `TheatreRef` gets
// turned into a string, so that is where the "never synthesize the numeric ID" rule is enforced.
export { TheatreRefSchema, TheatreSchema };
export type { TheatreRef, Theatre };

/**
 * One cell of a provider's raw seat-page grid, before any layout/bitmap processing.
 * Coordinates are 1-based, matching the provider-boundary convention `packages/core/src/layout.ts`
 * already documents on `SparseLayoutCell` ("Provider coordinates are 1-based and are converted
 * once by `buildAuditoriumLayout`", `layout.ts:39`) — a `RawGrid` cell is what an adapter hands to
 * that conversion, plus the one field layout-building has no use for: `rawType`.
 *
 * `kind` is the normalized `SeatKind` (reused from `packages/core/src/search-spec.ts`, not
 * redefined here — P1.4); `rawType` preserves the native upstream string as telemetry only and is
 * never itself interpreted by core code (query-design v2 §1, "Seat types").
 *
 * **Field-by-field compatibility with `SparseLayoutCell` (`packages/core/src/layout.ts:38-47`),
 * verified, not assumed:**
 * - `row`, `column`, `kind`, `available`, `visible` were always structurally identical.
 * - `tier` and `name` both use Zod's `.exactOptional()` rather than `.optional()`, for the same
 *   reason. Under this repo's `exactOptionalPropertyTypes: true`, `.optional()` infers a type with
 *   an explicit `| undefined` member (e.g. `tier?: string | null | undefined`,
 *   `name?: string | undefined`), which is not assignable to `SparseLayoutCell.tier?: string |
 *   null` / `.name?: string` — neither declares `undefined` as an allowed value, only an absent
 *   key. `.exactOptional()` keeps the key optional without adding `undefined` to the value type,
 *   so both fields infer exactly what `SparseLayoutCell` declares, and a `RawGrid` is assignable
 *   to `SparseLayoutInput` as a whole. No wire-shape change: a key-absent payload still parses
 *   with the key omitted; only an explicit `undefined` value (never produced by JSON) is now
 *   rejected. A provider that cannot read a cell's tier may now either omit the key or write
 *   `tier: null` — both mean "not determined"; only an explicit `undefined` is rejected.
 */
export const RawGridCellSchema = z.strictObject({
  row: z.number().int().positive(),
  column: z.number().int().positive(),
  kind: SeatKindSchema,
  rawType: z.string().min(1),
  tier: z.string().min(1).nullable().exactOptional(),
  available: z.boolean(),
  name: z.string().min(1).exactOptional(),
  visible: z.boolean(),
});
export type RawGridCell = z.infer<typeof RawGridCellSchema>;

/** Sparse seat-page grid returned by a provider, per `seatfirst-query-design.md:36-42`. */
export const RawGridSchema = z.strictObject({
  rows: z.number().int().positive(),
  columns: z.number().int().positive(),
  cells: z.array(RawGridCellSchema),
});
export type RawGrid = z.infer<typeof RawGridSchema>;

/**
 * Distinguishes a `minPrice` the adapter is confident reflects an ordinary ticket price from one
 * it could not determine. `UNKNOWN` is not an error state — some seat-page fetches resolve
 * without a usable price, and that is a first-class, representable outcome, not an absent field
 * standing in for one.
 *
 * **Reused, not redefined:** this is literally
 * `MoneySchema.shape.basis` (`packages/core/src/result-contracts.ts:29-33`), the same enum
 * approved ADR 0003 already ships for exactly this vocabulary — not a same-values-by-coincidence
 * copy. `CONTRIBUTING.md` §5 requires importing from `packages/core` rather than drafting a
 * competing schema in this package, which is what the earlier `z.enum(["TICKET_ONLY",
 * "UNKNOWN"])` here did. `test/contract.schema.test.ts` pins the reuse with a reference-identity
 * assertion (`PriceBasisSchema === MoneySchema.shape.basis`), so re-introducing a local copy
 * fails the test even though the values would still match.
 */
export const PriceBasisSchema = MoneySchema.shape.basis;
export type PriceBasis = z.infer<typeof PriceBasisSchema>;

/**
 * `minPrice` × `priceBasis` cross-product check. `SeatPageResultSchema`'s
 * own doc comment states the coupling exactly ("`TICKET_ONLY` when `minPrice` reflects a
 * determined ordinary-ticket price, `UNKNOWN` when the seat page resolved but no such price
 * could be determined") — `{priceBasis: "TICKET_ONLY", minPrice: null}` and `{priceBasis:
 * "UNKNOWN", minPrice: <a number>}` both contradict that stated definition, so this is a
 * refinement derived from a rule already written down in this file, not a new product judgment
 * (`CONTRIBUTING.md` §5 "The rule"; ADR 0003 §5, wire rules "become refinements, not
 * conventions").
 */
function checkPriceBasisConsistency(
  value: { readonly minPrice: number | null; readonly priceBasis: PriceBasis },
  context: z.core.$RefinementCtx,
): void {
  if (value.priceBasis === "TICKET_ONLY" && value.minPrice === null) {
    context.addIssue({
      code: "custom",
      path: ["minPrice"],
      message: "priceBasis TICKET_ONLY requires a determined (non-null) minPrice",
      input: value,
    });
  }
  if (value.priceBasis === "UNKNOWN" && value.minPrice !== null) {
    context.addIssue({
      code: "custom",
      path: ["priceBasis"],
      message: "priceBasis UNKNOWN requires minPrice: null",
      input: value,
    });
  }
}

/**
 * Result of a resolved seat-page fetch (`VenueProvider.getSeatPage`).
 *
 * `minPrice` is the lowest visible **ordinary-seat ticket price, fees excluded** — not "cheapest
 * seat" (which could be a differently-priced accessible seat) and not "starting from" (upstream
 * marketing copy that can bundle fees or promotional framing). It is nullable, and unknown until
 * *this* fetch resolves: prices are not carried on the schedule
 * (`seatfirst-query-design.md:59`, `:120`). Anchoring the field on `SeatPageResult`, rather
 * than on the pre-fetch schedule type, is what makes the null case unavoidable for a caller that
 * already holds a `SeatPageResult` — there is no fully-resolved variant of this type in which
 * `minPrice` is a plain non-nullable `number`. `priceBasis` states which case applies:
 * `TICKET_ONLY` when `minPrice` reflects a determined ordinary-ticket price, `UNKNOWN` when the
 * seat page resolved but no such price could be determined. `checkPriceBasisConsistency` above
 * enforces that coupling as a `.superRefine` so the two invalid cross-products can never parse.
 */
export const SeatPageResultSchema = z
  .strictObject({
    grid: RawGridSchema,
    minPrice: z.number().nonnegative().nullable(),
    priceBasis: PriceBasisSchema,
    /**
     * Provider oddities only — e.g. `performanceNumber`, `rawStatus` — never a named core column
     * (P1.9). Raw upstream data is `unknown` until parsed by the (not-yet-authorized) adapter; no
     * `any` crosses this boundary.
     */
    providerMeta: z.record(z.string(), z.unknown()),
  })
  .superRefine(checkPriceBasisConsistency);
export type SeatPageResult = z.infer<typeof SeatPageResultSchema>;

/**
 * Schedule-resolved performance data as returned by `VenueProvider.getSchedule`, before any
 * persistence. Field shapes follow `seatfirst-query-design.md:106-123` (§2.1). Runtime-
 * validated by `PerformanceSchema` below, so a value claimed to satisfy this interface is actually
 * checked at the boundary rather than merely asserted via `as Performance`.
 *
 * `packages/durability`'s `performance` table (`docs/backend-work-plan.md` §1 task S2.7) is, on
 * purpose, a **looser** shape than this one — rows there exist before full resolution, so several
 * fields this type declares non-null (`movieId`, `utcOffset`, `status`, `deepLinkUrl`) are
 * nullable at the DB boundary. That is closed, already-recorded reasoning about *why the two
 * shapes differ*, not a reason to leave this type unvalidated — the type itself describes a
 * fully-resolved performance and is settled (`seatfirst-query-design.md:106-123`).
 */
export interface Performance {
  readonly showtimeId: ShowtimeId;
  readonly providerId: string;
  /** Chain oddities, e.g. `{ performanceNumber, rawStatus }` — never named core columns. */
  readonly providerMeta: Record<string, unknown>;
  readonly theatreId: TheatreId;
  readonly movieId: MovieId;
  /** Movie display title, carried from the schedule payload (`group.movie.name`, S24.3). */
  readonly movieTitle: string;
  readonly auditorium: string | number | null;
  readonly showDateTimeUtc: Date;
  readonly showDateTimeLocal: string;
  readonly utcOffset: string;
  readonly runtimeMinutes: number | null;
  readonly status: ShowtimeStatus;
  readonly attributes: readonly string[];
  readonly formatCode: string | null;
  /** Null until the seat fetch resolves — prices are not on the schedule. */
  readonly minPrice: number | null;
  /** Constructed by `VenueProvider.deepLink`, never supplied verbatim by upstream. */
  readonly deepLinkUrl: string;
  readonly layoutId: string | null;
}

/**
 * Runtime mirror of `Performance` — a schema is needed because `Performance` is a plain
 * `interface`, and interfaces are erased at compile time, so nothing checks an incoming value
 * against it at runtime without one. `docs/backend-work-plan.md` §1 task S2.7 records the
 * shape as **settled** (`seatfirst-query-design.md:106-123`) and already explains the
 * DB/type divergence the interface's own doc comment cites — `performance` rows exist before
 * full resolution, so several DB columns are nullable where this type is not. That is closed
 * reasoning, not an open decision this schema would be pre-empting.
 *
 * Kept as a **separate** schema rather than replacing the interface with `z.infer<...>`: this
 * repo's prevailing style is `readonly` interface fields (`CONTRIBUTING.md` §5, "TypeScript and
 * Zod"), which `z.infer` does not produce. `test/contract.types.test.ts` proves the two stay in
 * sync — a hand-built `Performance` literal and a `PerformanceSchema.parse()` result are each
 * checked against the other's type.
 */
export const PerformanceSchema = z.strictObject({
  showtimeId: ShowtimeIdSchema,
  providerId: z.string().min(1),
  providerMeta: z.record(z.string(), z.unknown()),
  theatreId: TheatreIdSchema,
  movieId: MovieIdSchema,
  movieTitle: z.string().min(1),
  auditorium: z.union([z.string(), z.number(), z.null()]),
  showDateTimeUtc: z.date(),
  showDateTimeLocal: z.string().min(1),
  utcOffset: z.string().min(1),
  runtimeMinutes: z.number().int().positive().nullable(),
  status: ShowtimeStatusSchema,
  attributes: z.array(z.string()),
  formatCode: z.string().min(1).nullable(),
  /** Null until the seat fetch resolves — prices are not on the schedule. */
  minPrice: z.number().nonnegative().nullable(),
  /** Constructed by `VenueProvider.deepLink`, never supplied verbatim by upstream. */
  deepLinkUrl: z.string().min(1),
  layoutId: z.string().min(1).nullable(),
});

/**
 * Result of a `VenueProvider` fetch attempt. Every fetch method returns
 * this instead of resolving to bare data or rejecting with a `ProviderError` — the eight
 * `ProviderErrorCode`s (`errors.ts`) are first-class result states, never empty data (P1.5),
 * and TypeScript has no checked exceptions: a `throw`-based contract does not appear anywhere in
 * `VenueProvider`'s type, so nothing forces a caller, or a future adapter author, to handle any
 * of the eight codes. `packages/core/src/result-contracts.ts:297-321`'s `RecheckResultSchema`
 * (`status: "UNAVAILABLE", cause: z.enum([...])`) and its `HaltedEventSchema` (`:904-919`) model
 * this exact vocabulary as a discriminated variant of a return value under approved ADR 0003;
 * this follows the same precedent instead of throwing.
 *
 * `NO_RESULTS` and `NOT_FOUND` in particular are ordinary outcomes, not exceptions — forcing them
 * through a throw would push adapter authors toward `return []` on failure, exactly the
 * "never empty data" failure P1.5 exists to prevent.
 *
 * `.value` is reachable only after narrowing `.ok` (pinned by a `@ts-expect-error` test in
 * `test/contract.types.test.ts`) — that is what makes the union load-bearing rather than
 * decorative. `ProviderError` (`errors.ts`) may still be used as an adapter's *internal*
 * transport (e.g., thrown inside an adapter and caught at its own boundary) but must not be the
 * contract's error channel; nothing in `VenueProvider` throws or catches it.
 */
export type ProviderOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: ProviderErrorCode;
      readonly message: string;
      readonly providerMeta: Record<string, unknown>;
    };

/**
 * All upstream access goes through one provider interface (`seatfirst-query-design.md:18-24`).
 * The AMC public-website adapter is one implementation of it and is **not authorized yet**: gate 1
 * (ADR 0002, `docs/adr/0002-legal-data-use.md`, currently `proposed`) and gate 7 (empty fixture
 * corpus) both remain open (`docs/backend-work-plan.md` §6.3). This file lands the contract only —
 * no adapter, no HTTP client, no network call of any kind.
 *
 * `getSeatPage` supersedes the retired `getSeatGrid(showtimeId): Promise<RawGrid>` signature —
 * `seatfirst-architecture.md:715` amends the contract because the old return type cannot carry
 * `minPrice`/`priceBasis`, which arrive only on the seat page, never on the schedule. All three
 * fetch methods resolve to a `ProviderOutcome<T>` (see its doc comment above), not bare data and
 * not a rejected promise.
 *
 * Deliberately absent: a `session` or `auth` member. Cookie/session handling, response
 * classification, slug-addressing mechanics, page parsing, and native vocabularies all stay behind
 * this interface, inside whichever adapter implements it — the current provider needs cookies and
 * classification, a future one might need keys, and generalizing either into the contract would
 * leak an implementation detail across the exact boundary this interface exists to draw
 * (`seatfirst-query-design.md:62`).
 */
export interface VenueProvider {
  readonly id: string;
  searchTheatres(query: string): Promise<ProviderOutcome<readonly Theatre[]>>;
  getSchedule(
    theatreRef: TheatreRef,
    localDate: string,
  ): Promise<ProviderOutcome<readonly Performance[]>>;
  /** Keyed by `ShowtimeId` alone (`seatfirst-query-design.md:54`, §1 item 1). */
  getSeatPage(showtimeId: ShowtimeId): Promise<ProviderOutcome<SeatPageResult>>;
  /**
   * Deep links are constructed, not supplied (`seatfirst-query-design.md:60`, §1 item 7).
   * Implementations must validate the constructed URL against a per-provider host allowlist —
   * the same rule ADR 0003 §5 states for wire-level `deepLinkUrl` fields
   * (`docs/adr/0003-searchspec-result-contracts.md:377-380`) — rather than trusting whatever
   * string a native template produces; this contract does not weaken that requirement.
   *
   * The numeric upstream ID an adapter keeps for identity (inside the namespaced `TheatreId` /
   * `ShowtimeId`) is **never synthesized into a URL** (`seatfirst-query-design.md:55`; P1.6),
   * except through the adapter-owned, already-namespaced seat-map route builder: ADR 0002
   * §3.5 Phase 2 (approved 2026-09-05) explicitly authorizes constructing seat-level deep
   * links for handoff from the namespaced numeric showtime ID and the placement's validated
   * `seatNames` (`buildSeatsUrl(numericId, seatNames)`), carrying `?seats=<seatNames>` on
   * the seats route. When `seatNames` is omitted or empty, the clean baseline seats URL is
   * built. Every constructed URL is validated through `isAllowedUrl` before return.
   */
  deepLink(performance: Performance, seatNames?: readonly string[]): string;
}

// SeatKind is re-exported so `RawGrid` consumers do not need a second import for the type the
// grid cells are already typed against.
export { SeatKindSchema };
export type { SeatKind };
