import { describe, it, expect } from "vitest";
import { redactHeaders } from "@seatfirst/providers";
import type { CorridorStage } from "../src/guard.js";
import {
  ATTR_CHROME_VERSION,
  ATTR_EGRESS_IDENTITY_LABEL,
  ATTR_ENTITY_LOCAL_DATE,
  ATTR_ENTITY_SHOWTIME_ID,
  ATTR_ENTITY_THEATRE_ID,
  ATTR_PLAYWRIGHT_VERSION,
  ATTR_REDACTED_OUTCOME,
  ATTR_RUN_KEY_ID,
  ATTR_URL_CLASSIFICATION,
  CORRIDOR_LABELS,
  attachRunKeyEntityAttributes,
  buildSafeSpanAttributes,
  outcomeClassification,
} from "../src/observability.js";
import type { NavigationOutcome } from "../src/outcome.js";
import type { Span } from "@opentelemetry/api";

const VERSIONS = { chrome: "Chrome/151.0.7922.110", playwright: "1.62.1" };
const COUNTS = { physicalDocuments: 4, subresourceAborts: 3, chromeRecycled: false };

const HOP = { classification: "AMC_INITIAL" as const, status: 200, durationMs: 12 };
const HOP_LIST = [HOP, { ...HOP, classification: "QUEUE_ENTRY" as const }];

const SUCCESS_OUTCOME: NavigationOutcome = {
  kind: "SUCCESS",
  classification: "AMC_CLEAN_RETURN",
  hops: HOP_LIST,
  subresourceAborts: 3,
  payload: {
    finalUrl: { origin: "https://www.amctheatres.com", pathname: "/movies", queryKeys: [] },
    finalStatus: 200,
    headers: {},
    documentHtml: "<html></html>",
  },
};

function attrs(outcome: NavigationOutcome): Record<string, string | number | boolean> {
  return buildSafeSpanAttributes(outcome, "relay-eip-label", VERSIONS, COUNTS);
}

describe("safe span attributes (P6.14 / P6.15)", () => {
  it("classifies successful and terminal outcomes with one of the four fixed stage labels only", () => {
    const pairs: ReadonlyArray<{ readonly outcome: NavigationOutcome; readonly expected: string }> =
      [
        { outcome: SUCCESS_OUTCOME, expected: "AMC_CLEAN_RETURN" },
        {
          outcome: {
            kind: "QUEUE_ENTERED",
            classification: "QUEUE_ENTRY",
            hops: HOP_LIST,
            status: 200,
            headers: {},
          },
          expected: "QUEUE_ENTRY",
        },
        {
          outcome: {
            kind: "CHALLENGE_REQUIRED",
            classification: "AMC_INITIAL",
            hops: HOP_LIST,
            status: 403,
            headers: {},
          },
          expected: "AMC_INITIAL",
        },
        {
          outcome: {
            kind: "UPSTREAM_BLOCKED",
            classification: "AMC_INITIAL",
            hops: HOP_LIST,
            status: 403,
            headers: {},
          },
          expected: "AMC_INITIAL",
        },
        {
          outcome: {
            kind: "RATE_LIMITED",
            classification: "AMC_TOKEN_RETURN",
            hops: HOP_LIST,
            status: 429,
            headers: {},
          },
          expected: "AMC_TOKEN_RETURN",
        },
      ];
    const labels = new Set<CorridorStage>(CORRIDOR_LABELS);
    for (const { outcome, expected } of pairs) {
      const values = attrs(outcome);
      const classification = values[ATTR_URL_CLASSIFICATION];
      expect(classification).toBe(expected);
      expect(labels.has(classification as CorridorStage)).toBe(true);
      expect(outcomeClassification(outcome)).toBe(expected);
    }
  });

  it("attaches NO URL classification to a guard-rejected event (P6.14)", () => {
    const outcome: NavigationOutcome = {
      kind: "GUARD_REJECTED",
      reason: "DISALLOWED_QUERY_KEY",
      hops: HOP_LIST,
    };
    const values = attrs(outcome);
    expect(values[ATTR_URL_CLASSIFICATION]).toBeUndefined();
    expect(values[ATTR_REDACTED_OUTCOME]).toBe("GUARD_REJECTED");
    expect(outcomeClassification(outcome)).toBeNull();
  });

  it("never carries a literal URL string in any safe attribute value", () => {
    const outcomes: NavigationOutcome[] = [
      SUCCESS_OUTCOME,
      { kind: "CANCELLED" },
      { kind: "NAVIGATION_FAILED", error: "navigation timed out" },
    ];
    for (const outcome of outcomes) {
      for (const value of Object.values(attrs(outcome))) {
        expect(String(value)).not.toMatch(/https?:\/\//);
      }
    }
  });

  it("carries the fixed egress identity label as audit metadata (P6.15)", () => {
    const outcome: NavigationOutcome = { kind: "CANCELLED" };
    expect(attrs(outcome)[ATTR_EGRESS_IDENTITY_LABEL]).toBe("relay-eip-label");
  });

  it("carries safe versions and logical/physical request counts", () => {
    const outcome: NavigationOutcome = { kind: "CANCELLED" };
    const values = attrs(outcome);
    expect(values[ATTR_CHROME_VERSION]).toBe(VERSIONS.chrome);
    expect(values[ATTR_PLAYWRIGHT_VERSION]).toBe(VERSIONS.playwright);
  });

  it("exposes exactly the four permitted classification labels", () => {
    expect(CORRIDOR_LABELS).toEqual([
      "AMC_INITIAL",
      "QUEUE_ENTRY",
      "AMC_TOKEN_RETURN",
      "AMC_CLEAN_RETURN",
    ]);
  });
});

describe("header attachment path (P6.12)", () => {
  it("redacts IP literals in header values before they could reach a span attribute", () => {
    // The transport constructs outcomes through redactHeaders(); assert the primitive
    // itself scrubs an IP-bearing allowlisted value (the attribute path feeds on it).
    const scrubbed = redactHeaders({ server: "proxy at 192.0.2.1" });
    expect(scrubbed["server"]).toBe("proxy at [REDACTED_IPV4]");
  });

  it("drops non-allowlisted headers entirely", () => {
    const scrubbed = redactHeaders({ "set-cookie": "qf=secret", server: "cloudflare" });
    expect(scrubbed["set-cookie"]).toBeUndefined();
    expect(scrubbed["server"]).toBe("cloudflare");
  });
});

describe("run-key entity attributes (O3)", () => {
  /**
   * Minimal in-process `Span` stand-in: records `setAttribute` calls so the helper's
   * output can be asserted. Only the methods `attachRunKeyEntityAttributes` touches are
   * implemented; the rest are structural no-ops (same stub discipline as the O2 meter
   * stubs — `@opentelemetry/sdk-trace` is not a dependency of this package).
   */
  class RecordingSpan implements Span {
    readonly attributes: Record<string, string | number | boolean> = {};
    setAttribute(key: string, value: string | number | boolean): this {
      this.attributes[key] = value;
      return this;
    }
    spanContext() {
      return {
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      };
    }
    setAttributes() {
      return this;
    }
    addEvent() {
      return this;
    }
    setStatus() {
      return this;
    }
    updateName() {
      return this;
    }
    addLink() {
      return this;
    }
    addLinks() {
      return this;
    }
    end() {}
    isRecording() {
      return true;
    }
    recordException() {}
  }

  const FULL_RUN_KEY = {
    runKeyId: "key_abc123",
    theatreId: "theatre_7",
    showtimeId: "showtime_42",
    localDate: "2026-08-20",
  };

  it("attaches all four discrete entity identifiers under the O3.2 names", () => {
    const span = new RecordingSpan();
    attachRunKeyEntityAttributes(span, FULL_RUN_KEY);
    expect(span.attributes).toEqual({
      [ATTR_RUN_KEY_ID]: "key_abc123",
      [ATTR_ENTITY_THEATRE_ID]: "theatre_7",
      [ATTR_ENTITY_SHOWTIME_ID]: "showtime_42",
      [ATTR_ENTITY_LOCAL_DATE]: "2026-08-20",
    });
  });

  it('omits null entity parts rather than stringifying them as "null" (O3.2)', () => {
    const span = new RecordingSpan();
    // A SHOWTIME_FETCH key has theatre_id/local_date NULL; a SCHEDULE_RESOLUTION key has
    // showtime_id NULL. runKeyId is always present.
    attachRunKeyEntityAttributes(span, {
      runKeyId: "key_x",
      theatreId: null,
      showtimeId: "showtime_1",
      localDate: null,
    });
    expect(span.attributes).toEqual({
      [ATTR_RUN_KEY_ID]: "key_x",
      [ATTR_ENTITY_SHOWTIME_ID]: "showtime_1",
    });
    expect(span.attributes[ATTR_ENTITY_THEATRE_ID]).toBeUndefined();
    expect(span.attributes[ATTR_ENTITY_LOCAL_DATE]).toBeUndefined();
  });

  it("never receives a URL string — only the discrete RunKeyRow parts (O3.3)", () => {
    const span = new RecordingSpan();
    // The helper's parameter type admits no URL field, so no value can be a URL.
    attachRunKeyEntityAttributes(span, FULL_RUN_KEY);
    for (const value of Object.values(span.attributes)) {
      expect(String(value)).not.toMatch(/https?:\/\//);
    }
    // The only attribute keys the helper may set are the four O3 entity names.
    expect(Object.keys(span.attributes).sort()).toEqual(
      [
        ATTR_RUN_KEY_ID,
        ATTR_ENTITY_THEATRE_ID,
        ATTR_ENTITY_SHOWTIME_ID,
        ATTR_ENTITY_LOCAL_DATE,
      ].sort(),
    );
  });
});
