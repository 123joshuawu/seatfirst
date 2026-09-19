import { describe, expect, it, vi } from "vitest";
import type { ShowtimeId } from "@seatfirst/core";
import { parseSeats } from "../src/amc/parse/seats.js";
import { parseShowtimes } from "../src/amc/parse/showtimes.js";
import { AmcProvider } from "../src/amc/provider.js";
import type { AmcFetcher } from "../src/amc/fetcher.js";
import {
  ProviderError,
  attachUpstreamChangedDiagnostic,
  getUpstreamChangedDiagnostic,
} from "../src/errors.js";

function makeHtml(...jsonRows: string[]): string {
  const lines = [`0:"$L1"`, ...jsonRows.map((row, i) => `${i + 1}:${row}`)];
  return `<script>self.__next_f.push([1, ${JSON.stringify(`${lines.join("\n")}\n`)}])</script>`;
}

const observationTime = new Date("2026-08-10T12:00:00Z");

describe("UPSTREAM_CHANGED diagnostic side channel", () => {
  it("parseSeats attaches the raw body + URL to the thrown error, outside providerMeta", () => {
    const html = makeHtml(`{"notLayout": true}`);
    let caught: unknown;
    try {
      parseSeats(html, observationTime, "http://test/seats?x=1", 100);
    } catch (err: unknown) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("UPSTREAM_CHANGED");
    expect(getUpstreamChangedDiagnostic(caught)).toEqual({
      url: "http://test/seats?x=1",
      body: html,
    });
    // The persisted/comparable channel carries no raw content.
    expect(caught).not.toHaveProperty("providerMeta.body");
  });

  it("parseShowtimes attaches the diagnostic when both extraction and the DOM fallback fail", () => {
    const html = makeHtml(`{"notSchedule": true}`);
    let caught: unknown;
    try {
      parseShowtimes(html, observationTime, "http://test/showtimes?date=2026-08-13");
    } catch (err: unknown) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("UPSTREAM_CHANGED");
    expect(getUpstreamChangedDiagnostic(caught)).toEqual({
      url: "http://test/showtimes?date=2026-08-13",
      body: html,
    });
  });

  it("provider outcomes keep their exact observable shape while carrying the diagnostic", async () => {
    const html = makeHtml(`{"notLayout": true}`);
    const mockFetcher = {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        value: { body: html, log: { enrich: vi.fn() } },
      }),
    };
    const provider = new AmcProvider(mockFetcher as unknown as AmcFetcher);

    const res = await provider.getSeatPage("amc:showtime:123" as ShowtimeId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Exact pre-change shape: no enumerable diagnostic key for toEqual/JSON/goldens to see.
    expect({ ...res }).toEqual({
      ok: false,
      code: "UPSTREAM_CHANGED",
      message: res.message,
      providerMeta: res.providerMeta,
    });
    expect(JSON.stringify(res)).not.toContain("notLayout");
    expect(Object.keys(res)).not.toContain("diagnostic");
    expect(getUpstreamChangedDiagnostic(res)?.body).toBe(html);
    expect(getUpstreamChangedDiagnostic(res)?.url).toContain("/showtimes/123/seats");
  });

  it("attach is a no-op for non-UPSTREAM_CHANGED errors and first write wins", () => {
    const other = new ProviderError("NOT_FOUND", "missing");
    attachUpstreamChangedDiagnostic(other, { url: "http://test", body: "<html/>" });
    expect(getUpstreamChangedDiagnostic(other)).toBeUndefined();

    const changed = new ProviderError("UPSTREAM_CHANGED", "drift");
    attachUpstreamChangedDiagnostic(changed, { url: "http://first", body: "a" });
    attachUpstreamChangedDiagnostic(changed, { url: "http://second", body: "b" });
    expect(getUpstreamChangedDiagnostic(changed)).toEqual({ url: "http://first", body: "a" });
    expect(getUpstreamChangedDiagnostic(null)).toBeUndefined();
  });
});
