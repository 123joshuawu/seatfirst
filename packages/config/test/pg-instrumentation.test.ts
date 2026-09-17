import { describe, expect, it } from "vitest";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

import { buildOtelFromEnv, PG_INSTRUMENTATION_SCOPE } from "../src/otel-bootstrap.js";
import type { OtelResourceOptions } from "../src/otel.js";

const RESOURCE: OtelResourceOptions = { serviceName: "pg-instr-test", component: "worker" };

describe("buildOtelFromEnv — pg instrumentation registration (O8.2/O8.5)", () => {
  it("registers the instrumentation repeatedly without error and keeps every handle working", () => {
    // The once-per-process guard means multiple builds in one process (tests especially)
    // never stack instrumentations; each call must still return a working handle.
    const first = buildOtelFromEnv({}, RESOURCE);
    const second = buildOtelFromEnv({}, RESOURCE);
    const span = second.tracer.startSpan("registration-smoke");
    span.end();
    expect(typeof first.forceFlush).toBe("function");
    expect(typeof second.shutdown).toBe("function");
  });

  it("stamps seatfirst.component='db' on pg-scope spans only, never other scopes", async () => {
    // Positive: a span from the pg instrumentation's own scope gets the db stamp.
    // Negative: a span from any other scope (here the house scope) must NOT be
    // mislabeled as component=db — O8.5(a) is scoped to pg-derived spans.
    const capturing = new InMemorySpanExporter();
    const otel = buildOtelFromEnv({}, RESOURCE, {
      spanProcessors: [new SimpleSpanProcessor({ exporter: capturing })],
    });
    // Take the tracer for the pg scope from THIS handle's own provider (the OTel global
    // binds only once per process, so per-test handles must not rely on it).
    const pgSpan = otel.tracerProvider
      .getTracer(PG_INSTRUMENTATION_SCOPE)
      .startSpan("pg.query probe");
    pgSpan.end();
    const callerSpan = otel.tracer.startSpan("non-pg probe");
    callerSpan.end();
    await otel.forceFlush();

    const byName = new Map(capturing.getFinishedSpans().map((sp) => [sp.name, sp]));
    expect(byName.get("pg.query probe")?.attributes["seatfirst.component"]).toBe("db");
    expect(byName.get("non-pg probe")?.attributes["seatfirst.component"]).toBeUndefined();
  });
});
