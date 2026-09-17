import { describe, expect, it } from "vitest";
import {
  ALL_SCENARIOS,
  VIEWPORT_CONFIGS,
  findChromeExecutable,
  parseArgs,
  resolveScenarios,
  resolveViewports,
} from "./capture-ui-seeds.mjs";

describe("parseArgs", () => {
  it("returns defaults when no arguments provided", () => {
    const opts = parseArgs([]);
    expect(opts.baseUrl).toBe("http://localhost:8081");
    expect(opts.outDir).toBe("./screenshots");
    expect(opts.viewport).toBe("all");
    expect(opts.scenarios).toBeNull();
    expect(opts.chromePath).toBeNull();
    expect(opts.settleMs).toBe(1000);
    expect(opts.help).toBe(false);
  });

  it("parses separated arguments correctly", () => {
    const opts = parseArgs([
      "--url",
      "http://localhost:3000",
      "--out-dir",
      "./custom-dir",
      "--viewport",
      "mobile",
      "--scenarios",
      "search,confirmed",
      "--chrome",
      "/usr/bin/custom-chrome",
      "--settle-ms",
      "500",
    ]);
    expect(opts.baseUrl).toBe("http://localhost:3000");
    expect(opts.outDir).toBe("./custom-dir");
    expect(opts.viewport).toBe("mobile");
    expect(opts.scenarios).toEqual(["search", "confirmed"]);
    expect(opts.chromePath).toBe("/usr/bin/custom-chrome");
    expect(opts.settleMs).toBe(500);
  });

  it("parses equals-delimited arguments correctly", () => {
    const opts = parseArgs([
      "--url=http://127.0.0.1:8080",
      "--out-dir=./shots",
      "--viewport=desktop",
      "--scenarios=search-empty",
      "--chrome=/bin/chrome",
      "--settle-ms=2000",
      "-h",
    ]);
    expect(opts.baseUrl).toBe("http://127.0.0.1:8080");
    expect(opts.outDir).toBe("./shots");
    expect(opts.viewport).toBe("desktop");
    expect(opts.scenarios).toEqual(["search-empty"]);
    expect(opts.chromePath).toBe("/bin/chrome");
    expect(opts.settleMs).toBe(2000);
    expect(opts.help).toBe(true);
  });

  it("parses --seeds and --api arguments correctly", () => {
    const opts = parseArgs(["--seeds=form-movies-loading,form-theatre-error", "--api=offline"]);
    expect(opts.scenarios).toEqual(["form-movies-loading", "form-theatre-error"]);
    expect(opts.api).toBe("offline");
  });

  it("parses positional scenario arguments correctly", () => {
    const opts = parseArgs(["form-movies-loading", "form-theatre-error"]);
    expect(opts.scenarios).toEqual(["form-movies-loading", "form-theatre-error"]);
  });
});

describe("resolveScenarios", () => {
  it("returns all scenarios when filter is null or empty", () => {
    expect(resolveScenarios(null)).toEqual(ALL_SCENARIOS);
    expect(resolveScenarios([])).toEqual(ALL_SCENARIOS);
    expect(ALL_SCENARIOS.length).toBe(34);
  });

  it("filters scenarios by ID", () => {
    const filtered = resolveScenarios(["search", "confirmed"]);
    expect(filtered.map((s) => s.id)).toEqual(["search", "confirmed"]);
  });

  it("filters scenarios by scenario name", () => {
    const filtered = resolveScenarios(["13_movies_loading"]);
    expect(filtered.map((s) => s.id)).toEqual(["form-movies-loading"]);
  });

  it("filters scenarios by wildcard pattern", () => {
    const filtered = resolveScenarios(["*movies*"]);
    expect(filtered.map((s) => s.id)).toEqual([
      "form-movies-loading",
      "form-movies-empty",
      "form-movies-error",
    ]);
  });

  it("omits unknown scenario IDs", () => {
    const filtered = resolveScenarios(["search", "non-existent-id"]);
    expect(filtered.map((s) => s.id)).toEqual(["search"]);
  });
});

describe("resolveViewports", () => {
  it("resolves desktop viewport", () => {
    const vps = resolveViewports("desktop");
    expect(vps).toEqual([VIEWPORT_CONFIGS.desktop]);
  });

  it("resolves mobile viewport", () => {
    const vps = resolveViewports("mobile");
    expect(vps).toEqual([VIEWPORT_CONFIGS.mobile]);
  });

  it("resolves all viewports", () => {
    const vps = resolveViewports("all");
    expect(vps).toEqual([VIEWPORT_CONFIGS.desktop, VIEWPORT_CONFIGS.mobile]);
  });

  it("throws on unknown viewport", () => {
    expect(() => resolveViewports("tablet")).toThrow("Unknown viewport option 'tablet'");
  });
});

describe("findChromeExecutable", () => {
  it("prefers explicitPath if it exists", () => {
    const existsMock = (p) => p === "/opt/custom/chrome";
    const resolved = findChromeExecutable("/opt/custom/chrome", {}, existsMock);
    expect(resolved).toBe("/opt/custom/chrome");
  });

  it("prefers SEATFIRST_CHROME_EXECUTABLE env over candidates", () => {
    const existsMock = (p) => p === "/env/chrome" || p.includes("Google Chrome");
    const resolved = findChromeExecutable(
      null,
      { SEATFIRST_CHROME_EXECUTABLE: "/env/chrome" },
      existsMock,
    );
    expect(resolved).toBe("/env/chrome");
  });

  it("falls back to candidate list in priority order", () => {
    const existsMock = (p) => p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const resolved = findChromeExecutable(null, {}, existsMock);
    expect(resolved).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  it("returns null if no candidates exist", () => {
    const existsMock = () => false;
    const resolved = findChromeExecutable(null, {}, existsMock);
    expect(resolved).toBeNull();
  });
});
