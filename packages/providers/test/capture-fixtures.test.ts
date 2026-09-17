import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runCaptureSession, cliMain, CAPTURE_TARGETS } from "../scripts/capture-fixtures.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("capture-fixtures module (P3)", () => {
  function createStubFetcher(classifications: string[] = []) {
    let callCount = 0;
    // We override fetchImpl to return our stubbed Response.
    const stubFetch = vi.fn(() => {
      const idx = callCount++;
      const classification = classifications[idx] || "OK";

      const headers = new Headers({
        "content-type": "text/html",
      });
      if (classification === "CHALLENGE_REQUIRED") {
        headers.set("cf-mitigated", "challenge");
      }

      if (classification === "UPSTREAM_BLOCKED") {
        return Promise.resolve(
          new Response("Attention Required! | Cloudflare", {
            status: 403,
            headers,
          }),
        );
      }

      return Promise.resolve(
        new Response("stub body", {
          status: classification === "NOT_FOUND" ? 404 : classification === "RETRYABLE" ? 502 : 200,
          headers,
        }),
      );
    });

    const fetchOptions = {
      userAgent: "TestAgent (https://test.com)",
      maxAttempts: 1,
      backoffBaseMs: 100,
      backoffCeilingMs: 1000,
      jitterWindowMs: 0,
      socketTimeoutMs: 1000,
    };
    return { fetchOptions, transport: { request: stubFetch, isLive: false } };
  }

  it("respects the budget and stops exactly at the cap (P3.1 verification)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "seatfirst-test-"));
    const logs: string[] = [];
    const logWriter = (l: string) => logs.push(l);

    const { fetchOptions, transport } = createStubFetcher();

    const result = await runCaptureSession({
      targets: CAPTURE_TARGETS,
      budget: 2, // lowered cap via test injection
      fetchOptions,
      transport,
      outDir,
      logWriter,
    });

    expect(result.aborted).toBe(false);
    expect(result.requestsSpent).toBe(2);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("Budget of 2 requests spent. Target left uncaptured"))).toBe(
      true,
    );

    // Positive control: same target list, larger budget captures more
    const result2 = await runCaptureSession({
      targets: CAPTURE_TARGETS,
      budget: 4,
      fetchOptions,
      transport,
      outDir,
      logWriter: () => {},
    });
    expect(result2.requestsSpent).toBe(4);

    rmSync(outDir, { recursive: true, force: true });
  });
  it("stops exactly at the budget cap even with retryable failures (P3.1 verification)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "seatfirst-test-"));
    const logs: string[] = [];
    const logWriter = (l: string) => logs.push(l);

    const { fetchOptions, transport } = createStubFetcher([
      "RETRYABLE",
      "RETRYABLE",
      "RETRYABLE",
      "RETRYABLE",
    ]);
    fetchOptions.maxAttempts = 5; // Instruct AmcFetcher to retry 5 times

    // We expect the wrapped fetch to be called up to the budget cap, which is 2.
    // The target list is long, but it will get stuck retrying the first one.
    // The total calls to `fetch` should be exactly 2.

    const result = await runCaptureSession({
      targets: CAPTURE_TARGETS,
      budget: 2,
      fetchOptions,
      transport,
      outDir,
      logWriter,
    });

    expect(result.requestsSpent).toBe(2);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes("Budget of 2 requests spent."))).toBe(true);

    rmSync(outDir, { recursive: true, force: true });
  });

  it("aborts on CHALLENGE_REQUIRED classification (P3.4 verification)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "seatfirst-test-"));
    const logs: string[] = [];
    const logWriter = (l: string) => logs.push(l);

    // Third response is CHALLENGE_REQUIRED
    const { transport } = createStubFetcher(["OK", "OK", "CHALLENGE_REQUIRED"]);

    // Drive through cliMain to test the full abort path
    await cliMain(
      ["node", "script", "--confirm-live-session=yes-i-understand", "--operator=test-operator"],
      {
        SEATFIRST_ENV: "prod",
        AMC_USER_AGENT: "test (https://test.com)",
        AMC_MAX_ATTEMPTS: "1",
        AMC_BACKOFF_BASE_MS: "100",
        AMC_BACKOFF_CEILING_MS: "1000",
        AMC_JITTER_WINDOW_MS: "0",
        AMC_SOCKET_TIMEOUT_MS: "1000",
      },
      { transport, outDir, logWriter },
    );

    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset

    // Verify transport called exactly 3 times
    expect(transport.request).toHaveBeenCalledTimes(3);

    // Verify abort was logged
    expect(
      logs.some((l) => l.includes("[ABORT] Traffic control encountered: CHALLENGE_REQUIRED")),
    ).toBe(true);
    rmSync(outDir, { recursive: true, force: true });
  });

  it("aborts and exits non-zero on a sticky UPSTREAM_BLOCKED response", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "seatfirst-test-"));
    const logs: string[] = [];
    const { transport } = createStubFetcher(["UPSTREAM_BLOCKED"]);

    await cliMain(
      ["node", "script", "--confirm-live-session=yes-i-understand", "--operator=test-operator"],
      {
        SEATFIRST_ENV: "prod",
        AMC_USER_AGENT: "test (https://test.com)",
        AMC_MAX_ATTEMPTS: "1",
        AMC_BACKOFF_BASE_MS: "100",
        AMC_BACKOFF_CEILING_MS: "1000",
        AMC_JITTER_WINDOW_MS: "0",
        AMC_SOCKET_TIMEOUT_MS: "1000",
      },
      { transport, outDir, logWriter: (l) => logs.push(l) },
    );

    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(logs.filter((l) => l.includes("[ABORT]"))).toEqual([
      "[ABORT] Traffic control encountered: UPSTREAM_BLOCKED. Aborting session.",
    ]);
    expect(logs).toContain("Session ended. Aborted: true. Requests spent: 1/150.");

    rmSync(outDir, { recursive: true, force: true });
  });

  it("rejects a NaN or fractional budget before starting the session (P3.1 regression)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "seatfirst-test-"));
    const { fetchOptions, transport } = createStubFetcher();

    await expect(
      runCaptureSession({
        targets: CAPTURE_TARGETS,
        budget: Number.NaN,
        fetchOptions,
        transport,
        outDir,
        logWriter: () => {},
      }),
    ).rejects.toThrow(/Budget must be an integer/);

    await expect(
      runCaptureSession({
        targets: CAPTURE_TARGETS,
        budget: 2.5,
        fetchOptions,
        transport,
        outDir,
        logWriter: () => {},
      }),
    ).rejects.toThrow(/Budget must be an integer/);

    expect(transport.request).not.toHaveBeenCalled();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("does not retry within AmcFetcher when local post-processing (redact/write) fails after a real response (P3/P4 regression)", async () => {
    // A NOT_FOUND classification triggers the wrapper's own redact+write path; pointing outDir at
    // a directory that does not exist makes that local write throw, independent of the network call.
    const brokenOutDir = join(tmpdir(), "seatfirst-test-missing-" + Date.now(), "nested");
    const logs: string[] = [];
    const { fetchOptions, transport } = createStubFetcher(["NOT_FOUND"]);
    fetchOptions.maxAttempts = 3; // if a local failure were mistakenly retried, this would be > 1

    await expect(
      runCaptureSession({
        targets: CAPTURE_TARGETS,
        budget: 5,
        fetchOptions,
        transport,
        outDir: brokenOutDir,
        logWriter: (l) => logs.push(l),
      }),
    ).rejects.toThrow();

    // Exactly one upstream request, even though maxAttempts allowed 3 — local failure must not
    // be treated as a retryable transport/network error.
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it("writes exactly one abort record to the log when the session throws after local processing fails (P3.7 regression)", async () => {
    const brokenOutDir = join(tmpdir(), "seatfirst-test-missing-" + Date.now(), "nested");
    const logs: string[] = [];
    const { transport } = createStubFetcher(["NOT_FOUND"]);

    await cliMain(
      ["node", "script", "--confirm-live-session=yes-i-understand", "--operator=test-operator"],
      {
        SEATFIRST_ENV: "prod",
        AMC_USER_AGENT: "test (https://test.com)",
        AMC_MAX_ATTEMPTS: "1",
        AMC_BACKOFF_BASE_MS: "100",
        AMC_BACKOFF_CEILING_MS: "1000",
        AMC_JITTER_WINDOW_MS: "0",
        AMC_SOCKET_TIMEOUT_MS: "1000",
      },
      { transport, outDir: brokenOutDir, logWriter: (l) => logs.push(l) },
    );

    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset

    const abortLines = logs.filter((l) => l.includes("[ABORT]"));
    // Exactly one [ABORT] line — never zero, never a duplicate — and it must be sanitized
    // (never carry the raw error/exception text, which could contain a URL or token).
    expect(abortLines).toHaveLength(1);
    expect(abortLines[0]).toBe("[ABORT] Fatal error encountered.");
    const sessionEndedLines = logs.filter((l) => l.startsWith("Session ended."));
    expect(sessionEndedLines).toHaveLength(1);
  });

  describe("CLI refusals", () => {
    let originalError: typeof console.error;
    let originalExitCode: typeof process.exitCode;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalError = console.error;
      originalExitCode = process.exitCode;
      process.exitCode = 0;
      fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      console.error = originalError;
      process.exitCode = originalExitCode;
      vi.unstubAllGlobals();
    });

    it("refuses to run when SEATFIRST_ENV=ci", async () => {
      let errOutput = "";
      console.error = (msg: string) => {
        errOutput += msg;
      };

      await cliMain(
        [
          "node",
          "capture-fixtures.js",
          "--confirm-live-session=yes-i-understand",
          "--operator=test",
        ],
        {
          SEATFIRST_ENV: "ci",
        },
      );

      expect(errOutput).toContain("SEATFIRST_ENV=ci is set");
      expect(process.exitCode).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses to run without confirmation flag", async () => {
      let errOutput = "";
      console.error = (msg: string) => {
        errOutput += msg;
      };

      await cliMain(["node", "capture-fixtures.js", "--operator=test"], {});

      expect(errOutput).toContain("missing --confirm-live-session=yes-i-understand flag");
      expect(process.exitCode).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses to run if any traffic tunable is missing", async () => {
      let errOutput = "";
      console.error = (msg: string) => {
        errOutput += msg;
      };

      const envWithoutUA = {
        AMC_MAX_ATTEMPTS: "1",
        AMC_BACKOFF_BASE_MS: "100",
        AMC_BACKOFF_CEILING_MS: "1000",
        AMC_JITTER_WINDOW_MS: "50",
        AMC_SOCKET_TIMEOUT_MS: "15000",
      };

      await cliMain(
        [
          "node",
          "capture-fixtures.js",
          "--confirm-live-session=yes-i-understand",
          "--operator=test",
        ],
        envWithoutUA,
      );

      expect(errOutput).toContain("missing required environment variable AMC_USER_AGENT");
      expect(process.exitCode).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses to run if traffic tunables are not valid integers", async () => {
      let errOutput = "";
      console.error = (msg: string) => {
        errOutput += msg;
      };

      const invalidEnv = {
        AMC_USER_AGENT: "Test/1.0",
        AMC_MAX_ATTEMPTS: "one",
        AMC_BACKOFF_BASE_MS: "100",
        AMC_BACKOFF_CEILING_MS: "1000",
        AMC_JITTER_WINDOW_MS: "50",
        AMC_SOCKET_TIMEOUT_MS: "15000",
      };
      await cliMain(
        [
          "node",
          "capture-fixtures.js",
          "--confirm-live-session=yes-i-understand",
          "--operator=test",
        ],
        invalidEnv,
      );

      expect(errOutput).toContain("one or more traffic tunables are not valid integers");
      expect(process.exitCode).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
