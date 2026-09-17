/**
 * Inbound client-metadata redaction for production logs and traces — ADR 0005 §A
 * (docs/adr/0005-security-privacy-operations.md:169-196).
 *
 * §A decides that the remote address, `X-Forwarded-For`, and derived ASN are excluded
 * from every durable store by config-time allowlists before a log line or span is ever
 * emitted — "an OTel `SpanProcessor` attribute filter for traces" and an explicit field
 * allowlist for the request logger. This module ships both as caller-supplied primitives:
 * neither registers itself anywhere (O1's posture — the caller passes the processor
 * through `ConfigureOtelOptions.spanProcessors`, packages/config/src/otel.ts:118-121), and
 * the serializer is a plain function the first production Fastify bootstrap passes to
 * `logger.serializers.req/res` (S18.13's wiring contract).
 *
 * Scope, per the ADR: inbound client metadata only. §D's AMC-payload primitive
 * (`redactHeaders()`, packages/providers/src/amc/redact.ts) is a different decision on
 * a different code path and is not re-derived here.
 */
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import {
  ATTR_CLIENT_ADDRESS,
  ATTR_CLIENT_PORT,
  ATTR_NETWORK_PEER_ADDRESS,
  ATTR_NETWORK_PEER_PORT,
  SEMATTRS_NET_PEER_IP,
  SEMATTRS_NET_PEER_PORT,
} from "@opentelemetry/semantic-conventions";

/**
 * The three inbound-metadata field classes §A excludes, by exact attribute name
 * (docs/adr/0005-security-privacy-operations.md:181-196):
 *  - the HTTP semconv client-address names, stable and legacy namespaces;
 *  - the forwarded-header attribute names in the semconv header rendering;
 *  - any name containing `asn` (case-insensitive) — §A names "derived ASN" even though no
 *    code sets such an attribute today, so the filter is closed over the class rather
 *    than over a today-observed list.
 */
const INBOUND_METADATA_ATTRIBUTE_NAMES = new Set<string>([
  ATTR_CLIENT_ADDRESS, // stable: client.address
  ATTR_CLIENT_PORT, // stable: client.port
  ATTR_NETWORK_PEER_ADDRESS, // stable: network.peer.address
  ATTR_NETWORK_PEER_PORT, // stable: network.peer.port
  SEMATTRS_NET_PEER_IP, // legacy: net.peer.ip
  SEMATTRS_NET_PEER_PORT, // legacy: net.peer.port
  // The forwarded-header names are exported by no semconv namespace — the header
  // attribute rendering (http.request.header.<lowercased name>) is the documented
  // naming convention, spelled out here verbatim.
  "http.request.header.x_forwarded_for",
  "http.request.header.forwarded",
  "http.request.header.x_real_ip",
]);

function isInboundMetadataAttribute(name: string): boolean {
  return INBOUND_METADATA_ATTRIBUTE_NAMES.has(name) || name.toLowerCase().includes("asn");
}

/**
 * OTel `SpanProcessor` that, in `onEnd` — the last point before export — removes exactly
 * the three inbound-metadata field classes above from every span's attributes. Every
 * other attribute passes through untouched.
 *
 * Caller-supplied, never auto-registered: pass it through
 * `ConfigureOtelOptions.spanProcessors` (packages/config/src/otel.ts:118-121) ahead of the
 * export processor, so the delete happens before export.
 */
export class InboundSpanAttributeFilter implements SpanProcessor {
  onStart(): void {
    // no-op: attribute removal is an onEnd-only concern (started spans have no exporter yet)
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes;
    for (const name of Object.keys(attributes)) {
      if (isInboundMetadataAttribute(name)) {
        delete attributes[name];
      }
    }
  }

  async forceFlush(): Promise<void> {
    // no-op: nothing buffered by this processor
  }

  async shutdown(): Promise<void> {
    // no-op: nothing owned by this processor
  }
}

/** Structural request shape for the serializer — `packages/config` gains no `fastify` dependency. */
export interface InboundRequestLogSource {
  readonly method?: string;
  readonly url?: string;
  readonly hostname?: string;
  readonly protocol?: string;
}

/** Structural response shape — the serializer's res side. `statusCode` is required: a
 * Fastify reply always carries one, and the required property is what lets the `in`
 * dispatch narrow the union. */
export interface InboundResponseLogSource {
  readonly statusCode: number;
  readonly responseTime?: number;
}

/** Always-present allowlist projection of a request (S18.13's four named fields). */
export interface InboundRequestLogFields {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly hostname: string | undefined;
  readonly protocol: string | undefined;
}

/** Always-present allowlist projection of a response (S18.13's two named fields). */
export interface InboundResponseLogFields {
  readonly statusCode: number | undefined;
  readonly responseTime: number | undefined;
}

/**
 * Fastify request-log allowlist serializer (S18.13): returns exactly the four named
 * request fields for a request-shaped input and exactly `{ statusCode, responseTime }`
 * for a response-shaped input. It never spreads the input, never reads
 * `remoteAddress`/`remotePort`, and never touches `headers` — pino's default `req`
 * serializer includes both (remoteAddress and the full header map, which carries
 * `X-Forwarded-For`), which is precisely what ADR 0005 §A excludes. Wire it as
 * `logger.serializers.req/res` in whichever task lands the first production Fastify
 * logger configuration.
 */
export function inboundRequestLogSerializer(
  input: InboundRequestLogSource | InboundResponseLogSource,
): InboundRequestLogFields | InboundResponseLogFields {
  if ("statusCode" in input) {
    return { statusCode: input.statusCode, responseTime: input.responseTime };
  }
  return {
    method: input.method,
    url: input.url,
    hostname: input.hostname,
    protocol: input.protocol,
  };
}
