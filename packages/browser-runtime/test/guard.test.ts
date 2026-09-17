import { describe, it, expect } from "vitest";
import {
  checkDocument,
  CORRIDOR_STAGES,
  INITIAL_CORRIDOR_STATE,
  QUEUE_ENTRY_ORIGIN,
  type CorridorState,
} from "../src/guard.js";

const MOVIES = "https://www.amctheatres.com/movies";
const SEATS = "https://www.amctheatres.com/showtimes/123/seats";

function advance(rawUrl: string, from: CorridorState = INITIAL_CORRIDOR_STATE) {
  return checkDocument(from, rawUrl);
}

function accept(rawUrl: string, from: CorridorState = INITIAL_CORRIDOR_STATE): CorridorState {
  const result = advance(rawUrl, from);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result.next;
}

function queueUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${QUEUE_ENTRY_ORIGIN}/?${search.toString()}`;
}

describe("corridor guard — AMC_INITIAL", () => {
  it("accepts each of the six isAllowedUrl patterns (P6.6, ADR 0021)", () => {
    for (const target of [
      MOVIES,
      "https://www.amctheatres.com/movie-theatres?q=90045",
      "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes?date=2026-08-14",
      SEATS,
      "https://www.amctheatres.com/movie-theatres",
      "https://www.amctheatres.com/movie-theatres/los-angeles",
    ]) {
      const result = advance(target);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.classification).toBe("AMC_INITIAL");
        expect(result.next.stage).toBe("QUEUE_ENTRY");
      }
    }
  });

  it("ADR 0021: rejects near-misses of the two new movie-theatres shapes", () => {
    expect(advance("https://www.amctheatres.com/movie-theatres?extra=1")).toMatchObject({
      ok: false,
      reason: "INITIAL_NOT_ALLOWED",
    });
    expect(advance("https://www.amctheatres.com/movie-theatres/los-angeles?extra=1")).toMatchObject(
      {
        ok: false,
        reason: "INITIAL_NOT_ALLOWED",
      },
    );
    expect(
      advance("https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15"),
    ).toMatchObject({
      ok: false,
      reason: "INITIAL_NOT_ALLOWED",
    });
  });

  it("canonicalizes with WHATWG rules: default port and host casing are normalized", () => {
    expect(advance("https://WWW.AMCTHEATRES.COM:443/movies").ok).toBe(true);
  });

  it("rejects a host with a trailing dot — a different origin, not a substring match", () => {
    expect(advance("https://www.amctheatres.com./movies")).toMatchObject({
      ok: false,
      reason: "INITIAL_NOT_ALLOWED",
    });
  });

  it("rejects wrong origin, disallowed path, extra params, and credentials", () => {
    expect(advance("https://evil.example.com/movies")).toMatchObject({
      ok: false,
      reason: "INITIAL_NOT_ALLOWED",
    });
    expect(advance("https://www.amctheatres.com/movies?extra=1")).toMatchObject({
      ok: false,
      reason: "INITIAL_NOT_ALLOWED",
    });
    expect(advance("https://www.amctheatres.com/showtimes/abc/seats")).toMatchObject({
      ok: false,
      reason: "INITIAL_NOT_ALLOWED",
    });
    expect(advance("https://user:pass@www.amctheatres.com/movies")).toMatchObject({
      ok: false,
      reason: "CREDENTIALS_OR_HASH",
    });
    expect(advance("https://www.amctheatres.com/movies#fragment")).toMatchObject({
      ok: false,
      reason: "CREDENTIALS_OR_HASH",
    });
  });

  it("rejects an unparseable URL fail-closed", () => {
    expect(advance("not a url")).toMatchObject({ ok: false, reason: "UNPARSEABLE_URL" });
  });
});

describe("corridor guard — QUEUE_ENTRY (ADR 0005 §B exact rules)", () => {
  const afterInitial = accept(MOVIES);

  it("accepts the exact host, pathname /, and the allowed key set with a valid decoded t", () => {
    const result = advance(
      queueUrl({
        c: "amc",
        e: "seats",
        ver: "v1",
        cver: "2",
        man: "seatfinder",
        enqueuetoken: "0000-1111",
        t: SEATS,
        kupver: "3",
      }),
      afterInitial,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.classification).toBe("QUEUE_ENTRY");
      expect(result.next.stage).toBe("AMC_TOKEN_RETURN");
    }
  });

  it("rejects the .queue-it.net host — the guard uses ADR 0005's exact host, not classify.ts's heuristic (P6.10)", () => {
    const result = advance(
      "https://www.amctheatres.queue-it.net/?c=amc&t=" + encodeURIComponent(MOVIES),
      afterInitial,
    );
    expect(result).toMatchObject({ ok: false, reason: "WRONG_ORIGIN" });
  });

  it("rejects a wrong origin and an unexpected pathname", () => {
    expect(
      advance(
        "https://queue.evil.example.com/?c=amc&t=" + encodeURIComponent(MOVIES),
        afterInitial,
      ),
    ).toMatchObject({ ok: false, reason: "WRONG_ORIGIN" });
    expect(
      advance(
        `${QUEUE_ENTRY_ORIGIN}/some/other?c=amc&t=${encodeURIComponent(MOVIES)}`,
        afterInitial,
      ),
    ).toMatchObject({ ok: false, reason: "UNEXPECTED_PATHNAME" });
  });

  it("rejects any query key outside the allowlist, and duplicated keys", () => {
    expect(advance(queueUrl({ c: "amc", t: MOVIES, sneaky: "1" }), afterInitial)).toMatchObject({
      ok: false,
      reason: "DISALLOWED_QUERY_KEY",
    });
    const duplicated = new URLSearchParams([
      ["c", "amc"],
      ["c", "dupe"],
      ["t", MOVIES],
    ]);
    expect(advance(`${QUEUE_ENTRY_ORIGIN}/?${duplicated.toString()}`, afterInitial)).toMatchObject({
      ok: false,
      reason: "DISALLOWED_QUERY_KEY",
    });
  });

  it("rejects a missing or empty t constraint", () => {
    expect(advance(queueUrl({ c: "amc" }), afterInitial)).toMatchObject({
      ok: false,
      reason: "MISSING_T",
    });
    expect(advance(queueUrl({ c: "amc", t: "" }), afterInitial)).toMatchObject({
      ok: false,
      reason: "MISSING_T",
    });
  });

  it("rejects a t that does not decode to an AMC_INITIAL-valid URL", () => {
    // Wrong origin after decode.
    expect(
      advance(queueUrl({ c: "amc", t: "https://evil.example.com/movies" }), afterInitial),
    ).toMatchObject({ ok: false, reason: "INVALID_T_TARGET" });
    // Not a URL at all.
    expect(advance(queueUrl({ c: "amc", t: "opaque-token" }), afterInitial)).toMatchObject({
      ok: false,
      reason: "INVALID_T_TARGET",
    });
    // Double-encoded: one decode leaves a percent-encoded string, which is unparseable.
    expect(
      advance(
        queueUrl({ c: "amc", t: encodeURIComponent(encodeURIComponent(MOVIES)) }),
        afterInitial,
      ),
    ).toMatchObject({ ok: false, reason: "INVALID_T_TARGET" });
    // Decoded target with a disallowed AMC shape.
    expect(
      advance(
        queueUrl({ c: "amc", t: "https://www.amctheatres.com/movies?extra=1" }),
        afterInitial,
      ),
    ).toMatchObject({ ok: false, reason: "INVALID_T_TARGET" });
  });

  it("rejects any query key outside the allowlist, and duplicated keys", () => {
    expect(advance(queueUrl({ c: "amc", t: MOVIES, sneaky: "1" }), afterInitial)).toMatchObject({
      ok: false,
      reason: "DISALLOWED_QUERY_KEY",
    });
    const duplicated = new URLSearchParams([
      ["c", "amc"],
      ["c", "dupe"],
      ["t", MOVIES],
    ]);
    expect(advance(`${QUEUE_ENTRY_ORIGIN}/?${duplicated.toString()}`, afterInitial)).toMatchObject({
      ok: false,
      reason: "DISALLOWED_QUERY_KEY",
    });
  });

  it("rejects credentials or a hash on the queue URL", () => {
    expect(
      advance(`${QUEUE_ENTRY_ORIGIN}/?c=amc&t=${encodeURIComponent(MOVIES)}#frag`, afterInitial),
    ).toMatchObject({ ok: false, reason: "CREDENTIALS_OR_HASH" });
  });
});

describe("corridor guard — AMC_TOKEN_RETURN", () => {
  const afterInitial = accept(MOVIES);
  const afterQueue = accept(
    queueUrl({ c: "amc", enqueuetoken: "0000-1111", t: MOVIES }),
    afterInitial,
  );

  it("accepts the same pathname plus exactly one queueittoken param", () => {
    const result = advance(`${MOVIES}?queueittoken=q-123`, afterQueue);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.classification).toBe("AMC_TOKEN_RETURN");
      expect(result.next.stage).toBe("AMC_CLEAN_RETURN");
    }
  });

  it("accepts the token return for a query-bearing initial route (key-level rule)", () => {
    const theatresInitial = accept("https://www.amctheatres.com/movie-theatres?q=90045");
    const theatresQueue = accept(
      queueUrl({ c: "amc", t: "https://www.amctheatres.com/movie-theatres?q=90045" }),
      theatresInitial,
    );
    const result = advance(
      "https://www.amctheatres.com/movie-theatres?q=90045&queueittoken=q-456",
      theatresQueue,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.next.stage).toBe("AMC_CLEAN_RETURN");
    }
  });

  it("rejects a wrong origin and an unexpected pathname", () => {
    expect(advance("https://evil.example.com/movies?queueittoken=q", afterQueue)).toMatchObject({
      ok: false,
      reason: "WRONG_ORIGIN",
    });
    expect(advance("https://www.amctheatres.com/other?queueittoken=q", afterQueue)).toMatchObject({
      ok: false,
      reason: "UNEXPECTED_PATHNAME",
    });
  });

  it("rejects a missing, empty, or duplicated queueittoken", () => {
    expect(advance(MOVIES, afterQueue)).toMatchObject({
      ok: false,
      reason: "UNEXPECTED_QUERY_SHAPE",
    });
    expect(advance(`${MOVIES}?queueittoken=`, afterQueue)).toMatchObject({
      ok: false,
      reason: "UNEXPECTED_QUERY_SHAPE",
    });
    expect(advance(`${MOVIES}?queueittoken=a&queueittoken=b`, afterQueue)).toMatchObject({
      ok: false,
      reason: "UNEXPECTED_QUERY_SHAPE",
    });
  });

  it("rejects a dropped initial query key and an extra non-queueittoken key", () => {
    const theatresInitial = accept("https://www.amctheatres.com/movie-theatres?q=90045");
    const theatresQueue = accept(
      queueUrl({ t: "https://www.amctheatres.com/movie-theatres?q=90045" }),
      theatresInitial,
    );
    expect(
      advance("https://www.amctheatres.com/movie-theatres?queueittoken=q", theatresQueue),
    ).toMatchObject({ ok: false, reason: "UNEXPECTED_QUERY_SHAPE" });
    expect(
      advance(
        "https://www.amctheatres.com/movie-theatres?q=90045&queueittoken=q&extra=1",
        theatresQueue,
      ),
    ).toMatchObject({ ok: false, reason: "UNEXPECTED_QUERY_SHAPE" });
  });
});

describe("corridor guard — AMC_CLEAN_RETURN", () => {
  const afterInitial = accept(MOVIES);
  const afterQueue = accept(
    queueUrl({ c: "amc", enqueuetoken: "0000-1111", t: MOVIES }),
    afterInitial,
  );
  const afterToken = accept(`${MOVIES}?queueittoken=q-123`, afterQueue);

  it("accepts the same pathname with no added params, re-validated by isAllowedUrl", () => {
    const result = advance(MOVIES, afterToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.classification).toBe("AMC_CLEAN_RETURN");
      expect(result.next.stage).toBe("COMPLETE");
    }
  });

  it("rejects extra params (P6.9: no added params)", () => {
    expect(advance(`${MOVIES}?leftover=1`, afterToken)).toMatchObject({
      ok: false,
      reason: "EXTRA_PARAMS",
    });
  });

  it("rejects an unexpected pathname", () => {
    expect(advance("https://www.amctheatres.com/other", afterToken)).toMatchObject({
      ok: false,
      reason: "UNEXPECTED_PATHNAME",
    });
  });

  it("rejects a further document after the corridor completed (UNEXPECTED_HOP)", () => {
    const complete = accept(MOVIES, afterToken);
    expect(advance(MOVIES, complete)).toMatchObject({ ok: false, reason: "UNEXPECTED_HOP" });
  });

  it("rejects a further hop even at the QUEUE_ENTRY origin after completion", () => {
    const complete = accept(MOVIES, afterToken);
    expect(advance(queueUrl({ c: "amc", t: MOVIES }), complete)).toMatchObject({
      ok: false,
      reason: "UNEXPECTED_HOP",
    });
  });
});

describe("corridor guard — stage vocabulary (P6.14)", () => {
  it("exposes exactly the four fixed stage labels", () => {
    expect(CORRIDOR_STAGES).toEqual([
      "AMC_INITIAL",
      "QUEUE_ENTRY",
      "AMC_TOKEN_RETURN",
      "AMC_CLEAN_RETURN",
    ]);
  });
});
