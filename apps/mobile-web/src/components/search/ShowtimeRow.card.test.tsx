import { describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ShowtimeRow } from "./ShowtimeRow";
import { distanceLabel, priceLabel } from "@/lib/presentation";
import { colors } from "@/theme/colors";
import type { ResultGroup, ScheduleSkeletonEntry } from "@seatfirst/core";

function mkEntry(
  over: { showtimeId: string } & Partial<Omit<ScheduleSkeletonEntry, "showtimeId">>,
): ScheduleSkeletonEntry {
  return {
    theatreId: "th_amc_metreon",
    showDateTimeLocal: "2026-08-30T19:00",
    formatCode: "STANDARD",
    distanceKm: null,
    rank: 0,
    admitted: true,
    resolved: false,
    ...over,
  } as unknown as ScheduleSkeletonEntry;
}

function mkGroupWithLayout(params: {
  showtimeId: string;
  rows: number;
  columns: number;
  seatKinds: number[];
  freeIn: number[][];
  groupHits?: NonNullable<ResultGroup["groupHits"]>;
  auditorium?: string | number | null;
  minPrice?: { amount: number; currency: string; basis: "TICKET_ONLY" | "UNKNOWN" } | null;
  /** UI32: override the resolved showtime's snapshot instant (defaults to 4m ago). */
  capturedAt?: string | undefined;
}): ResultGroup {
  return {
    theatreId: "th_amc_metreon",
    layoutId: "lay_1",
    distanceKm: null,
    formatCode: "STANDARD",
    auditorium: params.auditorium ?? "Auditorium 1",
    attributes: [],
    rows: params.rows,
    columns: params.columns,
    seatKinds: params.seatKinds,
    seatNames: {},
    seatScores: Array.from({ length: params.rows * params.columns }, () => 0),
    showtimes: [
      {
        showtimeId: params.showtimeId as unknown as never,
        theatreId: "th_amc_metreon" as unknown as never,
        distanceKm: null,
        showDateTimeUtc: "2026-08-30T19:00:00Z",
        timezone: "America/Los_Angeles",
        minPrice: params.minPrice ?? null,
        status: "AVAILABLE" as unknown as never,
        deepLinkUrl: "https://www.amctheatres.com/showtimes/123",
        capturedAt: params.capturedAt ?? new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        staleAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        resolved: true as const,
        openCount: 5,
      },
    ],
    freeCount: [],
    freeIn: params.freeIn,
    groupHits: params.groupHits,
  };
}

const NOT_A_SEAT = 0;
const SEAT = 1;

function renderRow(props: Parameters<typeof ShowtimeRow>[0]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ShowtimeRow, props));
  });
  return renderer;
}

describe("ShowtimeRow card (UI17.1-17.4)", () => {
  it("resolved hit renders dot-grid, occupancy and placement line (UI17.1)", () => {
    const showtimeId = "sh_hit";
    const rows = 2;
    const columns = 4;
    // 2x4 grid: all seats except a gap at (0,1) to test NOT_A_SEAT exclusion
    const seatKinds = [SEAT, NOT_A_SEAT, SEAT, SEAT, SEAT, SEAT, SEAT, SEAT];
    // freeIn: free for showtime 0 for all seats except one taken at (1,3)
    const freeIn: number[][] = seatKinds.map((kind, idx) => {
      if (kind === NOT_A_SEAT) return [];
      // make cell 7 (row1 col3) taken (empty), others free includes 0
      if (idx === 7) return [];
      return [0];
    });
    const group = mkGroupWithLayout({
      showtimeId,
      rows,
      columns,
      seatKinds,
      freeIn,
      groupHits: [{ row: 1, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
    const entry = mkEntry({
      showtimeId,
      rank: 0,
      admitted: true,
      resolved: true,
      distanceKm: 1.8,
    });
    const renderer = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [showtimeId],
      theaterName: "AMC Metreon 16",
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("seat-dot-grid");
    expect(str).toContain("Row B, Seats 1-2");
    expect(str).toContain("centered");
    expect(str).toContain("Sun, Aug 30 · 7:00 PM");
    expect(str).toContain("AMC Metreon 16 · Standard · 1.1 mi");
    // No price
    expect(str).not.toMatch(/\$/);
  });

  it("resolved miss renders its own dot-grid and No together copy, no Hold (UI17.2)", () => {
    const showtimeId = "sh_miss";
    const rows = 2;
    const columns = 3;
    const total = rows * columns;
    const seatKinds = Array.from({ length: total }, () => SEAT);
    const freeIn: number[][] = Array.from({ length: total }, () => 0).map(() => []);
    const group = mkGroupWithLayout({
      showtimeId,
      rows,
      columns,
      seatKinds,
      freeIn,
      groupHits: [],
    });
    const entry = mkEntry({ showtimeId, rank: 1, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [],
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("seat-dot-grid");
    expect(str).toContain("No 2 together");
    expect(str).not.toContain("Go to AMC");
    expect(str).not.toMatch(/\$/);
  });

  it("checking/queued/deferred rows render no dot-grid and keep existing copy (UI17.2)", () => {
    const entryChecking = mkEntry({
      showtimeId: "sh_check",
      rank: 0,
      admitted: true,
      resolved: false,
    });
    const rendererChecking = renderRow({
      entry: entryChecking,
      groups: [],
      partySize: 2,
      resolvedCount: 0,
    });
    const strChecking = JSON.stringify(rendererChecking.toJSON());
    expect(strChecking).not.toContain("seat-dot-grid");
    expect(strChecking).toMatch(/Checking seats|Queued/);
    expect(strChecking).not.toMatch(/\$/);

    const entryDeferred = mkEntry({
      showtimeId: "sh_def",
      rank: 5,
      admitted: false,
      resolved: false,
    });
    const rendererDeferred = renderRow({
      entry: entryDeferred,
      groups: [],
      partySize: 2,
      resolvedCount: 0,
    });
    expect(JSON.stringify(rendererDeferred.toJSON())).toContain("Deferred");
    expect(JSON.stringify(rendererDeferred.toJSON())).not.toContain("seat-dot-grid");
  });

  it("hit row always shows freshness and Go to AMC without a click-to-expand toggle (UI17.4)", () => {
    const showtimeId = "sh_expand";
    const rows = 2;
    const columns = 4;
    const total = rows * columns;
    const seatKinds = Array.from({ length: total }, () => SEAT);
    const freeIn: number[][] = seatKinds.map(() => [0]);
    // make 2 seats taken to have free < total
    freeIn[0] = [];
    freeIn[1] = [];
    const group = mkGroupWithLayout({
      showtimeId,
      rows,
      columns,
      seatKinds,
      freeIn,
      groupHits: [{ row: 0, startCol: 1, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
    const onHandoff = vi.fn();
    const entry = mkEntry({ showtimeId, rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: [showtimeId],
    });
    // Freshness reads unconditionally now — no toggle needed to reveal it.
    let str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Available · checked");
    expect(str).toContain("ago");
    expect(str).not.toContain("ago ago");
    expect(str).toContain("Go to AMC");
    expect(str).not.toMatch(/\$/);
    // Auditorium number and free/total seat count were removed along with the toggle.
    expect(str).not.toContain("Auditorium 1");
    expect(str).not.toContain("seats still free");
    // There is no click-to-expand affordance left on the row.
    expect(
      renderer.root.findAllByProps({ testID: `showtime-row-pressable-${showtimeId}` }).length,
    ).toBe(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: "Expand details" }).length).toBe(0);
    // Go to AMC remains the only clickable control.
    const holdThese = renderer.root.findAllByProps({ accessibilityLabel: "Go to AMC" });
    expect(holdThese.length).toBeGreaterThanOrEqual(1);
    const onPressHoldThese = holdThese[0]!.props.onPress as () => void;
    act(() => {
      onPressHoldThese();
    });
    expect(onHandoff).toHaveBeenCalledWith(showtimeId);
    str = JSON.stringify(renderer.toJSON());
    expect(str).not.toContain("seats still free");
  });

  it("TOP PICK badge renders only when isTopPick true (UI17.8)", () => {
    const showtimeId = "sh_top";
    const group = mkGroupWithLayout({
      showtimeId,
      rows: 2,
      columns: 4,
      seatKinds: Array.from({ length: 8 }, () => SEAT),
      freeIn: Array.from({ length: 8 }, () => 0).map(() => [0]),
      groupHits: [{ row: 0, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
    const entry = mkEntry({ showtimeId, rank: 0, admitted: true, resolved: true });
    const without = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      isTopPick: false,
    });
    expect(JSON.stringify(without.toJSON())).not.toContain("TOP PICK");
    const withPick = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      isTopPick: true,
    });
    expect(JSON.stringify(withPick.toJSON())).toContain("TOP PICK");
  });

  it("priced hit renders priceLabel badge, even when handoff is ineligible (S59)", () => {
    const showtimeId = "sh_priced";
    const minPrice = { amount: 16.99, currency: "USD", basis: "TICKET_ONLY" as const };
    const group = mkGroupWithLayout({
      showtimeId,
      rows: 2,
      columns: 2,
      seatKinds: [SEAT, SEAT, SEAT, SEAT],
      freeIn: [[0], [0], [0], [0]],
      groupHits: [{ row: 0, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      minPrice,
    });
    const entry = mkEntry({ showtimeId, rank: 0, admitted: true, resolved: true });
    // No onHandoff / handoffEligible: the badge must not depend on handoff gating.
    const renderer = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      isTopPick: true,
    });
    const str = JSON.stringify(renderer.toJSON());
    // "$16.99" derived independently from the fixture amount above (en-US USD).
    expect(str).toContain("$16.99");
    expect(str).toContain(priceLabel(minPrice));
    // Legacy ad-hoc suffix ("$16.99 ea") must be gone.
    expect(str).not.toContain(" ea");
  });

  it("unpriced hit renders Price unavailable fallback and no Save Search (S59)", () => {
    const showtimeId = "sh_noprice";
    const group = mkGroupWithLayout({
      showtimeId,
      rows: 2,
      columns: 2,
      seatKinds: [SEAT, SEAT, SEAT, SEAT],
      freeIn: [[0], [0], [0], [0]],
      groupHits: [{ row: 0, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      minPrice: null,
    });
    const entry = mkEntry({ showtimeId, rank: 0, admitted: true, resolved: true });
    const renderer = renderRow({
      entry,
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [showtimeId],
      isTopPick: true,
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Price unavailable");
    expect(str).not.toMatch(/\$\d/);
    expect(str.toLowerCase()).not.toContain("save search");
  });
});

describe("ShowtimeRow party-size dimming + retained provenance (UI31 / ADR 0064)", () => {
  const HANDOFF_HINT = "Confirms seat availability and opens showtime on AMC";

  function rowStyleObjects(
    renderer: TestRenderer.ReactTestRenderer,
    showtimeId: string,
  ): Record<string, unknown>[] {
    const node = renderer.root.findByProps({ testID: `showtime-row-${showtimeId}` });
    const style = node.props.style as unknown;
    const flat = (Array.isArray(style) ? style : [style]).flat(Infinity);
    return flat.filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null);
  }

  function mkNarrowHit(
    showtimeId: string,
    freeIn: number[][],
  ): ReturnType<typeof mkGroupWithLayout> {
    return mkGroupWithLayout({
      showtimeId,
      rows: 1,
      columns: 2,
      seatKinds: [SEAT, SEAT],
      freeIn,
      groupHits: [{ row: 0, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
    });
  }

  it("dims a resolved hit whose free seats no longer fit the party, and leaves a fitting hit undimmed", () => {
    const tightId = "sh_tight";
    const tight = renderRow({
      entry: mkEntry({ showtimeId: tightId, rank: 0, admitted: true, resolved: true }),
      groups: [mkNarrowHit(tightId, [[0], []])],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [tightId],
    });
    // Sanity: this really is a hit row (not a miss borrowing missCard's opacity).
    expect(JSON.stringify(tight.toJSON())).toContain("Go to AMC");
    expect(
      rowStyleObjects(tight, tightId).some((s) => (s as { opacity?: number }).opacity === 0.5),
    ).toBe(true);
    tight.unmount();

    const roomyId = "sh_roomy";
    const roomy = renderRow({
      entry: mkEntry({ showtimeId: roomyId, rank: 0, admitted: true, resolved: true }),
      groups: [mkNarrowHit(roomyId, [[0], [0]])],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [roomyId],
    });
    expect(
      rowStyleObjects(roomy, roomyId).some((s) => (s as { opacity?: number }).opacity === 0.5),
    ).toBe(false);
    roomy.unmount();
  });

  it("miss rows keep the miss treatment instead of the party-size dimming", () => {
    const showtimeId = "sh_miss_tight";
    const renderer = renderRow({
      entry: mkEntry({ showtimeId, rank: 1, admitted: true, resolved: true }),
      // No groupHits: a resolved row with nowhere for 2 together — a miss even
      // though zero seats are free.
      groups: [
        mkGroupWithLayout({
          showtimeId,
          rows: 1,
          columns: 2,
          seatKinds: [SEAT, SEAT],
          freeIn: [[], []],
          groupHits: [],
        }),
      ],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [],
    });
    const styles = rowStyleObjects(renderer, showtimeId);
    // Miss keeps its own card treatment; the hit-only dimming must not stack.
    expect(styles.some((s) => (s as { opacity?: number }).opacity === 0.52)).toBe(true);
    expect(styles.some((s) => (s as { opacity?: number }).opacity === 0.5)).toBe(false);
    renderer.unmount();
  });

  it("retained hit row renders a disabled Updating CTA and no handoff control", () => {
    const showtimeId = "sh_retained";
    const onHandoff = vi.fn();
    const renderer = renderRow({
      entry: mkEntry({ showtimeId, rank: 0, admitted: true, resolved: true }),
      groups: [mkNarrowHit(showtimeId, [[0], [0]])],
      partySize: 2,
      resolvedCount: 1,
      onHandoff,
      handoffEligible: [showtimeId],
      provenance: "RETAINED_DISPLAY_ONLY",
    });
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Updating…");
    // The provenance gate blocks the live handoff CTA even though the row is a
    // hit, has a handler, and is in the eligible list.
    expect(renderer.root.findAllByProps({ accessibilityHint: HANDOFF_HINT })).toHaveLength(0);
    const updating = renderer.root.findAllByProps({ accessibilityLabel: "Updating…" });
    expect(updating.length).toBeGreaterThanOrEqual(1);
    expect(
      (updating[0]?.props.accessibilityState as { disabled?: boolean } | undefined)?.disabled,
    ).toBe(true);
    expect(onHandoff).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

describe("ShowtimeRow freshness tiers (UI32 / ADR 0065)", () => {
  function mkFreshHit(showtimeId: string, capturedAt?: string): ResultGroup {
    return mkGroupWithLayout({
      showtimeId,
      rows: 1,
      columns: 2,
      seatKinds: [SEAT, SEAT],
      freeIn: [[0], [0]],
      groupHits: [{ row: 0, startCol: 0, rowSpan: 1, runScore: 0, showtimeIndices: [0] }],
      capturedAt,
    });
  }

  function renderHit(showtimeId: string, group: ResultGroup) {
    return renderRow({
      entry: mkEntry({ showtimeId, rank: 0, admitted: true, resolved: true }),
      groups: [group],
      partySize: 2,
      resolvedCount: 1,
      onHandoff: vi.fn(),
      handoffEligible: [showtimeId],
    });
  }

  /** Collect every `color` value in the flattened style of nodes with this testID. */
  function styleColors(renderer: TestRenderer.ReactTestRenderer, testID: string): unknown[] {
    const found: unknown[] = [];
    const flatten = (style: unknown): void => {
      if (Array.isArray(style)) {
        style.forEach(flatten);
        return;
      }
      if (typeof style === "object" && style !== null) {
        const color = (style as { color?: unknown }).color;
        if (color !== undefined) found.push(color);
      }
    };
    for (const node of renderer.root.findAllByProps({ testID })) {
      flatten((node.props as { style?: unknown }).style);
    }
    return found;
  }

  it("stale snapshot (5m old) renders the label with the warning tint", () => {
    const showtimeId = "sh_stale";
    const renderer = renderHit(
      showtimeId,
      mkFreshHit(showtimeId, new Date(Date.now() - 5 * 60 * 1000).toISOString()),
    );
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Available · checked");
    expect(
      renderer.root.findAllByProps({ testID: `freshness-${showtimeId}` }).length,
    ).toBeGreaterThanOrEqual(1);
    // The stale tier swaps the tertiary caption color for the row's amber warning token.
    expect(styleColors(renderer, `freshness-${showtimeId}`)).toContain(colors.amberTagText);
    renderer.unmount();
  });

  it("fresh snapshot (10s old) renders just-now copy without the stale tint", () => {
    const showtimeId = "sh_fresh";
    const renderer = renderHit(
      showtimeId,
      mkFreshHit(showtimeId, new Date(Date.now() - 10 * 1000).toISOString()),
    );
    const str = JSON.stringify(renderer.toJSON());
    expect(str).toContain("Available · checked just now");
    expect(styleColors(renderer, `freshness-${showtimeId}`)).not.toContain(colors.amberTagText);
    renderer.unmount();
  });

  it("hit row with no capturedAt renders no freshness label at all", () => {
    const showtimeId = "sh_nocap";
    const group = mkFreshHit(showtimeId);
    delete (group.showtimes[0] as unknown as { capturedAt?: string }).capturedAt;
    const renderer = renderHit(showtimeId, group);
    expect(renderer.root.findAllByProps({ testID: `freshness-${showtimeId}` })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Available · checked");
    renderer.unmount();
  });

  it("plain resolved hit row renders no refresh/recheck button outside the handoff CTA", () => {
    const showtimeId = "sh_norefresh";
    const renderer = renderHit(showtimeId, mkFreshHit(showtimeId));
    const str = JSON.stringify(renderer.toJSON());
    expect(str).not.toMatch(/refresh seats|check again/i);
    // No recheck spinner/progress affordance on a plain hit row.
    expect(
      renderer.root.findAllByProps({ testID: `rechecking-collapsed-${showtimeId}` }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: `recheck-spinner-collapsed-${showtimeId}` }),
    ).toHaveLength(0);
    // "Go to AMC" remains the only action control.
    const ctas = renderer.root.findAllByProps({ accessibilityLabel: "Go to AMC" });
    expect(ctas.length).toBeGreaterThanOrEqual(1);
    renderer.unmount();
  });
});

describe("shared distanceLabel helper (UI25.2 regression guard)", () => {
  it("produces the same strings ShowtimeRow's inline copy always rendered", () => {
    // Hand-derived: 1.8 km × 0.621371 = 1.118… → "1.1 mi" (matches the UI17.1 row test above).
    expect(distanceLabel(1.8)).toBe("1.1 mi");
    expect(distanceLabel(0)).toBe("0.0 mi");
    expect(distanceLabel(10)).toBe("6.2 mi");
    expect(distanceLabel(null)).toBeNull();
    expect(distanceLabel(NaN)).toBeNull();
    expect(distanceLabel(Infinity)).toBeNull();
  });
});

describe("ShowtimeRow screening attribute badges (S62.10 / ADR 0067)", () => {
  let attrCase = 0;
  function renderWithAttributes(attributes: string[]): string {
    attrCase += 1;
    const entry = mkEntry({ showtimeId: `sh_attr_${attrCase}`, attributes });
    const renderer = renderRow({
      entry,
      groups: [],
      partySize: 2,
      resolvedCount: 0,
    });
    return JSON.stringify(renderer.toJSON());
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("renders a Recliners badge for recliner-family codes, deduped", () => {
    expect(renderWithAttributes(["reclinerseating"])).toContain("Recliners");
    expect(renderWithAttributes(["plushrecliners"])).toContain("Recliners");
    const both = renderWithAttributes(["reclinerseating", "plushrecliners"]);
    expect(countOccurrences(both, "Recliners")).toBe(1);
  });

  it("renders Heated Recliners with precedence over plain Recliners", () => {
    const heated = renderWithAttributes(["heatedseats"]);
    expect(heated).toContain("Heated Recliners");
    const combined = renderWithAttributes(["heatedseats", "reclinerseating"]);
    expect(combined).toContain("Heated Recliners");
    // Exactly one Recliners occurrence — the heated one, never both tags.
    expect(countOccurrences(combined, "Recliners")).toBe(1);
  });

  it("renders an Open Caption badge for opencaption", () => {
    expect(renderWithAttributes(["opencaption"])).toContain("Open Caption");
  });

  it("renders nothing extra for unknown codes or the entry's own format code", () => {
    expect(renderWithAttributes(["reservedseating"])).not.toContain("Reserved Seating");
    expect(renderWithAttributes(["somefuturecode"])).not.toContain("somefuturecode");
    // The format's own code in attributes never becomes a generic tag — the
    // raw uppercase code appears nowhere (the subtitle renders "Standard").
    expect(renderWithAttributes(["STANDARD"])).not.toContain("STANDARD");
    expect(renderWithAttributes([])).not.toContain("Recliners");
    expect(renderWithAttributes([])).not.toContain("Open Caption");
  });
});
