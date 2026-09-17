/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/require-await */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, create } from "react-test-renderer";
import React from "react";
import type { DateScope } from "@seatfirst/core";

// Mock trpcClient before importing hook
const mockQuery = vi.fn(async (..._args: unknown[]) => ({
  counts: [
    { kind: "MOVIE" as const, candidate: "m1", count: 5, coldTheatreCount: 0 },
    { kind: "MOVIE" as const, candidate: "m2", count: 0, coldTheatreCount: 0 },
  ],
}));
vi.mock("@/lib/trpc", () => ({
  trpcClient: {
    searches: {
      facetCounts: {
        query: (...args: unknown[]) => mockQuery(...args),
      },
    },
  },
  trpc: {
    theatres: {
      search: {
        useQuery: vi.fn(() => ({ data: { theatres: [] }, isFetching: false, error: null })),
      },
      movies: { useQuery: vi.fn(() => ({ data: null, isFetching: false, error: null })) },
    },
    searches: { facetCounts: { useQuery: vi.fn() } },
  },
  queryClient: { clear: vi.fn() },
}));

import { useFacetCounts } from "./useFacetCounts";
import { useSeatfirstStore } from "@/store/seatfirstStore";

function TestHarness(props: { theatreIds: string[]; movieIds: string[] }) {
  const { theatreIds, movieIds } = props;
  const result = useFacetCounts(
    theatreIds.length > 0 && movieIds.length > 0
      ? {
          theatreIds,
          axes: [{ kind: "MOVIE", candidates: movieIds }],
        }
      : null,
  );
  return React.createElement("div", {
    "data-testid": "counts",
    "data-counts": JSON.stringify(Array.from(result.countsMap.entries())),
  });
}

describe("useFacetCounts — debounce & coalesce (UI18.6 rate ≤120/min)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQuery.mockClear();
    useSeatfirstStore.setState({ bootstrapReady: true } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("debounces 300ms — burst 10 rapid changes in 500ms coalesces to ≤2 calls", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(TestHarness, { theatreIds: ["t1"], movieIds: ["m1"] }));
    });
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        renderer!.update(
          React.createElement(TestHarness, { theatreIds: ["t1"], movieIds: [`m${i}`] }),
        );
      });
      vi.advanceTimersByTime(50);
    }
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(mockQuery.mock.calls.length).toBeLessThanOrEqual(10);
    expect(mockQuery.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("burst 10 interactions in 5s → ≤10 calls, not 120", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(
        React.createElement(TestHarness, { theatreIds: ["t1", "t2"], movieIds: ["m1"] }),
      );
    });
    mockQuery.mockClear();
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        renderer!.update(
          React.createElement(TestHarness, { theatreIds: ["t1", "t2"], movieIds: [`m${i}`] }),
        );
      });
      vi.advanceTimersByTime(500);
      await act(async () => {
        vi.advanceTimersByTime(300);
        await Promise.resolve();
      });
    }
    expect(mockQuery.mock.calls.length).toBeLessThanOrEqual(10);
    expect(mockQuery.mock.calls.length).toBeLessThan(120);
  });

  it("coalesces identical input — duplicate rapid calls reuse pending", async () => {
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(TestHarness, { theatreIds: ["t1"], movieIds: ["m1"] }));
    });
    mockQuery.mockClear();
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        renderer!.update(
          React.createElement(TestHarness, { theatreIds: ["t1"], movieIds: ["m1"] }),
        );
      });
      vi.advanceTimersByTime(10);
    }
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(mockQuery.mock.calls.length).toBe(1);
  });

  it("refreshes theatre-scoped counts and ignores a late response from the prior theatre", async () => {
    let resolveFirstQuery!: (value: {
      counts: Array<{
        kind: "MOVIE";
        candidate: string;
        count: number;
        coldTheatreCount: number;
      }>;
    }) => void;
    mockQuery
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstQuery = resolve;
          }),
      )
      .mockResolvedValueOnce({
        counts: [{ kind: "MOVIE" as const, candidate: "m1", count: 12, coldTheatreCount: 0 }],
      });

    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(TestHarness, { theatreIds: ["A"], movieIds: ["m1"] }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(mockQuery).toHaveBeenLastCalledWith(expect.objectContaining({ theatreIds: ["A"] }));

    await act(async () => {
      renderer!.update(React.createElement(TestHarness, { theatreIds: ["B"], movieIds: ["m1"] }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(mockQuery).toHaveBeenLastCalledWith(expect.objectContaining({ theatreIds: ["B"] }));
    expect(renderer!.root.findByProps({ "data-testid": "counts" }).props["data-counts"]).toContain(
      '"count":12',
    );

    await act(async () => {
      resolveFirstQuery({
        counts: [{ kind: "MOVIE", candidate: "m1", count: 5, coldTheatreCount: 0 }],
      });
      await Promise.resolve();
    });
    expect(renderer!.root.findByProps({ "data-testid": "counts" }).props["data-counts"]).toContain(
      '"count":12',
    );
  });

  it("re-queries immediately when dev transport changes without waiting for input change", async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    const { setDevTransportHandler } = await import("@/lib/devTransport");

    await act(async () => {
      create(React.createElement(TestHarness, { theatreIds: ["A"], movieIds: ["m1"] }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);

    await act(async () => {
      setDevTransportHandler(() => null);
    });
    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    setDevTransportHandler(null);
  });
});

describe("useFacetCounts — date-scope-only change refires (UI24.6)", () => {
  function DateScopeHarness(props: { scope: DateScope }) {
    const result = useFacetCounts({
      theatreIds: ["t1"],
      dateScope: props.scope,
      axes: [{ kind: "MOVIE", candidates: ["m1"] }],
    });
    return React.createElement("div", {
      "data-testid": "counts",
      "data-counts": JSON.stringify(Array.from(result.countsMap.entries())),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockQuery.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("a date-scope-only change issues a new debounced count request with the exact scope", async () => {
    const scopeA: DateScope = {
      kind: "DATE_RANGE",
      from: "2026-09-04",
      to: "2026-09-06",
    };
    const scopeB: DateScope = {
      kind: "OR",
      of: [
        { kind: "DATE_RANGE", from: "2026-09-04", to: "2026-09-04" },
        { kind: "DATE_RANGE", from: "2026-09-08", to: "2026-09-08" },
      ],
    };
    let renderer: ReturnType<typeof create> | null = null;
    await act(async () => {
      renderer = create(React.createElement(DateScopeHarness, { scope: scopeA }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    const initialCalls = mockQuery.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);
    expect(mockQuery).toHaveBeenLastCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ base: expect.objectContaining({ dateScope: scopeA }) }),
    );

    // Change ONLY the date scope — same theatres, same axes.
    await act(async () => {
      renderer!.update(React.createElement(DateScopeHarness, { scope: scopeB }));
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(mockQuery.mock.calls.length).toBe(initialCalls + 1);
    expect(mockQuery).toHaveBeenLastCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ base: expect.objectContaining({ dateScope: scopeB }) }),
    );
    // No weekday fallback is ever sent.
    for (const call of mockQuery.mock.calls) {
      const input = call[0] as { base: Record<string, unknown> } & Record<string, unknown>;
      expect(input).not.toHaveProperty("days");
      expect(input.base).not.toHaveProperty("weekdays");
    }
  });
});
