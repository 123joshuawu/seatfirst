import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCLink,
} from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@seatfirst/server";
import { QueryClient } from "@tanstack/react-query";

import { cookieAwareFetch } from "./cookieJar";
import { devTransportLink, isDevTransportEnabled } from "./devTransport";
import { isUnauthorizedError } from "./errorEnvelope";

export const unauthorizedRetryLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) => {
    return observable((observer) => {
      let attempts = 0;
      let activeSub: { unsubscribe: () => void } | null = null;
      let isUnsubscribed = false;

      const subscribeWithHandler = () => {
        activeSub = next(op).subscribe({
          next(value) {
            observer.next(value);
          },
          error: (err) => {
            if (isUnsubscribed) return;
            // Do not retry bootstrap itself; it never throws UNAUTHORIZED (it mints)
            if (attempts === 0 && op.path !== "session.bootstrap" && isUnauthorizedError(err)) {
              attempts++;
              void (async () => {
                try {
                  const { renewSession } = await import("./session");
                  await renewSession();
                  if (isUnsubscribed) return;
                  // Retry once with the same op (same input, new cookie now in jar)
                  activeSub = next(op).subscribe({
                    next: (v) => observer.next(v),
                    error: (e) => observer.error(e),
                    complete: () => observer.complete(),
                  });
                } catch {
                  observer.error(err);
                }
              })();
            } else {
              observer.error(err);
            }
          },
          complete() {
            observer.complete();
          },
        });
      };

      subscribeWithHandler();

      return {
        unsubscribe() {
          isUnsubscribed = true;
          activeSub?.unsubscribe();
        },
      };
    });
  };
};

function getApiUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl && envUrl.trim().length > 0) return envUrl.replace(/\/$/, "");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- expo-constants is optional at runtime; static import would break web/test where the native module is absent
    const mod = require("expo-constants") as {
      default?: { expoConfig?: unknown; manifest?: unknown };
      expoConfig?: unknown;
      manifest?: unknown;
    };
    const Constants: unknown = mod.default ?? mod;
    const extraUrl =
      Constants !== null && typeof Constants === "object" && "expoConfig" in Constants
        ? ((
            Constants as {
              expoConfig?: { extra?: { apiUrl?: string } };
              manifest?: { extra?: { apiUrl?: string } };
            }
          ).expoConfig?.extra?.apiUrl ??
          (Constants as { manifest?: { extra?: { apiUrl?: string } } }).manifest?.extra?.apiUrl)
        : null;
    if (typeof extraUrl === "string" && extraUrl.trim().length > 0) {
      return extraUrl.replace(/\/$/, "");
    }
  } catch {
    // expo-constants not available (test environment)
  }
  // ADR 0055 §Decision item 5: the production web bundle is served same-origin
  // with the API by Caddy on the relay, so an empty/unset EXPO_PUBLIC_API_URL
  // resolves relatively ("", i.e. getTrpcUrl() === "/trpc"). Native has no DOM
  // document and dev builds never run under NODE_ENV=production, so both keep
  // the localhost default below; explicit env/extra URLs above always win.
  if (typeof document !== "undefined" && process.env.NODE_ENV === "production") {
    return "";
  }
  return "http://localhost:3000";
}

const apiUrl = getApiUrl();

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

/**
 * BATCH-414: cap for a single batched tRPC GET URL. Without a cap, every query
 * queued in the same tick is coalesced into one GET whose comma-joined
 * procedure-name path grows without bound (6x `theatres.movies` already exceeds
 * Fastify's 100-char default `maxParamLength` for that path segment). 2000
 * matches common reverse-proxy/URL-length safety margins; oversized batches
 * auto-split into sequential requests instead of ever emitting one giant URL.
 * Exported for tests to assert split behavior against the shipped value.
 */
export const TRPC_BATCH_MAX_URL_LENGTH = 2000;

/** React-hooks binding (UI11.2) — `trpc.[router].[procedure].useQuery()` etc. */
export const trpc = createTRPCReact<AppRouter>();

/** Vanilla tRPC client (UI11.2 rename) — for non-React modules and the provider below. */
export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    // Dev-only seam: with a handler installed (fixtures/mockTransport.ts) this terminates
    // an operation with fixture data; with none it passes straight through. Outside
    // __DEV__ the link is not added at all.
    ...(isDevTransportEnabled() ? [devTransportLink] : []),
    unauthorizedRetryLink,
    splitLink({
      condition: (op) => op.type === "subscription",
      true: httpSubscriptionLink({
        url: `${apiUrl}/trpc`,
        eventSourceOptions: { withCredentials: true },
        // EventSource supplies credentials via withCredentials; the same origin
        // carries the `seatfirst_session` cookie set during bootstrap (UI2).
        // Native EventSource polyfills read the Cookie header via this option
        // when available; fallback is via httpBatchLink's cookieAwareFetch for
        // mutations/queries. See spec UI3.8.
      }),
      false: splitLink({
        // `searches.get` and `showtimes.recheck` are served by bespoke Fastify
        // routes (apps/server/src/routes/searches/get.ts `registerSearchGet`,
        // apps/server/src/routes/showtimes/register.ts
        // `registerShowtimesRecheck`) mounted ahead of `fastifyTRPCPlugin`'s
        // batch-aware catch-all — `searches.get` for ETag/304 support, the
        // recheck route because its context needs `nonceSecret`/`deadlineMs`/
        // `recovery`. Neither bespoke route unwraps `httpBatchLink`'s
        // `?batch=1` / `{"0":<json>}` envelope, so both reject the call with a
        // zod "expected string, received undefined" error. Route them through
        // a plain, non-batching `httpLink` so their requests match the shapes
        // the bespoke routes actually parse (GET `?input=<json>` unwrapped;
        // POST body verbatim); every other query/mutation still goes through
        // the batch-aware catch-all via `httpBatchLink` below.
        condition: (op) => op.path === "searches.get" || op.path === "showtimes.recheck",
        true: httpLink({
          url: `${apiUrl}/trpc`,
          fetch: (input, init) => cookieAwareFetch(input, init as RequestInit | undefined),
        }),
        false: httpBatchLink({
          url: `${apiUrl}/trpc`,
          // BATCH-414: auto-split oversized batches (see TRPC_BATCH_MAX_URL_LENGTH).
          maxURLLength: TRPC_BATCH_MAX_URL_LENGTH,
          // tRPC's FetchEsque init is `RequestInit | RequestInitEsque`; under
          // exactOptionalPropertyTypes the DOM RequestInit's `signal?: AbortSignal | null`
          // is not assignable to RequestInitEsque's `signal?: AbortSignal | undefined`.
          // This adapter widens the init param to the union and casts to what our fetch
          // accepts (runtime shape is identical; only the optional-nullability differs).
          fetch: (input, init) => cookieAwareFetch(input, init as RequestInit | undefined),
        }),
      }),
    }),
  ],
});

/** Exposed for tests to assert URL construction. */
export function getTrpcUrl(): string {
  return `${apiUrl}/trpc`;
}
