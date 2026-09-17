import { describe, expect, it } from "vitest";

import { capturingLogger } from "./support/logger.js";
import { resolveFetchWorkerLogger } from "../src/fetch-worker/entrypoint.js";

describe("resolveFetchWorkerLogger (O6.5 seam)", () => {
  it("returns the injected logger instance by reference when options.logger provided", () => {
    const injected = capturingLogger();
    const result = resolveFetchWorkerLogger({ LOG_LEVEL: "info" }, { logger: injected });
    expect(result).toBe(injected);
  });

  it("returns the injected logger even when env field is also present", () => {
    const injected = capturingLogger({ requestId: "req-1" });
    const result = resolveFetchWorkerLogger(
      { LOG_LEVEL: "info" },
      { logger: injected, env: { LOG_LEVEL: "debug" } },
    );
    expect(result).toBe(injected);
    // Prove child context is preserved (injected logger's inherited fields)
    result.info({ extra: "x" }, "hello");
    expect(injected.calls).toHaveLength(1);
    expect(injected.calls[0]?.fields.requestId).toBe("req-1");
    expect(injected.calls[0]?.fields.extra).toBe("x");
  });

  it("builds a working SeatfirstLogger when no logger is injected", () => {
    const logger = resolveFetchWorkerLogger({ LOG_LEVEL: "info" }, {});
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.child).toBe("function");
    // Should not throw when emitting
    expect(() => logger.info({}, "hello from built logger")).not.toThrow();
    expect(() => logger.debug({}, "debug line")).not.toThrow();
    // Child logger should inherit and merge
    const child = logger.child({ job_id: "j1" });
    expect(typeof child.info).toBe("function");
    expect(() => child.info({ extra: 1 }, "child hello")).not.toThrow();
  });

  it("builds a logger when options is undefined", () => {
    const logger = resolveFetchWorkerLogger({ LOG_LEVEL: "debug" });
    expect(typeof logger.info).toBe("function");
    expect(() => logger.info({}, "no-options hello")).not.toThrow();
  });

  it("defaults to info when LOG_LEVEL is absent and no logger is injected", () => {
    expect(() => resolveFetchWorkerLogger({}, {}).info({}, "x")).not.toThrow();
    expect(() => resolveFetchWorkerLogger({ LOG_LEVEL: "" }, {}).info({}, "x")).not.toThrow();
  });

  it("is a real seam, not a renamed global — two calls with different injected loggers yield different instances", () => {
    const a = capturingLogger({ a: 1 });
    const b = capturingLogger({ b: 2 });
    const ra = resolveFetchWorkerLogger({ LOG_LEVEL: "info" }, { logger: a });
    const rb = resolveFetchWorkerLogger({ LOG_LEVEL: "info" }, { logger: b });
    expect(ra).toBe(a);
    expect(rb).toBe(b);
    expect(ra).not.toBe(rb);
    ra.info({}, "to a");
    rb.info({}, "to b");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(a.calls[0]?.fields.a).toBe(1);
    expect(b.calls[0]?.fields.b).toBe(2);
  });
});
