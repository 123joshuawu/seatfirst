// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { DEFAULT_SEARCH_LIMITS } from "@seatfirst/core";
import { useSeatfirstStore } from "@/store/seatfirstStore";

const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn((input: unknown, opts: unknown) => ({
    data: { theatres: [] },
    isFetching: false,
    error: null,
    _input: input,
    _opts: opts,
  })),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    theatres: {
      search: { useQuery: (...args: unknown[]) => mockUseQuery(...args) },
    },
  },
  queryClient: { clear: vi.fn() },
  trpcClient: {},
  getTrpcUrl: () => "http://localhost:3000/trpc",
}));

import { useTheatreSearch } from "./useTheatreSearch";

function HookProbe(props: Parameters<typeof useTheatreSearch>[0]) {
  useTheatreSearch(props);
  return null;
}

let activeRenderers: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  mockUseQuery.mockClear();
  useSeatfirstStore.setState({ bootstrapReady: true } as never);
});

afterEach(() => {
  for (const r of activeRenderers) {
    act(() => {
      r.unmount();
    });
  }
  activeRenderers = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  mockUseQuery.mockClear();
  useSeatfirstStore.setState({ bootstrapReady: false } as never);
});

function createProbe(props: Parameters<typeof useTheatreSearch>[0]) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(HookProbe, props));
  });
  activeRenderers.push(renderer);
  return renderer;
}

describe("useTheatreSearch browse-on-focus (UI18.1)", () => {
  it("empty q + browse true enables immediately (no debounce) and sends no q", () => {
    createProbe({ q: "", browse: true });
    expect(mockUseQuery).toHaveBeenCalledTimes(1);
    const [, opts] = mockUseQuery.mock.calls[0] as [
      unknown,
      { enabled: boolean; staleTime: number },
    ];
    expect(opts.enabled).toBe(true);
    expect(opts.staleTime).toBe(30_000);
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.q).toBeUndefined();
  });

  it("empty q + browse false stays disabled (negative: requires browse)", () => {
    createProbe({ q: "", browse: false });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { enabled: boolean }];
    expect(opts.enabled).toBe(false);
  });

  it("empty q + browse true with whitespace q still browses (no q sent) — would FAIL if hook required q length>0", () => {
    createProbe({ q: "   ", browse: true });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { enabled: boolean }];
    expect(opts.enabled).toBe(true);
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.q).toBeUndefined();
  });

  it("non-empty q enables via debounced q (no browse needed)", () => {
    createProbe({ q: "amc" });
    const opts = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1][1] as {
      enabled: boolean;
    };
    expect(opts.enabled).toBe(true);
    const input = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(input.q).toBe("amc");
  });

  it("typing still debounces: debouncedQ lags 250ms", () => {
    vi.useFakeTimers();
    const renderer = createProbe({ q: "a", browse: false });
    mockUseQuery.mockClear();
    act(() => {
      renderer.update(React.createElement(HookProbe, { q: "amc", browse: false }));
    });
    let lastInput = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastInput.q).toBe("a");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    lastInput = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastInput.q).toBe("a");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    lastInput = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(lastInput.q).toBe("amc");
  });

  it("browse empty q fires immediately (no debounce delay) so list populates instantly", () => {
    vi.useFakeTimers();
    const renderer = createProbe({ q: "amc", browse: false });
    mockUseQuery.mockClear();
    act(() => {
      renderer.update(React.createElement(HookProbe, { q: "", browse: true }));
    });
    const [, opts] = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1] as [
      Record<string, unknown>,
      { enabled: boolean },
    ];
    expect(opts.enabled).toBe(true);
    const [input] = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1] as [
      Record<string, unknown>,
      unknown,
    ];
    expect(input.q).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const finalInput = mockUseQuery.mock.calls[mockUseQuery.mock.calls.length - 1][0] as Record<
      string,
      unknown
    >;
    expect(finalInput.q).toBeUndefined();
  });

  it("half-pair lat without lng never fires (enabled false)", () => {
    createProbe({ q: "amc", lat: 41, browse: false });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { enabled: boolean }];
    expect(opts.enabled).toBe(false);
  });

  it("half-pair lng without lat never fires", () => {
    createProbe({ q: "amc", lng: -87 });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { enabled: boolean }];
    expect(opts.enabled).toBe(false);
  });

  it("half-pair with browse still never fires", () => {
    createProbe({ q: "", browse: true, lat: 41 });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { enabled: boolean }];
    expect(opts.enabled).toBe(false);
  });

  it("full lat/lng pair enables and passes lat/lng", () => {
    createProbe({ q: "amc", lat: 41, lng: -87, browse: false });
    const [input, opts] = mockUseQuery.mock.calls[0] as [
      Record<string, unknown>,
      { enabled: boolean },
    ];
    expect(opts.enabled).toBe(true);
    expect(input.lat).toBe(41);
    expect(input.lng).toBe(-87);
  });

  it("radiusKm passed through and clamped to maxAreaRadiusKm", () => {
    createProbe({ q: "", browse: true, lat: 41, lng: -87, radiusKm: 100 });
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.radiusKm).toBe(DEFAULT_SEARCH_LIMITS.maxAreaRadiusKm);
    expect(input.radiusKm).toBe(40);
  });

  it("radiusKm without center is omitted (requires lat/lng)", () => {
    createProbe({ q: "amc", radiusKm: 10 });
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.radiusKm).toBeUndefined();
  });

  it("radiusKm small value passes unchanged", () => {
    createProbe({ q: "", browse: true, lat: 41, lng: -87, radiusKm: 5 });
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.radiusKm).toBe(5);
  });

  it("never forwards local limit because theatres.search rejects unknown input keys", () => {
    createProbe({ q: "amc", limit: DEFAULT_SEARCH_LIMITS.maxTheatres + 1 });
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.limit).toBeUndefined();
  });

  it("omits local limit in browse mode too", () => {
    createProbe({ q: "", browse: true, limit: 1 });
    const [input] = mockUseQuery.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(input.limit).toBeUndefined();
  });

  it("staleTime remains 30s", () => {
    createProbe({ q: "amc" });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { staleTime: number }];
    expect(opts.staleTime).toBe(30_000);
  });

  it("bootstrapReady false disables even with browse", () => {
    useSeatfirstStore.setState({ bootstrapReady: false } as never);
    createProbe({ q: "", browse: true });
    const [, opts] = mockUseQuery.mock.calls[0] as [unknown, { enabled: boolean }];
    expect(opts.enabled).toBe(false);
  });
});
