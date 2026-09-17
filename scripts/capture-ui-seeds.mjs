#!/usr/bin/env node
/**
 * Captures full-fidelity screenshots of all seeded UI states across Desktop and Mobile
 * viewports from the local dev server (default http://localhost:8081).
 *
 * Scenarios match the fixtures defined in apps/mobile-web/src/fixtures/scenarios.ts.
 *
 * Usage:
 *   node scripts/capture-ui-seeds.mjs [options]
 *   pnpm capture:ui-seeds [options]
 *
 * Options:
 *   --url <url>              Base URL for dev UI (default: http://localhost:8081)
 *   --out-dir <path>         Output directory for screenshots (default: ./screenshots)
 *   --viewport <type>        Viewport to capture: 'desktop', 'mobile', or 'all' (default: 'all')
 *   --scenarios <list>       Comma-separated scenario IDs to capture (default: all)
 *   --chrome <path>          Path to Chrome/Chromium executable (default: auto-detected)
 *   --settle-ms <ms>         Wait time in ms after navigation for UI to settle (default: 1000)
 *   --help, -h               Show this help message
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALL_SCENARIOS = [
  { id: "search-empty", name: "01_search_empty" },
  { id: "search", name: "02_search_filled" },
  { id: "form-theatre-browse", name: "03_where_browse" },
  { id: "where-suggestions-happy", name: "04_where_suggestions" },
  { id: "where-chip-resolved-name", name: "05_where_resolved_chip" },
  { id: "where-place-selected-open", name: "06_where_place_panel_open" },
  { id: "where-theatres-selected-open", name: "07_where_theatres_selected_open" },
  { id: "form-theatre-loading", name: "08_theatre_search_loading" },
  { id: "form-theatre-empty", name: "09_theatre_search_empty" },
  { id: "form-theatre-error", name: "10_theatre_search_error" },
  { id: "where-place-not-found", name: "11_where_place_not_found" },
  { id: "where-place-unavailable", name: "12_where_place_unavailable" },
  { id: "form-movies-loading", name: "13_movies_loading" },
  { id: "form-movies-empty", name: "14_movies_empty" },
  { id: "form-movies-error", name: "15_movies_error" },
  { id: "form-facets-warm", name: "16_facets_warm" },
  { id: "form-facets-partial", name: "17_facets_partial" },
  { id: "form-facets-cold", name: "18_facets_cold" },
  { id: "form-facets-warm-zero", name: "19_facets_warm_zero_dead_end" },
  { id: "form-capacity-blocked", name: "20_capacity_blocked" },
  { id: "form-admission-rejected", name: "22_admission_rejected" },
  { id: "backend-offline", name: "23_backend_offline" },
  { id: "checking", name: "24_checking_streaming" },
  { id: "checking-reconnect", name: "25_checking_reconnect" },
  { id: "result-confident", name: "26_result_confident" },
  { id: "result-hedged", name: "27_result_hedged" },
  { id: "result-empty", name: "28_result_empty_sold_out" },
  { id: "result-deferred", name: "29_result_deferred" },
  { id: "partial", name: "30_result_partial" },
  { id: "halted", name: "31_result_halted_capacity" },
  { id: "recheck", name: "32_recheck_in_flight" },
  { id: "confirmed", name: "33_confirmed_available" },
  { id: "replacement", name: "34_replacement_seats_gone" },
  { id: "recheck-unavailable", name: "35_recheck_unavailable" },
];

export const VIEWPORT_CONFIGS = {
  desktop: {
    key: "desktop",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    key: "mobile",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

export const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChromeExecutable(explicitPath, env = process.env, exists = existsSync) {
  if (explicitPath && exists(explicitPath)) {
    return explicitPath;
  }
  const envPath = env.SEATFIRST_CHROME_EXECUTABLE;
  if (envPath && exists(envPath)) {
    return envPath;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    baseUrl: "http://localhost:8081",
    outDir: "./screenshots",
    viewport: "all",
    scenarios: null,
    api: null,
    chromePath: null,
    settleMs: 1000,
    help: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--url" && i + 1 < argv.length) {
      options.baseUrl = argv[++i];
    } else if (arg.startsWith("--url=")) {
      options.baseUrl = arg.slice(6);
    } else if (arg === "--out-dir" && i + 1 < argv.length) {
      options.outDir = argv[++i];
    } else if (arg.startsWith("--out-dir=")) {
      options.outDir = arg.slice(10);
    } else if (arg === "--viewport" && i + 1 < argv.length) {
      options.viewport = argv[++i].toLowerCase();
    } else if (arg.startsWith("--viewport=")) {
      options.viewport = arg.slice(11).toLowerCase();
    } else if (
      (arg === "--scenarios" || arg === "--scenario" || arg === "--seeds" || arg === "--seed") &&
      i + 1 < argv.length
    ) {
      options.scenarios = argv[++i].split(",").map((s) => s.trim());
    } else if (arg.startsWith("--scenarios=")) {
      options.scenarios = arg
        .slice(12)
        .split(",")
        .map((s) => s.trim());
    } else if (arg.startsWith("--scenario=")) {
      options.scenarios = arg
        .slice(11)
        .split(",")
        .map((s) => s.trim());
    } else if (arg.startsWith("--seeds=")) {
      options.scenarios = arg
        .slice(8)
        .split(",")
        .map((s) => s.trim());
    } else if (arg.startsWith("--seed=")) {
      options.scenarios = arg
        .slice(7)
        .split(",")
        .map((s) => s.trim());
    } else if (arg === "--api" && i + 1 < argv.length) {
      options.api = argv[++i];
    } else if (arg.startsWith("--api=")) {
      options.api = arg.slice(6);
    } else if (arg === "--chrome" && i + 1 < argv.length) {
      options.chromePath = argv[++i];
    } else if (arg.startsWith("--chrome=")) {
      options.chromePath = arg.slice(9);
    } else if (arg === "--settle-ms" && i + 1 < argv.length) {
      options.settleMs = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith("--settle-ms=")) {
      options.settleMs = Number.parseInt(arg.slice(12), 10);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (!options.scenarios && positional.length > 0) {
    options.scenarios = positional;
  }

  return options;
}

export function resolveScenarios(filterList, allScenarios = ALL_SCENARIOS) {
  if (!filterList || filterList.length === 0) {
    return allScenarios;
  }
  const idOrNameSet = new Set(filterList);
  const exactMatches = allScenarios.filter((s) => idOrNameSet.has(s.id) || idOrNameSet.has(s.name));

  const hasWildcardOrFuzzy = filterList.some(
    (f) => f.includes("*") || !allScenarios.some((s) => s.id === f || s.name === f),
  );
  if (!hasWildcardOrFuzzy) {
    return exactMatches;
  }

  const matched = new Set(exactMatches);
  for (const filter of filterList) {
    if (allScenarios.some((s) => s.id === filter || s.name === filter)) {
      continue;
    }
    const pattern = filter.includes("*")
      ? new RegExp(`^${filter.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i")
      : null;
    for (const s of allScenarios) {
      if (pattern && (pattern.test(s.id) || pattern.test(s.name))) {
        matched.add(s);
      } else if (!pattern && (s.id.includes(filter) || s.name.includes(filter))) {
        matched.add(s);
      }
    }
  }

  return allScenarios.filter((s) => matched.has(s));
}

export function resolveViewports(viewportArg, configs = VIEWPORT_CONFIGS) {
  if (viewportArg === "desktop") {
    return [configs.desktop];
  }
  if (viewportArg === "mobile") {
    return [configs.mobile];
  }
  if (viewportArg === "all") {
    return [configs.desktop, configs.mobile];
  }
  throw new Error(
    `Unknown viewport option '${viewportArg}'. Must be 'desktop', 'mobile', or 'all'.`,
  );
}

export async function getPlaywrightChromium() {
  try {
    const mod = await import("playwright-core");
    return mod.chromium;
  } catch {
    const relative = new URL(
      "../packages/browser-runtime/node_modules/playwright-core/index.mjs",
      import.meta.url,
    );
    const mod = await import(relative.href);
    return mod.chromium;
  }
}

export async function captureScreenshots(options = {}) {
  const baseUrl = options.baseUrl || "http://localhost:8081";
  const outDir = options.outDir || "./screenshots";
  const settleMs = options.settleMs ?? 1000;
  const scenarios = resolveScenarios(options.scenarios);
  const viewports = resolveViewports(options.viewport || "all");

  const chromeExecutable = findChromeExecutable(options.chromePath);
  if (!chromeExecutable) {
    throw new Error(
      "No Chrome or Chromium executable found. Please specify --chrome <path> or set SEATFIRST_CHROME_EXECUTABLE.",
    );
  }

  console.log(`Using Chrome: ${chromeExecutable}`);
  console.log(`Target URL:   ${baseUrl}`);
  console.log(`Output Dir:   ${path.resolve(outDir)}`);
  console.log(`Scenarios:    ${scenarios.length} to capture`);
  console.log(`Viewports:    ${viewports.map((v) => v.key).join(", ")}`);

  const chromium = await getPlaywrightChromium();
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });

  try {
    for (const vp of viewports) {
      const vpDir = path.join(path.resolve(outDir), vp.key);
      mkdirSync(vpDir, { recursive: true });

      const context = await browser.newContext({
        viewport: vp.viewport,
        deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
      });

      const page = await context.newPage();

      for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        const apiParam = options.api ? `&api=${encodeURIComponent(options.api)}` : "";
        const targetUrl = `${baseUrl.replace(/\/$/, "")}/?seed=${scenario.id}${apiParam}`;
        const filename = `${scenario.name}.png`;
        const filePath = path.join(vpDir, filename);

        process.stdout.write(`[${vp.key}] (${i + 1}/${scenarios.length}) ${scenario.name}... `);

        try {
          await page.goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });
          // Boot/hydration gate readiness: the app renders a full-screen "Connecting…"
          // spinner (BootstrapGate in app/_layout.tsx) until hydration + bootstrap/seed
          // settle. A fixed delay alone races that gate, especially on the slower mobile
          // pass, so wait for the gate text to be gone AND for real content to exist
          // (the pre-seed blank view has empty text, which must not count as ready).
          // Falls through to the settle buffer on timeout — a missed marker must never
          // fail a capture that the old fixed-delay path would have taken.
          try {
            await page.waitForFunction(
              () => {
                // eslint-disable-next-line no-undef -- runs inside the browser via Playwright, not Node.
                const text = document.body ? (document.body.textContent ?? "") : "";
                return text.length > 0 && !text.includes("Connecting\u2026");
              },
              { timeout: 15000 },
            );
          } catch {
            // Readiness marker never appeared; fall through to the settle delay below.
          }
          await page.waitForTimeout(settleMs);
          await page.screenshot({ path: filePath, fullPage: false });
          console.log("✓ saved");
        } catch (err) {
          console.log(`✗ failed: ${err.message}`);
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log("\nCapture run complete!");
}

function printHelp() {
  console.log(`
capture-ui-seeds.mjs — Automated UI seeded states screenshot capture

Usage:
  node scripts/capture-ui-seeds.mjs [options] [scenarios...]
  pnpm capture:ui-seeds [options] [scenarios...]

Options:
  --url <url>              Base URL of dev UI (default: http://localhost:8081)
  --out-dir <path>         Output directory for screenshots (default: ./screenshots)
  --viewport <type>        Viewport: 'desktop', 'mobile', or 'all' (default: 'all')
  --scenarios, --seeds     Comma-separated scenario/seed IDs, names, or patterns (default: all 30)
  --api <profile>          Override API profile for captured scenarios
  --chrome <path>          Path to Chrome/Chromium executable
  --settle-ms <ms>         Wait time in ms after navigation (default: 1000)
  --help, -h               Show this help message

Examples:
  node scripts/capture-ui-seeds.mjs --viewport=mobile
  node scripts/capture-ui-seeds.mjs --seeds=form-movies-loading,form-theatre-error
  node scripts/capture-ui-seeds.mjs form-movies-loading
  node scripts/capture-ui-seeds.mjs "*movies*"
`);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  await captureScreenshots(options);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
