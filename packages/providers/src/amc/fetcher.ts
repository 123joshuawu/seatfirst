/// <reference lib="dom" />
declare const process: { env: Record<string, string | undefined> };
import type { ProviderOutcome } from "../contract.js";
import { classifyResponse } from "./classify.js";
import { validateIdentity, type AmcIdentityOptions } from "./identity.js";
import { isAllowedUrl } from "./routes.js";

export interface AmcTrafficOptions {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCeilingMs: number;
  readonly jitterWindowMs: number;
  readonly socketTimeoutMs: number;
}

export interface AmcTransport {
  readonly request: typeof fetch;
  readonly isLive: boolean;
}

export interface AmcFetchOptions extends AmcIdentityOptions, AmcTrafficOptions {
  /** Injected transport interface so tests run offline */
  readonly transport: AmcTransport;
}

export interface AmcRequestLog {
  readonly url: string;
  readonly timestamp: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly cfRay: string | null;
  readonly pageTitle: string | null;
  parserVersion: string | null;
  schemaError: string | null;
  readonly classification: string;
  readonly enrich: (parserVersion: string, schemaError: string | null) => void;
}

export interface AmcFetchResult {
  readonly body: string;
  readonly log: AmcRequestLog;
}

const originLocks = new Map<string, Promise<void>>();

function acquireLock(origin: string): Promise<() => void> {
  let resolveCurrent: () => void;
  const current = new Promise<void>((r) => {
    resolveCurrent = r;
  });

  const previous = originLocks.get(origin) ?? Promise.resolve();
  originLocks.set(
    origin,
    previous.then(() => current),
  );

  return previous.then(() => resolveCurrent);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(header: string | undefined | null): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header)) {
    const seconds = parseInt(header, 10);
    if (!Number.isNaN(seconds)) return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta >= 0 ? delta : null;
  }
  return null;
}

function extractPageTitle(body: string): string | null {
  const match = body.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1] ?? null;
}

/**
 * Per-process, in-memory cookie jar scoped to one bounded navigation.
 * Never persisted to disk, never carried across sessions or clients.
 */
class CookieJar {
  private cookies = new Map<string, string>();

  processSetCookie(setCookieHeaders: string[]) {
    for (const header of setCookieHeaders) {
      const parts = header.split(";");
      if (parts.length === 0) continue;
      const [nameValue] = parts;
      const eqIdx = nameValue!.indexOf("=");
      if (eqIdx === -1) continue;
      const name = nameValue!.slice(0, eqIdx).trim();
      const value = nameValue!.slice(eqIdx + 1).trim();

      if (
        name.toLowerCase() === "cf_clearance" ||
        name.toLowerCase().includes("queue-it") ||
        name.toLowerCase().includes("queueit")
      ) {
        continue;
      }

      this.cookies.set(name, value);
    }
  }

  getCookieString(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
}

export class AmcFetcher {
  private readonly cookieJar = new CookieJar();
  private haltedOutcome: ProviderOutcome<AmcFetchResult> | null = null;

  constructor(private readonly options: AmcFetchOptions) {
    let isCi = false;
    if (typeof process !== "undefined") {
      isCi = process.env.SEATFIRST_ENV === "ci";
    }
    if (isCi && options.transport.isLive) {
      throw new Error("Refusing to use live global fetch when SEATFIRST_ENV is ci");
    }

    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (!Number.isInteger(options.backoffBaseMs) || options.backoffBaseMs <= 0) {
      throw new Error("backoffBaseMs must be a positive integer");
    }
    if (
      !Number.isInteger(options.backoffCeilingMs) ||
      options.backoffCeilingMs < options.backoffBaseMs
    ) {
      throw new Error("backoffCeilingMs must be a positive integer >= backoffBaseMs");
    }
    if (!Number.isInteger(options.jitterWindowMs) || options.jitterWindowMs < 0) {
      throw new Error("jitterWindowMs must be a non-negative integer");
    }
    if (options.transport.isLive && options.jitterWindowMs === 0) {
      throw new Error("jitterWindowMs must be >0 for live traffic");
    }
    if (!Number.isInteger(options.socketTimeoutMs) || options.socketTimeoutMs <= 0) {
      throw new Error("socketTimeoutMs must be a positive integer");
    }

    validateIdentity(options);
  }

  async fetch(url: URL): Promise<ProviderOutcome<AmcFetchResult>> {
    if (this.haltedOutcome) return this.haltedOutcome;
    if (!isAllowedUrl(url)) {
      return {
        ok: false,
        code: "UPSTREAM_BLOCKED",
        message: "URL not allowed",
        providerMeta: {},
      };
    }

    let attempt = 0;
    while (attempt < this.options.maxAttempts) {
      attempt++;

      const release = await acquireLock(url.origin);
      if (this.haltedOutcome) {
        release();
        return this.haltedOutcome;
      }

      // Jitter
      if (this.options.jitterWindowMs > 0) {
        await delay(Math.random() * this.options.jitterWindowMs);
      }

      let response: Response;
      let bodyText = "";
      let fetchError: unknown = null;
      const requestStart = new Date().toISOString();

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), this.options.socketTimeoutMs);

        const finalHeaders = {
          "User-Agent": this.options.userAgent,
        } as Record<string, string>;

        const cookieStr = this.cookieJar.getCookieString();
        if (cookieStr) {
          finalHeaders["Cookie"] = cookieStr;
        }

        response = await this.options.transport.request(url.toString(), {
          method: "GET",
          redirect: "manual",
          headers: finalHeaders,
          signal: controller.signal,
        });

        bodyText = await response.text();
      } catch (err) {
        fetchError = err;
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        release();
      }

      if (fetchError) {
        // Retry transient errors (timeout or connection failures)
        if (attempt < this.options.maxAttempts) {
          const backoff = Math.min(
            this.options.backoffCeilingMs,
            this.options.backoffBaseMs * Math.pow(2, attempt - 1),
          );
          await delay(backoff);
          continue;
        }
        return {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          message: "Connection failed",
          providerMeta: {
            cause: fetchError,
          },
        };
      }

      const status = response!.status;
      const headers = Object.fromEntries(response!.headers.entries());
      const contentType = response!.headers.get("content-type") ?? null;
      const cfRay = response!.headers.get("cf-ray") ?? null;
      const bodyPrefix = bodyText; // Finding 7: scan the complete body

      let classificationFinalHost = response!.url ? new URL(response!.url).host : url.host;
      let isAllowedRedirect = false;
      let targetUrl: URL | undefined = undefined;

      let invalidRedirect = false;
      if (status >= 300 && status < 400) {
        const location = response!.headers.get("location");
        if (location) {
          try {
            targetUrl = new URL(location, url);
            classificationFinalHost = targetUrl.host;
            if (targetUrl.origin === url.origin && isAllowedUrl(targetUrl)) {
              isAllowedRedirect = true;
            } else {
              invalidRedirect = true;
            }
          } catch {
            invalidRedirect = true;
          }
        } else {
          invalidRedirect = true;
        }
      }

      const classification = classifyResponse(status, headers, {
        finalHost: classificationFinalHost,
        bodyPrefix,
      });

      // Mask query params for the final response URL, but AMC's expected URLs don't have secrets.
      // We will record the final post-redirect URL.
      const finalUrlStr = response!.url || url.toString();

      const log: AmcRequestLog = {
        url: finalUrlStr,
        timestamp: requestStart,
        status,
        contentType,
        cfRay,
        pageTitle: extractPageTitle(bodyText),
        parserVersion: null, // P4 doesn't parse, so null
        schemaError: null,
        classification: classification.ok ? "NOT_TRAFFIC_CONTROL" : classification.code,
        enrich(parserVersion: string, schemaError: string | null) {
          this.parserVersion = parserVersion;
          this.schemaError = schemaError;
        },
      };

      if (!classification.ok) {
        if (
          classification.code === "CHALLENGE_REQUIRED" ||
          classification.code === "UPSTREAM_BLOCKED" ||
          classification.code === "UPSTREAM_QUEUED"
        ) {
          this.cookieJar.clear();
          this.haltedOutcome = {
            ok: false,
            code: classification.code,
            message: "Traffic control blocked request",
            providerMeta: { log },
          };
          return this.haltedOutcome;
        }
        if (classification.code === "NOT_FOUND") {
          // Branded error under 200, or actual 404
          return {
            ok: false,
            code: classification.code,
            message: "Not found",
            providerMeta: { log },
          };
        }

        if (classification.code === "RATE_LIMITED") {
          if (attempt < this.options.maxAttempts) {
            const retryAfter = parseRetryAfter(response!.headers.get("retry-after"));
            const backoff =
              retryAfter ??
              Math.min(
                this.options.backoffCeilingMs,
                this.options.backoffBaseMs * Math.pow(2, attempt - 1),
              );
            await delay(backoff);
            continue;
          }
          return {
            ok: false,
            code: classification.code,
            message: "Rate limited",
            providerMeta: { log },
          };
        }

        // Finding 10: Exhaustive fallback for other ProviderErrorCodes
        return {
          ok: false,
          code: classification.code,
          message: "Upstream error",
          providerMeta: { log },
        };
      }

      // Now we can store cookies (Finding 6)
      if (typeof response!.headers.getSetCookie === "function") {
        this.cookieJar.processSetCookie(response!.headers.getSetCookie());
      }
      if (status >= 300 && status < 400) {
        if (isAllowedRedirect && targetUrl) {
          url = targetUrl;
          continue;
        }
        if (invalidRedirect) {
          return {
            ok: false,
            code: "UPSTREAM_BLOCKED",
            message: "Invalid or malformed redirect target",
            providerMeta: { log },
          };
        }
      }
      // Transient 5xx
      if (status >= 500 && status < 600) {
        if (
          (status === 502 || status === 503 || status === 504) &&
          attempt < this.options.maxAttempts
        ) {
          const backoff = Math.min(
            this.options.backoffCeilingMs,
            this.options.backoffBaseMs * Math.pow(2, attempt - 1),
          );
          await delay(backoff);
          continue;
        }
        return {
          ok: false,
          code: "UPSTREAM_UNAVAILABLE",
          message: "Upstream 5xx error",
          providerMeta: { log },
        };
      }

      return {
        ok: true,
        value: { body: bodyText, log },
      };
    }

    // Should never reach here if maxAttempts > 0
    return {
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      message: "Max attempts exceeded",
      providerMeta: {},
    };
  }
}
