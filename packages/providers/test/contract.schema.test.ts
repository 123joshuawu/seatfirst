import { MoneySchema, SeatKindSchema as CoreSeatKindSchema } from "@seatfirst/core";
import { describe, expect, it } from "vitest";

import {
  PriceBasisSchema,
  RawGridCellSchema,
  RawGridSchema,
  SeatKindSchema,
  SeatPageResultSchema,
  type RawGrid,
} from "../src/index.js";

const validCell = {
  row: 1,
  column: 3,
  kind: "STANDARD",
  rawType: "CanReserve",
  tier: null,
  available: true,
  visible: true,
} as const;

const validGrid: RawGrid = {
  rows: 4,
  columns: 6,
  cells: [
    validCell,
    {
      row: 1,
      column: 4,
      kind: "WHEELCHAIR",
      rawType: "Wheelchair",
      tier: "premium",
      available: false,
      name: "A4",
      visible: true,
    },
  ],
};

describe("RawGridCellSchema", () => {
  it("parses a well-formed cell with the optional fields present", () => {
    const parsed = RawGridCellSchema.parse({
      row: 2,
      column: 5,
      kind: "COMPANION",
      rawType: "Companion",
      tier: "standard",
      available: true,
      name: "B5",
      visible: true,
    });
    expect(parsed).toMatchObject({
      row: 2,
      column: 5,
      kind: "COMPANION",
      tier: "standard",
      name: "B5",
    });
  });

  it("parses a well-formed cell with `name` absent and `tier: null`", () => {
    expect(RawGridCellSchema.safeParse(validCell).success).toBe(true);
  });

  it("parses a cell that omits `tier` entirely — a provider that cannot read a seat's tier may omit the key instead of writing `tier: null`", () => {
    // All three accepted shapes of `tier` are pinned across this suite: omitted (here), `null`
    // (`validCell` above), and a real value (`validGrid`'s second cell, top of file, `tier:
    // "premium"`). `tier` uses `.exactOptional()` on `RawGridCellSchema`, matching
    // `packages/core/src/layout.ts`'s `SparseLayoutCell.tier?: string | null` exactly — see the
    // doc comment on `RawGridCellSchema`.
    const withoutTier: Record<string, unknown> = { ...validCell };
    delete withoutTier["tier"];
    expect(RawGridCellSchema.safeParse(withoutTier).success).toBe(true);
  });

  it.each(["STANDARD", "WHEELCHAIR", "COMPANION", "NOT_A_SEAT", "UNKNOWN"] as const)(
    "accepts every value of core's SeatKind enum: %s",
    (kind) => {
      expect(RawGridCellSchema.safeParse({ ...validCell, kind }).success).toBe(true);
    },
  );

  it("uses core's actual SeatKindSchema object for `kind`, not a same-values local copy", () => {
    // The `it.each` above only proves the *value set* matches — a hand-written
    // `z.enum(["STANDARD", "WHEELCHAIR", "COMPANION", "NOT_A_SEAT", "UNKNOWN"])` here would pass
    // it identically while silently drifting the moment core adds or renames a kind. Reference
    // identity is the only check that actually distinguishes reuse from a byte-identical copy.
    expect(RawGridCellSchema.shape.kind).toBe(CoreSeatKindSchema);
    expect(SeatKindSchema).toBe(CoreSeatKindSchema);
  });

  it("rejects a kind outside core's SeatKind enum", () => {
    // Positive control above proves every real SeatKind value is accepted; this proves the
    // schema is not simply `z.string()` in disguise.
    expect(RawGridCellSchema.safeParse({ ...validCell, kind: "BOOTH" }).success).toBe(false);
  });

  it("rejects a cell missing a required field", () => {
    const withoutAvailable: Record<string, unknown> = { ...validCell };
    delete withoutAvailable["available"];
    expect(RawGridCellSchema.safeParse(withoutAvailable).success).toBe(false);
  });

  it("rejects a cell carrying an unrecognized property (strictObject)", () => {
    expect(RawGridCellSchema.safeParse({ ...validCell, seatId: "amc-seat-1" }).success).toBe(false);
  });

  it("rejects an explicit `name: undefined` — the documented cost of `.exactOptional()`", () => {
    // `.exactOptional()` keeps the key optional but does not widen the value type to include
    // `undefined`: a key-absent payload still parses (see the `name`-absent test above), but a
    // payload that explicitly carries `undefined` as the value does not. This is the behavior
    // change `.exactOptional()` exists to produce (see the doc comment on `RawGridCellSchema`),
    // and nothing else in this suite asserts it — `.optional()` would accept this same input.
    expect(RawGridCellSchema.safeParse({ ...validCell, name: undefined }).success).toBe(false);
  });

  it('rejects `name: ""` — `.min(1)` on `name` is enforced, not merely declared', () => {
    // Without this assertion, dropping `.min(1)` from `name` in `RawGridCellSchema` leaves every
    // other test in this file green.
    expect(RawGridCellSchema.safeParse({ ...validCell, name: "" }).success).toBe(false);
  });

  it('rejects `tier: ""` — `.min(1)` on `tier` is enforced, not merely declared', () => {
    expect(RawGridCellSchema.safeParse({ ...validCell, tier: "" }).success).toBe(false);
  });
});

describe("RawGridSchema", () => {
  it("parses a well-formed sparse grid", () => {
    expect(RawGridSchema.safeParse(validGrid).success).toBe(true);
  });

  it("rejects a grid missing a required top-level field", () => {
    const withoutColumns: Record<string, unknown> = { ...validGrid };
    delete withoutColumns["columns"];
    expect(RawGridSchema.safeParse(withoutColumns).success).toBe(false);
  });

  it("rejects a grid carrying an unrecognized top-level property (strictObject)", () => {
    expect(RawGridSchema.safeParse({ ...validGrid, auditoriumId: "42" }).success).toBe(false);
  });

  it("rejects non-positive rows/columns", () => {
    expect(RawGridSchema.safeParse({ ...validGrid, rows: 0 }).success).toBe(false);
    expect(RawGridSchema.safeParse({ ...validGrid, columns: -1 }).success).toBe(false);
  });
});

describe("PriceBasisSchema", () => {
  it.each(["TICKET_ONLY", "UNKNOWN"] as const)("accepts %s", (value) => {
    expect(PriceBasisSchema.safeParse(value).success).toBe(true);
  });

  it("rejects a value outside the two documented bases", () => {
    expect(PriceBasisSchema.safeParse("STARTING_FROM").success).toBe(false);
  });

  it("is literally core's MoneySchema.shape.basis, not a same-values local copy", () => {
    // Reference identity, not `.toEqual` on `.options`: two independently-declared enums with
    // identical values would also pass a value-equality check, which cannot distinguish "reused"
    // from "redefined." `PriceBasisSchema === MoneySchema.shape.basis` can only hold if this
    // module actually imports and re-exports core's schema object rather than drafting its own
    // (CONTRIBUTING.md §5).
    expect(PriceBasisSchema).toBe(MoneySchema.shape.basis);
  });
});

describe("SeatPageResultSchema", () => {
  const validResult = {
    grid: validGrid,
    minPrice: 12.5,
    priceBasis: "TICKET_ONLY",
    providerMeta: { performanceNumber: "142125592" },
  } as const;

  it("parses a resolved, ticket-priced result", () => {
    expect(SeatPageResultSchema.safeParse(validResult).success).toBe(true);
  });

  it("parses minPrice: null paired with priceBasis: UNKNOWN (P1.3's unavoidable null case)", () => {
    const result = SeatPageResultSchema.safeParse({
      ...validResult,
      minPrice: null,
      priceBasis: "UNKNOWN",
    });
    expect(result.success).toBe(true);
  });

  describe("priceBasis x minPrice cross-product refinement", () => {
    // Positive controls for both valid pairings already live above: `validResult` itself is
    // `{priceBasis: "TICKET_ONLY", minPrice: 12.5}` ("parses a resolved, ticket-priced result"),
    // and `{priceBasis: "UNKNOWN", minPrice: null}` is the case directly above this block. What
    // follows are the two invalid cross-products the doc comment on `SeatPageResultSchema`
    // (contract.ts) rules out.

    it("rejects priceBasis: TICKET_ONLY paired with minPrice: null", () => {
      const result = SeatPageResultSchema.safeParse({
        ...validResult,
        priceBasis: "TICKET_ONLY",
        minPrice: null,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["minPrice"]);
      }
    });

    it("rejects priceBasis: UNKNOWN paired with a non-null minPrice", () => {
      const result = SeatPageResultSchema.safeParse({
        ...validResult,
        priceBasis: "UNKNOWN",
        minPrice: 9.99,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(["priceBasis"]);
      }
    });
  });

  it("rejects a negative minPrice", () => {
    // Positive control: zero — the boundary directly below the rejected value — still parses,
    // so this is testing the sign check specifically, not merely "some minPrice is disallowed."
    expect(SeatPageResultSchema.safeParse({ ...validResult, minPrice: 0 }).success).toBe(true);
    expect(SeatPageResultSchema.safeParse({ ...validResult, minPrice: -0.01 }).success).toBe(false);
  });

  it("rejects a result missing a required field", () => {
    const withoutPriceBasis: Record<string, unknown> = { ...validResult };
    delete withoutPriceBasis["priceBasis"];
    expect(SeatPageResultSchema.safeParse(withoutPriceBasis).success).toBe(false);
  });

  it("rejects a result carrying an unrecognized top-level property (strictObject)", () => {
    expect(SeatPageResultSchema.safeParse({ ...validResult, minPriceFees: 1.5 }).success).toBe(
      false,
    );
  });

  it("keeps providerMeta open to arbitrary provider oddities without requiring `any`", () => {
    const result = SeatPageResultSchema.parse({
      ...validResult,
      providerMeta: { performanceNumber: "1", rawStatus: "Sellable", nested: { a: [1, 2] } },
    });
    expect(result.providerMeta).toEqual({
      performanceNumber: "1",
      rawStatus: "Sellable",
      nested: { a: [1, 2] },
    });
  });
});
