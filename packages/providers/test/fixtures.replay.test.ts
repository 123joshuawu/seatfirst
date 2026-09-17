// Production replay: everything under `fixtures/redacted/` against its golden, through the AMC
// adapter's real request pipeline (classify-then-parse, per-route dispatch) implemented in
// `test/support/amc-replay-normalize.ts` and plugged into the P2 harness's `normalize` seam
// (`test/support/replay.ts`). P5.12 promoted the first real redacted capture corpus (the
// 2026-08-13 session, 27 fixtures); 11 pairs (10 real seat-page captures plus the
// deliberately-invalid `showtimeId=0` case) are committed here and replay through the real
// parsers. The other 15 (12 schedule, 3 theatre-search) are held out pending an open finding —
// their captured bodies do not contain the result/schedule data their parsers expect
// (`docs/backlog.md` P5 row) — and are not yet present under `fixtures/redacted/`. A lone
// fixture/golden, a payload that stops classifying or parsing, or a normalized result that
// drifts from its golden fails this test loudly. `UPDATE_GOLDENS=1` is the one explicit opt-in
// this file reads (P2.4); the harness module never reads `process.env` itself.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { amcReplayNormalize } from "./support/amc-replay-normalize.js";
import { replayFixtures } from "./support/replay.js";

const FIXTURES_REDACTED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "redacted",
);

describe("fixture corpus replay (packages/providers/fixtures/redacted)", () => {
  it("replays every redacted fixture against its golden through the AMC classify-then-parse pipeline", async () => {
    const updateGoldens = process.env.UPDATE_GOLDENS === "1";
    const report = await replayFixtures(FIXTURES_REDACTED_DIR, {
      normalize: amcReplayNormalize,
      updateGoldens,
    });
    if (updateGoldens && report.updated.length > 0) {
      // `no-console` allows `warn` (packages/config/eslint.base.js:37) — this is meant to be
      // seen when a developer explicitly runs the regeneration command.
      console.warn(
        `UPDATE_GOLDENS=1: wrote ${report.updated.length} golden file(s): ${report.updated.join(", ")}`,
      );
    }
    expect(report.issues).toEqual([]);
    // Non-vacuous: the promoted corpus is real (26 fixture/golden pairs). A regression that
    // empties the directory again must fail here, not pass on zero pairs.
    expect(report.matched.length).toBeGreaterThan(0);
  });
});
