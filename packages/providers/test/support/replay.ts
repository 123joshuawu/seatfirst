/**
 * Fixture replay harness (P2, `docs/backend-work-plan.md:671-705`).
 *
 * Enumerates fixtures under a directory (production use: `packages/providers/fixtures/redacted/`,
 * P2.1/P2.2), loads each payload, runs it through the parse/normalize seam, and diffs the result
 * against a paired golden file. A fixture `<name>.json` pairs 1:1 with `<name>.golden.json` in the
 * same directory.
 *
 * **What "parse/normalize path" means today.** P1 landed the `VenueProvider` contract with
 * explicitly **no adapter, no parser, no network code** (`packages/providers/src/index.ts:1-7`),
 * and building one remains gate 1/7 blocked (`docs/backend-work-plan.md:663-667`). The only
 * parse/normalize logic that legitimately exists pre-adapter is Zod validation/normalization via
 * the exported contract schemas (`../../src/contract.ts`) — so `normalize` defaults to
 * `SeatPageResultSchema.parse` and is a parameter (`ReplayOptions.normalize`) precisely so a later,
 * separately gate-cleared adapter parser can plug into this exact seam without this file changing.
 *
 * **P2.3 — not vacuous.** An empty directory produces zero issues (correct: the corpus is empty
 * by design today). A fixture with no golden, or a golden with no fixture, is *always* reported as
 * an issue — never silently skipped. See `replay.self-test.test.ts` for the proof, exercised
 * against synthetic payloads, not the (today empty) real corpus.
 *
 * **P2.4 — golden regeneration is explicit opt-in.** This module never reads an environment
 * variable itself; `ReplayOptions.updateGoldens` must be passed explicitly `true` by the caller.
 * The one place `UPDATE_GOLDENS` is read is `../fixtures.replay.test.ts`.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SeatPageResultSchema } from "../../src/contract.js";

const FIXTURE_EXT = ".json";
const GOLDEN_EXT = ".golden.json";

/**
 * Pluggable parse/normalize step. Defaults to `SeatPageResultSchema.parse` — see the module
 * comment on why that, and not a hand-rolled parser, is the correct seam today.
 */
export type Normalize = (payload: unknown) => unknown;

export const defaultNormalize: Normalize = (payload) => SeatPageResultSchema.parse(payload);

export type ReplayIssueKind =
  "FIXTURE_WITHOUT_GOLDEN" | "GOLDEN_WITHOUT_FIXTURE" | "NORMALIZE_FAILED" | "GOLDEN_MISMATCH";

export interface ReplayIssue {
  readonly kind: ReplayIssueKind;
  readonly name: string;
  readonly detail: string;
}

export interface ReplayReport {
  /** Fixture base names successfully checked (paired, normalized, and matching their golden). */
  readonly matched: readonly string[];
  /** Fixture base names whose golden was written this run (only when `updateGoldens: true`). */
  readonly updated: readonly string[];
  readonly issues: readonly ReplayIssue[];
}

export interface ReplayOptions {
  readonly normalize?: Normalize;
  /** Explicit opt-in only (P2.4) — this module never toggles it from `process.env` itself. */
  readonly updateGoldens?: boolean;
}

function isErrnoException(error: unknown): error is { readonly code?: string } {
  return typeof error === "object" && error !== null && "code" in error;
}

async function listDir(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text) as unknown;
}

/**
 * Structural, key-order-independent canonicalization for equality comparison. Array element
 * *order* is left untouched (it is semantically meaningful — grid cell order, for instance) —
 * only object key order is normalized. This is a local, general-purpose JSON canonicalizer,
 * deliberately not a reuse of `packages/core`'s `canonicalJson`/`hashableSpec` helpers: those are
 * private to `search-spec.ts`/`region.ts` and typed against domain-specific shapes (`SearchSpec`,
 * `SeatRegion`), not exported as a generic utility this package could import.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value instanceof Date) {
    // `JSON.stringify` (which writes goldens) serializes Date as an ISO string; the
    // comparison side must treat Date the same way or goldens holding timestamps
    // (e.g. ProviderError providerMeta.observationTime) mismatch on every replay.
    return value.toISOString();
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonicalize(item)] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Replays every fixture under `dir` against its paired golden.
 *
 * - `dir` missing or empty: `{ matched: [], updated: [], issues: [] }` (P2.3's vacuous-pass case).
 * - A lone `<name>.json` with no `<name>.golden.json`: reported as `FIXTURE_WITHOUT_GOLDEN`,
 *   unless `updateGoldens` is `true`, in which case the golden is written from the normalized
 *   fixture and `name` is reported in `updated`.
 * - A lone `<name>.golden.json` with no `<name>.json`: always reported as
 *   `GOLDEN_WITHOUT_FIXTURE` (nothing to normalize against it, so `updateGoldens` cannot help).
 * - A paired fixture whose payload fails `normalize`: `NORMALIZE_FAILED`.
 * - A paired fixture that normalizes successfully but disagrees with its golden:
 *   `GOLDEN_MISMATCH`, unless `updateGoldens` is `true`, in which case the golden is overwritten.
 */
export async function replayFixtures(
  dir: string,
  options: ReplayOptions = {},
): Promise<ReplayReport> {
  const normalize = options.normalize ?? defaultNormalize;
  const updateGoldens = options.updateGoldens ?? false;

  const entries = await listDir(dir);
  const fixtureNames = new Set<string>();
  const goldenNames = new Set<string>();
  for (const entry of entries) {
    if (entry.endsWith(GOLDEN_EXT)) {
      goldenNames.add(entry.slice(0, -GOLDEN_EXT.length));
      continue;
    }
    if (entry.endsWith(FIXTURE_EXT)) {
      fixtureNames.add(entry.slice(0, -FIXTURE_EXT.length));
    }
  }

  const issues: ReplayIssue[] = [];
  const matched: string[] = [];
  const updated: string[] = [];

  const allNames = [...new Set([...fixtureNames, ...goldenNames])].sort();
  for (const name of allNames) {
    const hasFixture = fixtureNames.has(name);
    const hasGolden = goldenNames.has(name);
    const fixturePath = path.join(dir, `${name}${FIXTURE_EXT}`);
    const goldenPath = path.join(dir, `${name}${GOLDEN_EXT}`);

    if (hasGolden && !hasFixture) {
      issues.push({
        kind: "GOLDEN_WITHOUT_FIXTURE",
        name,
        detail: `golden "${goldenPath}" has no paired fixture "${fixturePath}". Delete the orphaned golden or restore its fixture.`,
      });
      continue;
    }

    if (hasFixture && !hasGolden) {
      if (!updateGoldens) {
        issues.push({
          kind: "FIXTURE_WITHOUT_GOLDEN",
          name,
          detail: `fixture "${fixturePath}" has no paired golden "${goldenPath}". Run with UPDATE_GOLDENS=1 to generate one, or delete the orphaned fixture.`,
        });
        continue;
      }
      let normalized: unknown;
      try {
        normalized = normalize(await readJsonFile(fixturePath));
      } catch (error) {
        issues.push({
          kind: "NORMALIZE_FAILED",
          name,
          detail: `parse/normalize failed for "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      await writeFile(goldenPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      updated.push(name);
      matched.push(name);
      continue;
    }

    // hasFixture && hasGolden
    let normalized: unknown;
    try {
      normalized = normalize(await readJsonFile(fixturePath));
    } catch (error) {
      issues.push({
        kind: "NORMALIZE_FAILED",
        name,
        detail: `parse/normalize failed for "${fixturePath}": ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (updateGoldens) {
      await writeFile(goldenPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      updated.push(name);
      matched.push(name);
      continue;
    }

    const golden = await readJsonFile(goldenPath);
    const actualCanonical = JSON.stringify(canonicalize(normalized), null, 2);
    const goldenCanonical = JSON.stringify(canonicalize(golden), null, 2);
    if (actualCanonical !== goldenCanonical) {
      issues.push({
        kind: "GOLDEN_MISMATCH",
        name,
        detail: `normalized "${fixturePath}" does not match "${goldenPath}".\n--- golden (canonical)\n${goldenCanonical}\n--- actual (canonical)\n${actualCanonical}`,
      });
      continue;
    }
    matched.push(name);
  }

  return { matched, updated, issues };
}
