#!/usr/bin/env node
// Offline generator for the postal-code -> IANA-timezone lookup table (P5.14,
// docs/tasks/P5-amc-parsers-provider/spec.md; decision recorded in docs/open-questions.md
// "Resolved", 2026-08-13).
//
// AMC's page payloads carry a theatre's postalCode/stateCode but never an IANA timezone name
// (docs/amc-public-website-api-spec.md:616-617, :741-743) — this script builds the missing
// mapping *once, offline*, from two public, real datasets:
//
//   1. US Census Bureau 2023 ZCTA Gazetteer — population-weighted centroid (lat/lng) for every
//      ZIP Code Tabulation Area:
//      https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip
//   2. geo-tz (https://www.npmjs.com/package/geo-tz) — an offline point-in-polygon lookup over
//      the `timezone-boundary-builder` project's OpenStreetMap-derived timezone boundaries.
//
// Nothing here makes a live geocoding call at parse time: the output is a static, vendored
// table (`src/amc/postal-timezone-table.generated.ts`) that the runtime lookup
// (`src/amc/postal-timezone.ts`) reads with zero I/O, mirroring G1.6's "no network" rule for
// parser-adjacent code (`docs/tasks/G1-theatre-entity-geo/spec.md` G1.6).
//
// A ZCTA can straddle a timezone boundary; geo-tz returns every candidate zone for a point,
// ordered by its own internal preference. This script takes only the first (most specific)
// result — documented here as the one place that choice is made, not re-derived per call site.
//
// Regenerate with:  node scripts/generate-postal-timezone-table.mjs
// Requires `curl` and `unzip` on PATH (used once, to fetch and extract the Census file into a
// throwaway temp directory — never committed, never read by anything at runtime).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { find as findTimezones } from "geo-tz";

const GAZETTEER_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip";
const GAZETTEER_ENTRY = "2023_Gaz_zcta_national.txt";
const GAZETTEER_VINTAGE = "US Census Bureau 2023 Gazetteer, ZCTA national file";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(packageRoot, "src", "amc", "postal-timezone-table.generated.ts");

const workDir = mkdtempSync(join(tmpdir(), "postal-tz-"));

try {
  const zipPath = join(workDir, "gazetteer.zip");
  console.log(`Fetching ${GAZETTEER_URL} ...`);
  execFileSync("curl", ["-sS", "-o", zipPath, "--max-time", "60", GAZETTEER_URL]);
  execFileSync("unzip", ["-o", "-q", zipPath, "-d", workDir]);

  const raw = readFileSync(join(workDir, GAZETTEER_ENTRY), "utf8");
  const lines = raw.split("\n").slice(1); // drop the GEOID/ALAND/.../INTPTLONG header row

  /** @type {Record<string, string>} */
  const table = {};
  let resolved = 0;
  let skipped = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const zip = cols[0]?.trim();
    const lat = Number.parseFloat(cols[5] ?? "");
    const lng = Number.parseFloat(cols[6] ?? "");
    if (!zip || Number.isNaN(lat) || Number.isNaN(lng)) {
      skipped++;
      continue;
    }
    const zones = findTimezones(lat, lng);
    const zone = zones[0];
    if (!zone) {
      skipped++;
      continue;
    }
    table[zip] = zone;
    resolved++;
  }

  const sortedKeys = Object.keys(table).sort();
  const body = JSON.stringify(table, sortedKeys, 2);

  const header = `// GENERATED FILE — do not hand-edit.
//
// Produced by scripts/generate-postal-timezone-table.mjs from the ${GAZETTEER_VINTAGE}
// (${GAZETTEER_URL}), resolved through geo-tz (timezone-boundary-builder / OpenStreetMap data).
// Regenerate with:  node scripts/generate-postal-timezone-table.mjs
//
// See docs/tasks/P5-amc-parsers-provider/spec.md P5.14 and docs/open-questions.md "Resolved"
// for the decision this implements. Consumed only by src/amc/postal-timezone.ts.
//
// Generated ${new Date().toISOString()}: ${resolved} ZIP codes resolved, ${skipped} skipped
// (no centroid, or no geo-tz match).

export const POSTAL_TIMEZONE_TABLE: Readonly<Record<string, string>> = ${body};
`;

  writeFileSync(outFile, header, "utf8");
  console.log(`Wrote ${resolved} entries (${skipped} skipped) to ${outFile}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
