import type { FastifyInstance } from "fastify";

import { parseSessionCookie } from "./cookie.js";
import { extractSessionContext, makeRelayPeerGate } from "./extract.js";
import type { AsnLookup } from "./extract.js";

/**
 * The session Fastify plugin (S16.16): one `onRequest` hook that verifies the S16.10
 * cookie, runs S16.7's extraction, and decorates `req.session` — and does nothing else.
 * No Postgres write per request (session rows are touched only by bootstrap's upsert,
 * S16.2), no rejection (routes decide presence, preserving fail-closed behavior), and
 * no logging of any decorated field.
 *
 * IP/ASN consumers are S16.9's Redis breach keys ONLY — nothing here (and nothing
 * downstream of the decoration) writes IP/ASN to Postgres, logs, spans, or telemetry
 * (S16.16; ADR 0005 §A:148-155,168-195).
 */

export interface SessionDecoration {
  readonly sessionId: string | undefined;
  readonly clientIp: string | undefined;
  readonly asn: string | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    session: SessionDecoration | null;
  }
}

export interface SessionPluginOptions {
  /** HMAC secret for S16.10 cookie signing — injected, never in the repo. */
  readonly cookieSecret: string;
  /** The relay's specific tailnet peer CIDR (S16.7) — not `true`, not a bare header name. */
  readonly relayPeerCidr: string;
  /** The offline ASN lookup loaded at wiring time (S16.8). */
  readonly asnLookup: AsnLookup;
}

/**
 * Registers the session decoration + hook. Deliberately called DIRECTLY on the root
 * instance (like `registerOnProgressSse`, sse.ts) rather than via `fastify.register`:
 * plugin encapsulation would scope this hook to a subtree, while the decoration must
 * apply to every route the app mounts (searches.create, the SSE transport, bootstrap).
 * The relay CIDR is validated once here — a miswired CIDR fails at startup.
 */
export function registerSessionPlugin(fastify: FastifyInstance, opts: SessionPluginOptions): void {
  const relayPeerGate = makeRelayPeerGate(opts.relayPeerCidr);
  fastify.decorateRequest("session", null);

  fastify.addHook("onRequest", (req, _reply, done) => {
    const sessionId = parseSessionCookie(req.headers.cookie, opts.cookieSecret);
    const { clientIp, asn } = extractSessionContext(
      req.socket.remoteAddress,
      req.headers["x-forwarded-for"],
      relayPeerGate,
      opts.asnLookup,
    );
    req.session = { sessionId, clientIp, asn };
    done();
  });
}
