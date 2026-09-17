// Self-test suite for the fixture replay harness (P2.3, P2.4). Proves the harness is not
// vacuous by exercising its loud-failure paths against synthetic, obviously-fake payloads —
// never against the real (today empty) `packages/providers/fixtures/redacted/` corpus, which
// cannot exercise a mismatch or an orphan by construction.
//
// Every JSON payload under `test/support/__fixtures__/` exists only to drive this suite and is
// labeled as such in its own `providerMeta.note` field. None of them may be treated as, or
// replace, a captured upstream response — `CONTRIBUTING.md` #Fixtures forbids synthesizing a
// file that "looks like" a captured payload, and these live under `test/support/`, never under
// `packages/providers/fixtures/`.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { replayFixtures } from "./replay.js";

const SELF_TEST_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ORPHAN_FIXTURE_DIR = join(SELF_TEST_FIXTURES_DIR, "orphan-fixture");
const ORPHAN_GOLDEN_DIR = join(SELF_TEST_FIXTURES_DIR, "orphan-golden");
const MATCHED_OK_DIR = join(SELF_TEST_FIXTURES_DIR, "matched-ok");
const MATCHED_MISMATCH_DIR = join(SELF_TEST_FIXTURES_DIR, "matched-mismatch");
const INVALID_PAYLOAD_DIR = join(SELF_TEST_FIXTURES_DIR, "invalid-payload");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("replayFixtures — loud-failure paths (P2.3)", () => {
  it("passes vacuously on an empty directory — no fixtures is not the same as no checking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seatfirst-providers-replay-"));
    tempDirs.push(dir);
    const report = await replayFixtures(dir);
    expect(report).toEqual({ matched: [], updated: [], issues: [] });
  });

  it("passes vacuously on a directory that does not exist yet", async () => {
    const dir = join(
      await mkdtemp(join(tmpdir(), "seatfirst-providers-replay-")),
      "does-not-exist",
    );
    const report = await replayFixtures(dir);
    expect(report).toEqual({ matched: [], updated: [], issues: [] });
  });

  it("fails loudly when a fixture exists with no golden", async () => {
    const report = await replayFixtures(ORPHAN_FIXTURE_DIR);
    expect(report.matched).toEqual([]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.kind).toBe("FIXTURE_WITHOUT_GOLDEN");
    expect(report.issues[0]?.name).toBe("orphan");
    expect(report.issues[0]?.detail).toContain("has no paired golden");
  });

  it("fails loudly when a golden exists with no fixture", async () => {
    const report = await replayFixtures(ORPHAN_GOLDEN_DIR);
    expect(report.matched).toEqual([]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.kind).toBe("GOLDEN_WITHOUT_FIXTURE");
    expect(report.issues[0]?.name).toBe("orphan");
    expect(report.issues[0]?.detail).toContain("has no paired fixture");
  });

  it("passes when a fixture's normalized output matches its golden, regardless of golden key order", async () => {
    const report = await replayFixtures(MATCHED_OK_DIR);
    expect(report.issues).toEqual([]);
    expect(report.matched).toEqual(["sample"]);
  });

  it("fails loudly when a fixture's normalized output does not match its golden", async () => {
    const report = await replayFixtures(MATCHED_MISMATCH_DIR);
    expect(report.matched).toEqual([]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.kind).toBe("GOLDEN_MISMATCH");
    expect(report.issues[0]?.name).toBe("sample");
    expect(report.issues[0]?.detail).toContain("does not match");
  });

  it("fails loudly, distinctly, when a fixture does not parse through the P1 contract schema", async () => {
    const report = await replayFixtures(INVALID_PAYLOAD_DIR);
    expect(report.matched).toEqual([]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.kind).toBe("NORMALIZE_FAILED");
    expect(report.issues[0]?.name).toBe("sample");
  });
});

describe("replayFixtures — golden regeneration is explicit opt-in (P2.4)", () => {
  it("does not write a golden unless updateGoldens is explicitly true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seatfirst-providers-replay-"));
    tempDirs.push(dir);
    await writeFile(
      join(dir, "sample.json"),
      await readFile(join(ORPHAN_FIXTURE_DIR, "orphan.json"), "utf8"),
    );

    const report = await replayFixtures(dir);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "FIXTURE_WITHOUT_GOLDEN", name: "sample" }),
    ]);
    await expect(readFile(join(dir, "sample.golden.json"), "utf8")).rejects.toThrow();
  });

  it("writes a golden when updateGoldens is true, and the corpus then replays clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seatfirst-providers-replay-"));
    tempDirs.push(dir);
    const fixtureText = await readFile(join(ORPHAN_FIXTURE_DIR, "orphan.json"), "utf8");
    await writeFile(join(dir, "sample.json"), fixtureText);

    const updateReport = await replayFixtures(dir, { updateGoldens: true });
    expect(updateReport.issues).toEqual([]);
    expect(updateReport.updated).toEqual(["sample"]);
    expect(updateReport.matched).toEqual(["sample"]);

    const golden: unknown = JSON.parse(await readFile(join(dir, "sample.golden.json"), "utf8"));
    expect(golden).toEqual(JSON.parse(fixtureText) as unknown);

    const checkReport = await replayFixtures(dir);
    expect(checkReport.issues).toEqual([]);
    expect(checkReport.matched).toEqual(["sample"]);
  });

  it("golden-without-fixture is never resolved by updateGoldens — nothing to normalize against it", async () => {
    const report = await replayFixtures(ORPHAN_GOLDEN_DIR, { updateGoldens: true });
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: "GOLDEN_WITHOUT_FIXTURE", name: "orphan" }),
    ]);
    expect(report.updated).toEqual([]);
  });
});
