/**
 * UI13.1 — unit matrix for the shared tRPC-error / SSE-envelope guards.
 * The accepted surface is fixed by what arrives at the former cast sites:
 * real TRPCClientError instances (either envelope placement) and the UI9
 * plain-Error-with-assigned-fields doubles from test/search-race.test.tsx
 * and test/sse-replay.test.tsx, plus garbage inputs reading as absent.
 */
import { describe, expect, it } from "vitest";
import { TRPCClientError } from "@trpc/client";

import {
  isRecord,
  isResultGroups,
  isUnauthorizedError,
  readProgressCount,
  readRankedAnswer,
  readResultGroups,
  readSearchStatus,
  readTrpcErrorCode,
  readTrpcErrorExtras,
} from "./errorEnvelope";

/** Repo convention (see session.test.ts / trpc.retry.test.ts): instance + assigned envelope. */
function makeTrpcClientError(message: string): TRPCClientError<never> {
  return new TRPCClientError(message);
}

describe("readTrpcErrorCode", () => {
  it("reads shape.data.code off a real TRPCClientError", () => {
    const err = makeTrpcClientError("gone");
    Object.assign(err, { shape: { data: { code: "NOT_FOUND" } } });
    expect(readTrpcErrorCode(err)).toBe("NOT_FOUND");
  });

  it("reads data.code off a real TRPCClientError", () => {
    const err = makeTrpcClientError("unauthorized");
    Object.assign(err, { data: { code: "UNAUTHORIZED" } });
    expect(readTrpcErrorCode(err)).toBe("UNAUTHORIZED");
  });

  it("prefers shape over data when both placements carry a code", () => {
    expect(
      readTrpcErrorCode({ shape: { data: { code: "CONFLICT" } }, data: { code: "TIMEOUT" } }),
    ).toBe("CONFLICT");
  });

  it("accepts the search-race double: Error with assigned data envelope", () => {
    const err = Object.assign(new Error("capacity"), {
      data: { code: "ADMISSION_REJECTED", retryAfterSeconds: 30 },
    });
    expect(readTrpcErrorCode(err)).toBe("ADMISSION_REJECTED");
  });

  it("accepts a bare plain-object envelope", () => {
    expect(readTrpcErrorCode({ data: { code: "IDEMPOTENCY_KEY_CONFLICT" } })).toBe(
      "IDEMPOTENCY_KEY_CONFLICT",
    );
  });

  it("returns null for null/undefined/primitive/garbage inputs", () => {
    expect(readTrpcErrorCode(null)).toBeNull();
    expect(readTrpcErrorCode(undefined)).toBeNull();
    expect(readTrpcErrorCode("UNAUTHORIZED")).toBeNull();
    expect(readTrpcErrorCode(42)).toBeNull();
    expect(readTrpcErrorCode(true)).toBeNull();
    expect(readTrpcErrorCode(() => {})).toBeNull();
    expect(readTrpcErrorCode({})).toBeNull();
    expect(readTrpcErrorCode({ data: null })).toBeNull();
    expect(readTrpcErrorCode({ data: { code: 7 } })).toBeNull();
    expect(readTrpcErrorCode({ shape: { data: null } })).toBeNull();
    expect(readTrpcErrorCode({ shape: "nope" })).toBeNull();
  });

  it("passes an empty-string code through unchanged (falsy handling stays at call sites)", () => {
    expect(readTrpcErrorCode({ data: { code: "" } })).toBe("");
  });
});

describe("readTrpcErrorExtras", () => {
  it("reads both extras off the search-race ADMISSION_REJECTED double", () => {
    const err = Object.assign(new Error("capacity"), {
      data: { code: "ADMISSION_REJECTED", searchId: "srch_9", retryAfterSeconds: 30 },
    });
    expect(readTrpcErrorExtras(err)).toEqual({
      searchId: "srch_9",
      retryAfterSeconds: 30,
    });
  });

  it("returns each field only when individually type-correct", () => {
    expect(readTrpcErrorExtras({ data: { searchId: 5 } })).toEqual({});
    expect(readTrpcErrorExtras({ data: { retryAfterSeconds: "30" } })).toEqual({});
    expect(readTrpcErrorExtras({ data: { searchId: "srch_1" } })).toEqual({ searchId: "srch_1" });
    expect(readTrpcErrorExtras({ data: { matchedCount: "237" } })).toEqual({});
    expect(readTrpcErrorExtras({ data: { limit: "200" } })).toEqual({});
  });

  it("reads matchedCount/limit off a CAPACITY_CEILING_EXCEEDED rejection (ADR 0054)", () => {
    const err = Object.assign(new Error("ceiling"), {
      data: {
        code: "CAPACITY_CEILING_EXCEEDED",
        matchedCount: 337,
        limit: 200,
      },
    });
    expect(readTrpcErrorExtras(err)).toEqual({ matchedCount: 337, limit: 200 });
  });

  it("returns empty extras for null/undefined/primitives and missing data", () => {
    expect(readTrpcErrorExtras(null)).toEqual({});
    expect(readTrpcErrorExtras(undefined)).toEqual({});
    expect(readTrpcErrorExtras("nope")).toEqual({});
    expect(readTrpcErrorExtras({})).toEqual({});
    expect(readTrpcErrorExtras(new Error("plain"))).toEqual({});
  });
});

describe("isUnauthorizedError — parity of the two former duplicated bodies", () => {
  it("detects TRPCClientError with data.code UNAUTHORIZED", () => {
    const err = makeTrpcClientError("UNAUTHORIZED");
    Object.assign(err, { data: { code: "UNAUTHORIZED" } });
    expect(isUnauthorizedError(err)).toBe(true);
  });

  it("detects TRPCClientError with shape.data.code UNAUTHORIZED", () => {
    const err = makeTrpcClientError("error");
    Object.assign(err, { shape: { data: { code: "UNAUTHORIZED" } } });
    expect(isUnauthorizedError(err)).toBe(true);
  });

  it("accepts the sse-replay double: Error with assigned UNAUTHORIZED data", () => {
    const err = Object.assign(new Error("Unauthorized"), { data: { code: "UNAUTHORIZED" } });
    expect(isUnauthorizedError(err)).toBe(true);
  });

  it("falls back to message === UNAUTHORIZED for mocks that set message to code", () => {
    expect(isUnauthorizedError(new Error("UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorizedError({ message: "UNAUTHORIZED" })).toBe(true);
  });

  it("returns false for other codes and ordinary errors", () => {
    expect(isUnauthorizedError({ data: { code: "NOT_FOUND" } })).toBe(false);
    expect(isUnauthorizedError({ shape: { data: { code: "BAD_REQUEST" } } })).toBe(false);
    expect(isUnauthorizedError(new Error("something"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
    expect(isUnauthorizedError("UNAUTHORIZED")).toBe(false);
    expect(isUnauthorizedError(42)).toBe(false);
  });

  it("still detects UNAUTHORIZED when one placement carries a different code", () => {
    // Both placements are checked independently, mirroring the original OR-equality.
    expect(
      isUnauthorizedError({
        shape: { data: { code: "CONFLICT" } },
        data: { code: "UNAUTHORIZED" },
      }),
    ).toBe(true);
  });
});

describe("SSE tracked-envelope narrowings", () => {
  it("isRecord accepts objects/arrays and rejects null/primitives/functions", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(3)).toBe(false);
    expect(isRecord(() => {})).toBe(false);
  });

  it("readSearchStatus passes strings through (terminal filtering stays at call site)", () => {
    expect(readSearchStatus("RUNNING")).toBe("RUNNING");
    expect(readSearchStatus("COMPLETE")).toBe("COMPLETE");
    expect(readSearchStatus("NOT_A_STATUS")).toBe("NOT_A_STATUS");
    expect(readSearchStatus(7)).toBeNull();
    expect(readSearchStatus(null)).toBeNull();
    expect(readSearchStatus(undefined)).toBeNull();
  });

  it("readRankedAnswer returns object payloads by reference and null otherwise", () => {
    const answer = { mode: "HEDGED", recommendations: [] };
    expect(readRankedAnswer(answer)).toBe(answer);
    expect(readRankedAnswer(null)).toBeNull();
    expect(readRankedAnswer(undefined)).toBeNull();
    expect(readRankedAnswer("HEDGED")).toBeNull();
    expect(readRankedAnswer(1)).toBeNull();
  });

  it("readProgressCount reads numbers only", () => {
    expect(readProgressCount(4)).toBe(4);
    expect(readProgressCount("4")).toBeUndefined();
    expect(readProgressCount(undefined)).toBeUndefined();
    expect(readProgressCount(null)).toBeUndefined();
  });

  it("isResultGroups/readResultGroups accept arrays and reject other shapes", () => {
    const groups: unknown = [{ movieId: "amc:movie:1" }];
    expect(isResultGroups(groups)).toBe(true);
    expect(readResultGroups(groups)).toBe(groups);
    expect(readResultGroups({ length: 1 })).toBeUndefined();
    expect(readResultGroups("groups")).toBeUndefined();
    expect(readResultGroups(undefined)).toBeUndefined();
  });
});
