import { describe, expect, it } from "vitest";

import {
  fixtureSimulationFromEnvironment,
  fixtureSimulationHash,
  fixtureSimulationOutcomeBucket,
  rebaseScheduleFixture,
  rekeySeatFixture,
  resolveFixtureSimulation,
} from "../docker/fetch-worker/dev-entrypoint.mjs";

describe("development fetch fixtures", () => {
  it("keeps captured schedule dates unchanged for the capture day", () => {
    const body = "start=2026-08-13T18:30:00Z end=2026-08-14T01:30:00Z";

    expect(rebaseScheduleFixture(body, "2026-08-13")).toBe(body);
  });

  it("rebases both captured schedule days to the requested day", () => {
    const body = "start=2026-08-13T18:30:00Z end=2026-08-14T01:30:00Z title=Spider-Man";

    expect(rebaseScheduleFixture(body, "2026-08-28")).toBe(
      "start=2026-08-28T18:30:00Z end=2026-08-29T01:30:00Z title=Spider-Man",
    );
  });

  it("rejects an invalid requested schedule date", () => {
    expect(() => rebaseScheduleFixture("2026-08-13", "2026-02-31")).toThrow(
      "invalid schedule date",
    );
  });

  it("derives date-unique showtimeIds for the same captured ID across different dates", () => {
    const body = 'payload {"showtimeId":145927006} trailer {"showtimeId":145927006}';
    const a = rebaseScheduleFixture(body, "2026-08-13");
    const b = rebaseScheduleFixture(body, "2026-09-01");
    const c = rebaseScheduleFixture(body, "2026-09-02");
    const idsA = [...a.matchAll(/"showtimeId":(\d+)/g)].map((m) => m[1]);
    const idsB = [...b.matchAll(/"showtimeId":(\d+)/g)].map((m) => m[1]);
    const idsC = [...c.matchAll(/"showtimeId":(\d+)/g)].map((m) => m[1]);
    expect(idsA).toHaveLength(2);
    expect(idsB).toHaveLength(2);
    expect(idsC).toHaveLength(2);
    // Same body rebased to different dates yields different derived IDs
    expect(idsA[0]).not.toBe(idsB[0]);
    expect(idsB[0]).not.toBe(idsC[0]);
    expect(idsA[0]).not.toBe(idsC[0]);
    // Same date is deterministic
    expect(rebaseScheduleFixture(body, "2026-09-01")).toBe(b);
    // Same derived value for same original within same rebased date
    expect(idsA[0]).toBe(idsA[1]);
    expect(idsB[0]).toBe(idsB[1]);
  });

  it("keeps derived showtimeIds as digit-only safe integers and preserves date rebasing", () => {
    const body =
      'start=2026-08-13T18:30:00Z {"showtimeId":145927006} end=2026-08-14T01:30:00Z {"showtimeId":146024502}';
    const rebased = rebaseScheduleFixture(body, "2026-08-28");
    // Dates still shift
    expect(rebased).toContain("2026-08-28");
    expect(rebased).toContain("2026-08-29");
    // ShowtimeIds are still digit-only, safe, no leading zeros
    const ids = [...rebased.matchAll(/"showtimeId":(\d+)/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(/^\d+$/);
      if (id.length > 1) expect(id[0]).not.toBe("0");
      const n = Number(id);
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      // Must still match SEATS_ROUTE digit pattern
      expect(/^\/showtimes\/(\d+)\/seats$/.test(`/showtimes/${id}/seats`)).toBe(true);
    }
    // Different from originals
    expect(ids).not.toContain("145927006");
    expect(ids).not.toContain("146024502");
  });

  it("handles escaped flight-payload showtimeIds (raw HTML body)", () => {
    const body = 'flight \\"showtimeId\\":145927006 and \\"showtimeId\\":145927006 tail';
    const a = rebaseScheduleFixture(body, "2026-08-13");
    const b = rebaseScheduleFixture(body, "2026-09-01");
    expect(a).not.toBe(b);
    const idsA = [...a.matchAll(/\\"showtimeId\\":(\d+)/g)].map((m) => m[1]);
    const idsB = [...b.matchAll(/\\"showtimeId\\":(\d+)/g)].map((m) => m[1]);
    expect(idsA).toHaveLength(2);
    expect(idsB).toHaveLength(2);
    expect(idsA[0]).not.toBe(idsB[0]);
    for (const id of [...idsA, ...idsB]) {
      expect(id).toMatch(/^\d+$/);
      expect(Number.isSafeInteger(Number(id))).toBe(true);
    }
  });

  it("re-keys the seat body without changing other content", () => {
    const body = "url=/showtimes/145927008/seats data-id=145927008 available=144";

    expect(rekeySeatFixture(body, "145927008", "145927006")).toBe(
      "url=/showtimes/145927006/seats data-id=145927006 available=144",
    );
  });

  it("defaults the fixture simulation to the recorded full-success seed", () => {
    expect(fixtureSimulationFromEnvironment({})).toEqual({
      scenario: "full",
      seed: "seatfirst-dev-fixture-v1",
    });
  });

  it("rejects an unknown scenario and an empty seed", () => {
    expect(() => fixtureSimulationFromEnvironment({ DEV_FIXTURE_SCENARIO: "random" })).toThrow(
      "invalid DEV_FIXTURE_SCENARIO",
    );
    expect(() => fixtureSimulationFromEnvironment({ DEV_FIXTURE_SEED: " " })).toThrow(
      "DEV_FIXTURE_SEED must not be empty",
    );
  });

  it("selects a stable seat profile from the seed and showtime", () => {
    const simulation = { scenario: "full", seed: "seatfirst-dev-fixture-v1" };

    expect(resolveFixtureSimulation(simulation, "145927006")).toEqual({
      kind: "success",
      fixture: {
        filename: "seats-146089621.json",
        sourceShowtimeId: "146089621",
      },
    });
    expect(fixtureSimulationHash(simulation.seed, "145927006")).toBe(
      fixtureSimulationHash(simulation.seed, "145927006"),
    );
    expect(fixtureSimulationHash(simulation.seed, "145927006")).not.toBe(
      fixtureSimulationHash("another-seed", "145927006"),
    );
  });

  it("fails exactly one of the four mixed-partial outcome buckets", () => {
    const simulation = { scenario: "mixed-partial", seed: "seatfirst-dev-fixture-v1" };
    const showtimeIds = ["145927000", "145927001", "145927005", "145927006"];

    expect(
      showtimeIds.map((showtimeId) => fixtureSimulationOutcomeBucket(simulation.seed, showtimeId)),
    ).toEqual([3, 1, 2, 0]);
    expect(
      showtimeIds.map((showtimeId) => resolveFixtureSimulation(simulation, showtimeId).kind),
    ).toEqual(["success", "success", "success", "failure"]);
  });

  it("supports full-success and all-error scenario branches", () => {
    const seed = "seatfirst-dev-fixture-v1";

    expect(resolveFixtureSimulation({ scenario: "full", seed }, "145927006").kind).toBe("success");
    expect(resolveFixtureSimulation({ scenario: "all-error", seed }, "145927007").kind).toBe(
      "failure",
    );
  });
});
