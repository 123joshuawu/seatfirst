import {
  buildAuditoriumLayout,
  MovieIdSchema,
  ShowtimeIdSchema,
  TheatreIdSchema,
  type ShowtimeId,
  type SparseLayoutCell,
} from "@seatfirst/core";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  PerformanceSchema,
  SeatPageResultSchema,
  TheatreRefSchema,
  type Performance,
  type ProviderOutcome,
  type RawGrid,
  type RawGridCell,
  type TheatreRef,
  type VenueProvider,
} from "../src/index.js";
import type { ProviderErrorCode } from "../src/errors.js";

const mockShowtimeId = ShowtimeIdSchema.parse("mock:showtime:1");

/**
 * Captures the last argument(s) each mock method actually received, so the tests below can
 * assert on them: a mock whose methods declare no parameters
 * (`() => Promise.resolve(...)`) type-checks against any parameter list, so nothing pins
 * `searchTheatres(query)`, `getSchedule(ref, localDate)`, or `deepLink(performance)`'s parameter
 * surface. Named, typed parameters that are captured and asserted on close that gap.
 */
let capturedQuery: string | undefined;
let capturedSchedule: { readonly ref: TheatreRef; readonly localDate: string } | undefined;
let capturedDeepLinkPerformance: Performance | undefined;

/**
 * A fully-typed mock — not an adapter. It never resolves a real network request; it only proves
 * that `VenueProvider`'s five members (`seatfirst-query-design.md:18-24`, with
 * `getSeatPage` in place of `getSeatGrid`) are satisfiable and mutually consistent as written,
 * and that every fetch method resolves a `ProviderOutcome<T>` (see its doc comment in
 * `contract.ts`), not bare data.
 */
const mockProvider: VenueProvider = {
  id: "mock",
  searchTheatres: (query: string) => {
    capturedQuery = query;
    return Promise.resolve({ ok: true, value: [] });
  },
  getSchedule: (ref: TheatreRef, localDate: string) => {
    capturedSchedule = { ref, localDate };
    return Promise.resolve({ ok: true, value: [] });
  },
  getSeatPage: (showtimeId: ShowtimeId) => {
    void showtimeId;
    return Promise.resolve({
      ok: true,
      value: SeatPageResultSchema.parse({
        grid: { rows: 1, columns: 1, cells: [] },
        minPrice: null,
        priceBasis: "UNKNOWN",
        providerMeta: {},
      }),
    });
  },
  deepLink: (performance: Performance) => {
    capturedDeepLinkPerformance = performance;
    return "https://mock.example/seat";
  },
};

describe("VenueProvider contract — type level", () => {
  it("a full mock implementation compiles and its getSeatPage resolves the documented null-price case", async () => {
    const outcome = await mockProvider.getSeatPage(mockShowtimeId);
    expect(outcome).toEqual({
      ok: true,
      value: {
        grid: { rows: 1, columns: 1, cells: [] },
        minPrice: null,
        priceBasis: "UNKNOWN",
        providerMeta: {},
      },
    });
  });

  it("a stub still exposing the retired getSeatGrid member does not typecheck as VenueProvider", () => {
    // `getSeatPage` (a required member) is missing and `getSeatGrid` (not a member of
    // `VenueProvider`) is present instead — TS reports the excess property at its own line, so
    // the `@ts-expect-error` directive sits directly above it. `getSeatPage`'s absence does not
    // surface as a second diagnostic here: with `getSeatGrid` still present, `tsc` emits only the
    // excess-property error (TS2353) the directive below is pinning. The missing-property error
    // (TS2741) appears only if `getSeatGrid` is deleted too, and then at the object literal's own
    // line, where this directive could not reach it. `searchTheatres` and `getSchedule` are
    // written in the current `ProviderOutcome`-returning shape so the only diagnostic this literal
    // produces is the one the directive below is pinning.
    const staleProvider: VenueProvider = {
      id: "stale-mock",
      searchTheatres: () => Promise.resolve({ ok: true, value: [] }),
      getSchedule: () => Promise.resolve({ ok: true, value: [] }),
      // @ts-expect-error — `getSeatGrid` was replaced by `getSeatPage` (P1.1,
      // `seatfirst-architecture.md:715`); an implementation offering the old member instead of
      // the new one must not satisfy `VenueProvider`. If this stops erroring, the amendment
      // regressed: TS reports the directive itself as unused (TS2578) and `pnpm typecheck` fails.
      getSeatGrid: () => Promise.resolve({ rows: 1, columns: 1, cells: [] }),
      deepLink: () => "https://mock.example/seat",
    };
    expect(staleProvider.id).toBe("stale-mock");
  });

  it("pins the parameter surface of searchTheatres, getSchedule, and deepLink", async () => {
    // Before this test, every mock method was `() => ...` — structurally compatible with *any*
    // parameter list, so nothing here actually exercised `query: string`, `ref: TheatreRef`,
    // `localDate: string`, or `performance: Performance`. Calling each method with a concrete,
    // independently-built argument and asserting the mock's captured variable equals it proves
    // the argument genuinely flows through with the declared type, not just that the method
    // exists.
    await mockProvider.searchTheatres("oppenheimer");
    expect(capturedQuery).toBe("oppenheimer");

    const ref = TheatreRefSchema.parse({ id: "amc-empire-25", slugs: { market: "nyc-metro" } });
    await mockProvider.getSchedule(ref, "2026-08-10");
    expect(capturedSchedule).toEqual({ ref, localDate: "2026-08-10" });

    const performance: Performance = {
      showtimeId: mockShowtimeId,
      providerId: "mock",
      providerMeta: {},
      theatreId: TheatreIdSchema.parse("mock:theatre:1"),
      movieId: MovieIdSchema.parse("mock:movie:1"),
      movieTitle: "Dune Part 3",
      auditorium: "7",
      showDateTimeUtc: new Date("2026-08-10T23:30:00.000Z"),
      showDateTimeLocal: "2026-08-10T19:30:00",
      utcOffset: "-04:00",
      runtimeMinutes: 180,
      status: "OPEN",
      attributes: [],
      formatCode: null,
      minPrice: null,
      deepLinkUrl: "https://mock.example/showtime/1",
      layoutId: null,
    };
    const link = mockProvider.deepLink(performance);
    expect(capturedDeepLinkPerformance).toBe(performance);
    expect(link).toBe("https://mock.example/seat");
  });
});

describe("ProviderOutcome<T> — the error codes are load-bearing on the return type", () => {
  it("exposes `.value` once `.ok` is narrowed true, and `.code`/`.message`/`.providerMeta` once narrowed false", () => {
    function handle(outcome: ProviderOutcome<number>): number | ProviderErrorCode {
      if (outcome.ok) {
        return outcome.value; // compiles: `.value` is reachable once `.ok` is narrowed `true`
      }
      return outcome.code; // compiles: `.code` (and `.message`, `.providerMeta`) once narrowed `false`
    }
    expect(handle({ ok: true, value: 42 })).toBe(42);
    expect(
      handle({ ok: false, code: "NOT_FOUND", message: "no such showtime", providerMeta: {} }),
    ).toBe("NOT_FOUND");
  });

  it("does not allow reading `.value` without narrowing `.ok` first — the assertion that makes the union load-bearing", () => {
    function readWithoutNarrowing(outcome: ProviderOutcome<number>): void {
      // @ts-expect-error — `.value` exists only on the `{ ok: true }` branch of `ProviderOutcome`.
      // If this stops erroring, a caller (or a future adapter) could read `.value` on a `{ ok:
      // false }` result without TypeScript forcing a check first, which is exactly what the
      // discriminated union exists to prevent: the eight `ProviderErrorCode`s becoming
      // reachable-but-unchecked again. Written
      // as a `void`-prefixed property access (not returned or assigned) so the suppressed
      // diagnostic's resulting `error`-typed expression does not also trip
      // `no-unsafe-return`/`-assignment`.
      void outcome.value;
    }
    // Never actually invoked — the point of this test is the compile-time diagnostic above, not
    // a runtime call. `void` keeps `noUnusedLocals`/lint quiet without pretending this executes.
    void readWithoutNarrowing;
  });
});

describe("RawGrid / core layout boundary", () => {
  it("RawGridCell['tier'] alone is assignable to SparseLayoutCell['tier']", () => {
    // Compile-time only, never invoked (same pattern as `readWithoutNarrowing` above): the point
    // is the type-checked return, not a runtime call. `Pick` preserves each field's own
    // optionality/nullability instead of collapsing it, so this isolates exactly the fix: `tier`
    // uses `.exactOptional()` on `RawGridCellSchema`, inferring `tier?: string | null` — matching
    // `SparseLayoutCell.tier?: string | null` exactly, with no `| undefined` in the value type.
    function tierIsAssignable(cell: Pick<RawGridCell, "tier">): Pick<SparseLayoutCell, "tier"> {
      return cell;
    }
    void tierIsAssignable;
  });

  it("RawGrid as a whole is assignable to SparseLayoutInput — buildAuditoriumLayout accepts a RawGrid directly", () => {
    // Compile-time only, never invoked (same pattern as the other tests in this describe block).
    // Passing a `RawGrid` straight into `buildAuditoriumLayout`'s parameter position is exactly
    // the assertion that fails unless `RawGridCellSchema.shape.name` and `.tier` both use
    // `.exactOptional()`: `SparseLayoutCell.name?: string` and `.tier?: string | null` are
    // hand-written without an explicit `| undefined`, and only `.exactOptional()` infers a
    // matching optional key under this repo's `exactOptionalPropertyTypes: true`.
    function wholeGridIsAssignable(grid: RawGrid): void {
      const layout = buildAuditoriumLayout(grid);
      void layout;
    }
    void wholeGridIsAssignable;
  });
});

describe("PerformanceSchema / Performance — the shape is pinned, not just unioned into `never`", () => {
  const validRaw = {
    showtimeId: "mock:showtime:1",
    providerId: "mock",
    providerMeta: { performanceNumber: "142125592" },
    theatreId: "mock:theatre:1",
    movieId: "mock:movie:1",
    movieTitle: "Dune Part 3",
    auditorium: "12",
    showDateTimeUtc: new Date("2026-08-10T23:30:00.000Z"),
    showDateTimeLocal: "2026-08-10T19:30:00",
    utcOffset: "-04:00",
    runtimeMinutes: 128,
    status: "OPEN",
    attributes: ["IMAX", "DBOX"],
    formatCode: "IMAX",
    minPrice: null,
    deepLinkUrl: "https://mock.example/showtime/1",
    layoutId: null,
  };

  it("parses a fully-resolved performance and the result satisfies the hand-written Performance interface", () => {
    const parsed = PerformanceSchema.parse(validRaw);
    // Compile-time: `PerformanceSchema`'s inferred output must be assignable to `Performance` —
    // if a field is dropped or retyped on either side, this line stops compiling.
    const asPerformance: Performance = parsed;
    expect(asPerformance.showtimeId).toBe(mockShowtimeId);
  });

  it("a hand-built Performance literal is also assignable to z.infer<typeof PerformanceSchema> — the reverse direction", () => {
    // Compile-time only, never invoked (same pattern as the other type-level assertions in this
    // file: `readWithoutNarrowing`, `tierIsAssignable`, `wholeGridIsAssignable`). The test above
    // proves `parsed → Performance` (schema's inferred output assignable to the interface); this
    // proves the direction that test does not: a hand-built `Performance` assignable to the
    // schema's own inferred output type, not just to the hand-written interface. Without this,
    // nothing checks a hand-built literal against `z.infer<typeof PerformanceSchema>` at all — a
    // field only the interface declares (and the schema's inferred type does not, or types
    // differently) would compile here even though it silently breaks the reverse direction.
    //
    // `attributes` is `Omit`-ted out on both sides: `Performance.attributes` is declared
    // `readonly string[]` (matching this file's `readonly`-interface-fields convention) while
    // `z.array(z.string())` infers plain `string[]`; a readonly array is never assignable to a
    // mutable array type in this direction (only the reverse, already proven above, holds) — an
    // expected artifact of the two types' declaration styles, not a schema/interface mismatch, so
    // isolating it here (same `Pick`/`Omit`-isolation idiom as `tierIsAssignable` above) keeps
    // this assertion checking the fields whose compatibility is actually in question.
    function performanceIsAssignableToInferredSchema(
      p: Omit<Performance, "attributes">,
    ): Omit<z.infer<typeof PerformanceSchema>, "attributes"> {
      return p;
    }
    void performanceIsAssignableToInferredSchema;
  });

  it("a hand-built Performance literal is independently valid — the type is not solely defined by what the schema happens to parse", () => {
    const p: Performance = {
      showtimeId: mockShowtimeId,
      providerId: "mock",
      providerMeta: {},
      theatreId: TheatreIdSchema.parse("mock:theatre:1"),
      movieId: MovieIdSchema.parse("mock:movie:1"),
      movieTitle: "Dune Part 3",
      auditorium: null,
      showDateTimeUtc: new Date("2026-08-10T23:30:00.000Z"),
      showDateTimeLocal: "2026-08-10T19:30:00",
      utcOffset: "-04:00",
      runtimeMinutes: null,
      status: "UNKNOWN",
      attributes: [],
      formatCode: null,
      minPrice: null,
      deepLinkUrl: "https://mock.example/showtime/1",
      layoutId: null,
    };
    expect(p.status).toBe("UNKNOWN");
  });

  it("rejects a performance missing a required field (strictObject)", () => {
    const withoutStatus: Record<string, unknown> = { ...validRaw };
    delete withoutStatus["status"];
    expect(PerformanceSchema.safeParse(withoutStatus).success).toBe(false);
  });

  it("rejects a performance carrying an unrecognized property (strictObject)", () => {
    expect(PerformanceSchema.safeParse({ ...validRaw, seatCount: 320 }).success).toBe(false);
  });

  it("rejects an unnormalized status string — only ShowtimeStatusSchema's members are valid", () => {
    expect(PerformanceSchema.safeParse({ ...validRaw, status: "SoldOut" }).success).toBe(false);
  });
});
