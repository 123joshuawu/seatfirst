#!/usr/bin/env node
/**
 * Finds and kills orphaned Chrome processes left behind by packages/browser-runtime's
 * test suites (see supervisor.ts's `mkdtemp(join(tmpdir(), "seatfirst-chrome-"))`).
 *
 * The supervisor launches Chrome detached, in its own process group, and tears it
 * down with a process-group kill (supervisor.ts's `process.kill(-pgid, signal)`) from
 * each suite's `afterAll`. If the test runner itself is killed before that hook runs,
 * the detached Chrome process has no parent left to reap it and is reparented to PID 1
 * — it just keeps running. This script finds exactly those orphans (PPID 1, and a
 * `--user-data-dir` whose final path segment starts with `seatfirst-chrome-`) and
 * kills each one's process group, mirroring the supervisor's own SIGTERM-then-SIGKILL
 * teardown. It never touches a process with a live parent, so it can't catch a Chrome
 * instance that belongs to a test run still in progress.
 *
 * The match is on the profile dir's basename, not a full path under the *current*
 * process's `os.tmpdir()`: the supervisor's `mkdtemp(join(tmpdir(), ...))` resolves
 * `tmpdir()` against whatever `$TMPDIR` was set (or unset) for the process that spawned
 * Chrome — e.g. `/tmp` for a launchd/agent job with no `$TMPDIR`, vs. a per-user
 * `/var/folders/.../T` for a normal Terminal.app login shell. Anchoring on this script's
 * own `os.tmpdir()` at scan time silently misses orphans spawned under a different
 * `$TMPDIR`, so it deliberately ignores the parent directory and matches on the
 * `seatfirst-chrome-` prefix alone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE_DIR_PREFIX = "seatfirst-chrome-";
const USER_DATA_DIR_PATTERN = /--user-data-dir=(\S+)/;
const GRACE_PERIOD_MS = 3000;
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");

export function listProcesses(exec = execFileSync) {
  const out = exec("ps", ["-axww", "-o", "pid,ppid,command"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .slice(1) // header
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (match === null) return null;
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
    })
    .filter((entry) => entry !== null);
}

export function findOrphans(exec = execFileSync) {
  return listProcesses(exec).filter((entry) => {
    if (entry.ppid !== 1) return false;
    const match = entry.command.match(USER_DATA_DIR_PATTERN);
    return match !== null && path.basename(match[1]).startsWith(PROFILE_DIR_PREFIX);
  });
}

export function isAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killGroup(pgid) {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return; // already gone
  }
  const deadline = Date.now() + GRACE_PERIOD_MS;
  while (Date.now() < deadline && isAlive(pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (isAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function main(exec = execFileSync) {
  const orphans = findOrphans(exec);
  // Each orphan's own detached process group is rooted at its own PID, so killing
  // -pid takes its helper/renderer children with it — no need to enumerate them.
  if (orphans.length === 0) {
    console.log("No dangling seatfirst-chrome processes found.");
    return;
  }

  console.log(`Found ${orphans.length} dangling seatfirst-chrome process group(s):`);
  for (const orphan of orphans) {
    console.log(`  pid ${orphan.pid}: ${orphan.command.slice(0, 120)}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: not killing anything.");
    return;
  }

  for (const orphan of orphans) {
    await killGroup(orphan.pid);
  }
  console.log("\nDone.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) await main();
