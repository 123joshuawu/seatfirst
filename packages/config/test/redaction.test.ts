import { describe, expect, it } from "vitest";

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import {
  InboundSpanAttributeFilter,
  inboundRequestLogSerializer,
  type InboundRequestLogSource,
} from "../src/redaction.js";

/**
 * ADR 0005 §A inbound-metadata redaction (S18.12/S18.13): the span filter strips exactly
 * the three excluded field classes in onEnd, and the serializer returns exactly the
 * allowlisted fields for each input shape. Falsifiability note: every "forbidden field
 * absent" assertion here has a positive control — the same input's permitted fields ARE
 * present, so a no-op filter/serializer fails immediately.
 */

describe("InboundSpanAttributeFilter (ADR 0005 §A span filter)", () => {
  const forbidden = {
    "client.address": "203.0.113.9", // stable name
    "client.port": 41234, // stable name
    "net.peer.ip": "198.51.100.4", // legacy name
    "http.request.header.x_forwarded_for": "203.0.113.1, 10.0.0.1", // forwarded-header
    "http.request.header.forwarded": "for=203.0.113.7;proto=https", // forwarded-header
    "network.asn": "64512", // asn-containing name (the class §A closes over, set by nothing today)
  };
  const permitted = {
    "http.request.method": "POST",
    "http.route": "/trpc/searches.create",
    "url.path": "/trpc/searches.create",
  };

  function recordSpan(withFilter: boolean) {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [
        ...(withFilter ? [new InboundSpanAttributeFilter()] : []),
        new SimpleSpanProcessor({ exporter }),
      ],
    });
    const span = provider.getTracer("redaction-test").startSpan("inbound-request", {
      attributes: { ...forbidden, ...permitted },
    });
    span.end();
    return exporter.getFinishedSpans();
  }

  it("strips exactly the three inbound-metadata classes in onEnd; everything else passes through", () => {
    const finished = recordSpan(true);
    expect(finished).toHaveLength(1);
    const attributes = finished[0]!.attributes;
    expect(Object.keys(attributes).sort()).toEqual(Object.keys(permitted).sort());
    expect(attributes).toEqual(permitted);
  });

  it("negative control: without the filter, the forbidden attributes reach the exporter intact", () => {
    const finished = recordSpan(false);
    expect(finished).toHaveLength(1);
    const attributes = finished[0]!.attributes;
    expect(attributes["client.address"]).toBe("203.0.113.9");
    expect(attributes["client.port"]).toBe(41234);
    expect(attributes["net.peer.ip"]).toBe("198.51.100.4");
    expect(attributes["http.request.header.x_forwarded_for"]).toBe("203.0.113.1, 10.0.0.1");
    expect(attributes["network.asn"]).toBe("64512");
    // the permitted attributes survive too — the control proves the exporter itself
    expect(attributes["http.request.method"]).toBe("POST");
  });
});

describe("inboundRequestLogSerializer (ADR 0005 §A request-log allowlist)", () => {
  interface RequestShapedInput extends InboundRequestLogSource {
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly headers: Readonly<Record<string, string>>;
  }

  it("returns exactly the four named request fields; address and headers are absent entirely", () => {
    const input: RequestShapedInput = {
      method: "POST",
      url: "/trpc/searches.create",
      hostname: "relay.seatfirst.example",
      protocol: "https",
      remoteAddress: "203.0.113.7",
      remotePort: 41234,
      headers: {
        "x-forwarded-for": "198.51.100.9",
        "set-cookie": "session=opaque",
      },
    };
    const output = inboundRequestLogSerializer(input);

    expect(Object.keys(output).sort()).toEqual(["hostname", "method", "protocol", "url"]);
    expect(output).toEqual({
      method: "POST",
      url: "/trpc/searches.create",
      hostname: "relay.seatfirst.example",
      protocol: "https",
    });
    // Absent from the output object entirely, not merely empty — the ADR excludes the
    // fields, and `in` is the falsifiable check that they were never copied.
    expect("headers" in output).toBe(false);
    expect("remoteAddress" in output).toBe(false);
    expect("remotePort" in output).toBe(false);
  });

  it("returns exactly { statusCode, responseTime } for a response-shaped input", () => {
    const reply = { statusCode: 200, responseTime: 12.3 };
    const output = inboundRequestLogSerializer(reply);

    expect(Object.keys(output).sort()).toEqual(["responseTime", "statusCode"]);
    expect(output).toEqual({ statusCode: 200, responseTime: 12.3 });
  });
});
