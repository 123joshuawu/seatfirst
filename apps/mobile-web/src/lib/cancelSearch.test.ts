import { describe, expect, it, vi, beforeEach } from "vitest";
import { useSeatfirstStore } from "@/store/seatfirstStore";
import { searchInitialState } from "@/store/searchSlice";
import { bootstrapInitialState } from "@/store/bootstrapSlice";
import { flowInitialState } from "@/store/flowSlice";
import { searchFormInitialState } from "@/store/searchFormSlice";

const mockCancelSearch = vi.fn<(...args: unknown[]) => unknown>();
const mockGetSearchStatus = vi.fn<(...args: unknown[]) => unknown>();
let mockStopFn: (() => void) | null = null;

vi.mock("@/api/search", () => ({
  cancelSearch: (...args: unknown[]) => mockCancelSearch(...args),
  getSearchStatus: (...args: unknown[]) => mockGetSearchStatus(...args),
  createSearch: vi.fn(),
  getSearch: vi.fn(),
}));

vi.mock("@/lib/searchSubscriptionController", () => ({
  setStopSubscription: vi.fn(),
  getStopSubscription: () => mockStopFn,
}));

// Must import after mocks
import { cancelCurrentSearch } from "./cancelSearch";

function resetStore(): void {
  useSeatfirstStore.setState({
    ...searchFormInitialState,
    ...flowInitialState,
    ...bootstrapInitialState,
    ...searchInitialState,
  });
}

describe("UI5.4-5 cancelCurrentSearch orchestration", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockGetSearchStatus.mockReset();
    mockStopFn = null;
  });

  it("calls searches.cancel with current searchId", async () => {
    useSeatfirstStore.getState().setSearchId("srch_test123", "RUNNING");
    mockCancelSearch.mockResolvedValue({ searchId: "srch_test123", status: "CANCELLED" });
    mockStopFn = vi.fn();
    const res = await cancelCurrentSearch();
    expect(mockCancelSearch).toHaveBeenCalledWith("srch_test123");
    expect(res.status).toBe("CANCELLED");
  });

  it("sends current searchId not stale closure", async () => {
    useSeatfirstStore.getState().setSearchId("srch_old", "RUNNING");
    useSeatfirstStore.getState().setSearchId("srch_new", "RUNNING");
    mockCancelSearch.mockResolvedValue({ searchId: "srch_new", status: "CANCELLED" });
    await cancelCurrentSearch();
    expect(mockCancelSearch).toHaveBeenCalledWith("srch_new");
  });

  it("idempotent echo COMPLETE is success and unlocks", async () => {
    useSeatfirstStore.getState().setSearchId("srch_1", "RUNNING");
    mockCancelSearch.mockResolvedValue({ searchId: "srch_1", status: "COMPLETE" });
    const res = await cancelCurrentSearch();
    expect(res.status).toBe("COMPLETE");
    expect(useSeatfirstStore.getState().status).toBe("COMPLETE");
    expect(useSeatfirstStore.getState().isCanceling).toBe(false);
    expect(useSeatfirstStore.getState().cancelError).toBeNull();
  });

  it("successful live cancel unlocks + calls stopSubscription", async () => {
    useSeatfirstStore.getState().setSearchId("srch_1", "RUNNING");
    mockCancelSearch.mockResolvedValue({ searchId: "srch_1", status: "CANCELLED" });
    const stopSpy = vi.fn();
    mockStopFn = stopSpy;
    await cancelCurrentSearch();
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(useSeatfirstStore.getState().status).toBe("CANCELLED");
    expect(useSeatfirstStore.getState().isCanceling).toBe(false);
  });

  it("second press while isCanceling is ignored (in-flight guard)", async () => {
    useSeatfirstStore.getState().setSearchId("srch_1", "RUNNING");
    let resolve: (v: unknown) => void = () => {};
    mockCancelSearch.mockImplementation(() => new Promise((r) => (resolve = r)));
    const p1 = cancelCurrentSearch();
    // second call while first is pending should reject with "Cancel already in progress"
    await expect(cancelCurrentSearch()).rejects.toThrow("Cancel already in progress");
    expect(mockCancelSearch).toHaveBeenCalledTimes(1);
    // resolve first
    resolve({ searchId: "srch_1", status: "CANCELLED" });
    await p1;
  });

  it("failure keeps lock, surfaces retryable error, re-enables", async () => {
    useSeatfirstStore.getState().setSearchId("srch_1", "RUNNING");
    mockCancelSearch.mockRejectedValue(new Error("Network error"));
    mockGetSearchStatus.mockResolvedValue({ searchId: "srch_1", status: "RUNNING" });
    await expect(cancelCurrentSearch()).rejects.toThrow("Network error");
    expect(useSeatfirstStore.getState().status).toBe("RUNNING");
    expect(useSeatfirstStore.getState().isCanceling).toBe(false);
    const err = useSeatfirstStore.getState().cancelError;
    expect(err).not.toBeNull();
    expect(err!.toLowerCase()).toContain("cancel");
    // retry with success unlocks
    mockCancelSearch.mockResolvedValue({ searchId: "srch_1", status: "CANCELLED" });
    await cancelCurrentSearch();
    expect(useSeatfirstStore.getState().status).toBe("CANCELLED");
    expect(useSeatfirstStore.getState().cancelError).toBeNull();
  });

  it("timeout where probe reveals committed cancel is treated as success", async () => {
    useSeatfirstStore.getState().setSearchId("srch_1", "RUNNING");
    mockCancelSearch.mockRejectedValue(new Error("timeout"));
    mockGetSearchStatus.mockResolvedValue({ searchId: "srch_1", status: "CANCELLED" });
    const stopSpy = vi.fn();
    mockStopFn = stopSpy;
    const res = await cancelCurrentSearch();
    expect(res.status).toBe("CANCELLED");
    expect(useSeatfirstStore.getState().status).toBe("CANCELLED");
    expect(useSeatfirstStore.getState().isCanceling).toBe(false);
    expect(useSeatfirstStore.getState().cancelError).toBeNull();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("probe failure re-throws the original cancel error for retry", async () => {
    useSeatfirstStore.getState().setSearchId("srch_1", "RUNNING");
    mockCancelSearch.mockRejectedValue(new Error("timeout"));
    mockGetSearchStatus.mockRejectedValue(new Error("probe failed"));
    const err = await cancelCurrentSearch().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("timeout");
    expect((err as Error).message).not.toContain("probe failed");
    expect(useSeatfirstStore.getState().status).toBe("RUNNING");
    expect(useSeatfirstStore.getState().isCanceling).toBe(false);
    expect(useSeatfirstStore.getState().cancelError).not.toBeNull();
  });

  it("rejects when no active searchId", async () => {
    resetStore();
    await expect(cancelCurrentSearch()).rejects.toThrow("No active search");
  });
});
