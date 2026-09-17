#!/usr/bin/env node
// Patch pnpm-workspace.yaml to approve esbuild's install script (pnpm 11
// strictness). Used by Dockerfile.app, Dockerfile.fetch-worker, and
// Dockerfile.mobile-web.dev — called twice per build (before and after the
// turbo-prune out/full/ copy overwrites the file with the unpatched original).
//
// Idempotent: skips the edit if the entry already exists.
import { readFileSync, writeFileSync } from "node:fs";

const p = "pnpm-workspace.yaml";
let s = readFileSync(p, "utf8");
if (!s.includes("esbuild: true")) {
  s = s.replace("allowBuilds:", "allowBuilds:\n  esbuild: true");
  writeFileSync(p, s);
}
