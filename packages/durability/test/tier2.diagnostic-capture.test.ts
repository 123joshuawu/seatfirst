import { describe, expect, it } from "vitest";

import {
  insertDiagnosticCapture,
  sweepExpiredDiagnosticCaptures,
} from "../src/repository.js";

import { useDatabase } from "./support/pg.js";

/**
 * Tier 2 — the provider-run diagnostic capture boundaries (migration 026): the
 * actor's best-effort insert of the raw url/headers/S3-key row, and the 30-day
 * hard-delete sweep that returns the deleted rows' S3 keys so the caller can
 * remove the objects after the Postgres delete commits. Lowest tier that
 * catches each bug (the insert is a guarded multi-column write with a jsonb
 * param; the sweep is a conditional DELETE whose RETURNING drives S3 cleanup).
 */
describe("tier 2 — diagnostic capture insert and expiry sweep", () => {
  const db = useDatabase();

  it("DIAGNOSTIC_CAPTURE_INSERT stores the raw url, raw headers, and S3 keys", async () => {
    const rows = await insertDiagnosticCapture(db(), {
      captureId: "cap-insert",
      runId: "run-insert",
      outcomeKind: "UPSTREAM_CHANGED",
      url: "https://www.amctheatres.com/showtimes?movie=123&perf=456",
      headers: { "content-type": "text/html", "x-amc-cache": "MISS" },
      bodyS3Key: "UPSTREAM_CHANGED/run-insert/cap-insert-body",
      screenshotS3Key: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      capture_id: "cap-insert",
      run_id: "run-insert",
      outcome_kind: "UPSTREAM_CHANGED",
      url: "https://www.amctheatres.com/showtimes?movie=123&perf=456",
      headers: { "content-type": "text/html", "x-amc-cache": "MISS" },
      body_s3_key: "UPSTREAM_CHANGED/run-insert/cap-insert-body",
      screenshot_s3_key: null,
    });
    expect(rows[0]!.captured_at).toBeInstanceOf(Date);
  });

  it("the outcome CHECK admits only the three terminal capture outcomes", async () => {
    await expect(
      insertDiagnosticCapture(db(), {
        captureId: "cap-scope",
        runId: "run-scope",
        outcomeKind: "SUCCESS" as never,
        url: "https://www.amctheatres.com/",
        headers: {},
        bodyS3Key: "SUCCESS/run-scope/cap-scope-body",
        screenshotS3Key: null,
      }),
    ).rejects.toThrow(/outcome/i);
  });

  it("DIAGNOSTIC_CAPTURE_SWEEP_EXPIRED deletes only captures older than the cutoff and returns their S3 keys", async () => {
    await insertDiagnosticCapture(db(), {
      captureId: "cap-swept",
      runId: "run-swept",
      outcomeKind: "UPSTREAM_BLOCKED",
      url: "https://www.amctheatres.com/blocked",
      headers: { "cf-mitigated": "challenge" },
      bodyS3Key: "UPSTREAM_BLOCKED/run-swept/cap-swept-body",
      screenshotS3Key: "UPSTREAM_BLOCKED/run-swept/cap-swept-shot",
    });
    await insertDiagnosticCapture(db(), {
      captureId: "cap-kept",
      runId: "run-kept",
      outcomeKind: "CHALLENGE_REQUIRED",
      url: "https://www.amctheatres.com/challenge",
      headers: { "cf-mitigated": "challenge" },
      bodyS3Key: "CHALLENGE_REQUIRED/run-kept/cap-kept-body",
      screenshotS3Key: null,
    });

    // A cutoff an hour in the future expires both test rows (captured_at <= now).
    const swept = await sweepExpiredDiagnosticCaptures(
      db(),
      new Date(Date.now() + 60 * 60 * 1000),
    );
    const byId = new Map(swept.map((row) => [row.capture_id, row]));
    expect(byId.get("cap-swept")).toMatchObject({
      run_id: "run-swept",
      outcome_kind: "UPSTREAM_BLOCKED",
      body_s3_key: "UPSTREAM_BLOCKED/run-swept/cap-swept-body",
      screenshot_s3_key: "UPSTREAM_BLOCKED/run-swept/cap-swept-shot",
    });
    expect(byId.get("cap-kept")).toMatchObject({
      body_s3_key: "CHALLENGE_REQUIRED/run-kept/cap-kept-body",
      screenshot_s3_key: null,
    });

    const remaining = await db().rows<{ capture_id: string }>(
      `SELECT capture_id FROM provider_run_diagnostic_capture WHERE capture_id IN ('cap-swept', 'cap-kept')`,
    );
    expect(remaining).toEqual([]);
  });

  it("a cutoff in the past sweeps nothing and leaves fresh captures alone", async () => {
    await insertDiagnosticCapture(db(), {
      captureId: "cap-fresh",
      runId: "run-fresh",
      outcomeKind: "UPSTREAM_CHANGED",
      url: "https://www.amctheatres.com/fresh",
      headers: {},
      bodyS3Key: "UPSTREAM_CHANGED/run-fresh/cap-fresh-body",
      screenshotS3Key: null,
    });

    const swept = await sweepExpiredDiagnosticCaptures(db(), new Date(0));
    expect(swept).toEqual([]);

    const remaining = await db().rows<{ capture_id: string }>(
      `SELECT capture_id FROM provider_run_diagnostic_capture WHERE capture_id = 'cap-fresh'`,
    );
    expect(remaining).toEqual([{ capture_id: "cap-fresh" }]);
  });
});
