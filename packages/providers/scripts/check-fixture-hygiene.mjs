#!/usr/bin/env node
// Fixture hygiene guard (P2.6, docs/backend-work-plan.md:693). Fails the build if:
//
//   (a) any file is present under packages/providers/fixtures/raw/ — that directory is
//       gitignored specifically so a captured payload cannot land by accident (.gitignore:29,
//       with the reason in the two comment lines above it). This step exists for the case the
//       ignore rule alone cannot catch: a file force-added past `.gitignore` (`git add -f`).
//   (b) any file under packages/providers/fixtures/redacted/ carries a genuine redaction-leakage
//       signature, by the cheap heuristic below.
//
// Heuristic (documented, not authoritative — see "Limits"):
//
//   1. Every committed entry under redacted/ must be `.gitkeep` or named `*.json`
//      (`<name>.json` fixtures, `<name>.golden.json` goldens).
//   2. No file under redacted/ may contain a known redaction-leakage signature — the FULL
//      `TOKEN_REGEXES` set `src/amc/capture-redact.ts`'s `redact()` uses to strip tokens (JWTs,
//      Queue-it wait token/UUIDs, `cf_clearance`, `__cf_bm`, `cf-ray`, `Bearer …`, `Cookie: …`),
//      plus its `IPV4_REGEX`/`IPV6_REGEX`. This is deliberately broader than that module's own
//      narrower fail-closed spot-check (`eyJh`/`cf_clearance`/`__cf_bm` + IPs only): this guard
//      is the last line of defense before real captured data becomes permanent git history, so
//      it re-checks everything `redact()` is supposed to have stripped, not just the subset
//      `redact()` re-checks on itself. Duplicated here by hand, kept in sync with that module,
//      because this script runs via plain `node` against source with no build step.
//
// Why this replaced a size/HTML-shape check: P5.1 requires every AMC route's parser
// (`src/amc/parse/*.ts`) to consume the FULL captured HTML page directly and extract the
// embedded Flight stream itself — `flight.ts`'s `extractShapeFromHtml` is how `UPSTREAM_CHANGED`
// gets detected when AMC's page shape drifts. A genuinely redacted fixture is therefore a real
// captured page: hundreds of KB to a few MB, containing ordinary HTML/`<script>`/
// `__next_f.push` structure by design — not a signal that anything is wrong. An earlier version
// of this guard rejected exactly that shape (a 32 KiB cap plus an HTML/RSC-marker reject) on the
// premise that "nothing the adapter produces is raw HTML" — that premise was false the moment
// P5.1 was designed this way, and the first real capture (P7, 2026-08-13) proved it: all 27
// committed fixtures are 400 KB-2 MB HTML documents, and none trip a leakage-marker scan. This
// guard now checks the thing actually at stake — did a token/IP survive redaction — instead of a
// proxy (size, HTML tags) that was never a valid signal for that question.
//
// Limits (say them, don't hide them): this is a cheap tripwire, not a redaction auditor. It
// cannot catch a leaked value that doesn't match one of the listed shapes (an unusual session
// id, a name or email embedded in page copy), and it does not inspect field *values*
// semantically — "is this actually redacted" stays a human review judgment for every fixture
// PR. This step exists so a mechanically detectable leak (a raw token, a raw IP, a stray
// non-JSON file, or a file force-added past `.gitignore`) is caught before a human has to
// notice it.
//
// `detectLeakage` below is exported so `test/check-fixture-hygiene.test.ts` can prove each
// signature actually fires against a synthetic leak — not just pass vacuously on clean fixtures.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

// Mirrors src/amc/capture-redact.ts's IPV4_REGEX / IPV6_REGEX / TOKEN_REGEXES exactly — keep
// both lists in sync by hand if that module's lists change.
const ipv4Pattern =
  /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/;
const ipv6Pattern =
  /(?<![a-zA-Z0-9])(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:(?:[a-fA-F0-9]{1,4}:)*[a-fA-F0-9]{1,4})?::(?:(?:[a-fA-F0-9]{1,4}:)*[a-fA-F0-9]{1,4})?)(?![a-zA-Z0-9])/i;
const tokenPatterns = [
  { name: "JWT", pattern: /ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/ },
  { name: "Queue-it wait token / UUID", pattern: /c=[0-9a-fA-F-]+/ },
  { name: "cf_clearance", pattern: /cf_clearance=[a-zA-Z0-9_-]+/ },
  { name: "__cf_bm", pattern: /__cf_bm=[a-zA-Z0-9_-]+/ },
  { name: "CF-Ray", pattern: /cf-ray[-:\s]+[0-9a-zA-Z-]+/i },
  { name: "Bearer token", pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/i },
  { name: "Cookie header", pattern: /Cookie["']?\s*:\s*[^\r\n]+/i },
];

/**
 * Pure detection: returns human-readable problems found in `content`, empty when clean. No I/O,
 * no process exit — safe to unit test directly (`test/check-fixture-hygiene.test.ts`).
 */
export function detectLeakage(content) {
  const found = [];
  for (const { name, pattern } of tokenPatterns) {
    if (pattern.test(content)) {
      found.push(`contains a ${name} signature`);
    }
  }
  if (ipv4Pattern.test(content)) {
    found.push("contains an unredacted IPv4 address");
  }
  if (ipv6Pattern.test(content)) {
    found.push("contains an unredacted IPv6 address");
  }
  return found;
}

export function listFilesRecursive(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(full) : [full];
  });
}

function main() {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const rawDir = join(packageRoot, "fixtures", "raw");
  const redactedDir = join(packageRoot, "fixtures", "redacted");

  const problems = [];

  for (const file of listFilesRecursive(rawDir)) {
    problems.push(
      `${file}: fixtures/raw/ must stay empty (.gitignore:29 blocks it for exactly this reason)`,
    );
  }

  for (const file of listFilesRecursive(redactedDir)) {
    const name = file.split("/").pop() ?? file;
    if (name === ".gitkeep") {
      continue;
    }

    if (!name.endsWith(".json")) {
      problems.push(`${file}: not a *.json/*.golden.json fixture file (heuristic 1)`);
      continue;
    }

    const content = readFileSync(file, "utf8");
    for (const issue of detectLeakage(content)) {
      problems.push(`${file}: ${issue} (heuristic 2)`);
    }
  }

  if (problems.length > 0) {
    stderr.write("Fixture hygiene guard failed (P2.6, docs/backend-work-plan.md:693):\n");
    for (const problem of problems) {
      stderr.write(`  - ${problem}\n`);
    }
    exit(1);
  }

  const checkedCount = listFilesRecursive(redactedDir).length;
  stdout.write(
    `Fixture hygiene guard passed: fixtures/raw/ empty, ${checkedCount} entr${checkedCount === 1 ? "y" : "ies"} under fixtures/redacted/ checked.\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
