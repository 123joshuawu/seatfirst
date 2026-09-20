import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { searchInitialState } from "@/store/searchSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";
import { layoutInitialState } from "@/store/layoutSlice";
import { recheckInitialState } from "@/store/recheckSlice";

/**
 * Regression for ADR 0047 / UI19: subscription lifecycle owner must survive
 * form/view-model unmount during create → reconcile → terminal COMPLETE.
 *
 * Failure mode under the old form-owned design: the view model creates its own
 * `useSearchSubscription` instance; routing away from `search` to `checking`
 * unmounts that owner before `create`/`get` complete, so `mountedRef` aborts
 * the state transition and the UI stays on `checking` even though the server
 * reached COMPLETE. With a single persistent owner at `app/index.tsx` the
 * form may unmount but the subscription owner remains mounted and delivers the
 * terminal transition to `result`.
 */

// Split create / get / subscribe so we can interleave unmount.

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let createDef: ReturnType<typeof makeDeferred<unknown>> | null = null;
const mockCreateMutate = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetQuery = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const mockSubscribe = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("@/lib/trpc", () => {
  const api = {
    searches: {
      create: { mutate: (...a: unknown[]) => mockCreateMutate(...a) },
      get: { query: (...a: unknown[]) => mockGetQuery(...a) },
      cancel: { mutate: vi.fn() },
      onProgress: { subscribe: (...a: unknown[]) => mockSubscribe(...a) },
    },
    session: { bootstrap: { mutate: vi.fn() } },
    theatres: { search: { query: vi.fn() }, movies: { query: vi.fn() } },
    showtimes: { recheck: { mutate: vi.fn() } },
  };
  return {
    trpc: api,
    trpcClient: api,
    getTrpcUrl: () => "http://localhost:3000/trpc",
    queryClient: { clear: vi.fn() },
  };
});

vi.mock("@/lib/polling", () => ({
  startPolling: vi.fn(() => () => {}),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  useWindowDimensions: () => ({ width: 800, height: 600 }),
}));

import { useSearchSubscription } from "@/hooks/useSearchSubscription";

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
    ...layoutInitialState,
    ...recheckInitialState,
  });
}

function fakeSpec(): unknown {
  return {
    specVersion: 1,
    providerId: "amc",
    theatres: { kind: "LIST", refs: [{ id: "amc:theatre:832" }] },
    where: { kind: "MOVIE", ids: ["amc:movie:1"] },
    aggregation: { reduce: "COUNT", threshold: { kind: "NONE" } },
  };
}

function renderHook<T>(hook: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as unknown as T };
  function HookComp(): React.JSX.Element | null {
    result.current = hook();
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(HookComp));
  });
  return { result, unmount: () => renderer.unmount() };
}

describe("persistent subscription owner — form unmount during create", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    createDef = makeDeferred<unknown>();
    mockCreateMutate.mockReturnValue(createDef.promise);
    // get-before-subscribe reconciliation returns terminal COMPLETE — no SSE needed
    mockGetQuery.mockResolvedValue({
      searchId: "srch_persist_1",
      status: "COMPLETE",
      resolved: 4,
      total: 4,
      groups: [{ showtimes: [{ showtimeId: "amc:showtime:1", resolved: true }] }],
      answer: { mode: "CONFIDENT" },
    });
    mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  });

  it("form owner unmounts after submit begins while persistent owner remains → store reaches COMPLETE/result", async () => {
    // Persistent owner: simulates app/index.tsx owning the lifecycle.
    const persistent = renderHook(() => useSearchSubscription());
    expect(typeof persistent.result.current.startSearch).toBe("function");

    // Form owner: simulates the view-model/requestor that will unmount during routing.
    // It does NOT own a subscription; it receives the persistent callback via injection
    // (ADR 0047 — component-owned VMs with an injected action callback, not a VM prop).
    const injectedStartSearch: (spec: unknown, continuesSearchId?: string) => Promise<void> =
      persistent.result.current.startSearch as unknown as (
        spec: unknown,
        continuesSearchId?: string,
      ) => Promise<void>;

    // Simulate wrappedStartSearch's create-direct call, but inject the
    // persistent startSearch instead of a form-owned one. The create promise is
    // held so we can unmount the form before it resolves.
    const spec = fakeSpec();
    let formTriggerDone: Promise<void> | null = null;

    function FormHost(): React.JSX.Element | null {
      // No subscription hook here — only the injected callback, per UI19.
      return null;
    }

    // Render a form-like host so we have something to unmount; its trigger uses the
    // injected persistent callback. In production this is useSubmitSearchViewModel's
    // wrappedStartSearch calling startRealSearch(spec) directly (ADR 0054).
    let formRenderer: TestRenderer.ReactTestRenderer;
    let triggerStart: () => void = () => {};
    const FormCapture = () => {
      triggerStart = () => {
        // Delegate to persistent owner — do not await synchronously
        // so unmount can interleave.
        formTriggerDone = (async () => {
          await injectedStartSearch(spec);
        })();
      };
      return React.createElement(FormHost);
    };
    act(() => {
      formRenderer = TestRenderer.create(React.createElement(FormCapture));
    });

    // Kick off submit — this enters create (pending) and would, in the real view
    // model, also run prepareSubmit + collapse the form (causing the form tree to
    // unmount in the next route render once setSearchId flips the screen). We keep
    // the persistent owner mounted while unmounting the form host before create
    // resolves.
    act(() => {
      triggerStart();
    });

    // While create is still pending, unmount the form/requestor.
    // Under the old form-owned design this also unmounted the subscription and
    // mountedRef would abort create's follow-up (no searchId / no terminal).
    act(() => {
      formRenderer.unmount();
    });

    // Complete create — started before unmount but its continuation runs on the
    // persistent owner's mountedRef.
    await act(async () => {
      // Let the injected startSearch's createSearch get scheduled
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      createDef!.resolve({
        searchId: "srch_persist_1",
        status: "RUNNING",
        scheduleSkeleton: [],
      });
      await createDef!.promise;
      // reconcileAndSubscribe does get → terminal, then skips opening SSE
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      if (formTriggerDone) await formTriggerDone;
      // Flush microtasks for getSearch().then(handleTerminal) chain
      await Promise.resolve();
      await Promise.resolve();
    });

    // Additional tick for setSearchTerminal's optional get re-read (COMPLETE already has groups)
    await act(async () => {
      await Promise.resolve();
    });

    const state = useSeatfirstStore.getState();
    expect(state.searchId).toBe("srch_persist_1");
    expect(state.status).toBe("COMPLETE");
    expect(state.phase).toBe("terminal");
    expect(state.screen).toBe("result");

    // Cleanup
    persistent.unmount();
  });

  it("injected startSearch preserves continuation search ID forwarding", async () => {
    const persistent = renderHook(() => useSearchSubscription());
    // Reset mocks to observe continuesSearchId threading
    let capturedContinuesId: unknown = undefined;
    // eslint-disable-next-line @typescript-eslint/require-await
    mockCreateMutate.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as Record<string, unknown>;
      capturedContinuesId = input.continuesSearchId;
      return { searchId: "srch_cont_1", status: "RUNNING", scheduleSkeleton: [] };
    });
    mockGetQuery.mockResolvedValue({
      searchId: "srch_cont_1",
      status: "RUNNING",
      resolved: 1,
      total: 10,
      groups: [],
      answer: null,
    });
    // Let openSubscription succeed without terminal
    mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });

    const spec = fakeSpec();
    // Genuine BATCH_DEFERRED continuation state, as checkMore in
    // useSearchResultsViewModel.ts observes before threading the hint (UI31
    // fix: startSearch only forwards continuesSearchId in that state).
    useSeatfirstStore.setState({
      serverCoverageSpec: spec as never,
      terminalCause: "BATCH_DEFERRED",
    });
    await act(async () => {
      await persistent.result.current.startSearch(spec as never, "srch_prev_999");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(capturedContinuesId).toBe("srch_prev_999");
    expect(mockCreateMutate).toHaveBeenCalledTimes(1);
    persistent.unmount();
  });
});
