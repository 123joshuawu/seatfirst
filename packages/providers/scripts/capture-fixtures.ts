import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";

import { AmcFetcher, type AmcFetchOptions } from "../src/amc/fetcher.js";
import {
  buildSeatsUrl,
  buildShowtimesUrl,
  buildTheatresUrl,
  buildMoviesUrl,
} from "../src/amc/routes.js";
import { redact } from "./redact.js";

const MAX_REQUESTS = 150;

// IMPORTANT: Real preregistration (verifying these slugs/IDs actually resolve to real inventory)
// is a REQUIRED operator step before the live session runs. The one session authorized on
// 2026-08-10 may be operated by Codex under Josh Wu's explicit one-time delegation; this is not
// general authorization for unattended or repeat execution.
// The 15 theatre/date pairs and nine nonzero seat/showtime IDs below were preregistered against
// ordinary AMC pages on 2026-08-10 for the 2026-08-11 inventory date. The zero ID is the API
// spec's intentional branded-NOT_FOUND case. Do not reuse this dated list for another session.
export const CAPTURE_TARGETS = [
  buildMoviesUrl(),
  buildTheatresUrl("New York"),
  buildTheatresUrl("Los Angeles"),
  buildTheatresUrl("Chicago"),
  buildTheatresUrl("Houston"),
  buildTheatresUrl("Miami"),
  buildTheatresUrl("Seattle"),
  buildTheatresUrl("Boston"),
  buildTheatresUrl("Atlanta"),
  buildTheatresUrl("Denver"),
  buildTheatresUrl("Phoenix"),
  buildShowtimesUrl("san-francisco", "amc-metreon-16", "2026-08-11"),
  buildShowtimesUrl("san-francisco", "amc-kabuki-8", "2026-08-11"),
  buildShowtimesUrl("oakland", "amc-bay-street-16", "2026-08-11"),
  buildShowtimesUrl("san-francisco", "amc-newpark-12", "2026-08-11"),
  buildShowtimesUrl("san-francisco", "amc-sunnyvale-12", "2026-08-11"),
  buildShowtimesUrl("san-jose", "amc-mercado-20", "2026-08-11"),
  buildShowtimesUrl("oakland", "amc-brentwood-14", "2026-08-11"),
  buildShowtimesUrl("san-jose", "amc-saratoga-14", "2026-08-11"),
  buildShowtimesUrl("san-jose", "amc-eastridge-15", "2026-08-11"),
  buildShowtimesUrl("new-york-city", "amc-empire-25", "2026-08-11"),
  buildShowtimesUrl("new-york-city", "amc-34th-street-14", "2026-08-11"),
  buildShowtimesUrl("new-york-city", "amc-kips-bay-15", "2026-08-11"),
  buildShowtimesUrl("new-york-city", "amc-19th-st-east-6", "2026-08-11"),
  buildShowtimesUrl("new-york-city", "amc-lincoln-square-13", "2026-08-11"),
  buildShowtimesUrl("new-york-city", "amc-village-7", "2026-08-11"),
  buildSeatsUrl(145738269), // standard Laser/recliner; mostly available; wheelchair/companion
  buildSeatsUrl(144251406), // Dolby recliner; mixed occupancy; wheelchair/companion
  buildSeatsUrl(144251404), // Dolby recliner; almost full (151/186 occupied)
  buildSeatsUrl(144696906), // IMAX 70mm Club Rocker; sold out (480/480 occupied)
  buildSeatsUrl(144251296), // ScreenX recliner layout
  buildSeatsUrl(144251356), // RealD 3D recliner layout
  buildSeatsUrl(145022936), // open-caption, ID-required showing
  buildSeatsUrl(143262705), // Japanese with English subtitles; small layout
  buildSeatsUrl(145493963), // small almost-full layout (44/47 occupied)
  buildSeatsUrl(0), // deliberately invalid ID (API spec documented 0) yielding 200 branded NOT_FOUND
];

export interface CaptureResult {
  aborted: boolean;
  requestsSpent: number;
}

import { isAllowedUrl } from "../src/amc/routes.js";
import { classifyResponse } from "../src/amc/classify.js";

export interface CaptureOptions {
  targets: URL[];
  budget: number;
  fetchOptions: Omit<AmcFetchOptions, "transport">;
  transport: { request: typeof fetch; isLive: boolean };
  outDir: string;
  logWriter: (line: string) => void;
  confirmedLive?: boolean;
  requestsSpentTracker?: { spent: number };
}

export async function runCaptureSession({
  targets,
  budget,
  fetchOptions,
  transport,
  outDir,
  logWriter,
  confirmedLive,
  requestsSpentTracker,
}: CaptureOptions): Promise<CaptureResult> {
  if (transport.isLive) {
    if (process.env.SEATFIRST_ENV === "ci") {
      throw new Error("Refusing to run live session in CI.");
    }
    if (!confirmedLive) {
      throw new Error("Refusing to run live session without explicit confirmation.");
    }
  }
  if (!Number.isInteger(budget) || budget <= 0 || budget > 150) {
    throw new Error("Budget must be an integer between 1 and 150.");
  }

  let requestsSpent = 0;
  let aborted = false;
  let localError: Error | null = null;
  const wrappedFetch: typeof fetch = async (input, init) => {
    const urlStr = input instanceof Request ? input.url : input.toString();
    const urlObj = new URL(urlStr);

    if (!isAllowedUrl(urlObj)) {
      throw new Error(`Refusing to follow disallowed origin or queue-it: ${urlStr}`);
    }

    if (requestsSpent >= budget) {
      throw new Error(`Budget of ${budget} requests exceeded.`);
    }
    requestsSpent++;
    if (requestsSpentTracker) requestsSpentTracker.spent = requestsSpent;
    const response = await transport.request(input, init);

    // Extract structured envelope before AmcFetcher reduces it (implementing our own observer)
    try {
      const cloned = response.clone();
      const status = response.status;
      const headers = Object.fromEntries(response.headers.entries());
      const contentType = headers["content-type"] || "";
      const cfRay = headers["cf-ray"] || "";

      // Get body for classification
      const bodyText = await cloned.text();
      let finalHost = response.url ? new URL(response.url).host : urlObj.host;
      let isInvalidRedirect = false;

      if (status >= 300 && status < 400) {
        const location = headers["location"];
        if (location) {
          try {
            const targetUrl = new URL(location, urlObj);
            finalHost = targetUrl.host;
            if (!isAllowedUrl(targetUrl)) {
              isInvalidRedirect = true;
            }
          } catch {
            isInvalidRedirect = true;
          }
        } else {
          isInvalidRedirect = true;
        }
      }

      const classification = classifyResponse(status, headers, {
        finalHost,
        bodyPrefix: bodyText,
      });
      let code = classification.ok ? "OK" : classification.code;
      if (code === "OK" && isInvalidRedirect) {
        code = "UPSTREAM_BLOCKED";
      }

      logWriter(
        `[ATTEMPT] ${new Date().toISOString()} | ${urlStr} | HTTP ${status} (${code}) | contentType: ${contentType} | cfRay: ${cfRay}`,
      );

      // Persist NOT_FOUND (like the branded 200 invalid showtime) while refusing challenge/queue bodies
      if (code === "NOT_FOUND") {
        const safeName =
          urlObj.pathname.replace(/[^a-z0-9]/gi, "_") +
          "_" +
          urlObj.search.replace(/[^a-z0-9]/gi, "_");
        const outPath = join(outDir, `${safeName}_${Date.now()}.json`);
        const redacted = redact({ url: urlStr, status, headers, body: bodyText });
        writeFileSync(outPath, JSON.stringify(redacted));
      }
    } catch (err) {
      localError = err instanceof Error ? err : new Error(String(err));
      aborted = true;
      return new Response("Local processing failed", { status: 599 });
    }

    return response;
  };
  const fetcher = new AmcFetcher({
    ...fetchOptions,
    transport: { request: wrappedFetch, isLive: transport.isLive },
  });

  for (const url of targets) {
    if (requestsSpent >= budget) {
      logWriter(`[WARN] Budget of ${budget} requests spent. Target left uncaptured: ${url.href}`);
      continue;
    }

    const result = await fetcher.fetch(url);

    if (localError) {
      throw localError as Error;
    }

    if (!result.ok) {
      const code = result.code;
      logWriter(`[${new Date().toISOString()}] ${url.href} - FAILED: ${code}`);

      if (
        code === "CHALLENGE_REQUIRED" ||
        code === "UPSTREAM_QUEUED" ||
        code === "UPSTREAM_BLOCKED"
      ) {
        logWriter(`[ABORT] Traffic control encountered: ${code}. Aborting session.`);
        aborted = true;
        break;
      }
      continue;
    }

    const { body, log } = result.value;
    logWriter(`[${log.timestamp}] ${log.url} - ${log.status} (${log.classification})`);

    if (
      log.classification === "CHALLENGE_REQUIRED" ||
      log.classification === "UPSTREAM_QUEUED" ||
      log.classification === "UPSTREAM_BLOCKED"
    ) {
      logWriter(`[ABORT] Traffic control encountered: ${log.classification}. Aborting session.`);
      aborted = true;
      break;
    }

    const headersFromLog: Record<string, string> = {};
    if (log.contentType) headersFromLog["content-type"] = log.contentType;
    if (log.cfRay) headersFromLog["cf-ray"] = log.cfRay;

    // Redact
    const redacted = redact({
      url: log.url,
      status: log.status,
      headers: headersFromLog,
      body,
    });

    // Write to fixtures/raw/
    const safeName =
      url.pathname.replace(/[^a-z0-9]/gi, "_") + "_" + url.search.replace(/[^a-z0-9]/gi, "_");
    const outPath = join(outDir, `${safeName}_${Date.now()}.json`);
    writeFileSync(
      outPath,
      JSON.stringify({
        url: redacted.url,
        status: redacted.status,
        headers: redacted.headers,
        body: redacted.body,
      }),
    );
  }

  return { aborted, requestsSpent };
}

export interface CliDependencies {
  transport?: { request: typeof fetch; isLive: boolean };
  outDir?: string;
  logWriter?: (line: string) => void;
}

export async function cliMain(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: CliDependencies = {},
): Promise<void> {
  const isCi = env.SEATFIRST_ENV === "ci";
  const flagIndex = args.indexOf("--confirm-live-session=yes-i-understand");

  if (isCi) {
    console.error(
      "Refusing to run: SEATFIRST_ENV=ci is set. Explicit operator authorization is required.",
    );
    process.exitCode = 1;
    return;
  }

  if (flagIndex === -1) {
    console.error("Refusing to run: missing --confirm-live-session=yes-i-understand flag.");
    process.exitCode = 1;
    return;
  }

  const operatorFlag = args.find((a) => a.startsWith("--operator="));
  const operator = operatorFlag ? operatorFlag.split("=")[1] : env.AMC_OPERATOR;
  if (!operator || operator.trim() === "") {
    console.error(
      "Refusing to run: missing or invalid operator. Provide --operator=NAME or AMC_OPERATOR env var.",
    );
    process.exitCode = 1;
    return;
  }

  const requiredEnvVars = [
    "AMC_USER_AGENT",
    "AMC_MAX_ATTEMPTS",
    "AMC_BACKOFF_BASE_MS",
    "AMC_BACKOFF_CEILING_MS",
    "AMC_JITTER_WINDOW_MS",
    "AMC_SOCKET_TIMEOUT_MS",
  ];

  for (const v of requiredEnvVars) {
    if (!env[v]) {
      console.error(
        `Refusing to run: missing required environment variable ${v}.\n` +
          `You MUST supply all traffic-control tunables explicitly.\n` +
          `Note: ADR 0002 §2.8 requires AMC_USER_AGENT to include a descriptive product name and contact info.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const maxAttempts = parseInt(env.AMC_MAX_ATTEMPTS!, 10);
  const backoffBaseMs = parseInt(env.AMC_BACKOFF_BASE_MS!, 10);
  const backoffCeilingMs = parseInt(env.AMC_BACKOFF_CEILING_MS!, 10);
  const jitterWindowMs = parseInt(env.AMC_JITTER_WINDOW_MS!, 10);
  const socketTimeoutMs = parseInt(env.AMC_SOCKET_TIMEOUT_MS!, 10);

  if (
    isNaN(maxAttempts) ||
    isNaN(backoffBaseMs) ||
    isNaN(backoffCeilingMs) ||
    isNaN(jitterWindowMs) ||
    isNaN(socketTimeoutMs)
  ) {
    console.error("Refusing to run: one or more traffic tunables are not valid integers.");
    process.exitCode = 1;
    return;
  }

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = deps.outDir || join(packageRoot, "fixtures", "raw");
  if (!deps.outDir) {
    mkdirSync(outDir, { recursive: true });
  }

  const logPath = join(packageRoot, "fixtures", "CAPTURE-LOG.md");

  const logWriter =
    deps.logWriter ||
    ((line: string) => {
      process.stdout.write(line + "\n");
      appendFileSync(logPath, line + "\n");
    });

  logWriter(`\n## Session started at ${new Date().toISOString()}`);
  logWriter(`Operator: ${operator}`);

  let moviesCount = 0;
  let theatresCount = 0;
  let showtimesCount = 0;
  let seatsCount = 0;
  for (const t of CAPTURE_TARGETS) {
    const path = t.pathname;
    if (path.includes("/seats")) seatsCount++;
    else if (path.includes("/showtimes")) showtimesCount++;
    else if (path.includes("/theatres") || path.includes("/movie-theatres")) theatresCount++;
    else if (path.includes("/movies")) moviesCount++;
    logWriter(`Target: ${t.href}`);
  }
  logWriter(
    `Route mix: ${moviesCount} movies, ${theatresCount} theatres, ${showtimesCount} showtimes, ${seatsCount} seats`,
  );

  const requestsSpentTracker = { spent: 0 };

  try {
    const { aborted, requestsSpent } = await runCaptureSession({
      targets: CAPTURE_TARGETS,
      budget: MAX_REQUESTS,
      fetchOptions: {
        userAgent: env.AMC_USER_AGENT!,
        maxAttempts,
        backoffBaseMs,
        backoffCeilingMs,
        jitterWindowMs,
        socketTimeoutMs,
      },
      transport: deps.transport || { request: fetch, isLive: true },
      outDir,
      logWriter,
      confirmedLive: flagIndex !== -1,
      requestsSpentTracker,
    });
    requestsSpentTracker.spent = requestsSpent;
    logWriter(
      `Session ended. Aborted: ${aborted}. Requests spent: ${requestsSpent}/${MAX_REQUESTS}.`,
    );
    if (aborted) {
      process.exitCode = 1;
    }
  } catch (err) {
    // Never print the raw error: a redaction fail-closed error (redact.ts) legitimately embeds
    // the un-redacted fragment it caught, and other local errors may carry a filesystem path or
    // URL. Only the error's name is safe to surface; the sanitized [ABORT] entry below is the
    // durable, human-verifiable record.
    console.error(
      `Fatal error during capture session: ${err instanceof Error ? err.name : "UnknownError"}.`,
    );
    logWriter(`[ABORT] Fatal error encountered.`);
    logWriter(
      `Session ended. Aborted: true. Requests spent: ${requestsSpentTracker.spent}/${MAX_REQUESTS}.`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cliMain(process.argv, process.env)
    .then(() => {
      if (process.exitCode) {
        process.exit(process.exitCode);
      }
    })
    .catch((err) => {
      console.error(
        `Fatal error running capture-fixtures: ${err instanceof Error ? err.name : "UnknownError"}.`,
      );
      process.exit(1);
    });
}
