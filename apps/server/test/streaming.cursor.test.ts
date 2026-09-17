import { describe, expect, it } from "vitest";

import {
  cursorAfterSeq,
  entryIdForSeq,
  LAST_EVENT_ID_PATTERN,
  seqOfEntryId,
} from "../src/streaming/cursor.js";

/**
 * S38.1 — exhaustive-branch unit tests for the reconnect-cursor math. The cursor a
 * client sends back is the Redis Stream entry ID of the last event it saw; the exact
 * conforming form is `<digits>-0` with no leading zeros, and anything else must be
 * rejected at the boundary, never silently treated as "start from the beginning".
 */

describe("LAST_EVENT_ID_PATTERN", () => {
  it("accepts the exact `${seq}-0` form with positive multi-digit seqs", () => {
    expect(LAST_EVENT_ID_PATTERN.test("1-0")).toBe(true);
    expect(LAST_EVENT_ID_PATTERN.test("9-0")).toBe(true);
    expect(LAST_EVENT_ID_PATTERN.test("42-0")).toBe(true);
    expect(LAST_EVENT_ID_PATTERN.test("123456789012345789-0")).toBe(true);
  });

  it("rejects leading zeros, bare digits, missing -0, negatives, and other shapes", () => {
    // Leading zeros — Postgres never renders a bigint this way.
    expect(LAST_EVENT_ID_PATTERN.test("0-0")).toBe(false);
    expect(LAST_EVENT_ID_PATTERN.test("01-0")).toBe(false);
    expect(LAST_EVENT_ID_PATTERN.test("007-0")).toBe(false);
    // Bare digits / missing `-0`.
    expect(LAST_EVENT_ID_PATTERN.test("42")).toBe(false);
    expect(LAST_EVENT_ID_PATTERN.test("42-")).toBe(false);
    // Negative.
    expect(LAST_EVENT_ID_PATTERN.test("-1-0")).toBe(false);
    // Wrong sub-second field.
    expect(LAST_EVENT_ID_PATTERN.test("1-1")).toBe(false);
    expect(LAST_EVENT_ID_PATTERN.test("1-00")).toBe(false);
    // Empty and garbage.
    expect(LAST_EVENT_ID_PATTERN.test("")).toBe(false);
    expect(LAST_EVENT_ID_PATTERN.test("$")).toBe(false);
  });
});

describe("cursorAfterSeq", () => {
  it("returns 0n when the client sent no lastEventId (start from the beginning)", () => {
    expect(cursorAfterSeq(undefined)).toBe(0n);
  });

  it("round-trips entryIdForSeq for several seqs", () => {
    for (const seq of [1n, 2n, 9n, 10n, 999n, 123456789012345789n]) {
      expect(cursorAfterSeq(entryIdForSeq(seq))).toBe(seq);
    }
  });
});

describe("entryIdForSeq", () => {
  it("renders the projector's `${seq}-0` entry ID", () => {
    expect(entryIdForSeq(1n)).toBe("1-0");
    expect(entryIdForSeq(42n)).toBe("42-0");
    expect(entryIdForSeq(123456789012345789n)).toBe("123456789012345789-0");
  });

  it("produces ids matching LAST_EVENT_ID_PATTERN", () => {
    for (const seq of [1n, 7n, 1000000n]) {
      expect(LAST_EVENT_ID_PATTERN.test(entryIdForSeq(seq))).toBe(true);
    }
  });
});

describe("seqOfEntryId", () => {
  it("parses multi-digit ids, ignoring the sub-second field", () => {
    expect(seqOfEntryId("1-0")).toBe(1n);
    expect(seqOfEntryId("42-7")).toBe(42n);
    expect(seqOfEntryId("123456-0")).toBe(123456n);
  });

  it("returns null for garbage, empty, and wrong-shape strings", () => {
    expect(seqOfEntryId("garbage")).toBeNull();
    expect(seqOfEntryId("")).toBeNull();
    expect(seqOfEntryId("42")).toBeNull();
    expect(seqOfEntryId("abc-def")).toBeNull();
    expect(seqOfEntryId("-1-0")).toBeNull();
  });
});
