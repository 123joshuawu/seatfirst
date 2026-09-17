/**
 * Shared SeatfirstLogger test doubles for the worker-fleet logging suites (O6).
 * A fake is a plain object implementing the O4 interface — no pino, no stdout — so
 * tests assert on recorded calls, never on console side effects.
 */
import type { SeatfirstLogger } from "@seatfirst/config/logger";

export interface LogCall {
  readonly level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export interface CapturingLogger extends SeatfirstLogger {
  /** Every call in emission order, across this logger and all children (context merged). */
  readonly calls: LogCall[];
}

/**
 * A `SeatfirstLogger` that records every call (with merged child context) and emits
 * nothing. `child()` returns a capturing view sharing the same `calls` array, so
 * assertions can filter the combined stream by any structured field — the same shape
 * a Loki query would run in production.
 */
export function capturingLogger(
  inherited: Record<string, unknown> = {},
  calls: LogCall[] = [],
): CapturingLogger {
  const method =
    (level: LogCall["level"]) => (fields: Record<string, unknown>, message: string) => {
      calls.push({ level, fields: { ...inherited, ...fields }, message });
    };
  return {
    trace: method("trace"),
    debug: method("debug"),
    info: method("info"),
    warn: method("warn"),
    error: method("error"),
    fatal: method("fatal"),
    child: (fields) => capturingLogger({ ...inherited, ...fields }, calls),
    calls,
  };
}
