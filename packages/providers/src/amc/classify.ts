import type { ProviderErrorCode } from "../errors.js";

export interface BodyMarkers {
  readonly finalHost: string;
  readonly bodyPrefix: string;
}

export type ClassifyResult =
  { readonly ok: true } | { readonly ok: false; readonly code: ProviderErrorCode };

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

export function classifyResponse(
  status: number,
  headers: Record<string, string | undefined>,
  bodyMarkers: BodyMarkers,
): ClassifyResult {
  // 1. cf-mitigated: challenge
  const cfMitigated = getHeader(headers, "cf-mitigated");
  if (cfMitigated?.toLowerCase() === "challenge") {
    return { ok: false, code: "CHALLENGE_REQUIRED" };
  }

  const finalHost = bodyMarkers.finalHost.toLowerCase();
  const bodyPrefix = bodyMarkers.bodyPrefix.toLowerCase();

  // 2. Queue-it
  if (finalHost.endsWith(".queue-it.net") || /queue-it|waiting room/.test(bodyPrefix)) {
    return { ok: false, code: "UPSTREAM_QUEUED" };
  }

  // 3. Rate limited
  if (status === 429) {
    return { ok: false, code: "RATE_LIMITED" };
  }

  // 4. Cloudflare blocked
  if (status === 403 && /cloudflare|attention required|just a moment/.test(bodyPrefix)) {
    return { ok: false, code: "UPSTREAM_BLOCKED" };
  }

  // 5. Branded 404 under 200 -> NOT_FOUND, or actual 404.
  //    AMC's Next.js App Router renders its branded not-found page with HTTP 200 when a
  //    route does not exist. Next.js emits its internal `notFound()` digest constant only
  //    when the requested route actually resolves to the not-found boundary: either as the
  //    aborting render's Flight error row `E{"digest":"NEXT_NOT_FOUND"}` (quotes escaped
  //    inside the page's `self.__next_f.push` chunk) or as the rendered boundary marker
  //    `<template data-dgst="NEXT_NOT_FOUND">`. Every healthy AMC page merely preloads the
  //    boundary component's markup (its "Error 404" heading) into the route tree without
  //    emitting a digest, so the markup alone cannot discriminate a true 404. Verified
  //    against all 26 redacted fixtures: the heading markup appears in every body, the
  //    digest in exactly one — the true 404 (`seats-invalid-showtime-0`).
  if (
    (status === 200 &&
      /digest\\?"\s*:\s*\\?"next_not_found|data-dgst\s*=\s*"?next_not_found/.test(bodyPrefix)) ||
    status === 404
  ) {
    return { ok: false, code: "NOT_FOUND" };
  }

  return { ok: true };
}
