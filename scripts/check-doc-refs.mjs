#!/usr/bin/env node
// Validates cross-references inside this repo's Markdown docs. Two independent checks:
//
// 1. Real Markdown links — `[text](path)` / `[text](path#anchor)` / `[text](#anchor)`.
//    Local (non-http, non-mailto) targets must resolve to a file on disk (a link to a bare
//    directory, e.g. `docs/adr/`, resolves against that directory or its `README.md`), and
//    any `#anchor` must match a heading in the target file (or the current file, for
//    same-file anchors). Anchors are computed with `github-slugger`, the same algorithm
//    GitHub uses to turn headings into `#slugs`, so this matches what actually renders. Link
//    targets are resolved relative to the citing file's own directory (standard Markdown/GFM
//    behaviour), so a link written from `docs/backlog.md` to a file under `docs/tasks/` omits
//    the `docs/` prefix even though this repo's prose convention writes it out in full.
//
// 2. Informal path citations — this repo's dominant cross-reference style is *not* Markdown
//    links but inline-code citations like `docs/backend-work-plan.md:671-705` or
//    `packages/core/src/result-contracts.ts:551` embedded in prose, and — just as commonly —
//    bare filenames with no directory component at all (`seatfirst-query-design.md:383`,
//    `boundaries.ts:23`, relying on surrounding prose to establish which package). Every such
//    citation found inside backticks **with a line number** is checked: the file must exist
//    (resolved repo-root-relative first, then against a fixed list of package/docs roots —
//    see ROOTS below) and the line number/range must be valid and within the file's actual
//    line count. Bare filenames with no line number are deliberately NOT checked — this
//    repo's task specs routinely name a file that a *future* task will create
//    (`docs/tasks/O1-otel-wiring/spec.md` names `otel.ts` before it exists), and a bare
//    mention is indistinguishable from a "go read this" citation without deep context. A line
//    number is the signal that the author means "this exact content is already there" — that
//    is the claim that can actually go stale, and it's what this repo's own convention treats
//    as load-bearing (see `docs/backend-work-plan.md`'s "Superseded" banner, appended rather
//    than edited in place specifically to keep such citations valid).
//
//    If a bare filename resolves under more than one root (e.g. `index.ts` exists in every
//    package's `src/`), that is reported as an ambiguous citation rather than silently picked
//    — the citing prose needs enough of a directory prefix to disambiguate.
//
//    Fenced code blocks (``` ... ```) are excluded from both checks: an example command or a
//    sample file listing inside a fence is not a real citation, and headings/links shown
//    verbatim inside a fence do not produce real anchors.
//
// Scope: only `*.md` files tracked by git (via `git ls-files -z`, NUL-delimited so quoted or
// non-ASCII paths survive), so generated/ignored content (node_modules, dist, coverage, docs
// capture artifacts) is never scanned, and a file that is tracked in the index but has been
// deleted from the working tree (not yet `git rm`'d) is skipped rather than crashing the
// checker.
//
// Not covered: reachability of `http(s)://` URLs. This repo has very few external links, and
// this project's stance (ADR 0002) is that CI never makes network calls of any kind — a link
// checker phoning out to the internet in CI would violate that same posture. Review external
// links by eye.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
// Repo- or package-relative path, with an OPTIONAL directory prefix, a known extension, and a
// required `:123` or `:123-456` (also accepts an en dash) line reference. The directory
// prefix is optional so a bare filename (`package.json:19`, `boundaries.ts:23`) is caught too
// — see the header comment for why a bare filename with NO line number is intentionally
// excluded instead.
const CITATION_RE =
  /`((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|ts|tsx|mjs|cjs|js|json|sql|txt|yml|yaml)):(\d+)(?:[-–](\d+))?`/g;
const FENCE_RE = /^(```|~~~)/;

// Deterministic resolution roots for bare/package-relative citations, tried in order after a
// direct repo-root-relative lookup fails. Includes each package's `src/`, `test/`, and (for
// `packages/durability`) `migrations/` — not just the package root — because most bare
// citations name a file one directory below the package root, and the package root itself
// rarely contains a bare `.ts` file directly.
export const PACKAGE_ROOTS = [
  "packages/durability",
  "packages/durability/src",
  "packages/durability/test",
  "packages/durability/test/support",
  "packages/durability/migrations",
  "packages/core",
  "packages/core/src",
  "packages/core/test",
  "packages/providers",
  "packages/providers/src",
  "packages/providers/src/amc",
  "packages/providers/test",
  "packages/providers/test/support",
  "packages/config",
  "packages/config/src",
  "packages/config/test",
  "apps/server",
  "apps/server/src",
  "apps/server/src/routes/searches",
  "apps/server/src/routes/showtimes",
  "apps/server/src/routes/theatres",
  "apps/server/src/dispatch/handlers",
  "apps/server/src/crawler",
  "apps/server/src/lib",
  "apps/server/test",
  "apps/mobile-web",
  "apps/mobile-web/src",
  "apps/mobile-web/src/components/search",
  "apps/mobile-web/src/components/result",
  "apps/mobile-web/src/components/core",
  "apps/mobile-web/src/components/flow",
  "apps/mobile-web/src/hooks",
  "apps/mobile-web/src/hooks/viewModels",
  "apps/mobile-web/src/store",
  "apps/mobile-web/src/lib",
  "apps/mobile-web/src/theme",
  "apps/mobile-web/src/fixtures",
  "apps/mobile-web/test",
  "docker/fetch-worker",
];

/** Lists `*.md` files tracked by git or present-but-untracked, NUL-delimited so quoted /
 * non-ASCII paths survive. */
export function listMarkdownFiles(repoRoot) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.md"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

/** Line count matching what a 1-indexed line-number citation / the `read` tool means: the
 * count of terminated (or final, unterminated) lines, not `split("\n")`'s trailing empty
 * element for a file that ends with a newline. */
export function computeLineCount(text) {
  if (text === "") return 0;
  const raw = text.split("\n");
  return text.endsWith("\n") ? raw.length - 1 : raw.length;
}

/** One boolean per line: true while inside a ``` or ~~~ fenced code block (the fence marker
 * lines themselves count as fenced). Nested/mismatched fence markers are not a real Markdown
 * construct, so a naive toggle is sufficient. */
export function computeFencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const isFenceMarker = FENCE_RE.test(lines[i]);
    if (isFenceMarker) {
      fenced[i] = true;
      inFence = !inFence;
    } else {
      fenced[i] = inFence;
    }
  }
  return fenced;
}

/** Heading slugs for a file, skipping any heading that appears inside a fenced code block
 * (a heading shown as a Markdown example, not a real one). */
export function extractSlugs(text) {
  const lines = text.split("\n");
  const fenced = computeFencedLines(lines);
  const slugger = new GithubSlugger();
  const slugs = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) slugs.add(slugger.slug(m[2]));
  }
  return slugs;
}

/** Parses a citation's start/end capture groups into a validated `{ start, end }`, or a
 * `{ error }` describing why the range itself is malformed — independent of whether the
 * target file exists or is long enough. */
export function parseRange(startStr, endStr) {
  const start = Number(startStr);
  const end = endStr === undefined ? start : Number(endStr);
  if (start < 1) return { error: `line ${start} is not a valid 1-indexed line number` };
  if (end < start) return { error: `range end ${end} is before range start ${start}` };
  return { start, end };
}

/** @typedef {{lineCount: number, slugs: Set<string>}} FileEntry */

/** Builds a memoized `indexFile(relPath) -> FileEntry | null` reader scoped to `repoRoot`.
 * Missing files (including a tracked-but-working-tree-deleted file) resolve to `null` rather
 * than throwing. */
export function makeIndexer(repoRoot) {
  /** @type {Map<string, FileEntry | null>} */
  const cache = new Map();
  return function indexFile(relPath) {
    if (cache.has(relPath)) return cache.get(relPath);
    const abs = path.join(repoRoot, relPath);
    let entry = null;
    try {
      if (statSync(abs).isFile()) {
        const text = readFileSync(abs, "utf8");
        entry = { lineCount: computeLineCount(text), slugs: extractSlugs(text) };
      }
    } catch {
      entry = null;
    }
    cache.set(relPath, entry);
    return entry;
  };
}

/** Resolves a bare or partially-qualified citation path: direct repo-root-relative lookup
 * first, then each entry in `roots`. Returns `{ status: "ok", path, entry }`,
 * `{ status: "missing" }`, or `{ status: "ambiguous", candidates }` if more than one root
 * produces a distinct existing file. */
export function resolveCitation(citedPath, indexFile, roots = PACKAGE_ROOTS) {
  const direct = indexFile(citedPath);
  if (direct) return { status: "ok", path: citedPath, entry: direct };
  const candidates = [];
  for (const base of roots) {
    const candidate = path.posix.join(base, citedPath);
    const entry = indexFile(candidate);
    if (entry) candidates.push({ path: candidate, entry });
  }
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length > 1) return { status: "ambiguous", candidates };
  return { status: "ok", path: candidates[0].path, entry: candidates[0].entry };
}

/** Runs both checks across every tracked Markdown file under `repoRoot` and returns the list
 * of human-readable failure strings (empty = clean). */
export function checkDocs(repoRoot) {
  const indexFile = makeIndexer(repoRoot);
  const mdFiles = listMarkdownFiles(repoRoot);
  const failures = [];

  for (const relFile of mdFiles) {
    const abs = path.join(repoRoot, relFile);
    if (!existsSync(abs)) continue; // tracked in the index, deleted from the working tree
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const fenced = computeFencedLines(lines);
    const selfEntry = { lineCount: computeLineCount(text), slugs: extractSlugs(text) };

    // --- 1. Markdown links ---
    for (let i = 0; i < lines.length; i++) {
      if (fenced[i]) continue;
      for (const m of lines[i].matchAll(LINK_RE)) {
        let target = m[2].trim();
        if (/^(https?:|mailto:|tel:)/i.test(target)) continue; // external, not our job
        target = target.replace(/:\d+(?:[-–]\d+)?(#.*)?$/, (m, g1) => g1 || "");
        if (target.startsWith("file://")) {
          try {
            const parsed = new URL(target);
            const targetPath = fileURLToPath(parsed);
            const hash = parsed.hash.replace(/^#/, "");
            if (targetPath.startsWith(repoRoot)) {
              target = path.relative(path.dirname(abs), targetPath) + (hash ? `#${hash}` : "");
            } else {
              continue;
            }
          } catch {
            continue;
          }
        } else if (path.isAbsolute(target)) {
          const [rawAbsPath, anchor] = target.split("#");
          if (rawAbsPath.startsWith(repoRoot)) {
            target = path.relative(path.dirname(abs), rawAbsPath) + (anchor ? `#${anchor}` : "");
          } else {
            continue;
          }
        }
        const [rawPathWithLine, anchor] = target.split("#");
        const rawPath = rawPathWithLine.replace(/:\d+(?:[-–]\d+)?$/, "");
        let entry = selfEntry;
        let displayPath = relFile;
        if (rawPath) {
          const resolvedAbs = path.normalize(path.join(path.dirname(relFile), rawPath));
          displayPath = resolvedAbs;
          entry = indexFile(resolvedAbs);
          if (!entry) entry = indexFile(path.join(resolvedAbs, "README.md")); // dir link fallback
          if (!entry && existsSync(path.join(repoRoot, resolvedAbs))) entry = selfEntry; // bare dir, no README
          if (!entry) {
            failures.push(`${relFile}:${i + 1}  broken link target -> ${rawPath}`);
            continue;
          }
        }
        if (
          anchor &&
          displayPath.endsWith(".md") &&
          !anchor.startsWith("L") &&
          !entry.slugs.has(anchor)
        ) {
          failures.push(`${relFile}:${i + 1}  broken anchor -> ${displayPath}#${anchor}`);
        }
      }
    }

    // --- 2. Informal backtick path:line citations ---
    for (let i = 0; i < lines.length; i++) {
      if (fenced[i]) continue;
      for (const m of lines[i].matchAll(CITATION_RE)) {
        const [full, citedPath, startStr, endStr] = m;
        const range = parseRange(startStr, endStr);
        if (range.error) {
          failures.push(`${relFile}:${i + 1}  invalid citation range -> ${full} (${range.error})`);
          continue;
        }
        const resolved = resolveCitation(citedPath, indexFile);
        if (resolved.status === "missing") {
          failures.push(`${relFile}:${i + 1}  citation targets missing file -> ${full}`);
          continue;
        }
        if (resolved.status === "ambiguous") {
          const paths = resolved.candidates.map((c) => c.path).join(", ");
          failures.push(
            `${relFile}:${i + 1}  citation "${full}" is ambiguous, resolves under multiple roots -> ${paths}`,
          );
          continue;
        }
        if (range.end > resolved.entry.lineCount) {
          failures.push(
            `${relFile}:${i + 1}  citation line ${range.end} exceeds ${resolved.path}'s length ` +
              `(${resolved.entry.lineCount} lines) -> ${full}`,
          );
        }
      }
    }
  }

  return failures;
}

function runCli() {
  const repoRoot = process.cwd();
  const mdFiles = listMarkdownFiles(repoRoot);
  const failures = checkDocs(repoRoot);
  if (failures.length > 0) {
    console.error(`${failures.length} doc reference problem(s):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("");
    console.error("Fix the citation, or the file/heading it points at.");
    process.exit(1);
  }
  console.log(`checked ${mdFiles.length} markdown files, all references resolve`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) runCli();
