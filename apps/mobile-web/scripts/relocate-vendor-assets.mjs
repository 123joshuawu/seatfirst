#!/usr/bin/env node
/**
 * Post-export build step: renames any hidden ("dot") directory Metro copied
 * into `dist/assets/` and rewrites every reference to it across the exported
 * output.
 *
 * Why this exists: @expo-google-fonts/* (loaded per ADR 0068 §6) ship their
 * .ttf files inside node_modules. pnpm nests every package under a
 * `.pnpm/<name>@<version>/node_modules/...` virtual store folder, and
 * `expo export --platform web` mirrors that source path verbatim into the
 * public `assets/` URL (see @expo/metro-config's
 * transform-worker/getAssets.js, which builds the public path from
 * `path.relative(projectRoot, module.path)`). Two independent problems follow
 * from the resulting `.pnpm` segment:
 *
 *   1. `actions/upload-artifact@v4` (used in .github/workflows/deploy.yml)
 *      excludes dot-prefixed paths by default, so the entire font asset tree
 *      was silently missing from the deployed web bundle in production.
 *   2. The internal, version-pinned pnpm virtual-store layout should not be a
 *      public-facing URL on getseatfirst.com.
 *
 * This step runs strictly after `expo export` (see package.json's `build`
 * script) so it cannot interfere with Metro's own internal path bookkeeping
 * (in particular, the `../` -> `_` monorepo-hoisting collapse Metro performs
 * while computing `assets/__node_modules/...`). It only touches the already
 * finished `dist/` output on disk: local dev (`expo start`) and pnpm's own
 * node_modules layout are completely untouched.
 *
 * Cache-hash safety: `infra/config/relay/Caddyfile`'s `@immutable path
 * /_expo/static/*` rule serves every `<name>-<hash>.js` chunk (including
 * `entry-<hash>.js`, which embeds asset paths and does get its text rewritten
 * below) with `Cache-Control: public, max-age=31536000, immutable` — a
 * promise that the URL's bytes never change once published. This script
 * keeps that promise without needing to know or reproduce Metro's hashing
 * algorithm, because the rewrite is a pure, deterministic function of the
 * exported bytes (same input always yields the same output) and the whole
 * `dist/` tree is produced by one atomic build step
 * (`expo export && node relocate-vendor-assets.mjs`, package.json) before
 * anything downstream — CI's `upload-artifact`, a CDN, or a browser — can
 * observe it. Nothing ever serves the pre-rewrite bytes under that filename.
 * Redeploys and rollbacks reuse that same CI-built artifact verbatim
 * (`scripts/ops/rollback-prod.sh` downloads `seatfirst-web-dist-<sha>` rather
 * than rebuilding), so a given commit's chunk names are assigned exactly
 * once, for good — the actual invariant immutable caching requires.
 */
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = join(APP_ROOT, "dist");
const REWRITTEN_FILE_EXTS = new Set([".html", ".js", ".json", ".css"]);

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function findHiddenDirs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith(".")) {
      found.push(full);
      // Do not recurse into it: the whole subtree moves as one unit below.
      continue;
    }
    found.push(...findHiddenDirs(full));
  }
  return found;
}

export function relocateVendorAssets(distDir) {
  const assetsDir = join(distDir, "assets");
  if (!statSync(distDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`relocate-vendor-assets: ${distDir} does not exist — run expo export first`);
  }
  if (!statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    // No third-party assets (e.g. no fonts) were bundled this build; nothing to do.
    console.log("relocate-vendor-assets: no dist/assets directory, nothing to relocate");
    return;
  }

  const hiddenDirs = findHiddenDirs(assetsDir);
  if (hiddenDirs.length === 0) {
    console.log(
      "relocate-vendor-assets: no hidden directories found under dist/assets, nothing to do",
    );
    return;
  }

  /** @type {Array<{ oldSegment: string, newSegment: string }>} */
  const renames = [];
  for (const hiddenDirAbs of hiddenDirs) {
    const parent = dirname(hiddenDirAbs);
    const base = hiddenDirAbs.slice(parent.length + 1); // e.g. ".pnpm"
    const newBase = `_${base.slice(1)}`; // e.g. "_pnpm"
    const newDirAbs = join(parent, newBase);
    if (statSync(newDirAbs, { throwIfNoEntry: false })) {
      throw new Error(
        `relocate-vendor-assets: target ${newDirAbs} already exists, refusing to overwrite`,
      );
    }
    renameSync(hiddenDirAbs, newDirAbs);
    // Path segment as it appears in URLs / source references, bounded by "/"
    // on both sides so we never touch an unrelated substring match.
    renames.push({ oldSegment: `/${base}/`, newSegment: `/${newBase}/` });
    console.log(
      `relocate-vendor-assets: renamed ${relative(distDir, hiddenDirAbs)} -> ${relative(distDir, newDirAbs)}`,
    );
  }

  const textFiles = listFilesRecursive(distDir).filter((f) =>
    REWRITTEN_FILE_EXTS.has(f.slice(f.lastIndexOf("."))),
  );

  let totalReplacements = 0;
  for (const file of textFiles) {
    let content = readFileSync(file, "utf8");
    let changed = false;
    for (const { oldSegment, newSegment } of renames) {
      const occurrences = content.split(oldSegment).length - 1;
      if (occurrences > 0) {
        content = content.split(oldSegment).join(newSegment);
        totalReplacements += occurrences;
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(file, content, "utf8");
      console.log(`relocate-vendor-assets: rewrote references in ${relative(distDir, file)}`);
    }
  }

  // Exhaustive verification: fail the build loudly rather than ship broken
  // asset URLs, if any old hidden-path reference or hidden directory survives.
  const remaining = listFilesRecursive(distDir)
    .filter((f) => REWRITTEN_FILE_EXTS.has(f.slice(f.lastIndexOf("."))))
    .flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return renames
        .filter(({ oldSegment }) => content.includes(oldSegment))
        .map(({ oldSegment }) => `${relative(distDir, file)} still references ${oldSegment}`);
    });
  const survivingHiddenDirs = findHiddenDirs(assetsDir).map((d) => relative(distDir, d));

  if (remaining.length > 0 || survivingHiddenDirs.length > 0) {
    throw new Error(
      `relocate-vendor-assets: verification failed after rewrite.\n` +
        [...remaining, ...survivingHiddenDirs.map((d) => `hidden directory survived: ${d}`)].join(
          "\n",
        ),
    );
  }

  console.log(
    `relocate-vendor-assets: done — ${renames.length} director${renames.length === 1 ? "y" : "ies"} renamed, ${totalReplacements} reference(s) rewritten across ${textFiles.length} file(s), 0 hidden paths remaining`,
  );
}

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  relocateVendorAssets(DIST_DIR);
}
