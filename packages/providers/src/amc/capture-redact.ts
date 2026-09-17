import { redactHeaders } from "./redact.js";

export interface RedactTarget {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const IPV4_REGEX =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const IPV6_REGEX =
  /(?<![a-zA-Z0-9])(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:(?:[a-fA-F0-9]{1,4}:)*[a-fA-F0-9]{1,4})?::(?:(?:[a-fA-F0-9]{1,4}:)*[a-fA-F0-9]{1,4})?)(?![a-zA-Z0-9])/gi;

const TOKEN_REGEXES = [
  /ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWTs
  /c=[0-9a-fA-F-]+/g, // Queue-it wait token / UUIDs
  /cf_clearance=[a-zA-Z0-9_-]+/g,
  /__cf_bm=[a-zA-Z0-9_-]+/g,
  /cf-ray[-:\s]+[0-9a-zA-Z-]+/gi, // CF-Ray traces inside body
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
  /Cookie["']?\s*:\s*[^\r\n]+/gi,
];

export function redact(payload: RedactTarget): RedactTarget {
  // 1. Redact URL
  const parsedUrl = new URL(payload.url);
  const newParams = new URLSearchParams();
  if (parsedUrl.searchParams.has("q")) newParams.set("q", parsedUrl.searchParams.get("q")!);
  if (parsedUrl.searchParams.has("date"))
    newParams.set("date", parsedUrl.searchParams.get("date")!);
  parsedUrl.search = newParams.toString();
  const redactedUrl = parsedUrl.toString();

  // 2. Redact Headers — shared primitive, defined once in `src/amc/redact.ts`
  // (ADR 0005 §D: fixture capture and production must not carry two copies).
  const redactedHeaders = redactHeaders(payload.headers);

  let redactedBody = payload.body;

  // 3. Redact Body (IPs and Tokens)
  redactedBody = redactedBody.replace(IPV4_REGEX, "[REDACTED_IPV4]");
  redactedBody = redactedBody.replace(IPV6_REGEX, "[REDACTED_IPV6]");
  for (const regex of TOKEN_REGEXES) {
    redactedBody = redactedBody.replace(regex, "[REDACTED_TOKEN]");
  }

  // 4. Fail-closed post-redaction check
  const forbiddenMarkers = ["eyJh", "cf_clearance", "__cf_bm"];
  for (const marker of forbiddenMarkers) {
    if (redactedBody.includes(marker)) {
      throw new Error(
        `Redaction failure: forbidden marker '${marker}' found in body after redaction.`,
      );
    }
  }
  if (IPV4_REGEX.test(redactedBody)) {
    throw new Error(`Redaction failure: IPv4 still found in body after redaction.`);
  }
  if (IPV6_REGEX.test(redactedBody)) {
    throw new Error(`Redaction failure: IPv6 still found in body after redaction.`);
  }

  return {
    ...payload,
    url: redactedUrl,
    headers: redactedHeaders,
    body: redactedBody,
  };
}
