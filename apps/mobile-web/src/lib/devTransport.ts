/**
 * Dev-only transport seam for the tRPC client.
 *
 * `trpc.ts` composes `trpcClient` from a link array; this module contributes a link that
 * sits in front of the retry and HTTP links and can terminate an operation with fixture
 * data instead of a network call. It carries no fixtures itself — the handler is
 * installed at runtime by `fixtures/mockTransport.ts`, which is dynamically imported, so
 * nothing in `fixtures/` reaches the initial bundle through this file.
 *
 * With no handler installed the link is a pass-through, and `trpc.ts` does not add it at
 * all outside `__DEV__`.
 *
 * This is the seam the store seeder cannot reach: the search form's loading, error, and
 * facet-count states live in react-query and in bare `trpcClient` calls, not in zustand.
 * It follows the pattern `lib/geocodeSeam.ts` already established for `resolvePlace`.
 */
import type { TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@seatfirst/server";

/** What a handler decides to do with one operation. */
export type DevTransportResult =
  | { kind: "data"; data: unknown; delayMs?: number }
  /** `code` lands on `error.data.code`, where `lib/errorEnvelope` reads it. */
  | {
      kind: "error";
      code: string;
      message?: string;
      extras?: Record<string, unknown>;
      delayMs?: number;
    }
  /** Never settles — holds the caller in its loading state for as long as you look at it. */
  | { kind: "pending" };

export interface DevTransportOperation {
  path: string;
  type: string;
  input: unknown;
}

/** Returns null to let the operation go to the network unchanged. */
export type DevTransportHandler = (op: DevTransportOperation) => DevTransportResult | null;

let installedHandler: DevTransportHandler | null = null;
const changeListeners = new Set<() => void>();

export function onDevTransportChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

export function setDevTransportHandler(handler: DevTransportHandler | null): void {
  installedHandler = handler;
  for (const listener of changeListeners) {
    listener();
  }
}

export function getDevTransportHandler(): DevTransportHandler | null {
  return installedHandler;
}

export function isDevTransportEnabled(): boolean {
  return (globalThis as { __DEV__?: boolean }).__DEV__ === true;
}

/**
 * Shaped so `readTrpcErrorCode`/`readTrpcErrorExtras` and `isUnauthorizedError` read it
 * exactly as they read a real `TRPCClientError`: code and extras live under `data`.
 */
export class DevTransportError extends Error {
  readonly data: Record<string, unknown>;

  constructor(message: string, data: Record<string, unknown>) {
    super(message);
    this.name = "DevTransportError";
    this.data = data;
  }
}

export const devTransportLink: TRPCLink<AppRouter> = () => {
  return ({ next, op }) =>
    observable((observer) => {
      const handler = getDevTransportHandler();
      const result =
        handler === null ? null : handler({ path: op.path, type: op.type, input: op.input });

      if (result === null) return next(op).subscribe(observer);
      // Deliberately never calls next/complete — this is the loading state.
      if (result.kind === "pending") return () => undefined;

      const timer = setTimeout(() => {
        if (result.kind === "error") {
          observer.error(
            new DevTransportError(result.message ?? result.code, {
              code: result.code,
              ...result.extras,
            }) as unknown as Parameters<typeof observer.error>[0],
          );
          return;
        }
        observer.next({ result: { data: result.data } });
        observer.complete();
      }, result.delayMs ?? 0);

      return () => clearTimeout(timer);
    });
};
