import { describe, expect, it, vi } from "vitest";

import type { LogAttributes, LogRecord, Logger as OtelLogger } from "@opentelemetry/api-logs";

import {
  LOG_LEVELS,
  createLogger,
  logLevelFromEnv,
  type LogLevel,
  type SeatfirstLogger,
} from "../src/logger.js";

/** Collects the JSON lines a logger writes and parses each one back into an object. */
class LineSink {
  readonly lines: unknown[] = [];
  private buffer = "";

  readonly asDestination = {
    write: (chunk: string): boolean => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== "") {
          this.lines.push(JSON.parse(line) as unknown);
        }
        newline = this.buffer.indexOf("\n");
      }
      return true;
    },
    end: (): void => {},
  };

  last(): Record<string, unknown> {
    expect(this.lines.length).toBeGreaterThan(0);
    return this.lines.at(-1) as Record<string, unknown>;
  }
}

function makeLogger(
  level: LogLevel,
  sink: LineSink,
  otel?: { readonly emit: ReturnType<typeof vi.fn> },
): SeatfirstLogger {
  const options = {
    service: "test-service",
    component: "app" as const,
    level,
    destination: sink.asDestination,
    ...(otel === undefined ? {} : { otelLogger: otel as unknown as OtelLogger }),
  };
  return createLogger(options);
}

describe("logLevelFromEnv", () => {
  it("accepts each of the six levels", () => {
    for (const level of LOG_LEVELS) {
      expect(logLevelFromEnv({ LOG_LEVEL: level })).toBe(level);
    }
  });

  it("defaults to info when unset or empty", () => {
    expect(logLevelFromEnv({})).toBe("info");
    expect(logLevelFromEnv({ LOG_LEVEL: "" })).toBe("info");
  });

  it("throws with a message on a value outside the six levels", () => {
    expect(() => logLevelFromEnv({ LOG_LEVEL: "verbose" })).toThrow(
      'LOG_LEVEL must be one of trace|debug|info|warn|error|fatal, got "verbose"',
    );
  });
});

describe("createLogger — structured context (verification 3)", () => {
  it("emits child context as a JSON field, not interpolated into the message", () => {
    const sink = new LineSink();
    makeLogger("info", sink).child({ searchId: "srch_x" }).info({}, "message");
    const line = sink.last();
    // The field is its own key in the JSON object…
    expect(line.searchId).toBe("srch_x");
    // …and the message string carries no trace of it.
    expect(line.msg).toBe("message");
    expect(line.level).toBe(30); // pino's numeric info level
    expect(line.service).toBe("test-service");
    expect(line.component).toBe("app");
  });

  it("merges child fields over parent context across nesting", () => {
    const sink = new LineSink();
    makeLogger("info", sink)
      .child({ requestId: "req_1", shared: "outer" })
      .child({ searchId: "srch_2", shared: "inner" })
      .warn({}, "nested");
    const line = sink.last();
    expect(line.requestId).toBe("req_1");
    expect(line.searchId).toBe("srch_2");
    expect(line.shared).toBe("inner");
  });

  it("carries call-site fields alongside child context", () => {
    const sink = new LineSink();
    makeLogger("error", sink).child({ requestId: "req_9" }).error({ attempt: 3 }, "fetch failed");
    const line = sink.last();
    expect(line.requestId).toBe("req_9");
    expect(line.attempt).toBe(3);
    expect(line.msg).toBe("fetch failed");
    expect(line.level).toBe(50);
  });
});

describe("createLogger — level filtering (verification 4)", () => {
  it("drops debug/info lines from a warn-level logger but keeps warn/error/fatal", () => {
    const sink = new LineSink();
    const logger = makeLogger("warn", sink);
    logger.trace({}, "t");
    logger.debug({}, "d");
    logger.info({}, "i");
    expect(sink.lines).toHaveLength(0);
    logger.warn({}, "w");
    logger.error({}, "e");
    logger.fatal({}, "f");
    expect(sink.lines).toHaveLength(3);
    expect(sink.last().level).toBe(60);
  });

  it("keeps debug lines from a debug-level logger", () => {
    const sink = new LineSink();
    makeLogger("debug", sink).debug({ hop: 2 }, "detail");
    expect(sink.last().msg).toBe("detail");
  });
});

describe("createLogger — OTel bridge is opt-in (verification 5)", () => {
  function stubOtelLogger(): { emit: ReturnType<typeof vi.fn> } {
    return { emit: vi.fn() };
  }

  it("calls emit with severity/body/attributes when an otelLogger is supplied", () => {
    const otel = stubOtelLogger();
    const sink = new LineSink();
    makeLogger("info", sink, otel).child({ searchId: "srch_x" }).info({ attempt: 1 }, "hello");
    expect(otel.emit).toHaveBeenCalledTimes(1);
    const record = otel.emit.mock.calls[0]![0] as LogRecord;
    expect(record.severityText).toBe("INFO");
    expect(record.body).toBe("hello");
    const attributes = record.attributes as LogAttributes;
    expect(attributes.searchId).toBe("srch_x");
    expect(attributes.attempt).toBe(1);
  });

  it("converts Error attributes to messages before OTel emission", () => {
    const otel = stubOtelLogger();
    const sink = new LineSink();
    const error = new Error("connection reset");
    makeLogger("info", sink, otel).error({ error, attempt: 2 }, "upstream request failed");

    const record = otel.emit.mock.calls[0]![0] as LogRecord;
    const attributes = record.attributes as LogAttributes;
    expect(attributes.error).toBe("connection reset");
    expect(attributes.attempt).toBe(2);
  });

  it("maps all six levels onto OTel severity text and numbers", () => {
    const otel = stubOtelLogger();
    const sink = new LineSink();
    const logger = makeLogger("trace", sink, otel);
    const expectedText: Record<LogLevel, string> = {
      trace: "TRACE",
      debug: "DEBUG",
      info: "INFO",
      warn: "WARN",
      error: "ERROR",
      fatal: "FATAL",
    };
    const expectedNumber: Record<LogLevel, number> = {
      trace: 1,
      debug: 5,
      info: 9,
      warn: 13,
      error: 17,
      fatal: 21,
    };
    for (const level of LOG_LEVELS) {
      logger[level]({}, level);
    }
    expect(otel.emit).toHaveBeenCalledTimes(LOG_LEVELS.length);
    LOG_LEVELS.forEach((level, index) => {
      const record = otel.emit.mock.calls[index]![0] as LogRecord;
      expect(record.severityText).toBe(expectedText[level]);
      expect(record.severityNumber).toBe(expectedNumber[level]);
    });
  });

  it("never calls into the OTel Logs API when otelLogger is omitted", () => {
    const otel = stubOtelLogger();
    const sink = new LineSink();
    makeLogger("warn", sink, otel).debug({}, "filtered");
    expect(otel.emit).not.toHaveBeenCalled();
    expect(sink.lines).toHaveLength(0);
  });
});
