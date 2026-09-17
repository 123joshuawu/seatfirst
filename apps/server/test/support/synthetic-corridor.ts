/**
 * Offline synthetic corridor harness for the S8 provider-fetch-actor suite. This is the
 * apps/server-side minimal equivalent of `packages/browser-runtime/test/support/harness.ts`
 * (which is private to that package and never imported here): it serves each guard-accepted
 * document hop through P6's public `fetchHop` seam, so no S8 test ever touches a network
 * socket, resolves DNS, or talks to AMC. Everything consumed from `@seatfirst/browser-runtime`
 * is a barrel export (`BrowserSupervisor`, `runCorridorNavigation`, `CorridorNavigationOptions`'s
 * `contextSetup`/`fetchHop` seams).
 *
 * The harness IS the entire network: `runCorridorNavigation` performs each document hop by
 * calling the injected `fetchHop`, and any unscripted or misordered document is refused —
 * the suite's network-denial posture for AMC hostnames.
 */
import { existsSync } from "node:fs";

import type { Redis } from "ioredis";
import type { BrowserContext, Route } from "playwright-core";

import type { BrowserSupervisor, HopResponse } from "@seatfirst/browser-runtime";
import type {
  RedisArgument,
  RedisHashCache,
  RedisScript,
  RedisScriptExecutor,
} from "@seatfirst/durability";

/**
 * Chrome executable discovery for the suite — the CI "pinned browser test image supplies
 * Chrome before tests start" (`docs/seatfirst-architecture.md:620`); I1 pins that image and
 * sets `SEATFIRST_CHROME_EXECUTABLE`. Locally, a system Chrome is used. Mirrors
 * `packages/browser-runtime/test/support/chrome.ts` (private to that package) rather than
 * importing it.
 *
 * In CI (`SEATFIRST_ENV === "ci"`), ONLY `SEATFIRST_CHROME_EXECUTABLE` is trusted: the
 * default `ubuntu-latest` runner image ships its own unrelated Chrome at some of the same
 * system paths used for local-dev fallback below, which would otherwise silently enable
 * this suite — including its live-session-refusal assertions — on jobs that never
 * provisioned Chrome for it (verify/checks).
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

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface SyntheticHop {
  /** The exact document URL this hop must carry (WHATWG-normalized). */
  readonly url: string;
  readonly status: number;
  /** Extra response headers (lowercase names); `location` is added for redirects automatically. */
  readonly headers?: Record<string, string>;
  /** Present for 3xx hops: the next hop's URL. */
  readonly location?: string;
  readonly body?: string;
  /**
   * When set, the handler withholds the response until the test resolves the deferred —
   * used to hold a hop open (heartbeat-loss / cancellation tests).
   */
  readonly hold?: Deferred;
}

export interface DocumentRecord {
  readonly url: string;
  readonly cookies: string;
}

export interface SyntheticHarness {
  /** Guard-accepted document requests, in order, with the Cookie header they carried. */
  readonly documents: readonly DocumentRecord[];
  /** Document requests the script did not include or that mismatched the scripted URL. */
  readonly refusals: readonly string[];
  /** The `fetchHop` seam to inject into the actor's navigation seams. */
  readonly fetchHop: (route: Route) => Promise<HopResponse>;
}

export function createSyntheticHarness(hops: readonly SyntheticHop[]): SyntheticHarness {
  const documents: DocumentRecord[] = [];
  const refusals: string[] = [];

  async function fetchHop(route: Route): Promise<HopResponse> {
    const request = route.request();
    const url = request.url();
    const index = documents.length;
    documents.push({ url, cookies: request.headers()["cookie"] ?? "" });
    const hop = hops[index];
    if (hop === undefined || hop.url !== url) {
      // Unscripted or misordered document: refuse — this is the denial posture.
      refusals.push(url);
      throw new Error("synthetic network refused an unscripted document request");
    }
    if (hop.hold !== undefined) {
      await hop.hold.promise;
    }
    const headers: Record<string, string> = {
      "content-type": "text/html; charset=utf-8",
      ...hop.headers,
    };
    if (hop.location !== undefined) {
      headers["location"] = hop.location;
    }
    return { status: hop.status, headers, body: hop.body ?? "" };
  }

  return { documents, refusals, fetchHop };
}

export const SEAT_PAGE_HTML = `<!doctype html>
<html>
  <head><title>seat page</title></head>
  <body>
    <h1>Seats</h1>
    <div id="seat-map"></div>
</html>`;

export const QUEUE_WAITING_HTML = `<!doctype html>
<html>
  <head><title>queue waiting</title></head>
  <body>
    <h1>You are in the queue</h1>
    <script src="/queueit/waitingroom.js"></script>
  </body>
</html>`;

/** The exact corridor script the browser-runtime suite validates (P6). */
export const MOVIES = "https://www.amctheatres.com/movies";
export const QUEUE = `https://queue.amctheatres.com/?c=amc&e=seats&ver=v1&cver=2&man=seatfinder&enqueuetoken=0000-1111&kupver=3&t=${encodeURIComponent(MOVIES)}`;
export const TOKEN_RETURN = `${MOVIES}?queueittoken=q-123`;

export interface CorridorOverrides {
  readonly initialUrl?: string;
  readonly initialStatus?: number;
  readonly initialHeaders?: Record<string, string>;
  readonly queueStatus?: number;
  readonly queueHeaders?: Record<string, string>;
  readonly queueBody?: string;
  readonly cleanBody?: string;
  readonly holdQueue?: Deferred;
}

/** The four-document AMC corridor, scripted for one terminal outcome per test. */
export function corridorHops(overrides: CorridorOverrides = {}): SyntheticHop[] {
  const initialUrl = overrides.initialUrl ?? MOVIES;
  const initialStatus = overrides.initialStatus ?? 302;
  const queueStatus = overrides.queueStatus ?? 302;
  return [
    {
      url: initialUrl,
      status: initialStatus,
      ...(initialStatus === 302 ? { location: QUEUE } : {}),
      ...(initialStatus !== 302 && overrides.initialHeaders !== undefined
        ? { headers: overrides.initialHeaders }
        : {}),
    },
    {
      url: QUEUE,
      status: queueStatus,
      ...(queueStatus === 302 ? { location: TOKEN_RETURN } : {}),
      ...(queueStatus !== 302 && overrides.queueHeaders !== undefined
        ? { headers: overrides.queueHeaders }
        : {}),
      ...(queueStatus !== 302 ? { body: overrides.queueBody ?? QUEUE_WAITING_HTML } : {}),
      ...(overrides.holdQueue !== undefined ? { hold: overrides.holdQueue } : {}),
    },
    {
      url: TOKEN_RETURN,
      status: 302,
      location: initialUrl,
    },
    {
      url: initialUrl,
      status: 200,
      body: overrides.cleanBody ?? SEAT_PAGE_HTML,
    },
  ];
}

/**
 * A recording adapter over the ioredis client the suite already shares with BullMQ.
 * It satisfies durability's `RedisScriptExecutor & RedisHashCache` structurally while
 * recording every script invocation so tests can observe acquire/release ordering
 * without touching the scripts themselves.
 */
export class RecordingRedis implements RedisScriptExecutor, RedisHashCache {
  readonly calls: Array<{
    readonly name: string;
    readonly keys: readonly string[];
    readonly args: readonly RedisArgument[];
  }> = [];

  constructor(private readonly redis: Redis) {}

  async eval(
    script: RedisScript,
    keys: readonly string[],
    args: readonly RedisArgument[],
  ): Promise<unknown> {
    this.calls.push({ name: script.name, keys, args });
    return this.redis.eval(script.text, keys.length, ...keys, ...args);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  async hset(key: string, values: Readonly<Record<string, RedisArgument>>): Promise<number> {
    return this.redis.hset(key, values);
  }

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }
}

export interface CleanupGate {
  /** The cleanup-completion promise, blocked until `open()` is called. */
  readonly opened: Promise<void>;
  open(): void;
  restore(): void;
}

/**
 * Gates the shared supervisor's `cleanupContext` on a deferred: the navigation's
 * cleanup-completion signal cannot resolve until the test opens the gate. This makes
 * the S8.16 ordering proof deterministic — the handler's SEMAPHORE_RELEASE cannot fire
 * before `cleanupCompleted` resolves, so the test observes zero releases while the gate
 * is closed and exactly the release after it opens. `restore()` reinstates the real
 * method (the supervisor is shared across the suite).
 */
export function gateCleanup(supervisor: BrowserSupervisor): CleanupGate {
  const original = supervisor.cleanupContext.bind(supervisor);
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  supervisor.cleanupContext = async (context: BrowserContext) => {
    await opened;
    await original(context);
  };
  return {
    opened,
    open: () => release(),
    restore: () => {
      supervisor.cleanupContext = original;
    },
  };
}
