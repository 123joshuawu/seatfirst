import type { ConfiguredOtel } from "@seatfirst/config/otel";
import type { SeatfirstLogger } from "@seatfirst/config/logger";

export interface CrashHandlerDeps {
  readonly logger: SeatfirstLogger;
  readonly otel: ConfiguredOtel;
  readonly exit: (code: number) => void;
}

let installed = false;

function errorFields(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return { errName: reason.name, errMessage: reason.message, errStack: reason.stack };
  }
  return { errName: "UnknownError", errMessage: String(reason), errStack: undefined };
}

export function installCrashHandlers(deps: CrashHandlerDeps): void {
  if (installed) return;
  installed = true;

  const handle = async (
    reason: unknown,
    message: "uncaught exception" | "unhandled rejection",
  ): Promise<void> => {
    deps.logger.fatal(errorFields(reason), message);
    try {
      await deps.otel.forceFlush();
    } catch (flushError) {
      deps.logger.error(errorFields(flushError), "crash telemetry flush failed");
    }
    process.exitCode = 1;
    deps.exit(1);
  };

  // process.on expects void-returning listeners; the async handle is fire-and-forget here.
  const uncaughtException = (reason: unknown): void => {
    void handle(reason, "uncaught exception");
  };
  const unhandledRejection = (reason: unknown): void => {
    void handle(reason, "unhandled rejection");
  };
  process.on("uncaughtException", uncaughtException);
  process.on("unhandledRejection", unhandledRejection);
}
