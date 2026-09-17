import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SearchSpec } from "@seatfirst/core";

const mockMutateCreate = vi.fn<(...args: unknown[]) => unknown>();
const mockQueryGet = vi.fn<(...args: unknown[]) => unknown>();
const mockMutateCancel = vi.fn<(...args: unknown[]) => unknown>();
vi.mock("@/lib/trpc", () => {
  // UI11: the vanilla client export is now named `trpcClient`; both keys share one mock.
  const api = {
    searches: {
      create: { mutate: (...args: unknown[]) => mockMutateCreate(...args) },
      get: { query: (...args: unknown[]) => mockQueryGet(...args) },
      cancel: { mutate: (...args: unknown[]) => mockMutateCancel(...args) },
      onProgress: { subscribe: vi.fn() },
    },
  };
  return {
    trpc: api,
    trpcClient: api,
    getTrpcUrl: () => "http://localhost:3000/trpc",
    queryClient: { clear: vi.fn() },
  };
});

import { createSearch, getSearch, cancelSearch } from "./search";

describe("api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("createSearch calls trpc.searches.create.mutate with spec and idempotencyKey", async () => {
    const spec = { specVersion: 1, providerId: "amc" } as unknown as SearchSpec; // minimal stub for transport test; only spec/idempotencyKey wiring is under test
    mockMutateCreate.mockResolvedValue({ searchId: "srch_1", status: "PENDING_SCHEDULE" });
    const res = await createSearch(spec, "key-123");
    expect(mockMutateCreate).toHaveBeenCalledWith({ spec, idempotencyKey: "key-123" });
    expect(mockMutateCreate).toHaveBeenCalledTimes(1);
    expect(res.searchId).toBe("srch_1");
  });

  it("createSearch discriminates PENDING_SCHEDULE vs RUNNING", async () => {
    const spec = {} as unknown as SearchSpec; // stub: status discrimination doesn't depend on spec content
    mockMutateCreate.mockResolvedValue({
      searchId: "srch_2",
      status: "RUNNING",
      showtimeCount: 5,
      cachedCount: 2,
      estimatedMs: 1000,
      groups: [],
    });
    const res = await createSearch(spec, "k");
    expect(res.status).toBe("RUNNING");
  });

  it("getSearch calls trpc.searches.get.query with searchId", async () => {
    mockQueryGet.mockResolvedValue({
      searchId: "srch_1",
      status: "COMPLETE",
      resolved: 10,
      total: 10,
      groups: [],
      answer: null,
    });
    const res = await getSearch("srch_1");
    expect(mockQueryGet).toHaveBeenCalledWith({ searchId: "srch_1" });
    expect((res as { searchId: string }).searchId).toBe("srch_1");
  });

  it("cancelSearch calls trpc.searches.cancel.mutate with searchId", async () => {
    mockMutateCancel.mockResolvedValue({ searchId: "srch_1", status: "CANCELLED" });
    const res = await cancelSearch("srch_1");
    expect(mockMutateCancel).toHaveBeenCalledWith({ searchId: "srch_1" });
    expect(res.status).toBe("CANCELLED");
  });

  it("cancelSearch is idempotent — server echoes terminal status", async () => {
    mockMutateCancel.mockResolvedValue({ searchId: "srch_1", status: "COMPLETE" });
    const res = await cancelSearch("srch_1");
    expect(res.status).toBe("COMPLETE");
  });

  it("surfaces TRPC error codes for idempotency conflict", async () => {
    const err = Object.assign(new Error("conflict"), {
      data: { code: "IDEMPOTENCY_KEY_CONFLICT", searchId: "srch_orig" },
    });
    mockMutateCreate.mockRejectedValue(err);
    await expect(createSearch({} as unknown as SearchSpec, "dup")).rejects.toThrow("conflict"); // stub spec, error path doesn't depend on spec content
  });
});
