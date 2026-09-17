import { createTRPCClient, httpLink } from "@trpc/client";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TheatreSearchResponseSchema } from "@seatfirst/core";
import { poolClient, upsertTheatre } from "@seatfirst/durability";
import type { UpsertTheatreInput } from "@seatfirst/durability";

import { theatresRouter } from "../src/routes/theatres/router.js";
import { t } from "../src/routes/theatres/search.js";
import { createTheatreSearchContextFactory } from "../src/routes/theatres/searchContext.js";

import { startTestPostgres } from "./support/containers.js";
import { migrateDatabase } from "./support/db.js";

/**
 * S20 verification, items 2–6 of the spec's verification list, over HTTP against a real
 * Fastify server (tRPC fastify adapter + the `theatres` router) and real Postgres. The
 * router is mounted through a minimal server bound to `TheatreSearchContext { db }` —
 * this route needs only the pool (no session, no limiter, no Redis), so no heavier
 * assembly is warranted. Item 5 ("no live traffic, asserted by construction") is proven
 * by the route files importing nothing from `packages/providers` or the dispatch actor.
 *
 * The catalogue is seeded through the real `upsertTheatre` write path (S2), never a
 * hand-built row. Distances are derived by hand (S2's radius-query rule), never by
 * re-running the implementation.
 */

const testRouter = t.router({ theatres: theatresRouter });
type TestRouter = typeof testRouter;

async function startServer(db: Pool): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const fastify = Fastify();
  void fastify.register(fastifyTRPCPlugin<TestRouter>, {
    prefix: "/trpc",
    trpcOptions: {
      router: testRouter,
      createContext: ({ req }) => createTheatreSearchContextFactory({ db })(req),
    },
  });
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/trpc`,
    close: async () => {
      await fastify.close();
    },
  };
}

function makeClient(baseUrl: string) {
  return createTRPCClient<TestRouter>({ links: [httpLink({ url: baseUrl })] });
}

const seenAt = new Date("2026-08-01T00:00:00.000Z");

function theatreInput(
  theatreId: string,
  name: string,
  lat: number,
  lng: number,
): UpsertTheatreInput {
  return {
    theatreId,
    providerId: "amc",
    name,
    lat,
    lng,
    marketSlug: null,
    timezone: "America/Chicago",
    city: null,
    address: null,
    slugs: { detail: theatreId },
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
  };
}

let pg: Awaited<ReturnType<typeof startTestPostgres>>;
let server: { baseUrl: string; close(): Promise<void> };
let pool: Pool;

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrateDatabase(pg.url);
  pool = new Pool({ connectionString: pg.url });
  server = await startServer(pool);
});

afterAll(async () => {
  await server.close();
  await pool.end();
  await pg.stop();
});

beforeEach(async () => {
  // Test isolation: clean the catalogue between cases (the established state-reset
  // pattern, create.test.ts:272-277). Scaffolding, not a state transition.
  await pool.query("TRUNCATE theatre CASCADE");
});

describe("theatres.search (S20)", () => {
  it("returns an empty result over an empty catalogue (item 2)", async () => {
    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({ q: "anything" });
    expect(body).toEqual({ theatres: [] });
    expect(TheatreSearchResponseSchema.safeParse(body).success).toBe(true);
  });

  it("annotates distance and orders nearest-first when lat/lng are supplied (item 4)", async () => {
    // Hand-derived coordinates: origin = Beta's location (41, -86). Beta is 0 km away.
    // Alpha is 1° of longitude east at lat 41°, ≈ 6371.0088 * (π/180) * cos(41°) ≈ 83.9 km.
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:alpha", "Alpha Theatre", 41, -87),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:beta", "Beta Theatre", 41, -86),
    );

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({ q: "theatre", lat: 41, lng: -86 });

    expect(body.theatres).toHaveLength(2);
    const [beta, alpha] = body.theatres;
    if (beta === undefined || alpha === undefined) {
      throw new Error("expected exactly two hits");
    }
    // Nearest-first: Beta Theatre (0 km) before Alpha Theatre (~83.9 km).
    expect(beta.name).toBe("Beta Theatre");
    expect(beta.distanceKm).toBe(0);
    const alphaDistance = alpha.distanceKm;
    if (alphaDistance === null) {
      throw new Error("a hit with an origin must carry a non-null distanceKm (S20.5)");
    }
    expect(alpha.name).toBe("Alpha Theatre");
    expect(alphaDistance).toBeGreaterThan(80);
    expect(alphaDistance).toBeLessThan(87);
    // Every hit carries a non-null distance when an origin is present (S20.5).
    for (const hit of body.theatres) {
      expect(hit.distanceKm).not.toBeNull();
    }
    // The non-empty wire body must validate against the response schema even after a JSON
    // round-trip (stringify/parse) — this is the regression guard for the Date→UtcInstant
    // wire fix: `TheatreSearchHitSchema` overrides `TheatreSchema`'s `z.date()` timestamps
    // with `UtcInstantSchema`, and the route emits `.toISOString()` strings, so the
    // transported (string) timestamps satisfy the schema. (Before the fix this parse
    // failed: `z.date()` cannot round-trip JSON strings.)
    expect(TheatreSearchResponseSchema.safeParse(JSON.parse(JSON.stringify(body))).success).toBe(
      true,
    );
    // Each hit's timestamps are wire-form ISO instants (end in `Z`), not Date objects.
    for (const hit of body.theatres) {
      expect(typeof hit.firstSeenAt).toBe("string");
      expect(hit.firstSeenAt.endsWith("Z")).toBe(true);
      expect(typeof hit.lastSeenAt).toBe("string");
      expect(hit.lastSeenAt.endsWith("Z")).toBe(true);
    }
  });

  it("returns null distances in boundary (name) order without lat/lng (items 4, 6)", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:alpha", "Alpha Theatre", 41, -87),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:beta", "Beta Theatre", 41, -86),
    );

    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({ q: "theatre" });

    expect(body.theatres).toHaveLength(2);
    // No origin → boundary order (name, theatre_id): Alpha Theatre before Beta Theatre.
    expect(body.theatres.map((hit) => hit.name)).toEqual(["Alpha Theatre", "Beta Theatre"]);
    for (const hit of body.theatres) {
      expect(hit.distanceKm).toBeNull();
    }
  });

  it("never filters by distance — both theatres return regardless of how far they are (item 6)", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:alpha", "Alpha Theatre", 41, -87),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:beta", "Beta Theatre", 41, -86),
    );

    const client = makeClient(server.baseUrl);
    // An origin a hemisphere away from both must still return them (no radius to exclude).
    const body = await client.theatres.search.query({ q: "theatre", lat: -33, lng: -70 });
    // Both theatres return no matter how far away (no radius to exclude them); with an
    // origin present the order is nearest-first, so assert the returned set, not order.
    expect(body.theatres).toHaveLength(2);
    expect(new Set(body.theatres.map((hit) => hit.name))).toEqual(
      new Set(["Alpha Theatre", "Beta Theatre"]),
    );
    for (const hit of body.theatres) {
      expect(hit.distanceKm).not.toBeNull();
    }
  });

  it("rejects a lone lat (both-or-neither) as BAD_REQUEST", async () => {
    const client = makeClient(server.baseUrl);
    await expect(client.theatres.search.query({ q: "theatre", lat: 41 })).rejects.toMatchObject({
      data: { httpStatus: 400 },
    });
  });

  it("surfaces city on results and matches city via free-text q (ADR 0029 §7)", async () => {
    // Theatre whose name does NOT contain "Sunnyvale" but whose city does — q=Sunnyvale
    // must match via city, not name, proving the §7 (a) ILIKE extension.
    await upsertTheatre(poolClient(pool), {
      theatreId: "amc:theatre:sunnyvale",
      providerId: "amc",
      name: "Riverside Cinema",
      lat: 37.37,
      lng: -122.03,
      marketSlug: null,
      timezone: "America/Los_Angeles",
      city: "Sunnyvale",
      address: "150 E. McKinley Ave, Sunnyvale, CA, 94086",
      slugs: { detail: "amc:theatre:sunnyvale" },
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    // Control theatre in a different city, different name — should not match Sunnyvale query.
    await upsertTheatre(poolClient(pool), {
      theatreId: "amc:theatre:chicago",
      providerId: "amc",
      name: "Grand Palace",
      lat: 41.88,
      lng: -87.62,
      marketSlug: null,
      timezone: "America/Chicago",
      city: "Chicago",
      address: "123 Main St, Chicago, IL, 60601",
      slugs: { detail: "amc:theatre:chicago" },
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    // Theatre with no city — still findable by name, city is null on the wire.
    await upsertTheatre(poolClient(pool), {
      theatreId: "amc:theatre:nocity",
      providerId: "amc",
      name: "Alpha Cinemas",
      lat: 41,
      lng: -87,
      marketSlug: null,
      timezone: "America/Chicago",
      city: null,
      address: null,
      slugs: { detail: "amc:theatre:nocity" },
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });

    const client = makeClient(server.baseUrl);

    // City-only match: q=Sunnyvale returns only Riverside Cinema (city match, not name).
    const byCity = await client.theatres.search.query({ q: "Sunnyvale" });
    expect(byCity.theatres).toHaveLength(1);
    expect(byCity.theatres[0]!.name).toBe("Riverside Cinema");
    expect(byCity.theatres[0]!.city).toBe("Sunnyvale");
    expect(TheatreSearchResponseSchema.safeParse(byCity).success).toBe(true);

    // Case-insensitive city match.
    const byCityLower = await client.theatres.search.query({ q: "sunnyvale" });
    expect(byCityLower.theatres).toHaveLength(1);
    expect(byCityLower.theatres[0]!.city).toBe("Sunnyvale");

    // Name-only match still works for null-city theatre, and city is null on the wire.
    const byName = await client.theatres.search.query({ q: "Alpha" });
    expect(byName.theatres).toHaveLength(1);
    expect(byName.theatres[0]!.name).toBe("Alpha Cinemas");
    expect(byName.theatres[0]!.city).toBeNull();

    // A query matching neither name nor city returns zero theatres.
    const missing = await client.theatres.search.query({ q: "NoSuchCityOrName" });
    expect(missing.theatres).toEqual([]);

    // Searching by city also works with lat/lng — city match is independent of distance annotation.
    const byCityWithOrigin = await client.theatres.search.query({
      q: "Chicago",
      lat: 41.88,
      lng: -87.62,
    });
    expect(byCityWithOrigin.theatres).toHaveLength(1);
    expect(byCityWithOrigin.theatres[0]!.city).toBe("Chicago");
    expect(byCityWithOrigin.theatres[0]!.distanceKm).not.toBeNull();
  });
});

describe("theatres.search (S49 — browse mode)", () => {
  it("returns empty catalogue for {} when no theatres exist", async () => {
    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({});
    expect(body).toEqual({ theatres: [] });
    expect(TheatreSearchResponseSchema.safeParse(body).success).toBe(true);
  });

  it('treats empty q as browse — {} and { q: "" } return same catalogue in name order', async () => {
    await upsertTheatre(poolClient(pool), theatreInput("amc:theatre:zeta", "Zeta", 41, -87));
    await upsertTheatre(poolClient(pool), theatreInput("amc:theatre:alpha", "Alpha", 41, -87));
    const client = makeClient(server.baseUrl);
    const byEmpty = await client.theatres.search.query({ q: "" });
    const byMissing = await client.theatres.search.query({});
    expect(byMissing.theatres.map((hit) => hit.name)).toEqual(["Alpha", "Zeta"]);
    expect(byEmpty.theatres.map((hit) => hit.name)).toEqual(["Alpha", "Zeta"]);
    for (const hit of byMissing.theatres) expect(hit.distanceKm).toBeNull();
    for (const hit of byEmpty.theatres) expect(hit.distanceKm).toBeNull();
  });

  it("browses with lat/lng sorts nearest-first but does not filter (S49.3)", async () => {
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:alpha", "Alpha Theatre", 41, -87),
    );
    await upsertTheatre(
      poolClient(pool),
      theatreInput("amc:theatre:beta", "Beta Theatre", 41, -86),
    );
    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({ lat: 41, lng: -86 });
    expect(body.theatres).toHaveLength(2);
    expect(body.theatres[0]!.name).toBe("Beta Theatre");
    expect(body.theatres[0]!.distanceKm).toBe(0);
    expect(body.theatres[1]!.distanceKm).not.toBeNull();
    // Far origin still returns both — no filtering without radiusKm.
    const far = await client.theatres.search.query({ lat: -33, lng: -70 });
    expect(far.theatres).toHaveLength(2);
  });

  it("filters by radiusKm to in-radius theatres nearest-first and caps at 25 (S49.2/S49.3)", async () => {
    // Inside: 0.1° lat ≈ 11.12 km; outside: 0.2° ≈ 22.24 km.
    await upsertTheatre(poolClient(pool), theatreInput("amc:theatre:inside", "Inside", 0.1, 0));
    await upsertTheatre(poolClient(pool), theatreInput("amc:theatre:outside", "Outside", 0.2, 0));
    const client = makeClient(server.baseUrl);
    const narrow = await client.theatres.search.query({ lat: 0, lng: 0, radiusKm: 15 });
    expect(narrow.theatres.map((hit) => hit.name)).toEqual(["Inside"]);
    expect(narrow.theatres[0]!.distanceKm).not.toBeNull();
    expect(narrow.theatres[0]!.distanceKm!).toBeGreaterThan(10);
    expect(narrow.theatres[0]!.distanceKm!).toBeLessThan(12);

    const wide = await client.theatres.search.query({ lat: 0, lng: 0, radiusKm: 25 });
    expect(wide.theatres.map((hit) => hit.name)).toEqual(["Inside", "Outside"]);
    for (const hit of wide.theatres) expect(hit.distanceKm).not.toBeNull();
    // Nearest-first already: Inside before Outside.
    expect(wide.theatres[0]!.name).toBe("Inside");
  });

  it("caps radius-filtered results at 25 (min(50, maxTheatres))", async () => {
    for (let i = 0; i < 30; i += 1) {
      const id = `amc:theatre:cap-r-${String(i).padStart(2, "0")}`;
      await upsertTheatre(
        poolClient(pool),
        theatreInput(id, `Theatre ${String(i).padStart(2, "0")}`, 0, 0.001 * i),
      );
    }
    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({ lat: 0, lng: 0, radiusKm: 40 });
    expect(body.theatres).toHaveLength(25);
    for (const hit of body.theatres) expect(hit.distanceKm).not.toBeNull();
  });

  it("caps browse (no radius) at 50 after sorting", async () => {
    for (let i = 0; i < 51; i += 1) {
      const id = `amc:theatre:cap-b-${String(i).padStart(2, "0")}`;
      await upsertTheatre(
        poolClient(pool),
        theatreInput(id, `Theatre ${String(i).padStart(2, "0")}`, 41, -87),
      );
    }
    const client = makeClient(server.baseUrl);
    const body = await client.theatres.search.query({});
    expect(body.theatres).toHaveLength(50);
    // Stable name order: Theatre 00 should be first, Theatre 49 last (50th), 50 excluded.
    expect(body.theatres[0]!.name).toBe("Theatre 00");
    expect(body.theatres[49]!.name).toBe("Theatre 49");
  });

  it("rejects radiusKm > 40 with BAD_REQUEST and SELECTOR_UNSUPPORTED", async () => {
    const client = makeClient(server.baseUrl);
    await expect(
      client.theatres.search.query({ lat: 41, lng: -87, radiusKm: 40.01 }),
    ).rejects.toMatchObject({ data: { httpStatus: 400 } });
    // Verify the validation issue carries SELECTOR_UNSUPPORTED.
    try {
      await client.theatres.search.query({ lat: 41, lng: -87, radiusKm: 50 });
      throw new Error("expected BAD_REQUEST");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/SELECTOR_UNSUPPORTED/);
    }
    // Exactly 40 is accepted (even over empty catalogue).
    const ok = await client.theatres.search.query({ lat: 41, lng: -87, radiusKm: 40 });
    expect(ok.theatres).toEqual([]);
  });

  it("rejects radiusKm without lat/lng as BAD_REQUEST", async () => {
    const client = makeClient(server.baseUrl);
    await expect(client.theatres.search.query({ radiusKm: 10 })).rejects.toMatchObject({
      data: { httpStatus: 400 },
    });
    await expect(client.theatres.search.query({ lat: 41, radiusKm: 10 })).rejects.toMatchObject({
      data: { httpStatus: 400 },
    });
  });

  it("q-present behaviour unchanged — free-text still filters by name/city (S49.4)", async () => {
    await upsertTheatre(poolClient(pool), {
      theatreId: "amc:theatre:alpha",
      providerId: "amc",
      name: "Alpha Cinemas",
      lat: 41,
      lng: -87,
      marketSlug: null,
      timezone: "America/Chicago",
      city: null,
      address: null,
      slugs: { detail: "amc:theatre:alpha" },
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    await upsertTheatre(poolClient(pool), {
      theatreId: "amc:theatre:beta",
      providerId: "amc",
      name: "Beta Theatre",
      lat: 41,
      lng: -86,
      marketSlug: null,
      timezone: "America/Chicago",
      city: "Sunnyvale",
      address: "150 McKinley Ave, Sunnyvale, CA",
      slugs: { detail: "amc:theatre:beta" },
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });
    const client = makeClient(server.baseUrl);
    const byName = await client.theatres.search.query({ q: "Alpha" });
    expect(byName.theatres.map((hit) => hit.name)).toEqual(["Alpha Cinemas"]);
    const byCity = await client.theatres.search.query({ q: "Sunnyvale" });
    expect(byCity.theatres.map((hit) => hit.name)).toEqual(["Beta Theatre"]);
    const missing = await client.theatres.search.query({ q: "NoMatch" });
    expect(missing.theatres).toEqual([]);
  });
});
