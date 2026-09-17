/**
 * The shared structured logger (O4.1–O4.4, O4.8). `packages/config` already owns
 * "the one OTel SDK setup" (`src/otel.ts`); this module gives the same package the one
 * logger factory every process uses, replacing `apps/server/src/relay/logger.ts`'s
 * two-method `consoleLogger` (`error`/`warn` straight to `console.error`/`console.warn`).
 *
 * Shape decisions, each cited:
 *
 * - Six standard pino levels (`trace`/`debug`/`info`/`warn`/`error`/`fatal`), every call
 *   taking `(fields, message)` — fields first, matching pino's own call signature, so a
 *   line's context is always a structured object, never string interpolation (O4.2).
 * - `child(fields)` returns a new logger that merges `fields` into every subsequent
 *   line — this is how request IDs and other per-request context propagate (O4.2).
 * - `level` is a required argument with no default, matching every other tunable in
 *   this repo's `*ConfigFromEnv` discipline (`docs/gates.md:1-7`; an undecided number
 *   may not be encoded anywhere). Read it from env with `logLevelFromEnv`.
 * - Output is pino's default plain-JSON transport — no `pino-pretty` dependency. An
 *   operator who wants a human-readable local view pipes `docker compose logs -f
 *   <service>` through their own `pino-pretty`/`jq` (O4.3).
 * - The OTel Logs API bridge is opt-in (O4.4): when the caller supplies an
 *   `@opentelemetry/api-logs` `Logger` handle (from `ConfiguredOtel.logger`), every call
 *   additionally emits an OTel `LogRecord` (severity mapped from the level, body =
 *   message, attributes = the structured fields). When omitted, nothing calls into the
 *   OTel Logs API at all — pure pino. This is the log-layer half of "if otel is
 *   configured, send otel, otherwise not": the caller decides by whether it passes a
 *   real exporting handle or nothing, mirroring `configureOtel`'s own "omitting a field
 *   means that signal is unconfigured" contract.
 */
import {
  SeverityNumber,
  type LogAttributes,
  type Logger as OtelLogger,
} from "@opentelemetry/api-logs";
import pino from "pino";

import type { SeatfirstComponent } from "./otel.js";

/** The six standard pino levels, lowest severity first (O4.2). */
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Structured logger contract (O4.2). Every method takes the structured fields object
 * first and the human message second; `child` merges its fields into every subsequent
 * line of the returned logger.
 */
export interface SeatfirstLogger {
  readonly trace: (fields: Record<string, unknown>, message: string) => void;
  readonly debug: (fields: Record<string, unknown>, message: string) => void;
  readonly info: (fields: Record<string, unknown>, message: string) => void;
  readonly warn: (fields: Record<string, unknown>, message: string) => void;
  readonly error: (fields: Record<string, unknown>, message: string) => void;
  readonly fatal: (fields: Record<string, unknown>, message: string) => void;
  /** Returns a new logger whose lines carry `fields` merged over this logger's context. */
  readonly child: (fields: Record<string, unknown>) => SeatfirstLogger;
}

/** Options for `createLogger` (O4.3/O4.4). `level` is required — no default exists. */
export interface CreateLoggerOptions {
  /** `service.name`-style attribution for every emitted line. */
  readonly service: string;
  /**
   * The cost-attribution dimension reused from `otel.ts`'s `SeatfirstComponent` union,
   * so log lines and OTel resource attributes carry the identical dimension (O4.3).
   */
  readonly component: SeatfirstComponent;
  /** Minimum level for this instance — typically resolved via `logLevelFromEnv`, which
   *  defaults to `"info"` when `LOG_LEVEL` is unset or empty. */
  readonly level: LogLevel;
  /**
   * Opt-in OTel Logs API bridge (O4.4) — pass `ConfiguredOtel.logger` to mirror every
   * line into OTel logs; omit for pure pino.
   */
  readonly otelLogger?: OtelLogger;
  /**
   * pino serializers applied at construction (pino v10 only honors constructor
   * options — post-construction `logger.serializers = …` assignment is not read).
   * O5.1's Fastify request logger passes `{ req: inboundRequestLogSerializer,
   * res: inboundRequestLogSerializer }` here so the allowlist is baked into the very
   * instance handed to Fastify.
   */
  readonly serializers?: { readonly [key: string]: pino.SerializerFn };
  /**
   * Test-injection seam only: pino write destination. Production callers omit it and get
   * stdout (pino's default), which is what `docker compose logs` reads.
   */
  readonly destination?: pino.DestinationStream;
}

/** pino numeric level per name — pino's own table; used only for construction. */
const PINO_NUMERIC_LEVEL: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** OTel `SeverityNumber` base value per level (OTel Logs Data Model appendix). */
const SEVERITY_NUMBER: Record<LogLevel, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Read the process's `LOG_LEVEL` (O4.8). One of the six levels; defaults to `"info"`
 * when unset or empty. An explicitly-set value outside the six levels is still a loud
 * configuration error — only a missing/empty value is defaulted, never a typo'd one.
 */
export function logLevelFromEnv(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.LOG_LEVEL;
  if (raw === undefined || raw === "") {
    return "info";
  }
  if (!isLogLevel(raw)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join("|")}, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Resolve an entrypoint config's optional `logLevel` into the required `LogLevel` for
 * default-logger construction (O6.8's discipline): production always supplies it via the
 * process's own `*ConfigFromEnv` (which calls {@link logLevelFromEnv}); when absent —
 * only possible in tests that inject a logger instead — building a default logger is a
 * loud error, never a guessed level.
 */
export function requireLogLevel(level: LogLevel | undefined): LogLevel {
  if (level === undefined) {
    throw new Error(
      "logLevel is required when no logger is injected — supply it via the " +
        "process's *ConfigFromEnv (logLevelFromEnv)",
    );
  }
  return level;
}

/**
 * Build the shared structured logger (O4.3). Every line is one JSON object carrying
 * `service`, `component`, the merged child context, the call-site fields, the message,
 * and pino's `level`/`time`.
 *
 * The returned object IS a real pino logger (prototype-linked to one): it satisfies the
 * {@link SeatfirstLogger} facade structurally AND pino's own full surface — O5.1's
 * requirement that ONE logger built here is handed to Fastify directly, with no second
 * raw-pino construction path anywhere. The six level methods are shadowed to add the
 * OTel bridge (O4.4) with exact merged-context attributes; `child` is shadowed so every
 * descendant — including Fastify's `request.log.child(...)` (O5.3) — bridges with its
 * full inherited context. Everything else (`isLevelEnabled`, flush, level accessors,
 * serializer behavior) is inherited untouched from the real instance.
 */
export function createLogger(options: CreateLoggerOptions): pino.Logger & SeatfirstLogger {
  return buildLogger(
    options.service,
    options.component,
    options.level,
    options.otelLogger,
    {},
    options.serializers,
    options.destination,
  );
}

/**
 * OTel LogAttributes cannot represent Error objects. Keep pino's original fields intact,
 * but turn direct Error values into their message strings for the OTel record.
 */
function otelAttributes(
  inherited: Record<string, unknown>,
  fields: Record<string, unknown>,
): LogAttributes {
  const attributes = { ...inherited, ...fields };
  for (const key in attributes) {
    const value = attributes[key];
    if (value instanceof Error) {
      attributes[key] = value.message;
    }
  }
  return attributes as LogAttributes;
}

function buildLogger(
  service: string,
  component: SeatfirstComponent,
  level: LogLevel,
  otelLogger: OtelLogger | undefined,
  inherited: Record<string, unknown>,
  serializers: { readonly [key: string]: pino.SerializerFn } | undefined,
  destination: pino.DestinationStream | undefined,
): pino.Logger {
  const pinoLogger = pino(
    {
      level,
      base: { ...inherited, service, component },
      ...(serializers !== undefined ? { serializers } : {}),
    },
    destination,
  );

  // Shadow the six level methods on a prototype-linked derivative: pino applies level
  // filtering itself (a call below the configured level serializes nothing), and the
  // same numeric comparison gates the optional OTel bridge so both sinks stay
  // level-consistent.
  const wrapped = Object.create(pinoLogger) as pino.Logger;
  const bridge = (lvl: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (otelLogger === undefined || PINO_NUMERIC_LEVEL[lvl] < PINO_NUMERIC_LEVEL[level]) {
      return;
    }
    otelLogger.emit({
      severityNumber: SEVERITY_NUMBER[lvl],
      severityText: lvl.toUpperCase(),
      body: message,
      // Attributes carry the merged child context plus the call-site fields. Error
      // objects are converted to primitive messages because OTel drops invalid values.
      attributes: otelAttributes(inherited, fields),
    });
  };
  // defineProperty (not assignment) — pino's declared LogFn/child signatures are more
  // permissive than this facade's, so direct assignment is a type error even though
  // the runtime contract is exactly compatible.
  const shadow = (
    name: string,
    value: (fields: Record<string, unknown>, ...rest: never[]) => void | pino.Logger,
  ): void => {
    Object.defineProperty(wrapped, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  };
  for (const lvl of LOG_LEVELS) {
    shadow(lvl, (fields: Record<string, unknown>, message: string) => {
      pinoLogger[lvl](fields, message);
      bridge(lvl, fields, message);
    });
  }
  shadow("child", (fields: Record<string, unknown>): pino.Logger =>
    buildLogger(
      service,
      component,
      level,
      otelLogger,
      { ...inherited, ...fields },
      serializers,
      destination,
    ),
  );
  return wrapped;
}
