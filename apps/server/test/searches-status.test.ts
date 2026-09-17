import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTRPCClient, httpLink } from "@trpc/client";
import { Client, Pool } from "pg";

import type { TestServer } from "./support/app.js";
import { sessionCookieHeader, startTestServer } from "./support/app.js";
import { startTestPostgres, startTestRedis } from "./support/containers.js";
import type { TestService } from "./support/containers.js";
import { migrateDatabase, seedSearchRow } from "./support/db.js";
import type { AppRouter } from "../src/routes/searches/router.js";

/**
 * S60 verification — the `searches.status` query end to end (S60.8/S60.10):
 * Zod boundary, ownership, and the CANCELLED-serving probe contract that
 * distinguishes it from `searches.get`.
 */

let seq = 0;
function searchId(): string {
  seq += 1;
  return `srch_s60_${Date.now().toString(36)}_${seq}`;
}

/** A query-capable client (httpLink + session cookie), like cancel.test.ts. */
function makeClient(baseUrl: string, sessionId: string) {
  return createTRPCClient<AppRouter>({
    links: [httpLink({ url: baseUrl, headers: { cookie: sessionCookieHeader(sessionId) } })],
  });
}
type StatusClient = ReturnType<typeof makeClient>;

describe("searches.status (S60)", () => {
  let pg: TestService;
  let redis: TestService;
  let server: TestServer;
  let pool: Pool;
  let admin: Client;
  let client: StatusClient;

  beforeEach(async () => {
    await admin.query("TRUNCATE search, provider_admission, provider_fence CASCADE");
  });

  beforeAll(async () => {
    pg = await startTestPostgres();
    redis = await startTestRedis();
    await migrateDatabase(pg.url);

    pool = new Pool({ connectionString: pg.url });
    admin = new Client({ connectionString: pg.url });
    await admin.connect();

    server = await startTestServer({ db: pool, redisUrl: redis.url, blockTimeoutMs: 250 });
    client = makeClient(server.baseUrl, "sess_owner");
  });

  afterAll(async () => {
    await server.close();
    await admin.end();
    await pool.end();
    await Promise.all([pg.stop(), redis.stop()]);
  });

  it("Zod boundary: a searchId failing ^srch_.+$ is BAD_REQUEST before any read", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    await expect(
      client.searches.status.query({ searchId: "not-a-search-id" }),
    ).rejects.toMatchObject({
      data: { code: "BAD_REQUEST" },
    });
  });

  it("ownership: a different valid session, no session, and an unknown searchId are UNAUTHORIZED, never NOT_FOUND", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });

    const other = makeClient(server.baseUrl, "sess_other");
    await expect(other.searches.status.query({ searchId: id })).rejects.toMatchObject({
      data: { code: "UNAUTHORIZED" },
    });

    const anonymous = makeClient(server.baseUrl, "sess_ghost"); // no row owns it
    await expect(anonymous.searches.status.query({ searchId: id })).rejects.toMatchObject({
      data: { code: "UNAUTHORIZED" },
    });

    const unknown = makeClient(server.baseUrl, "sess_other");
    await expect(
      unknown.searches.status.query({ searchId: "srch_does_not_exist" }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  });

  it("owner probing a real nonterminal search gets { searchId, status } matching the seeded status", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" }); // PENDING_SCHEDULE
    await expect(client.searches.status.query({ searchId: id })).resolves.toEqual({
      searchId: id,
      status: "PENDING_SCHEDULE",
    });

    const running = searchId();
    await seedSearchRow(pool, { searchId: running, sessionId: "sess_owner", status: "RUNNING" });
    await expect(client.searches.status.query({ searchId: running })).resolves.toEqual({
      searchId: running,
      status: "RUNNING",
    });
  });

  it("owner probing a CANCELLED search gets { searchId, status: 'CANCELLED' } without throwing (unlike searches.get)", async () => {
    const id = searchId();
    await seedSearchRow(pool, { searchId: id, sessionId: "sess_owner" });
    await client.searches.cancel.mutate({ searchId: id });
    await expect(client.searches.status.query({ searchId: id })).resolves.toEqual({
      searchId: id,
      status: "CANCELLED",
    });
  });
});
