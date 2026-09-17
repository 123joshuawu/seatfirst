import { existsSync } from "node:fs";

/**
 * Chrome executable discovery for the offline synthetic suite.
 *
 * The CI "pinned browser test image supplies Chrome before tests start"
 * (`docs/seatfirst-architecture.md:620`) — I1 pins that image and sets
 * `SEATFIRST_CHROME_EXECUTABLE`. Locally, a system Chrome is used.
 *
 * In CI (`SEATFIRST_ENV === "ci"`), ONLY `SEATFIRST_CHROME_EXECUTABLE` is trusted: the
 * default `ubuntu-latest` runner image ships its own unrelated Chrome at some of the
 * same system paths used for local-dev fallback below, which would otherwise silently
 * enable this suite on jobs that never provisioned Chrome for it (verify/checks).
 */
const LOCAL_DEV_CANDIDATES: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChromeExecutable(): string | null {
  const pinned = process.env["SEATFIRST_CHROME_EXECUTABLE"];
  if (pinned !== undefined && pinned !== "" && existsSync(pinned)) {
    return pinned;
  }
  if (process.env["SEATFIRST_ENV"] === "ci") {
    return null;
  }
  for (const candidate of LOCAL_DEV_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
