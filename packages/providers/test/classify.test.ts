/**
 * Unit tests for classifyResponse's rule 5: branded 404 under HTTP 200 (src/amc/classify.ts).
 *
 * AMC's Next.js App Router preloads the not-found boundary component's markup (an
 * "Error 404" heading) into every page's Flight route tree, so the markup alone cannot
 * distinguish a genuine 404 from a healthy page. The real structural signal is Next.js's
 * internal notFound() digest constant: it is emitted only when the requested route
 * actually resolves to the not-found boundary — either as the aborting render's Flight
 * error row `E{"digest":"NEXT_NOT_FOUND"}` or as the rendered boundary marker
 * `<template data-dgst="NEXT_NOT_FOUND">`.
 *
 * The bodies below are real excerpts from the promoted redacted fixture corpus
 * (fixtures/redacted/): the markup-only body comes from a genuinely-successful page
 * (schedule-amc-evanston-12-2026-08-13), the digest bodies from the genuine 404
 * (seats-invalid-showtime-0). Backslashes in the literals are the Flight stream's own
 * JSON escaping as it appears byte-for-byte in the captured bodies.
 */
import { describe, expect, it } from "vitest";

import { classifyResponse } from "../src/amc/classify.js";

const HOST: { finalHost: string } = { finalHost: "www.amctheatres.com" };

describe("classifyResponse rule 5 (branded 404 under 200)", () => {
  it("does not classify a page that merely preloads the not-found markup as NOT_FOUND", () => {
    // Real excerpt from a healthy schedule page's route tree: the not-found boundary
    // component's "Error 404" heading is present but never rendered.
    const bodyPrefix =
      '"header","1",{"children":["\\n          ",["$","h1","1",{"className":"YUTHi-text-xs YUTHi-uppercase","children":["Error 404"]}],"\\n          ",["$","h2","3",{"className":"';
    expect(classifyResponse(200, {}, { ...HOST, bodyPrefix })).toEqual({ ok: true });
  });

  it("classifies the Flight notFound digest error row as NOT_FOUND", () => {
    // Real excerpt from the genuine 404: the server aborted the page render with
    // notFound(), emitting this error row into the Flight stream.
    const bodyPrefix = 'E{\\"digest\\":\\"NEXT_NOT_FOUND\\"}\\n"])</script><script>self._';
    expect(classifyResponse(200, {}, { ...HOST, bodyPrefix })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("classifies the rendered not-found boundary template as NOT_FOUND", () => {
    // Real excerpt from the genuine 404's HTML: the rendered error boundary marker.
    const bodyPrefix =
      '<!--$!--><template data-dgst="NEXT_NOT_FOUND"></template><div class="h-[100dvh]"';
    expect(classifyResponse(200, {}, { ...HOST, bodyPrefix })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });

  it("classifies status 404 as NOT_FOUND regardless of body", () => {
    expect(classifyResponse(404, {}, { ...HOST, bodyPrefix: "<html>anything</html>" })).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
  });
});
