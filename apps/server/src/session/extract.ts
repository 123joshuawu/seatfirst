import { readFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";

/**
 * Client-IP and ASN extraction (S16.7/S16.8) — ADR 0005 §A's trusted-proxy mechanism,
 * implemented: the socket peer must BE the relay (inside the injected tailnet CIDR)
 * before any `X-Forwarded-For` value is read at all, and then only the relay's single
 * entry is used. Everything else is unknown/unextractable — never a fallback to the
 * socket address, never a multi-entry read (docs/adr/0005-security-privacy-operations.md:136-147).
 *
 * ASN comes from a local MaxMind GeoLite2-ASN (or equivalent offline) file loaded at
 * wiring time — the module contains no network-capable code path whatsoever, so an
 * extracted IP never leaves the process (docs/adr/0005-security-privacy-operations.md:149-156).
 * Extracted values are consumed ONLY for S16.9's Redis breach keys: nothing here — and
 * nothing in the plugin that calls it — writes IP or ASN to Postgres, logs, spans, or
 * telemetry (S16.16, docs/gates.md's trap row).
 */

export interface AsnLookup {
  lookup(ip: string): string | undefined;
}

/**
 * No-op ASN lookup used when no ASN database is configured (ADR 0095 — Josh Wu
 * authorized deferring the MaxMind GeoLite2-ASN requirement for the initial
 * production deployment). Every lookup resolves `undefined`, matching the same
 * "ASN not derivable" outcome `parseGeoLiteAsnCsv`'s lookup already produces for an
 * unmatched IP — downstream (S16.9's breach-observation windows) already treats an
 * undefined ASN as a no-op key, so no other code path needs to change.
 */
export const noopAsnLookup: AsnLookup = { lookup: () => undefined };

export interface ExtractedSessionContext {
  readonly clientIp: string | undefined;
  readonly asn: string | undefined;
}

/**
 * Builds the relay-peer gate. Throws on a malformed CIDR — the CIDR is injected config,
 * and a deployment that miswires it must fail at wiring time, never silently trust
 * nothing (or everything).
 */
export function makeRelayPeerGate(cidr: string): (socketAddress: string | undefined) => boolean {
  const separator = cidr.lastIndexOf("/");
  if (separator === -1) {
    throw new Error(`relay peer CIDR must be CIDR notation (address/prefix), got "${cidr}"`);
  }
  const network = cidr.slice(0, separator);
  const prefixText = cidr.slice(separator + 1);
  const prefix = Number(prefixText);
  const family = isIP(network);
  if (family === 0 || !Number.isInteger(prefix) || prefix < 0) {
    throw new Error(`relay peer CIDR is not a valid IP network: "${cidr}"`);
  }
  const maxPrefix = family === 6 ? 128 : 32;
  if (prefix > maxPrefix) {
    throw new Error(`relay peer CIDR prefix out of range for its family: "${cidr}"`);
  }
  const blockList = new BlockList();
  blockList.addSubnet(network, prefix, family === 6 ? "ipv6" : "ipv4");
  return (socketAddress) =>
    socketAddress !== undefined && isIP(socketAddress) !== 0 && blockList.check(socketAddress);
}

/**
 * The relay's single `X-Forwarded-For` entry — and ONLY a single entry. Any count other
 * than exactly one (zero, comma-joined chains) is unknown/unextractable, per ADR 0005
 * §A:144-146. The entry must also parse as an IP address; anything else is not an
 * address we key breach windows on.
 */
export function singleXffEntry(header: string | string[] | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const value = Array.isArray(header) ? header.join(", ") : header;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length !== 1) {
    return undefined;
  }
  const [entry] = entries;
  return entry !== undefined && isIP(entry) !== 0 ? entry : undefined;
}

/**
 * The explicit socket-peer gate (S16.7). `socketAddress` is `req.socket.remoteAddress`;
 * the `x-forwarded-for` header is read ONLY when the peer is the relay, and the ASN is
 * derived only from an extractable IP.
 */
export function extractSessionContext(
  socketAddress: string | undefined,
  xForwardedFor: string | string[] | undefined,
  relayPeerGate: (socketAddress: string | undefined) => boolean,
  asnLookup: AsnLookup,
): ExtractedSessionContext {
  if (!relayPeerGate(socketAddress)) {
    return { clientIp: undefined, asn: undefined };
  }
  const clientIp = singleXffEntry(xForwardedFor);
  if (clientIp === undefined) {
    return { clientIp: undefined, asn: undefined };
  }
  return { clientIp, asn: asnLookup.lookup(clientIp) };
}

/* ----------------------------------------------------------------------- ASN lookup */

interface AsnRange {
  readonly start: number;
  readonly end: number;
  readonly asn: string;
}

/**
 * Parses a GeoLite2-ASN CSV (`network,autonomous_system_number,
 * autonomous_system_organization`) into an in-memory sorted range table. The concrete
 * lookup library is this module's own choice (ADR 0005 §A:154-155): the file format is
 * the public GeoLite2-ASN CSV, and the constraint that matters — no IP forwarded
 * off-box — holds by construction.
 *
 * IPv4 rows only: IPv6 rows are skipped at load, and an IPv6 lookup resolves to
 * `undefined` (no ASN key) rather than a wrong answer.
 */
export function parseGeoLiteAsnCsv(csv: string): AsnLookup {
  const ranges: AsnRange[] = [];
  for (const line of csv.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const firstComma = trimmed.indexOf(",");
    const secondComma = trimmed.indexOf(",", firstComma + 1);
    if (firstComma === -1 || secondComma === -1) {
      continue;
    }
    const network = trimmed.slice(0, firstComma).trim();
    const asn = trimmed.slice(firstComma + 1, secondComma).trim();
    if (network.length === 0 || asn.length === 0) {
      continue;
    }
    const separator = network.lastIndexOf("/");
    if (separator === -1) {
      continue;
    }
    const base = parseIpv4(network.slice(0, separator));
    const prefixText = network.slice(separator + 1);
    const prefix = Number(prefixText);
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      continue;
    }
    const mask = prefix === 0 ? 0xffff_ffff : ((1 << (32 - prefix)) - 1) >>> 0;
    ranges.push({ start: base, end: (base | mask) >>> 0, asn });
  }
  ranges.sort((a, b) => a.start - b.start);

  return {
    lookup(ip: string): string | undefined {
      const numeric = parseIpv4(ip);
      if (numeric === null) {
        return undefined;
      }
      // Binary search for the last range whose start is <= the address.
      let low = 0;
      let high = ranges.length - 1;
      let candidate = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const range = ranges[mid];
        if (range !== undefined && range.start <= numeric) {
          candidate = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (candidate === -1) {
        return undefined;
      }
      const match = ranges[candidate];
      return match !== undefined && numeric <= match.end ? match.asn : undefined;
    },
  };
}

/**
 * Loads the offline ASN database from a local file (the image-baked GeoLite2-ASN or
 * equivalent fixture) at wiring time. Request-time lookups touch only the in-memory
 * table; no request performs I/O and no code path in this module performs network I/O.
 */
export async function loadAsnLookup(filePath: string): Promise<AsnLookup> {
  const csv = await readFile(filePath, "utf8");
  return parseGeoLiteAsnCsv(csv);
}

function parseIpv4(value: string): number | null {
  if (isIP(value) !== 4) {
    return null;
  }
  const octets = value.split(".");
  if (octets.length !== 4) {
    return null;
  }
  let numeric = 0;
  for (const octet of octets) {
    const part = Number(octet);
    if (!Number.isInteger(part) || part < 0 || part > 255) {
      return null;
    }
    numeric = (numeric * 256 + part) >>> 0;
  }
  return numeric;
}
