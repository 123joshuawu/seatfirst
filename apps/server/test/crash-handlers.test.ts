import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfiguredOtel } from "@seatfirst/config/otel";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

const installedListeners: Array<[string, (...args: unknown[]) => void]> = [];

type ErrorFields = { errName?: unknown; errMessage?: unknown };

function loggerFor(events: string[]): SeatfirstLogger {
  const crashFields = (fields: Record<string, unknown>): ErrorFields => ({
    errName: fields["errName"],
    errMessage: fields["errMessage"],
  });
  return {
    fatal: vi.fn((fields: Record<string, unknown>, message: string) =>
      events.push(
        `fatal:${message}:${String(crashFields(fields).errName)}:${String(crashFields(fields).errMessage)}`,
      ),
    ),
    error: vi.fn((fields: Record<string, unknown>, message: string) =>
      events.push(
        `error:${message}:${String(crashFields(fields).errName)}:${String(crashFields(fields).errMessage)}`,
      ),
    ),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  };
}

type FlushOutcome = number | void;

function makeFakeOtel(forceFlush: (...args: unknown[]) => FlushOutcome): ConfiguredOtel {
  return {
    forceFlush: vi.fn((...args: unknown[]) =>
      Promise.resolve()
        .then(() => forceFlush(...args))
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error(String(error));
        }),
    ),
    shutdown: () => Promise.resolve(undefined),
    tracer: { startSpan: vi.fn() },
    meter: {},
    logger: { emit: vi.fn() },
    metrics: {},
    globalRegistration: { tracer: false, metrics: false, logs: false },
  } as unknown as ConfiguredOtel;
}

async function freshInstaller() {
  vi.resetModules();
  const module = await import("../src/crash-handlers.js");
  const beforeUncaught = new Set(process.listeners("uncaughtException"));
  const beforeRejection = new Set(process.listeners("unhandledRejection"));
  return {
    ...module,
    cleanup() {
      for (const listener of process.listeners("uncaughtException")) {
        if (!beforeUncaught.has(listener)) process.removeListener("uncaughtException", listener);
      }
      for (const listener of process.listeners("unhandledRejection")) {
        if (!beforeRejection.has(listener)) process.removeListener("unhandledRejection", listener);
      }
      process.exitCode = undefined;
    },
  };
}

afterEach(() => {
  for (const [event, listener] of installedListeners.splice(0))
    process.removeListener(event, listener);
  process.exitCode = undefined;
});

describe("installCrashHandlers", () => {
  it.each([
    ["uncaughtException", "uncaught exception"],
    ["unhandledRejection", "unhandled rejection"],
  ] as const)("handles %s with fatal, flush, then exit", async (event, message) => {
    const mod = await freshInstaller();
    const events: string[] = [];
    const logger = loggerFor(events);
    const otel = makeFakeOtel(() => events.push("flush"));
    const exit = vi.fn((code: number) => events.push(`exit:${code}`));
    mod.installCrashHandlers({ logger, otel, exit });
    // Real process.on listeners are void-returning; the async body is fire-and-forget,
    // so wait for its observable completion instead of awaiting the call.
    const listener = process.listeners(event as "uncaughtException").at(-1) as unknown as (
      reason: Error,
    ) => void;
    installedListeners.push([event, listener as unknown as (...args: unknown[]) => void]);
    listener(new Error("boom"));
    await vi.waitFor(() => expect(events.length).toBe(3));
    expect(events).toEqual([`fatal:${message}:Error:boom`, "flush", "exit:1"]);
    expect(process.exitCode).toBe(1);
    mod.cleanup();
  });

  it("logs flush failure with structured error fields and still exits", async () => {
    const mod = await freshInstaller();
    const events: string[] = [];
    const logger = loggerFor(events);
    const otel = makeFakeOtel(() => {
      throw new Error("flush failed");
    });
    const exit = vi.fn((code: number) => events.push(`exit:${code}`));
    mod.installCrashHandlers({ logger, otel, exit });
    const listener = process.listeners("uncaughtException").at(-1) as unknown as (
      reason: Error,
    ) => void;
    listener(new Error("boom"));
    await vi.waitFor(() => expect(events.length).toBe(3));
    expect(events).toEqual([
      "fatal:uncaught exception:Error:boom",
      "error:crash telemetry flush failed:Error:flush failed",
      "exit:1",
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errName: "Error", errMessage: "flush failed" }),
      "crash telemetry flush failed",
    );
    const errorLogger = logger.error as unknown as {
      mock: { calls: Array<[Record<string, unknown>, string]> };
    };
    const errorFields = errorLogger.mock.calls[0]?.[0];
    expect(errorFields).toBeDefined();
    expect(String(errorFields?.["errStack"])).toMatch(/^Error: flush failed/);
    mod.cleanup();
  });

  it("is idempotent and normal startup does not invoke crash behavior", async () => {
    const mod = await freshInstaller();
    const logger = loggerFor([]);
    const otel = makeFakeOtel(() => undefined);
    const exit = vi.fn();
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    mod.installCrashHandlers({ logger, otel, exit });
    mod.installCrashHandlers({ logger, otel, exit });
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);
    expect(logger.fatal).not.toHaveBeenCalled();
    expect(otel.forceFlush).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    mod.cleanup();
  });
});
