import { describe, expect, it } from "vitest";

import { rowBuffer, rowNullableString, rowNumber, rowString } from "../src/pg-row.js";

/**
 * S40.1 — accept/reject tables for the guard accessors, including the realistic wrong
 * kinds (`undefined` from a renamed column, a numeric string where `integer` is
 * expected). Every rejection is a `TypeError` naming the column and the received kind.
 */

const BUFFER = Buffer.from([0b00000011]);

describe("rowString", () => {
  it("accepts a present string column", () => {
    expect(rowString({ session_id: "sess_1" }, "session_id")).toBe("sess_1");
    expect(rowString({ seq: "" }, "seq")).toBe("");
  });

  it.each([
    [{}, "undefined"],
    [{ session_id: 7 }, "number"],
    [{ session_id: null }, "null"],
    [{ session_id: BUFFER }, "Buffer"],
    [{ session_id: new Date(0) }, "Date"],
    [{ session_id: { nested: true } }, "object"],
    [{ session_id: ["a"] }, "array"],
  ])("rejects %o with a TypeError naming the column and kind", (row, kind) => {
    expect(() => rowString(row, "session_id")).toThrow(TypeError);
    expect(() => rowString(row, "session_id")).toThrow(
      `pg row column "session_id": expected string, received ${kind}`,
    );
  });
});

describe("rowNullableString", () => {
  it("accepts strings and maps SQL null / missing keys to null", () => {
    expect(rowNullableString({ theatre_id: "th_1" }, "theatre_id")).toBe("th_1");
    expect(rowNullableString({ theatre_id: null }, "theatre_id")).toBeNull();
    expect(rowNullableString({}, "theatre_id")).toBeNull();
    expect(rowNullableString({ theatre_id: undefined }, "theatre_id")).toBeNull();
  });

  it.each([
    [{ theatre_id: 7 }, "number"],
    [{ theatre_id: BUFFER }, "Buffer"],
    [{ theatre_id: new Date(0) }, "Date"],
  ])("rejects %o with a TypeError naming the column and kind", (row, kind) => {
    expect(() => rowNullableString(row, "theatre_id")).toThrow(TypeError);
    expect(() => rowNullableString(row, "theatre_id")).toThrow(
      `pg row column "theatre_id": expected string | null, received ${kind}`,
    );
  });
});

describe("rowNumber", () => {
  it("accepts pg integer deliveries", () => {
    expect(rowNumber({ free_count: 0 }, "free_count")).toBe(0);
    expect(rowNumber({ free_count: 42 }, "free_count")).toBe(42);
    expect(rowNumber({ free_count: -3 }, "free_count")).toBe(-3);
  });

  it("rejects a numeric string — the realistic bigint-drift shape", () => {
    expect(() => rowNumber({ free_count: "42" }, "free_count")).toThrow(TypeError);
    expect(() => rowNumber({ free_count: "42" }, "free_count")).toThrow(
      `pg row column "free_count": expected number, received string`,
    );
  });

  it.each([
    [{}, "undefined"],
    [{ free_count: null }, "null"],
    [{ free_count: true }, "boolean"],
    [{ free_count: 1n }, "bigint"],
  ])("rejects %o with a TypeError naming the column and kind", (row, kind) => {
    expect(() => rowNumber(row, "free_count")).toThrow(TypeError);
    expect(() => rowNumber(row, "free_count")).toThrow(
      `pg row column "free_count": expected number, received ${kind}`,
    );
  });
});

describe("rowBuffer", () => {
  it("accepts a pg bytea delivery (Buffer)", () => {
    const bitmap = Buffer.from([1, 2, 3]);
    expect(rowBuffer({ bitmap }, "bitmap")).toBe(bitmap);
  });

  it("rejects a bare Uint8Array — pg bytea is a Buffer, not any TypedArray", () => {
    expect(() => rowBuffer({ bitmap: new Uint8Array([1, 2, 3]) }, "bitmap")).toThrow(TypeError);
    expect(() => rowBuffer({ bitmap: new Uint8Array([1, 2, 3]) }, "bitmap")).toThrow(
      `pg row column "bitmap": expected Buffer, received Uint8Array`,
    );
  });

  it.each([
    [{}, "undefined"],
    [{ bitmap: null }, "null"],
    [{ bitmap: "010203" }, "string"],
  ])("rejects %o with a TypeError naming the column and kind", (row, kind) => {
    expect(() => rowBuffer(row, "bitmap")).toThrow(TypeError);
    expect(() => rowBuffer(row, "bitmap")).toThrow(
      `pg row column "bitmap": expected Buffer, received ${kind}`,
    );
  });
});
